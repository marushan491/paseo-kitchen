import { Platform } from "react-native";
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
  PointLight,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { officePosition, officeToneColor, type OfficeDesk } from "./office-model.js";
import { clampZoom, travelDuration, travelPosition } from "./kitchen-stations.js";
import { createKitchen, createPanda, disposeKitchen } from "./kitchen-scene.js";

interface Input {
  clientX: number;
  clientY: number;
  pointerId?: number;
  deltaX?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  key?: string;
  preventDefault(): void;
}
interface Canvas {
  style: { width: string; height: string; display: string; touchAction: string; cursor: string };
  getContext(kind: "webgl2", attributes: { antialias: boolean; alpha: boolean }): unknown;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  addEventListener(
    name: string,
    listener: (event: Input) => void,
    options?: { passive: boolean },
  ): void;
  removeEventListener(name: string, listener: (event: Input) => void): void;
  setAttribute(name: string, value: string): void;
  remove(): void;
}
interface Container {
  clientWidth: number;
  clientHeight: number;
  appendChild(canvas: Canvas): void;
}
declare const document: { createElement(tag: "canvas"): Canvas };
declare const window: {
  devicePixelRatio: number;
  matchMedia?(query: string): { matches: boolean };
};
declare const ResizeObserver: new (callback: () => void) => {
  observe(container: Container): void;
  disconnect(): void;
};
declare function requestAnimationFrame(callback: () => void): number;
declare function cancelAnimationFrame(id: number): void;
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
  zoomTo(percent: number): void;
  fit(): void;
  dispose(): void;
}
export type OfficeMountResult =
  | { status: "ready"; renderer: OfficeRenderer }
  | { status: "unavailable"; reason: string };
interface Traveller {
  group: Group;
  from: { x: number; z: number };
  to: { x: number; z: number };
  started: number;
  duration: number;
}

export function mountOffice(
  target: unknown,
  palette: OfficePalette,
  onSelect: (id: string) => void,
  onUnavailable: (reason: string) => void,
  onZoom: (percent: number) => void = () => {},
): OfficeMountResult {
  if (Platform.OS !== "web")
    return {
      status: "unavailable",
      reason: "3D is available on web and desktop. Native map and Stages remain available.",
    };
  const container = target as Container | null;
  if (
    !container ||
    typeof container.appendChild !== "function" ||
    typeof document === "undefined" ||
    typeof ResizeObserver === "undefined"
  )
    return {
      status: "unavailable",
      reason: "The 3D canvas could not be attached. Native map and Stages remain available.",
    };
  const canvas = document.createElement("canvas");
  let renderer: WebGLRenderer;
  try {
    const context = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!context) {
      canvas.remove();
      return {
        status: "unavailable",
        reason: "WebGL2 is unavailable. Native map and Stages remain available.",
      };
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
    return {
      status: "unavailable",
      reason: "WebGL2 is unavailable. Native map and Stages remain available.",
    };
  }
  return {
    status: "ready",
    renderer: new KitchenViewport(
      container,
      canvas,
      renderer,
      palette,
      onSelect,
      onUnavailable,
      onZoom,
    ),
  };
}
class KitchenViewport implements OfficeRenderer {
  private scene = new Scene();
  private camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  private ray = new Raycaster();
  private pointer = new Vector2();
  private target = new Vector3(0, 0, 1);
  private room: ReturnType<typeof createKitchen>;
  private travellers = new Map<string, Traveller>();
  private observer: InstanceType<typeof ResizeObserver>;
  private disposed = false;
  private percent = 100;
  private span = 8;
  private frame: number | null = null;
  private fingers = new Map<number, { x: number; y: number }>();
  private previousDistance = 0;
  private dragDistance = 0;
  private ignoreClick = false;
  private reduced = Boolean(
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  constructor(
    private container: Container,
    private canvas: Canvas,
    private renderer: WebGLRenderer,
    private palette: OfficePalette,
    private onSelect: (id: string) => void,
    private onUnavailable: (reason: string) => void,
    private onZoom: (percent: number) => void,
  ) {
    this.scene.background = new Color(palette.background);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.scene.add(new AmbientLight(0xd8e0ef, 1.2));
    const light = new DirectionalLight(0xfff2df, 3);
    light.position.set(4, 12, 7);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.left = -12;
    light.shadow.camera.right = 12;
    light.shadow.camera.top = 12;
    light.shadow.camera.bottom = -12;
    light.shadow.bias = -0.002;
    this.scene.add(light);
    for (const x of [-4, 0, 4]) {
      const warm = new PointLight(0xffcb82, 8, 8, 2);
      warm.position.set(x, 2.1, -6.2);
      this.scene.add(warm);
    }
    this.room = createKitchen(palette);
    this.scene.add(this.room.room);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";
    canvas.setAttribute(
      "aria-label",
      "Interactive Kitchen map. Drag to pan, wheel or pinch to zoom. Use Stages for keyboard station selection.",
    );
    canvas.setAttribute("role", "img");
    canvas.setAttribute("tabindex", "0");
    container.appendChild(canvas);
    this.camera.position.set(13, 18, 19);
    this.camera.lookAt(this.target);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    canvas.addEventListener("click", this.select);
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.up);
    canvas.addEventListener("pointerleave", this.up);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("keydown", this.key);
    canvas.addEventListener("webglcontextlost", this.lost);
    this.fit();
  }
  private render() {
    if (this.disposed) return;
    try {
      this.renderer.render(this.scene, this.camera);
    } catch {
      this.dispose();
      this.onUnavailable("The 3D renderer stopped. Native map and Stages remain available.");
    }
  }
  private resize() {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth),
      height = Math.max(1, this.container.clientHeight);
    const aspect = width / height;
    const span = (this.span * 100) / this.percent;
    this.camera.left = -span * aspect;
    this.camera.right = span * aspect;
    this.camera.top = span;
    this.camera.bottom = -span;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(width, height, false);
    this.render();
  }
  zoomTo(percent: number) {
    this.percent = clampZoom(percent);
    this.onZoom(this.percent);
    this.resize();
  }
  fit() {
    this.percent = 100;
    this.span = Math.max(
      7.8,
      10 / Math.max(0.5, this.container.clientWidth / Math.max(1, this.container.clientHeight)),
    );
    this.camera.position.set(13, 18, 20);
    this.target.set(0, 0, 1);
    this.camera.lookAt(this.target);
    this.onZoom(100);
    this.resize();
  }
  private pan(dx: number, dy: number) {
    const scale = (this.span * 2 * 100) / this.percent / Math.max(1, this.container.clientHeight);
    const right = new Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const offset = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
    this.camera.position.add(offset);
    this.target.add(offset);
    this.render();
  }
  private down = (event: Input) => {
    this.fingers.set(event.pointerId || 0, { x: event.clientX, y: event.clientY });
    this.dragDistance = 0;
    this.canvas.style.cursor = "grabbing";
  };
  private move = (event: Input) => {
    const id = event.pointerId || 0,
      previous = this.fingers.get(id);
    if (!previous) return;
    const dx = event.clientX - previous.x,
      dy = event.clientY - previous.y;
    this.fingers.set(id, { x: event.clientX, y: event.clientY });
    this.dragDistance += Math.abs(dx) + Math.abs(dy);
    if (this.fingers.size === 2) {
      const [a, b] = [...this.fingers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.previousDistance) this.zoomTo((this.percent * distance) / this.previousDistance);
      this.previousDistance = distance;
    } else this.pan(dx, dy);
  };
  private up = () => {
    this.fingers.clear();
    this.previousDistance = 0;
    this.ignoreClick = this.dragDistance > 5;
    this.canvas.style.cursor = "grab";
  };
  private wheel = (event: Input) => {
    event.preventDefault();
    if (event.shiftKey || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY || 0))
      this.pan(event.deltaX || 0, event.deltaY || 0);
    else this.zoomTo(this.percent * Math.exp(-(event.deltaY || 0) * 0.002));
  };
  private key = (event: Input) => {
    const key = event.key;
    if (key === "+" || key === "=") this.zoomTo(this.percent + 10);
    else if (key === "-") this.zoomTo(this.percent - 10);
    else if (key === "0") this.fit();
    else if (key?.startsWith("Arrow")) {
      event.preventDefault();
      this.pan(
        ({ ArrowLeft: 30, ArrowRight: -30 } as Record<string, number>)[key] ?? 0,
        ({ ArrowUp: 30, ArrowDown: -30 } as Record<string, number>)[key] ?? 0,
      );
    }
  };
  private select = (event: Input) => {
    if (this.ignoreClick) {
      this.ignoreClick = false;
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
      (-(event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1,
    );
    this.ray.setFromCamera(this.pointer, this.camera);
    for (const hit of this.ray.intersectObjects(this.scene.children, true)) {
      let object = hit.object;
      while (object.parent && !object.userData.selectionId) object = object.parent;
      if (typeof object.userData.selectionId === "string") {
        this.onSelect(object.userData.selectionId);
        return;
      }
    }
  };
  private lost = () => {
    this.dispose();
    this.onUnavailable("WebGL context was lost. Native map and Stages remain available.");
  };
  update(desks: readonly OfficeDesk[], selectedId: string | null, palette: OfficePalette) {
    if (this.disposed) return;
    this.palette = palette;
    const desired = new Set(desks.map((desk) => desk.agentId));
    for (const [id, traveller] of this.travellers)
      if (!desired.has(id)) {
        disposeKitchen(traveller.group);
        this.travellers.delete(id);
      }
    desks.forEach((desk, index) => this.updateTraveller(desk, index));
    for (const [id, ring] of this.room.stations) {
      const material = ring.material as MeshStandardMaterial;
      const selected =
        selectedId === `station:${id}` ||
        desks.some((desk) => desk.stationId === id && selectedId === `agent:${desk.agentId}`);
      const working = desks.some((desk) => desk.stationId === id && desk.tone === "active");
      const attention = desks.some((desk) => desk.stationId === id && desk.tone === "attention");
      const color = attention ? palette.danger : palette.accent;
      material.color.set(selected || working || attention ? color : palette.border);
      material.emissive.set(selected || working || attention ? color : "#000000");
      material.emissiveIntensity = selected ? 0.7 : 0.25;
    }
    this.render();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.animate();
  }
  private updateTraveller(desk: OfficeDesk, index: number) {
    const to = officePosition(desk);
    let traveller = this.travellers.get(desk.agentId);
    if (!traveller) {
      const group = createPanda(officeToneColor(desk.tone, this.palette));
      group.userData.selectionId = `agent:${desk.agentId}`;
      group.position.set(to.x, 0, to.z);
      this.scene.add(group);
      traveller = { group, from: to, to, started: 0, duration: 0 };
      this.travellers.set(desk.agentId, traveller);
      return;
    }
    traveller.group.traverse((object) => {
      if (!object.userData.apron) return;
      const material = (object as import("three").Mesh).material as MeshStandardMaterial;
      material.color.set(officeToneColor(desk.tone, this.palette));
    });
    if (traveller.to.x === to.x && traveller.to.z === to.z) return;
    traveller.from = { x: traveller.group.position.x, z: traveller.group.position.z };
    traveller.to = to;
    traveller.started = Date.now() + (index % 6) * 100;
    traveller.duration = this.reduced
      ? 0
      : travelDuration(Math.hypot(to.x - traveller.from.x, to.z - traveller.from.z));
  }
  private animate = () => {
    this.frame = null;
    if (this.disposed) return;
    let moving = false;
    const now = Date.now();
    for (const value of this.travellers.values()) {
      const progress = value.duration ? Math.max(0, (now - value.started) / value.duration) : 1;
      const point = travelPosition(value.from, value.to, progress, this.reduced);
      value.group.position.set(point.x, 0, point.z);
      if (progress < 1) moving = true;
    }
    this.render();
    if (moving) this.frame = requestAnimationFrame(this.animate);
  };
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    for (const [name, listener] of Object.entries({
      click: this.select,
      pointerdown: this.down,
      pointermove: this.move,
      pointerup: this.up,
      pointercancel: this.up,
      pointerleave: this.up,
      wheel: this.wheel,
      keydown: this.key,
      webglcontextlost: this.lost,
    }))
      this.canvas.removeEventListener(name, listener);
    disposeKitchen(this.room.room);
    for (const traveller of this.travellers.values()) disposeKitchen(traveller.group);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
