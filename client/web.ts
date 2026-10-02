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
import { officeToneColor, type OfficeDesk } from "./office-model.js";

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
    "Kitchen 3D. Select an agent station, or use the accessible role list below.",
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
    context.font = "600 48px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text.slice(0, 38), 384, 48);
    const map = new CanvasTexture(
      image as unknown as ConstructorParameters<typeof CanvasTexture>[0],
    );
    const sprite = new Sprite(new SpriteMaterial({ map, transparent: true, depthTest: false }));
    sprite.position.set(x, y, z);
    sprite.scale.set(3.2, 0.5, 1);
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
        const stationRoles = ["Head Chef", "po", "developer", "reviewer", "verifier", "integrator"];
        const stations = desks.length
          ? desks
          : stationRoles.map((role) => ({
              role,
              title: stationTitle(role),
              id: "",
              tone: "unknown" as const,
            }));
        const columns = Math.min(3, Math.max(1, stations.length));
        const rows = Math.ceil(stations.length / columns);
        const width = columns * 3.4;
        const depth = rows * 4.2;
        const centerFloorX = width / 2 - 1.7;
        const centerFloorZ = depth / 2 - 2.1;
        box(
          objects,
          colors.border,
          [width + 2, 0.18, depth + 2],
          [centerFloorX, -0.1, centerFloorZ],
        );
        for (let col = 0; col < columns * 3 + 2; col++) {
          for (let row = 0; row < rows * 4 + 2; row++) {
            box(
              objects,
              (col + row) % 2 ? colors.surface : colors.border,
              [1.04, 0.02, 1.04],
              [col * 1.1 - 2.1, 0.01, row * 1.05 - 2.6],
            );
          }
        }
        box(objects, colors.surface, [width + 2, 2.7, 0.14], [centerFloorX, 1.3, -3.15]);
        box(objects, colors.surface, [0.14, 2.7, depth + 2], [-2.8, 1.3, centerFloorZ]);
        for (let i = 0; i < stations.length; i++) {
          const desk = stations[i]!;
          const x = (i % columns) * 3.4;
          const z = Math.floor(i / columns) * 4.2;
          const group = new Group();
          group.position.set(x, 0, z);
          if (desk.id) group.userData.deskId = desk.id;
          objects.add(group);
          const statusColor = officeToneColor(desk.tone, colors);
          box(
            group,
            desk.id === selectedId ? colors.accent : colors.border,
            [2.6, 0.12, 2.65],
            [0, 0.08, 0],
          );
          box(group, colors.surface, [2.25, 0.85, 1.1], [0, 0.5, -0.4]);
          box(group, "#9ba4ab", [2.35, 0.12, 1.18], [0, 0.98, -0.4]);
          box(group, colors.border, [0.03, 0.6, 0.02], [0, 0.5, 0.16]);
          box(group, "#9ba4ab", [0.35, 0.06, 0.05], [-0.5, 0.68, 0.2]);
          box(group, "#9ba4ab", [0.35, 0.06, 0.05], [0.5, 0.68, 0.2]);
          const role = desk.role.toLowerCase();
          if (role === "developer" || role === "integrator") {
            box(group, "#26313a", [1.3, 0.04, 0.9], [0, 1.06, -0.4]);
            for (const burnerX of [-0.34, 0.34]) {
              const burner = new Mesh(
                new CylinderGeometry(0.24, 0.24, 0.03, 24),
                new MeshStandardMaterial({ color: "#627079" }),
              );
              burner.position.set(burnerX, 1.1, -0.45);
              group.add(burner);
            }
            const pot = new Mesh(
              new CylinderGeometry(0.26, 0.24, 0.28, 24),
              new MeshStandardMaterial({ color: "#bcc5cb", metalness: 0.5, roughness: 0.3 }),
            );
            pot.position.set(-0.34, 1.25, -0.45);
            group.add(pot);
            box(group, "#9ba4ab", [1.65, 0.16, 0.9], [0, 2.35, -0.4]);
            box(group, colors.border, [0.6, 0.5, 0.45], [0, 2.67, -0.6]);
          } else if (role === "verifier" || role === "tester") {
            box(group, "#42505c", [1.0, 0.03, 0.72], [0, 1.07, -0.4]);
            box(group, "#d4dde3", [0.1, 0.45, 0.1], [0.5, 1.28, -0.78]);
            box(group, "#d4dde3", [0.35, 0.08, 0.1], [0.35, 1.5, -0.78]);
          } else if (role === "reviewer") {
            for (const plateX of [-0.5, 0.15, 0.7]) {
              const plate = new Mesh(
                new CylinderGeometry(0.24, 0.2, 0.04, 24),
                new MeshStandardMaterial({ color: "#eceee8" }),
              );
              plate.position.set(plateX, 1.09, -0.4);
              group.add(plate);
            }
          } else {
            box(group, "#ad8060", [1.25, 0.05, 0.7], [0, 1.07, -0.4]);
            box(group, "#dde1d4", [0.3, 0.04, 0.3], [-0.3, 1.12, -0.4]);
            box(group, colors.border, [1.6, 0.75, 0.08], [0, 1.8, -1]);
            for (const ticketX of [-0.45, 0, 0.45])
              box(group, "#e8e5d8", [0.28, 0.45, 0.03], [ticketX, 1.8, -0.94]);
          }
          if (desk.id) {
            const body = new Mesh(
              new CylinderGeometry(0.22, 0.3, 0.65, 12),
              new MeshStandardMaterial({ color: statusColor }),
            );
            body.position.set(0, 0.75, 0.7);
            group.add(body);
            const head = new Mesh(
              new SphereGeometry(0.22, 16, 12),
              new MeshStandardMaterial({ color: "#dbc4ac" }),
            );
            head.position.set(0, 1.3, 0.7);
            group.add(head);
            const hat = new Mesh(
              new CylinderGeometry(0.27, 0.22, 0.3, 16),
              new MeshStandardMaterial({ color: "#f0efe9" }),
            );
            hat.position.set(0, 1.6, 0.7);
            group.add(hat);
            for (const legX of [-0.15, 0.15])
              box(group, colors.border, [0.16, 0.4, 0.18], [legX, 0.32, 0.7]);
          }
          label(group, stationTitle(desk.role), 0, 0.2, 1.55, colors.foreground);
        }
        const centerX = width / 2 - 1.7;
        const centerZ = depth / 2 - 2.1;
        camera.position.set(centerX + 14, 20, centerZ + 20);
        camera.lookAt(centerX, 0, centerZ);
        span = Math.max(6, (width + depth) * 0.32);
        resize();
      },
      dispose,
    },
  };
}

function stationTitle(role: string) {
  return (
    (
      {
        "Head Chef": "Head Chef · Coordination",
        po: "Prep · Planning",
        developer: "Stove · Build",
        reviewer: "Plating · Review",
        verifier: "Quality · Verify",
        integrator: "Pass · Integration",
        tester: "Quality · Tests",
      } as Record<string, string>
    )[role] || role
  );
}
