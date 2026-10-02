import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
} from "three";
import { kitchenStations } from "./kitchen-stations.js";
import type { OfficePalette } from "./web.js";

interface LabelCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): {
    fillStyle: string;
    font: string;
    textAlign: string;
    textBaseline: string;
    fillText(text: string, x: number, y: number): void;
    fillRect(x: number, y: number, w: number, h: number): void;
  } | null;
}
declare const document: { createElement(tag: "canvas"): LabelCanvas };
export function kitchenBox(
  group: Group,
  color: string,
  size: [number, number, number],
  position: [number, number, number],
  metalness = 0,
) {
  const mesh = new Mesh(
    new BoxGeometry(...size),
    new MeshStandardMaterial({ color, metalness, roughness: metalness ? 0.32 : 0.7 }),
  );
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}
function cylinder(
  group: Group,
  color: string,
  radius: number,
  height: number,
  x: number,
  y: number,
  z: number,
) {
  const mesh = new Mesh(
    new CylinderGeometry(radius, radius, height, 24),
    new MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.35 }),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  group.add(mesh);
  return mesh;
}
function sphere(group: Group, color: string, radius: number, x: number, y: number, z: number) {
  const mesh = new Mesh(
    new SphereGeometry(radius, 16, 12),
    new MeshStandardMaterial({ color, roughness: 0.65 }),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  group.add(mesh);
  return mesh;
}
function label(group: Group, title: string, subtitle: string, palette: OfficePalette) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = palette.background;
  context.fillRect(0, 0, 640, 160);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = palette.foreground;
  context.font = "600 42px sans-serif";
  context.fillText(title, 320, 55);
  context.fillStyle = palette.muted;
  context.font = "28px sans-serif";
  context.fillText(subtitle, 320, 110);
  const texture = new CanvasTexture(
    canvas as unknown as ConstructorParameters<typeof CanvasTexture>[0],
  );
  const sprite = new Sprite(new SpriteMaterial({ map: texture, depthTest: false }));
  sprite.position.set(0, 0.1, 2);
  sprite.scale.set(2.8, 0.7, 1);
  group.add(sprite);
}
export function createKitchen(palette: OfficePalette) {
  const room = new Group();
  const stations = new Map<string, Mesh>();
  for (let x = -7; x <= 7; x++)
    for (let z = -7; z <= 8; z++)
      kitchenBox(
        room,
        (x + z) % 2 ? palette.surface : palette.border,
        [0.99, 0.08, 0.99],
        [x, -0.08, z],
      );
  kitchenBox(room, palette.surface, [15, 3.5, 0.25], [0, 1.65, -7.3]);
  kitchenBox(room, palette.surface, [0.25, 3.5, 16], [-7.4, 1.65, 0.2]);
  for (let x = -6; x <= 6; x += 2) {
    kitchenBox(room, palette.background, [1.8, 1.0, 0.85], [x, 0.6, -6.6]);
    kitchenBox(room, "#9fa6ac", [1.86, 0.1, 0.9], [x, 1.13, -6.6], 0.7);
    kitchenBox(room, palette.background, [1.8, 0.95, 0.55], [x, 2.7, -6.85]);
    const strip = kitchenBox(room, "#dfb574", [1.55, 0.03, 0.12], [x, 2.17, -6.6]);
    (strip.material as MeshStandardMaterial).emissive.set("#dca15d");
    (strip.material as MeshStandardMaterial).emissiveIntensity = 1.2;
    for (const offset of [-0.55, 0.2, 0.5])
      cylinder(room, offset > 0 ? "#bc8858" : "#708267", 0.1, 0.35, x + offset, 1.35, -6.55);
  }
  for (const station of kitchenStations) {
    const island = new Group();
    island.position.set(station.x, 0, station.z);
    island.userData.selectionId = `station:${station.id}`;
    room.add(island);
    const ring = kitchenBox(island, palette.border, [2.8, 0.06, 2.05], [0, 0.08, -0.1]);
    stations.set(station.id, ring);
    kitchenBox(island, palette.background, [2.45, 0.95, 1.65], [0, 0.57, -0.1]);
    kitchenBox(island, "#acb2b7", [2.65, 0.14, 1.8], [0, 1.12, -0.1], 0.55);
    for (const doorX of [-0.61, 0.61]) {
      kitchenBox(island, palette.surface, [1.13, 0.72, 0.04], [doorX, 0.59, 0.75]);
      kitchenBox(island, "#adb1b2", [0.36, 0.04, 0.06], [doorX, 0.84, 0.8], 0.7);
    }
    stationTools(island, station.id, palette);
    label(island, station.title, station.purpose, palette);
  }
  plant(room, -6, 0, -4);
  plant(room, 6.3, 0, -5.9);
  plant(room, -6, 0, 6.8);
  return { room, stations };
}
function stationTools(group: Group, id: string, palette: OfficePalette) {
  if (id === "build" || id === "integrate") {
    kitchenBox(group, "#25292e", [1.5, 0.05, 1.2], [-0.2, 1.23, -0.12], 0.4);
    for (const x of [-0.58, 0.18])
      for (const z of [-0.42, 0.22]) cylinder(group, "#6c737c", 0.21, 0.03, x, 1.28, z);
    const pot = cylinder(group, "#a9b2b8", 0.26, 0.3, -0.58, 1.43, -0.42);
    pot.userData.cookware = true;
    kitchenBox(group, "#4a5259", [0.45, 0.045, 0.1], [-0.26, 1.45, -0.42], 0.8);
  } else if (id === "review" || id === "final") {
    for (const x of [-0.65, 0, 0.65]) {
      cylinder(group, "#ecece5", 0.27, 0.04, x, 1.24, -0.05);
      sphere(group, "#b68057", 0.13, x, 1.34, -0.05);
    }
    kitchenBox(group, palette.surface, [1.4, 0.2, 0.45], [0, 1.29, -0.68]);
  } else if (id === "verify") {
    kitchenBox(group, "#45515a", [1.2, 0.05, 0.75], [-0.25, 1.24, -0.1], 0.7);
    kitchenBox(group, "#b5bcc2", [0.07, 0.45, 0.07], [0.6, 1.48, -0.65], 0.8);
    kitchenBox(group, "#b5bcc2", [0.35, 0.07, 0.07], [0.46, 1.68, -0.65], 0.8);
  } else {
    kitchenBox(group, "#98734f", [1.3, 0.05, 0.8], [-0.25, 1.25, -0.03]);
    kitchenBox(group, "#ecece5", [0.7, 0.025, 0.5], [-0.25, 1.29, -0.05]);
    for (const x of [-0.4, 0, 0.4])
      kitchenBox(group, "#c7c7b8", [0.25, 0.4, 0.025], [x, 1.6, -0.76]);
  }
  kitchenBox(group, palette.background, [0.85, 0.7, 0.08], [0.5, 1.68, -0.82]);
  kitchenBox(group, palette.accent, [0.7, 0.52, 0.02], [0.5, 1.7, -0.76]);
  plant(group, -0.9, 1.24, -0.56);
}
function plant(group: Group, x: number, y: number, z: number) {
  cylinder(group, "#b9aaa0", 0.16, 0.25, x, y + 0.13, z);
  sphere(group, "#637a50", 0.21, x, y + 0.44, z);
  sphere(group, "#768a58", 0.16, x + 0.12, y + 0.56, z);
}
export function createPanda(color: string) {
  const panda = new Group();
  sphere(panda, "#ecefeb", 0.29, 0, 0.75, 0);
  sphere(panda, "#171c22", 0.14, -0.27, 0.68, 0);
  sphere(panda, "#171c22", 0.14, 0.27, 0.68, 0);
  sphere(panda, "#ecefeb", 0.3, 0, 1.19, 0);
  sphere(panda, "#171c22", 0.12, -0.23, 1.4, 0);
  sphere(panda, "#171c22", 0.12, 0.23, 1.4, 0);
  for (const x of [-0.12, 0.12]) {
    const patch = sphere(panda, "#171c22", 0.095, x, 1.23, 0.265);
    patch.scale.set(0.8, 1.25, 0.35);
    sphere(panda, "#e6eced", 0.026, x, 1.25, 0.296);
    sphere(panda, "#171c22", 0.12, x, 0.32, 0);
  }
  sphere(panda, "#171c22", 0.045, 0, 1.13, 0.3);
  const apron = kitchenBox(panda, color, [0.32, 0.37, 0.1], [0, 0.76, 0.24]);
  apron.userData.apron = true;
  cylinder(panda, "#fbfcf7", 0.26, 0.16, 0, 1.57, 0);
  for (const x of [-0.17, 0, 0.17]) sphere(panda, "#fbfcf7", 0.16, x, 1.77, 0);
  return panda;
}
export function disposeKitchen(group: Group) {
  group.traverse((object) => {
    if (object instanceof Mesh) object.geometry.dispose();
    if (object instanceof Mesh || object instanceof Sprite) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material instanceof SpriteMaterial) material.map?.dispose();
        material.dispose();
      }
    }
  });
  group.removeFromParent();
}
