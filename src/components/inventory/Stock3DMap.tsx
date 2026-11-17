import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { InventoryEntry, WmsData } from '../../types/wms';
import { RESERVE_SPOTS, SPOT_D, SPOT_IDS, SPOT_W, buildPlan, rackPoses, type RackPose } from './plantLayout';

/*
 * Mapa 3D do estoque no formato da planta da produção.
 * Lê os mesmos dados do WMS (data.entries) e desenha cada rack com suas posições:
 *   endereço = ZONA + SEÇÃO(3-4 díg.) + POSIÇÃO(4 díg.) + NÍVEL(00/10/20/30)
 *   seção ímpar = lado esquerdo, seção par = lado direito; rack = ceil(seção / 2).
 * ESTOQUE EXTRA (R1-R6): espaços fora das prateleiras. O vínculo "linha -> reserva" é uma anotação
 * salva só neste navegador (localStorage); não altera o WMS nem o banco compartilhado.
 */

type Side = 'left' | 'right';
type Parsed = { rack: string; section: string; level: string; side: Side };
type ColorMode = 'item' | 'idle' | 'pending' | 'occ';

const BAY_W = 1.2;
const BAY_D = 0.8;
const LV_H = 0.55;
const BASE_Y = 0.12;
const RES_H = 0.1;
const MAX_BOXES = 12;
const STD_LEVELS = ['00', '10', '20', '30'];
const EXTRA_LEVELS = ['00', '10', '20'];
const LEVEL_LABEL: Record<string, string> = { '00': 'Térreo', '10': '1º nível', '20': '2º nível', '30': '3º nível', RES: 'Estoque extra' };
const DEFAULT_RACKS = ['A001', 'A002', 'A003', 'A004', 'A005', 'A006', 'E001'];
const RESERVE_STORAGE_KEY = 'wms-3d-reserve-v1';
const RES_COLOR = '#e0452a';
const SLOT_COLOR = '#3a4454';

function parseLocation(value: string): Parsed | null {
  const match = value.trim().toLocaleUpperCase('pt-BR').replace(/\s+/g, '')
    .match(/^([A-Z])(\d{3,4})(\d{4})(00|10|20|30)$/);
  if (!match) return null;
  const section = Number(match[2]);
  if (section < 1 || Number(match[3]) === 0) return null;
  return {
    rack: `${match[1]}${String(Math.ceil(section / 2)).padStart(3, '0')}`,
    section: `${match[1]}${match[2]}`,
    level: match[4],
    side: section % 2 === 1 ? 'left' : 'right',
  };
}

const levelsOf = (rack: string) => (rack.startsWith('E') ? EXTRA_LEVELS : STD_LEVELS);
const slotKey = (rack: string, level: string, side: Side) => `${rack}|${level}|${side}`;
const reserveKey = (spot: string) => `${spot}|RES|res`;
const isReserveKey = (key: string) => key.includes('|RES|');
const formatQty = (entry: InventoryEntry) =>
  entry.quantity == null
    ? `a conferir: ${entry.rawQuantity || '—'}`
    : `${entry.quantity.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${entry.unit}`;

function loadReserve(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(RESERVE_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) as unknown : {};
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, spot]) => typeof spot === 'string' && SPOT_IDS.has(spot))) as Record<string, string>;
  } catch {
    return {};
  }
}

function idleDays(entry: InventoryEntry): number | null {
  const time = Date.parse(entry.receivedDate);
  if (!entry.receivedDate || Number.isNaN(time)) return null;
  return Math.max(0, Math.round((Date.now() - time) / 86400000));
}

function hashColor(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 62%, 55%)`;
}

function entryColor(entry: InventoryEntry, mode: ColorMode): string {
  if (mode === 'pending') return entry.quantity == null ? '#ff5a5f' : (entry.quantity > 0 ? '#2fd18b' : '#8d9bb0');
  if (mode === 'idle') {
    const days = idleDays(entry);
    if (days === null) return '#8d9bb0';
    return days <= 30 ? '#f9c5d1' : days <= 90 ? '#ef7d9b' : days <= 180 ? '#c2275a' : '#6b0f33';
  }
  if (mode === 'occ') return '#b9c3d1';
  return hashColor(entry.itemCode || entry.itemName);
}

const occColor = (count: number) => (count === 0 ? SLOT_COLOR : count <= 2 ? '#2fd18b' : count <= 5 ? '#ffd23f' : '#ff5a5f');

const LEGENDS: Record<ColorMode, Array<[string, string]>> = {
  item: [['#8d9bb0', 'Cada item tem uma cor própria (pelo código)']],
  idle: [['#f9c5d1', 'Até 30 dias'], ['#ef7d9b', '31 a 90 dias'], ['#c2275a', '91 a 180 dias'], ['#6b0f33', 'Mais de 180 dias'], ['#8d9bb0', 'Sem data de entrada']],
  pending: [['#2fd18b', 'Saldo conferido'], ['#ff5a5f', 'A conferir'], ['#8d9bb0', 'Saldo zero']],
  occ: [[SLOT_COLOR, 'Posição vazia'], ['#2fd18b', '1 a 2 linhas'], ['#ffd23f', '3 a 5 linhas'], ['#ff5a5f', '6 ou mais linhas']],
};

function makeLabel(text: string, width: number, height: number, font: string, fg: string, bg?: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = Math.round((256 * height) / width);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.fillStyle = fg;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
  );
}

function disposeGroup(group: THREE.Group) {
  group.children.slice().forEach((child) => {
    group.remove(child);
    child.traverse((node) => {
      const mesh = node as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else if (material) {
        const map = (material as THREE.MeshBasicMaterial).map;
        map?.dispose();
        material.dispose();
      }
    });
  });
}

/* posição local do rack (x = ao longo das baias, z = profundidade) -> mundo */
function toWorldPos(lx: number, ly: number, lz: number, pose: RackPose) {
  const c = Math.cos(pose.rot);
  const s = Math.sin(pose.rot);
  return new THREE.Vector3(pose.x + lx * c + lz * s, ly, pose.z - lx * s + lz * c);
}

type Api = {
  goTo: (pos: THREE.Vector3, look: THREE.Vector3) => void;
  frontView: () => void;
  getHits: () => THREE.Object3D[];
};

export function Stock3DMap({ data }: { data: WmsData }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const structureRef = useRef<THREE.Group>(new THREE.Group());
  const itemsRef = useRef<THREE.Group>(new THREE.Group());
  const selRef = useRef<THREE.Mesh | null>(null);
  const hitsRef = useRef<THREE.Object3D[]>([]);
  const boardsRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const centersRef = useRef<Map<string, THREE.Vector3>>(new Map());
  const localRef = useRef<Map<string, THREE.Vector3>>(new Map());
  const posesRef = useRef<Map<string, RackPose>>(new Map());
  const apiRef = useRef<Api | null>(null);
  const firstBuild = useRef(true);

  const [mode, setMode] = useState<ColorMode>('item');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState('');
  const [tour, setTour] = useState(false);
  const [reserve, setReserve] = useState<Record<string, string>>(loadReserve);

  useEffect(() => {
    try { window.localStorage.setItem(RESERVE_STORAGE_KEY, JSON.stringify(reserve)); } catch { /* sem armazenamento: segue sem salvar */ }
  }, [reserve]);

  const assign = (entryId: string, spot: string) => setReserve((prev) => {
    const next = { ...prev };
    if (spot && SPOT_IDS.has(spot)) next[entryId] = spot;
    else delete next[entryId];
    return next;
  });

  const parsed = useMemo(
    () => data.entries.map((entry) => {
      const loc = parseLocation(entry.location);
      const spot = SPOT_IDS.has(reserve[entry.id]) ? reserve[entry.id] : '';
      const key = spot ? reserveKey(spot) : loc ? slotKey(loc.rack, loc.level, loc.side) : null;
      return { entry, loc, spot, key };
    }),
    [data.entries, reserve],
  );

  const racks = useMemo(() => {
    const names = new Set(DEFAULT_RACKS);
    parsed.forEach(({ loc }) => { if (loc) names.add(loc.rack); });
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [parsed]);
  const racksKey = racks.join(',');

  const bySlot = useMemo(() => {
    const map = new Map<string, InventoryEntry[]>();
    parsed.forEach(({ entry, key }) => {
      if (!key) return;
      map.set(key, [...(map.get(key) ?? []), entry]);
    });
    return map;
  }, [parsed]);

  const term = query.trim().toLocaleLowerCase('pt-BR');
  const matches = (entry: InventoryEntry) => !term
    || [entry.itemName, entry.itemCode, entry.lot, entry.location].some((v) => v.toLocaleLowerCase('pt-BR').includes(term));

  /* ---------- KPIs ---------- */
  const totalSlots = racks.reduce((sum, rack) => sum + levelsOf(rack).length * 2, 0);
  const usedSlots = [...bySlot.entries()]
    .filter(([key, list]) => !isReserveKey(key) && list.some((e) => (e.quantity ?? 0) > 0 || e.quantity == null)).length;
  const inReserve = parsed.filter(({ spot }) => spot).length;
  const units = data.entries.reduce((s, e) => s + (e.quantity != null && e.unit === 'UN' && e.quantity > 0 ? e.quantity : 0), 0);
  const meters = data.entries.reduce((s, e) => s + (e.quantity != null && e.unit === 'MT' && e.quantity > 0 ? e.quantity : 0), 0);
  const pending = data.entries.filter((e) => e.quantity == null).length;
  const noAddress = parsed.filter(({ loc }) => !loc).length;
  const old180 = data.entries.filter((e) => (idleDays(e) ?? 0) > 180).length;

  /* ---------- cena (1x) ---------- */
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#10141b');
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 300);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 0.8;
    controls.maxDistance = 90;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334055, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.position.set(4, 8, 8);
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), new THREE.MeshLambertMaterial({ color: '#1a212c' }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);
    const plan = buildPlan(makeLabel);
    scene.add(plan, structureRef.current, itemsRef.current);

    const selMesh = new THREE.Mesh(
      new THREE.BoxGeometry(BAY_W + 0.04, LV_H, BAY_D + 0.04),
      new THREE.MeshBasicMaterial({ color: '#4aa3ff', transparent: true, opacity: 0.22, depthWrite: false }),
    );
    selMesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(selMesh.geometry), new THREE.LineBasicMaterial({ color: '#4aa3ff' })));
    selMesh.visible = false;
    scene.add(selMesh);
    selRef.current = selMesh;

    let tween: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;
    const api: Api = {
      goTo: (pos, look) => { tween = { pos, look }; },
      frontView: () => api.goTo(new THREE.Vector3(0, 40, 24), new THREE.Vector3(0, 0, 1)),
      getHits: () => [...itemsRef.current.children, ...hitsRef.current],
    };
    apiRef.current = api;
    controls.addEventListener('start', () => { tween = null; setTour(false); });

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    camera.position.set(0, 40, 24);
    controls.target.set(0, 0, 1);

    /* picking */
    const ray = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const pick = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(mouse, camera);
      const hit = ray.intersectObjects(api.getHits(), false)[0];
      return hit ? (hit.object.userData as { slot?: string; entry?: string }) : null;
    };
    let downAt: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => { downAt = { x: event.clientX, y: event.clientY }; };
    const onUp = (event: PointerEvent) => {
      if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) return;
      const info = pick(event);
      if (info?.slot) { setTour(false); setSelected(info.slot); }
    };
    const onMove = (event: PointerEvent) => {
      if (event.buttons) return;
      const info = pick(event);
      setHover(info?.slot ? info.slot : '');
    };
    const onLeave = () => setHover('');
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      if (tween) {
        camera.position.lerp(tween.pos, 0.07);
        controls.target.lerp(tween.look, 0.07);
        if (camera.position.distanceTo(tween.pos) < 0.01) tween = null;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      controls.dispose();
      disposeGroup(plan);
      disposeGroup(structureRef.current);
      disposeGroup(itemsRef.current);
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      selMesh.geometry.dispose();
      renderer.dispose();
      apiRef.current = null;
    };
  }, []);

  /* ---------- estrutura: racks na planta + vagas de estoque extra ---------- */
  useEffect(() => {
    const group = structureRef.current;
    disposeGroup(group);
    hitsRef.current = [];
    boardsRef.current = new Map();
    centersRef.current = new Map();
    localRef.current = new Map();
    const poses = rackPoses(racks);
    posesRef.current = poses;
    const post = new THREE.MeshLambertMaterial({ color: '#c9922a' });

    racks.forEach((rack) => {
      const pose = poses.get(rack);
      if (!pose) return;
      const levels = levelsOf(rack);
      const height = BASE_Y + levels.length * LV_H + 0.04;
      const rg = new THREE.Group();
      rg.position.set(pose.x, 0, pose.z);
      rg.rotation.y = pose.rot;
      group.add(rg);
      [-BAY_W, 0, BAY_W].forEach((dx) => {
        [-1, 1].forEach((dz) => {
          const p = new THREE.Mesh(new THREE.BoxGeometry(0.05, height, 0.05), post);
          p.position.set(dx, height / 2, dz * (BAY_D / 2 - 0.03));
          rg.add(p);
        });
      });
      const title = makeLabel(rack.startsWith('E') ? 'RACK EXTRA' : `RACK ${Number(rack.slice(1))}`, 1.5, 0.3, 'bold 56px system-ui', '#ffffff', '#1e6fd6dd');
      title.position.set(0, height + 0.25, BAY_D / 2);
      rg.add(title);
      (['left', 'right'] as const).forEach((side) => {
        const bayX = (side === 'left' ? -1 : 1) * (BAY_W / 2);
        const sectionNo = Number(rack.slice(1)) * 2 - (side === 'left' ? 1 : 0);
        const section = `${rack[0]}${String(sectionNo).padStart(3, '0')}`;
        levels.forEach((level, li) => {
          const key = slotKey(rack, level, side);
          const topY = BASE_Y + li * LV_H;
          const board = new THREE.Mesh(new THREE.BoxGeometry(BAY_W - 0.04, 0.04, BAY_D), new THREE.MeshLambertMaterial({ color: SLOT_COLOR }));
          board.position.set(bayX, topY - 0.02, 0);
          rg.add(board);
          boardsRef.current.set(key, board);
          const rail = new THREE.Mesh(new THREE.BoxGeometry(BAY_W - 0.04, 0.08, 0.02), new THREE.MeshLambertMaterial({ color: '#e9eef6' }));
          rail.position.set(bayX, topY - 0.06, BAY_D / 2);
          rg.add(rail);
          const text = makeLabel(`${section} · ${level}`, 0.62, 0.07, 'bold 40px system-ui', '#10141b');
          text.position.set(bayX, topY - 0.06, BAY_D / 2 + 0.013);
          rg.add(text);
          const local = new THREE.Vector3(bayX, topY + (LV_H - 0.04) / 2, 0);
          localRef.current.set(key, local);
          centersRef.current.set(key, toWorldPos(local.x, local.y, local.z, pose));
          const hit = new THREE.Mesh(new THREE.BoxGeometry(BAY_W - 0.06, LV_H - 0.06, BAY_D), new THREE.MeshBasicMaterial({ visible: false }));
          hit.position.copy(local);
          hit.userData = { slot: key };
          rg.add(hit);
          hitsRef.current.push(hit);
        });
      });
    });

    RESERVE_SPOTS.forEach((spot) => {
      const key = reserveKey(spot.id);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(SPOT_W - 0.04, RES_H, SPOT_D - 0.04), new THREE.MeshLambertMaterial({ color: RES_COLOR }));
      pad.position.set(spot.x, RES_H / 2 + 0.01, spot.z);
      group.add(pad);
      boardsRef.current.set(key, pad);
      const text = makeLabel(spot.id, 1, 0.5, 'bold 72px system-ui', '#ffffff');
      text.rotation.x = -Math.PI / 2;
      text.position.set(spot.x, RES_H + 0.03, spot.z);
      group.add(text);
      const center = new THREE.Vector3(spot.x, RES_H + 0.01 + 0.15, spot.z);
      localRef.current.set(key, center);
      centersRef.current.set(key, center);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(SPOT_W, 0.5, SPOT_D), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.set(spot.x, 0.25, spot.z);
      hit.userData = { slot: key };
      group.add(hit);
      hitsRef.current.push(hit);
    });

    if (firstBuild.current && apiRef.current) {
      firstBuild.current = false;
      apiRef.current.frontView();
    }
  }, [racksKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- itens (quando muda estoque, reserva, cor ou busca) ---------- */
  useEffect(() => {
    const group = itemsRef.current;
    disposeGroup(group);
    boardsRef.current.forEach((board, key) => {
      const count = bySlot.get(key)?.length ?? 0;
      const base = isReserveKey(key) ? RES_COLOR : SLOT_COLOR;
      (board.material as THREE.MeshLambertMaterial).color.set(mode === 'occ' ? occColor(count) : base);
    });
    bySlot.forEach((list, key) => {
      const local = localRef.current.get(key);
      if (!local) return;
      const reserved = isReserveKey(key);
      const pose = reserved ? null : posesRef.current.get(key.split('|')[0]);
      if (!reserved && !pose) return;
      const innerW = reserved ? SPOT_W - 0.16 : BAY_W - 0.14;
      const innerD = reserved ? SPOT_D - 0.16 : BAY_D - 0.12;
      const shown = list.slice(0, MAX_BOXES);
      const cols = Math.min(reserved ? 3 : 4, shown.length);
      const rows = Math.ceil(shown.length / cols);
      const bw = (innerW / cols) * 0.88;
      const bd = (innerD / rows) * 0.88;
      const floorY = reserved ? RES_H + 0.01 : local.y - (LV_H - 0.04) / 2;
      shown.forEach((entry, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const qty = entry.quantity ?? 60;
        const bh = 0.14 + (Math.min(qty, 500) / 500) * 0.26;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(bw, bh, bd),
          new THREE.MeshLambertMaterial({ color: entryColor(entry, mode), transparent: true, opacity: matches(entry) ? 1 : 0.1 }),
        );
        const lx = local.x - innerW / 2 + ((col + 0.5) * innerW) / cols;
        const lz = (reserved ? local.z : 0) - innerD / 2 + ((row + 0.5) * innerD) / rows;
        if (pose) {
          mesh.position.copy(toWorldPos(lx, floorY + bh / 2, lz, pose));
          mesh.rotation.y = pose.rot;
        } else mesh.position.set(lx, floorY + bh / 2, lz);
        mesh.userData = { slot: key, entry: entry.id };
        group.add(mesh);
      });
    });
  }, [bySlot, mode, term]); // eslint-disable-line react-hooks/exhaustive-deps

  /* seleção: caixa azul + câmera */
  useEffect(() => {
    const sel = selRef.current;
    if (!sel) return;
    const center = selected ? centersRef.current.get(selected) : null;
    if (!selected || !center) { sel.visible = false; return; }
    sel.position.copy(center);
    sel.visible = true;
    if (isReserveKey(selected)) {
      sel.scale.set(SPOT_W / (BAY_W + 0.04), 0.3 / LV_H, SPOT_D / (BAY_D + 0.04));
      sel.rotation.y = 0;
      apiRef.current?.goTo(new THREE.Vector3(center.x, 7, center.z + 4.5), center);
    } else {
      const pose = posesRef.current.get(selected.split('|')[0]);
      const rot = pose?.rot ?? 0;
      sel.scale.set(1, 1, 1);
      sel.rotation.y = rot;
      apiRef.current?.goTo(new THREE.Vector3(center.x + 2.4 * Math.sin(rot), center.y + 0.2, center.z + 2.4 * Math.cos(rot)), center);
    }
  }, [selected]);

  /* busca: voa até o primeiro resultado */
  useEffect(() => {
    if (!term) return;
    const found = parsed.find(({ entry, key }) => key && matches(entry));
    if (found?.key) setSelected(found.key);
  }, [term]); // eslint-disable-line react-hooks/exhaustive-deps

  /* tour pelas prateleiras */
  useEffect(() => {
    if (!tour) return;
    let index = 0;
    const go = () => {
      const rack = racks[index % racks.length];
      index += 1;
      const pose = posesRef.current.get(rack);
      if (!pose) return;
      apiRef.current?.goTo(
        new THREE.Vector3(pose.x + 4.6 * Math.sin(pose.rot), 1.8, pose.z + 4.6 * Math.cos(pose.rot)),
        new THREE.Vector3(pose.x, 1, pose.z),
      );
    };
    go();
    const timer = window.setInterval(go, 3200);
    return () => window.clearInterval(timer);
  }, [tour, racksKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedEntries = selected ? (bySlot.get(selected) ?? []) : [];
  const [sRack, sLevel, sSide] = selected ? selected.split('|') : ['', '', ''];
  const selectedIsReserve = selected ? isReserveKey(selected) : false;
  const describe = (key: string) => {
    const [name, level, side] = key.split('|');
    const count = bySlot.get(key)?.length ?? 0;
    return isReserveKey(key)
      ? `Estoque extra ${name} · ${count} linha(s)`
      : `${name} · ${LEVEL_LABEL[level] ?? level} · ${side === 'left' ? 'esquerda' : 'direita'} · ${count} linha(s)`;
  };

  return (
    <section className="rounded-lg bg-[#0b1425] p-3 text-slate-100 sm:p-4">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-sky-200">Planta da produção · WMS</p>
          <h2 className="text-lg font-black text-white sm:text-2xl">MAPA 3D DO ESTOQUE</h2>
          <p className="text-xs text-sky-100/70">Prateleiras e estoque extra na planta · usa os dados do WMS · reserva salva só neste navegador</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {[
            ['Posições com saldo', `${usedSlots} / ${totalSlots}`, 'text-emerald-300'],
            ['Em estoque extra', String(inReserve), inReserve ? 'text-orange-300' : 'text-slate-300'],
            ['Linhas de estoque', String(data.entries.length), 'text-sky-300'],
            ['Saldo (UN)', units.toLocaleString('pt-BR'), 'text-amber-300'],
            ['Saldo (MT)', meters.toLocaleString('pt-BR', { maximumFractionDigits: 1 }), 'text-amber-300'],
            ['A conferir', String(pending), pending ? 'text-rose-300' : 'text-slate-300'],
            ['Parados > 180d', String(old180), old180 ? 'text-amber-300' : 'text-slate-300'],
            ['Sem endereço válido', String(noAddress), noAddress ? 'text-rose-300' : 'text-slate-300'],
          ].map(([label, value, tone]) => (
            <div key={label} className="rounded-lg border border-white/10 bg-[#14233a] px-3 py-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
              <p className={`text-base font-black ${tone}`}>{value}</p>
            </div>
          ))}
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar item, código, lote ou endereço"
          className="min-h-9 w-full rounded-md border border-white/15 bg-[#0f1a2e] px-3 text-slate-100 placeholder:text-slate-500 sm:w-72"
        />
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as ColorMode)}
          aria-label="Colorir por"
          className="min-h-9 rounded-md border border-white/15 bg-[#0f1a2e] px-2 text-slate-100"
        >
          <option value="item">Cor por item</option>
          <option value="idle">Tempo parado</option>
          <option value="pending">A conferir</option>
          <option value="occ">Ocupação da posição</option>
        </select>
        <button type="button" onClick={() => { setTour(false); apiRef.current?.frontView(); }} className="min-h-9 rounded-md border border-white/15 px-3 font-semibold hover:bg-white/10">Vista geral</button>
        <button type="button" onClick={() => setTour((value) => !value)} className="min-h-9 rounded-md border border-white/15 px-3 font-semibold hover:bg-white/10">{tour ? '■ Parar tour' : '▶ Tour'}</button>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-300">
          {LEGENDS[mode].map(([color, label]) => (
            <span key={label} className="inline-flex items-center gap-1.5"><i className="inline-block h-3 w-3 rounded-sm" style={{ background: color }} />{label}</span>
          ))}
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3 w-3 rounded-sm" style={{ background: RES_COLOR }} />Estoque extra (R1–R6)</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div ref={hostRef} className="relative h-[68vh] min-h-[400px] overflow-hidden rounded-lg border border-white/10">
          <canvas ref={canvasRef} className="block h-full w-full" />
          {hover && (
            <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[11px]">{describe(hover)}</div>
          )}
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/50 px-2 py-1 text-[10px] text-slate-300">Arraste para girar · roda para zoom · clique numa prateleira ou num retângulo vermelho</div>
        </div>

        <aside className="max-h-[68vh] min-h-[200px] overflow-auto rounded-lg border border-white/10 bg-[#14233a] p-3">
          {!selected ? (
            <p className="text-xs text-slate-400">Clique numa posição do rack ou num espaço de estoque extra (vermelho) para ver o que está guardado nele.</p>
          ) : (
            <>
              <h3 className="text-base font-black">{selectedIsReserve ? `Estoque extra ${sRack}` : `${sRack} · ${LEVEL_LABEL[sLevel] ?? sLevel}`}</h3>
              <p className="mb-2 text-[11px] text-slate-400">
                {selectedIsReserve ? 'Fora das prateleiras' : `Lado ${sSide === 'left' ? 'esquerdo' : 'direito'}`} · {selectedEntries.length} linha(s)
              </p>
              {selectedEntries.length === 0 && <p className="rounded border border-white/10 p-2 text-xs text-slate-400">{selectedIsReserve ? 'Espaço vazio.' : 'Posição vazia.'}</p>}
              {selectedEntries.map((entry) => (
                <div key={entry.id} className={`mb-2 rounded border p-2 ${matches(entry) ? 'border-white/15' : 'border-white/5 opacity-50'}`}>
                  <p className="text-sm font-bold">{entry.itemName}</p>
                  <p className="text-[11px] text-slate-400">Código {entry.itemCode} · Lote {entry.lot || '—'}</p>
                  <p className="mt-1 text-xs">
                    <span className={entry.quantity == null ? 'font-bold text-rose-300' : 'font-bold text-emerald-300'}>{formatQty(entry)}</span>
                    {' · '}{entry.boxCount} caixa(s)
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Endereço original {entry.location || '—'} · {entry.status || 'sem status'}
                    {idleDays(entry) !== null && ` · parado há ${idleDays(entry)} dia(s)`}
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-[11px] text-slate-300">
                    Estoque extra
                    <select
                      value={reserve[entry.id] && SPOT_IDS.has(reserve[entry.id]) ? reserve[entry.id] : ''}
                      onChange={(event) => assign(entry.id, event.target.value)}
                      className="min-h-8 rounded border border-white/15 bg-[#0f1a2e] px-1 text-slate-100"
                    >
                      <option value="">Na prateleira</option>
                      {RESERVE_SPOTS.map((spot) => <option key={spot.id} value={spot.id}>{spot.id}</option>)}
                    </select>
                  </label>
                </div>
              ))}
              {selectedEntries.length > MAX_BOXES && <p className="text-[11px] text-amber-300">O 3D mostra as {MAX_BOXES} primeiras linhas; todas estão listadas aqui.</p>}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
