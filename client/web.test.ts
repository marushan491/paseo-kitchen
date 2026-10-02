import { afterEach, expect, it, vi } from "vitest";
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

it("evaluates Three and returns native role view without touching DOM globals", () => {
  vi.stubGlobal("document", undefined);
  vi.stubGlobal("window", undefined);
  vi.stubGlobal("ResizeObserver", undefined);
  expect(mountOffice(null, palette, vi.fn(), vi.fn())).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("Role view"),
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
    reason: "WebGL2 is unavailable. Role view is active.",
  });
  expect(canvas.remove).toHaveBeenCalledOnce();
  expect(canvas.getContext).toHaveBeenCalledExactlyOnceWith("webgl2", {
    antialias: true,
    alpha: false,
  });
  expect(error).not.toHaveBeenCalled();
  expect(host.appendChild).not.toHaveBeenCalled();
});
