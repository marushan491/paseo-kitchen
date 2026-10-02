import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTeamState } from "./engine.js";
import { kitchenPack } from "./pack.js";
import { NativeMigration } from "./migration.js";
import { TeamStore } from "./store.js";
import { WorkflowProfiles } from "./profiles.js";
import type { TeamService } from "./service.js";

it("backs up and idempotently imports closed native history/profile defaults while preserving active jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "kitchen-migration-"));
  try {
    const home = join(root, "host"),
      storage = join(root, "studio"),
      project = join(root, "project");
    const native = new TeamStore(join(home, "teams"));
    const states = ["done", "active"].map((status) => {
      const { state } = createTeamState({
        pack: kitchenPack,
        title: status,
        objective: "Legacy",
        cwd: project,
        bossAgentId: "legacy",
        roleProfiles: {},
      });
      state.team.status = status as "done" | "active";
      return state;
    });
    for (const state of states) await native.create(state, []);
    await mkdir(join(project, ".pandaos"), { recursive: true });
    const original = JSON.stringify({
      roles: { developer: { provider: "codex", instructions: "Check inputs" } },
    });
    await writeFile(join(project, ".pandaos", "project.json"), original);
    const service = {
      store: new TeamStore(join(storage, "teams")),
      profiles: new WorkflowProfiles(storage),
    } as TeamService;
    const migration = new NativeMigration(home, storage, service);
    const inspection = await migration.inspect(project);
    expect(inspection.sources.reduce((sum, source) => sum + source.activeJobs, 0)).toBe(1);
    const result = await migration.import(
      inspection.sources.map((source) => source.id),
      project,
    );
    expect(result.errors).toEqual([]);
    expect(result.imported).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect((await service.store.get(states[0]!.team.id))?.team.importedFrom?.readOnly).toBe(true);
    expect(await service.store.get(states[1]!.team.id)).toBeNull();
    expect(await readFile(join(project, ".pandaos", "project.json"), "utf8")).toBe(original);
    expect((await service.profiles.list())[0]?.profile.instructions).toBe("Check inputs");
    expect(
      JSON.parse(await readFile(join(result.backupRef, "manifest.json"), "utf8")).imported,
    ).toEqual(result.imported);
    expect(
      (
        await migration.import(
          inspection.sources.map((source) => source.id),
          project,
        )
      ).imported,
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
