import { Platform } from "react-native";
import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  WebGLRenderer,
} from "three";
import { officePosition, officeToneColor, type OfficeDesk } from "./office-model.js";

interface Pointer {
  clientX: number;
  clientY: number;
}
interface TextContext {
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillText(text: string, x: number, y: number): void;
}
interface Canvas {
  width: number;
  height: number;
  style: { width: string; height: string; display: string; touchAction: string };
  getContext(kind: "2d"): TextContext | null;
  getContext(kind: "webgl2", attributes: { antialias: boolean; alpha: boolean }): unknown;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  addEventListener(name: string, listener: (event: Pointer) => void): void;
  removeEventListener(name: string, listener: (event: Pointer) => void): void;
  setAttribute(name: string, value: string): void;
  remove(): void;
}
interface Container {
  clientWidth: number;
  clientHeight: number;
  appendChild(canvas: Canvas): void;
}
declare const document: { createElement(tag: "canvas"): Canvas };
declare const window: { devicePixelRatio: number };
declare const ResizeObserver: new (callback: () => void) => {
  observe(container: Container): void;
  disconnect(): void;
};

export interface OfficePalette {
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  accent: string;
  danger: string;
  border: string;
}

export interface OfficeRenderer {
  update(desks: readonly OfficeDesk[], selectedId: string | null, palette: OfficePalette): void;
  dispose(): void;
}

export type OfficeMountResult =
  | { status: "ready"; renderer: OfficeRenderer }
  | { status: "unavailable"; reason: string };

export function mountOffice(
  target: unknown,
  palette: OfficePalette,
  onSelect: (id: string) => void,
  onUnavailable: (reason: string) => void,
): OfficeMountResult {
  if (Platform.OS !== "web")
    return {
      status: "unavailable",
      reason: "3D is available on web and desktop. Role view is active.",
    };
  const container = target as Container | null;
  if (!container || typeof container.appendChild !== "function")
    return {
      status: "unavailable",
      reason: "The 3D canvas could not be attached. Role view is active.",
    };
  if (typeof document === "undefined" || typeof ResizeObserver === "undefined")
    return {
      status: "unavailable",
      reason: "This client cannot host the 3D canvas. Role view is active.",
    };
  let renderer: WebGLRenderer;
  const canvas = document.createElement("canvas");
  try {
    const context = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!context) {
      canvas.remove();
      return { status: "unavailable", reason: "WebGL2 is unavailable. Role view is active." };
    }
    renderer = new WebGLRenderer({
      canvas: canvas as unknown as NonNullable<
        ConstructorParameters<typeof WebGLRenderer>[0]
      >["canvas"],
      context: context as NonNullable<ConstructorParameters<typeof WebGLRenderer>[0]>["context"],
      antialias: true,
      alpha: false,
    });
  } catch {
    canvas.remove();
    return { status: "unavailable", reason: "WebGL2 is unavailable. Role view is active." };
  }
  const scene = new Scene();
  scene.background = new Color(palette.background);
  const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 300);
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let objects = new Group();
  let disposed = false;
  let span = 10;
  scene.add(new AmbientLight(0xffffff, 2.2));
  const light = new DirectionalLight(0xffffff, 3);
  light.position.set(6, 15, 8);
  scene.add(light, objects);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.touchAction = "pan-y";
  canvas.setAttribute(
    "aria-label",
    "Kitchen 3D office. Select a desk, or use the agent list below.",
  );
  canvas.setAttribute("role", "img");
  container.appendChild(canvas);

  function render() {
    if (disposed) return;
    try {
      renderer.render(scene, camera);
    } catch {
      dispose();
      onUnavailable("The 3D renderer stopped. Role view is active.");
    }
  }
  function resize() {
    if (disposed) return;
    const width = Math.max(1, container!.clientWidth);
    const height = Math.max(1, container!.clientHeight);
    const aspect = width / height;
    camera.left = -span * aspect;
    camera.right = span * aspect;
    camera.top = span;
    camera.bottom = -span;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(width, height, false);
    render();
  }
  function select(event: Pointer) {
    if (disposed) return;
    const bounds = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
      -((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObjects(objects.children, true)) {
      let object = hit.object;
      while (object.parent && !object.userData.deskId) object = object.parent;
      if (typeof object.userData.deskId === "string") {
        onSelect(object.userData.deskId);
        break;
      }
    }
  }
  const contextLost = () => {
    dispose();
    onUnavailable("WebGL context was lost. Role view is active.");
  };
  canvas.addEventListener("click", select);
  canvas.addEventListener("webglcontextlost", contextLost);
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  function releaseObjects() {
    objects.traverse((object) => {
      if (object instanceof Mesh) object.geometry.dispose();
      if (object instanceof Mesh || object instanceof Sprite) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material instanceof SpriteMaterial) material.map?.dispose();
          material.dispose();
        }
      }
    });
    scene.remove(objects);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    canvas.removeEventListener("click", select);
    canvas.removeEventListener("webglcontextlost", contextLost);
    releaseObjects();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }
  function box(
    group: Group,
    color: string,
    size: [number, number, number],
    position: [number, number, number],
  ) {
    const mesh = new Mesh(
      new BoxGeometry(...size),
      new MeshStandardMaterial({ color, roughness: 0.85 }),
    );
    mesh.position.set(...position);
    group.add(mesh);
  }
  function label(group: Group, text: string, x: number, y: number, z: number, color: string) {
    const image = document.createElement("canvas");
    image.width = 768;
    image.height = 96;
    const context = image.getContext("2d");
    if (!context) return;
    context.fillStyle = color;
    context.font = "600 32px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text.slice(0, 38), 384, 48);
    const map = new CanvasTexture(
      image as unknown as ConstructorParameters<typeof CanvasTexture>[0],
    );
    const sprite = new Sprite(new SpriteMaterial({ map, transparent: true, depthTest: false }));
    sprite.position.set(x, y, z);
    sprite.scale.set(3.2, 0.4, 1);
    group.add(sprite);
  }
  return {
    status: "ready",
    renderer: {
      update(desks, selectedId, colors) {
        if (disposed) return;
        releaseObjects();
        objects = new Group();
        scene.add(objects);
        scene.background = new Color(colors.background);
        const width = Math.max(1, ...desks.map((desk) => desk.seat + 1)) * 3.4;
        const depth = Math.max(1, ...desks.map((desk) => desk.lane + 1)) * 4.2;
        box(
          objects,
          colors.surface,
          [width + 2, 0.18, depth + 2],
          [width / 2 - 1.7, -0.1, depth / 2 - 2.1],
        );
        const lanes = new Set<number>();
        for (const desk of desks) {
          const { x, z } = officePosition(desk);
          if (!lanes.has(desk.lane)) {
            lanes.add(desk.lane);
            label(objects, desk.role, width / 2 - 1.7, 0.25, z - 1.8, colors.muted);
          }
          const group = new Group();
          group.position.set(x, 0, z);
          group.userData.deskId = desk.id;
          objects.add(group);
          const statusColor = officeToneColor(desk.tone, colors);
          box(
            group,
            desk.id === selectedId ? colors.accent : colors.border,
            [2.5, 0.14, 2.3],
            [0, 0, 0],
          );
          box(group, colors.surface, [2.1, 0.18, 1], [0, 0.95, -0.25]);
          box(group, colors.border, [0.13, 0.9, 0.13], [-0.85, 0.45, -0.5]);
          box(group, colors.border, [0.13, 0.9, 0.13], [0.85, 0.45, -0.5]);
          box(group, colors.foreground, [0.85, 0.6, 0.1], [0, 1.37, -0.5]);
          box(group, statusColor, [0.7, 0.44, 0.03], [0, 1.37, -0.43]);
          const body = new Mesh(
            new CylinderGeometry(0.22, 0.3, 0.72, 10),
            new MeshStandardMaterial({ color: statusColor }),
          );
          body.position.set(0, 0.7, 0.7);
          group.add(body);
          const head = new Mesh(
            new SphereGeometry(0.24, 12, 8),
            new MeshStandardMaterial({ color: colors.foreground }),
          );
          head.position.set(0, 1.3, 0.7);
          group.add(head);
          label(group, desk.title, 0, 2, 0, colors.foreground);
        }
        const centerX = width / 2 - 1.7;
        const centerZ = depth / 2 - 2.1;
        camera.position.set(centerX + 14, 20, centerZ + 20);
        camera.lookAt(centerX, 0, centerZ);
        span = Math.max(5, (width + depth) * 0.38);
        resize();
      },
      dispose,
    },
  };
}
