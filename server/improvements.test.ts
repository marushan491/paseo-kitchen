import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ImprovementLoop } from "./improvements.js";
import { TeamStore } from "./store.js";
import { kitchenPack } from "./pack.js";
import { createTeamState } from "./engine.js";
import type { TeamService } from "./service.js";

it("executes only enabled bounded rules from recorded events and preserves kickoff identity across recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitchen-loop-"));
  try {
    const store = new TeamStore(join(root, "teams"));
    const { state } = createTeamState({
      pack: kitchenPack,
      title: "Source",
      objective: "Check",
      cwd: "/repo",
      bossAgentId: "boss",
      roleProfiles: {},
    });
    state.team.status = "done";
    await store.create(state, [
      {
        type: "decision.failed",
        actor: { type: "runtime", id: "runtime" },
        text: "Real recorded failure",
      },
    ]);
    const startKitchen = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary unavailable"))
      .mockResolvedValue(state);
    const service = { store, startKitchen } as unknown as Pick<
      TeamService,
      "store" | "startKitchen"
    >;
    const loop = new ImprovementLoop(root, service, () => new Date("2026-10-02T12:00:00Z"));
    const rule = {
      id: "repair",
      name: "Repair repeated checks",
      enabled: false,
      sourcePackIds: ["kitchen"],
      eventTypes: ["decision.failed"],
      minOccurrences: 1,
      cooldownMs: 60_000,
      maxRuns: 1,
      target: {
        title: "Repair",
        objective: "Repair the check within this repository",
        cwd: "/repo",
        provider: "codex",
        acceptanceCriteria: [{ id: "check", text: "Independent check passes" }],
      },
    };
    await loop.save(rule);
    await loop.scan();
    expect(startKitchen).not.toHaveBeenCalled();
    await loop.save({ ...rule, enabled: true });
    expect((await loop.scan()).errors).toHaveLength(1);
    const recovered = new ImprovementLoop(root, service, () => new Date("2026-10-02T12:02:00Z"));
    expect((await recovered.scan()).started).toEqual([state.team.id]);
    expect(startKitchen.mock.calls[0]![0].idempotencyKey).toBe(
      startKitchen.mock.calls[1]![0].idempotencyKey,
    );
    await recovered.scan();
    expect(startKitchen).toHaveBeenCalledTimes(2);
    expect(startKitchen.mock.calls[1]![0].objective).toContain(`${state.team.id}:0`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
