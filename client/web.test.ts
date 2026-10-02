import { afterEach, expect, it, vi } from "vitest";
import {
  clampZoom,
  kitchenStations,
  stageForRole,
  stationPosition,
  travelDuration,
  travelPosition,
} from "./kitchen-stations.js";
import { mountOffice, type OfficePalette } from "./web.js";

const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react-native", () => ({ Platform: platform }));
const palette: OfficePalette = {
  background: "#202020",
  surface: "#303030",
  foreground: "#eeeeee",
  muted: "#aaaaaa",
  accent: "#44aa88",
  danger: "#ee5555",
  border: "#444444",
};
afterEach(() => {
  platform.OS = "android";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("evaluates Three and returns native map without touching DOM globals", () => {
  vi.stubGlobal("document", undefined);
  vi.stubGlobal("window", undefined);
  vi.stubGlobal("ResizeObserver", undefined);
  expect(mountOffice(null, palette, vi.fn(), vi.fn())).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("Native map"),
  });
});

it("returns a usable fallback when the web host cannot attach a canvas", () => {
  platform.OS = "web";
  vi.stubGlobal("document", undefined);
  expect(mountOffice({}, palette, vi.fn(), vi.fn())).toMatchObject({ status: "unavailable" });
});

it("preflights unavailable WebGL2 without renderer errors and removes the unattached canvas", () => {
  platform.OS = "web";
  const canvas = {
    getContext: vi.fn(() => null),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
    setAttribute: vi.fn(),
    style: {},
  };
  vi.stubGlobal("document", { createElement: () => canvas });
  vi.stubGlobal("ResizeObserver", vi.fn());
  const error = vi.spyOn(console, "error");
  const host = { appendChild: vi.fn() };
  expect(mountOffice(host, palette, vi.fn(), vi.fn())).toEqual({
    status: "unavailable",
    reason: "WebGL2 is unavailable. Native map and Stages remain available.",
  });
  expect(canvas.remove).toHaveBeenCalledOnce();
  expect(canvas.getContext).toHaveBeenCalledExactlyOnceWith("webgl2", {
    antialias: true,
    alpha: false,
  });
  expect(error).not.toHaveBeenCalled();
  expect(host.appendChild).not.toHaveBeenCalled();
});

it("keeps seven stable stages while mapping actual role transitions and bounded motion", () => {
  expect(kitchenStations.map((station) => station.id)).toEqual([
    "head",
    "plan",
    "build",
    "review",
    "verify",
    "integrate",
    "final",
  ]);
  expect(stageForRole("Verifier", "verify", true)).toBe("final");
  expect(stageForRole("Verifier", "verify", false)).toBe("verify");
  expect(stageForRole("Integrator", "implement")).toBe("integrate");
  expect(stageForRole("Integrator", "integrate")).toBe("integrate");
  const from = stationPosition("build");
  const to = stationPosition("review");
  expect(travelPosition(from, to, 0, false)).toEqual(from);
  expect(travelPosition(from, to, 1, false)).toEqual(to);
  expect(travelPosition(from, to, 0.2, true)).toEqual(to);
  expect(travelDuration(0)).toBe(400);
  expect(travelDuration(100)).toBe(900);
  expect([clampZoom(20), clampZoom(250)]).toEqual([60, 180]);
});
