import * as THREE from 'three';

/*
 * Planta da produção (coordenadas tiradas da imagem da planta, em pixels).
 * 1 px = PX unidades 3D; o centro do prédio é a origem. x = direita, z = para baixo (sul).
 */
export const PX = 0.04;
const CX = 351;
const CY = 443;
export const toWorld = (px: number, py: number): [number, number] => [(px - CX) * PX, (py - CY) * PX];

export type RackPose = { x: number; z: number; rot: number };

/* Estoque extra (retângulos vermelhos): R1-R3 à esquerda da produção, R4-R6 à direita (de cima para baixo). */
export const SPOT_W = 33 * PX;
export const SPOT_D = 61 * PX;
export const RESERVE_SPOTS = [
  { id: 'R1', px: 194.5, py: 58.5 },
  { id: 'R2', px: 194.5, py: 127.5 },
  { id: 'R3', px: 194.5, py: 196.5 },
  { id: 'R4', px: 487.5, py: 58.5 },
  { id: 'R5', px: 487.5, py: 127.5 },
  { id: 'R6', px: 487.5, py: 196.5 },
].map((spot) => {
  const [x, z] = toWorld(spot.px, spot.py);
  return { id: spot.id, x, z };
});
export const SPOT_IDS = new Set(RESERVE_SPOTS.map((spot) => spot.id));

/* Prateleiras rosa: 6 em coluna na parede direita da área de estoque + 1 larga no topo (rack extra). */
const COLUMN_Y = [56.5, 127.5, 198.5, 269.5, 341, 412.5];
export function rackPoses(racks: string[]): Map<string, RackPose> {
  const poses = new Map<string, RackPose>();
  let overflow = 0;
  const nextOverflow = (): RackPose => {
    const k = overflow;
    overflow += 1;
    const [x, z] = k < 4 ? toWorld(532, 483 + 71 * k) : toWorld(590, 483 + 71 * (k - 4));
    return { x, z, rot: -Math.PI / 2 };
  };
  racks.filter((r) => !r.startsWith('E')).forEach((rack, i) => {
    if (i < COLUMN_Y.length) {
      const [x, z] = toWorld(532, COLUMN_Y[i]);
      poses.set(rack, { x, z, rot: -Math.PI / 2 });
    } else poses.set(rack, nextOverflow());
  });
  racks.filter((r) => r.startsWith('E')).forEach((rack, i) => {
    if (i === 0) {
      const [x, z] = toWorld(612, 41);
      poses.set(rack, { x, z, rot: 0 });
    } else poses.set(rack, nextOverflow());
  });
  return poses;
}

type LabelFn = (text: string, w: number, h: number, font: string, fg: string, bg?: string) => THREE.Mesh;
type Rect = [number, number, number, number];

const TABLES: Rect[] = [
  // eletrônica
  [28, 26, 159, 54], [28, 62, 72, 229], [28, 251, 72, 418],
  // mesa de produção (4 mesas juntas, 8 cadeiras)
  [264, 44, 334, 202], [341, 44, 411, 202], [264, 203, 334, 361], [341, 203, 411, 361],
  // lado executivo
  [247, 580, 286, 650], [194, 650, 286, 702], [194, 711, 247, 762], [247, 711, 286, 825],
  [363, 554, 412, 662], [413, 554, 462, 662], [363, 662, 412, 770], [413, 662, 462, 770], [363, 770, 462, 825],
  // estoque
  [522, 724, 597, 756],
];
const CHAIRS: Array<[number, number]> = [
  [127, 59], [77, 116], [77, 188], [77, 304], [77, 376],
  [261, 91], [261, 163], [261, 235], [261, 307], [411, 102], [411, 174], [411, 246], [411, 318],
  [222, 625], [222, 785], [357, 610], [357, 724], [467, 610], [467, 724], [412, 831],
  [559, 716],
];

/* Piso, paredes, portas, mesas, cadeiras e nomes das áreas (tudo estático). */
export function buildPlan(label: LabelFn): THREE.Group {
  const g = new THREE.Group();
  const lam = (color: string) => new THREE.MeshLambertMaterial({ color });

  const floor = (pts: Array<[number, number]>, color: string) => {
    const shape = new THREE.Shape(pts.map(([px, py]) => { const [x, z] = toWorld(px, py); return new THREE.Vector2(x, -z); }));
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), lam(color));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.01;
    g.add(mesh);
  };
  const box = ([x1, y1, x2, y2]: Rect, h: number, color: string, base = 0) => {
    const [ax, az] = toWorld(x1, y1);
    const [bx, bz] = toWorld(x2, y2);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(bx - ax, h, bz - az), lam(color));
    mesh.position.set((ax + bx) / 2, base + h / 2, (az + bz) / 2);
    g.add(mesh);
  };
  const seg = (x1: number, y1: number, x2: number, y2: number, h: number, color: string, t: number) => {
    const [ax, az] = toWorld(x1, y1);
    const [bx, bz] = toWorld(x2, y2);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(t, h, Math.hypot(bx - ax, bz - az)), lam(color));
    mesh.position.set((ax + bx) / 2, h / 2, (az + bz) / 2);
    mesh.rotation.y = Math.atan2(bx - ax, bz - az);
    g.add(mesh);
  };
  const flat = (text: string, px: number, py: number, w: number, h: number, font: string, fg: string, y = 0.04) => {
    const mesh = label(text, w, h, font, fg);
    mesh.rotation.x = -Math.PI / 2;
    const [x, z] = toWorld(px, py);
    mesh.position.set(x, y, z);
    g.add(mesh);
  };

  // pisos: eletrônica (salmão), produção (azul), estoque (branco)
  floor([[22, 20], [165, 20], [165, 430], [22, 430]], '#c98a84');
  floor([[165, 20], [510, 20], [510, 867], [165, 867]], '#6fa3d6');
  floor([[510, 20], [680, 20], [603, 763], [510, 763]], '#d3dae4');

  // paredes (com vãos nas portas e na passagem)
  const WALL = '#9aa4b2';
  const wall = (x1: number, y1: number, x2: number, y2: number) => seg(x1, y1, x2, y2, 0.7, WALL, 0.12);
  wall(22, 20, 680, 20);
  wall(680, 20, 619.8, 601); wall(609.5, 700, 603, 763);
  wall(603, 763, 510, 763);
  wall(510, 20, 510, 455); wall(510, 553, 510, 867);
  wall(510, 867, 165, 867);
  wall(165, 430, 165, 523); wall(165, 595, 165, 867);
  wall(165, 20, 165, 340); wall(165, 412, 165, 430);
  wall(22, 430, 165, 430);
  wall(22, 20, 22, 168); wall(22, 267, 22, 430);

  // portas pretas, porta laranja (saída para o exterior) e passagem cinza (sem porta)
  const DOOR = '#15181d';
  seg(22, 168, 22, 267, 1.0, DOOR, 0.22);
  seg(165, 523, 165, 595, 1.0, DOOR, 0.22);
  seg(510, 455, 510, 553, 1.0, DOOR, 0.22);
  seg(619.8, 601, 609.5, 700, 1.0, '#ff9a3d', 0.24);
  seg(165, 340, 165, 412, 0.05, '#7d8794', 0.4);

  TABLES.forEach((rect) => box(rect, 0.75, '#3fb865'));
  CHAIRS.forEach(([px, py]) => {
    const chair = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.5, 20), lam('#1b1f26'));
    const [x, z] = toWorld(px, py);
    chair.position.set(x, 0.25, z);
    g.add(chair);
  });

  flat('ELETRÔNICA', 118, 235, 3.2, 0.5, 'bold 44px system-ui', '#3b1512');
  flat('PRODUÇÃO', 337, 400, 4.2, 0.6, 'bold 56px system-ui', '#0d2a47');
  flat('MESA DE PRODUÇÃO', 337, 202, 4.6, 0.5, 'bold 40px system-ui', '#06260f', 0.78);
  flat('DIRETORIA / EXECUTIVOS', 330, 500, 6.4, 0.6, 'bold 40px system-ui', '#0d2a47');
  flat('ESTOQUE', 610, 300, 3, 0.6, 'bold 56px system-ui', '#1c2533');
  flat('ESTOQUE EXTRA', 194.5, 12, 3.2, 0.5, 'bold 36px system-ui', '#e8eef7', 0.05);
  flat('ESTOQUE EXTRA', 487.5, 12, 3.2, 0.5, 'bold 36px system-ui', '#e8eef7', 0.05);
  return g;
}
