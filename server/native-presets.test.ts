import { describe, it, expect } from "vitest";
import { PackRegistry, kitchenPack } from "./pack.js";
import { definitionFromPack } from "./workflow-definitions.js";
import { headChefConfig, nativePresets } from "./native-presets.js";

describe("native team presets", () => {
  it("presents actual delivery packs and keeps satellite packs out of the picker", () => {
    const result = nativePresets(new PackRegistry().list(), [], {});
    expect(result.defaultPresetId).toBe("kitchen");
    expect(result.presets.map((preset) => [preset.id, preset.title])).toEqual([
      ["kitchen", "Standard team"],
      ["software-basic", "Basic team"],
    ]);
  });
  it("offers real configured project teams and saved variants with exact defaults", () => {
    const project = { ...kitchenPack, id: "project-delivery", title: "Project delivery" };
    const variant = { ...definitionFromPack(kitchenPack, "custom-delivery"), revision: 2 };
    const packs = [...new PackRegistry().list(), project];
    expect(nativePresets(packs, [variant], { workflowPack: project.id }).defaultPresetId).toBe(
      project.id,
    );
    expect(
      nativePresets(packs, [variant], { workflowId: variant.id }).presets.some(
        (entry) => entry.id === variant.id,
      ),
    ).toBe(true);
    expect(nativePresets(packs, [variant], { workflowId: variant.id }).defaultPresetId).toBe(
      variant.id,
    );
  });
  it("keeps an unavailable project default explicit instead of silently falling back", () => {
    const result = nativePresets(new PackRegistry().list(), [], {
      workflowPack: "missing-delivery",
    });
    expect(result.defaultPresetId).toBe("missing-delivery");
    expect(result.unavailableReason).toContain("unavailable");
    expect(result.presets.some((entry) => entry.id === "missing-delivery")).toBe(false);
    expect(nativePresets([], [], {}).unavailableReason).toBeDefined();
    const stale = {
      ...definitionFromPack(kitchenPack, "stale-team"),
      revision: 1,
      basePackVersion: kitchenPack.version + 1,
    };
    expect(
      nativePresets(new PackRegistry().list(), [stale], { workflowId: stale.id }).unavailableReason,
    ).toBeDefined();
    expect(
      nativePresets(new PackRegistry().list(), [stale], {}).presets.some(
        (value) => value.id === stale.id,
      ),
    ).toBe(false);
  });
  it("preserves inherited permissions and options while applying Head Chef preferences", () => {
    const config = {
      provider: "codex-plus/model-a",
      modeId: "full-access",
      options: { custom: true },
    };
    expect(headChefConfig(config, { model: "model-b" })).toEqual({
      ...config,
      provider: "codex-plus/model-b",
    });
    expect(headChefConfig(config, { provider: "claude" }).provider).toBe("claude");
    expect(headChefConfig(config, undefined)).toBe(config);
  });
});
