import { mkdtemp, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTeamState } from "./engine.js";
import { kitchenPack } from "./pack.js";
import { TeamStore } from "./store.js";
import { acquireRuntimeOwnership } from "./storage-lock.js";

describe("persistent writer isolation", () => {
  it("rejects a second live runtime and releases ownership on cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kitchen-owner-"));
    try {
      const release = await acquireRuntimeOwnership(dir);
      await expect(acquireRuntimeOwnership(dir)).rejects.toThrow("Another Kitchen runtime");
      await release();
      const again = await acquireRuntimeOwnership(dir);
      await again();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("serializes independent stores, reads fresh state and rejects duplicate creates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kitchen-store-"));
    try {
      const a = new TeamStore(dir),
        b = new TeamStore(dir);
      const { state } = createTeamState({
        pack: kitchenPack,
        title: "Task",
        objective: "Check",
        cwd: "/repo",
        bossAgentId: "boss",
        roleProfiles: {},
      });
      await a.create(state, []);
      const id = state.team.id;
      await a.get(id);
      await Promise.all([
        a.commit(id, async (draft) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          draft.team.title += "A";
          return { events: [], result: null };
        }),
        b.commit(id, (draft) => {
          draft.team.title += "B";
          return { events: [], result: null };
        }),
      ]);
      expect(["TaskAB", "TaskBA"]).toContain((await a.get(id))?.team.title);
      const revision = (await a.get(id))!.commit;
      await a.commit(id, () => ({ events: [], result: null }));
      expect((await b.get(id))?.commit).toBe(revision);
      await expect(b.create(state, [])).rejects.toThrow("already exists");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not expose or truncate an event before its state commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kitchen-store-"));
    try {
      const store = new TeamStore(dir);
      const { state } = createTeamState({
        pack: kitchenPack,
        title: "Task",
        objective: "Check",
        cwd: "/repo",
        bossAgentId: "boss",
        roleProfiles: {},
      });
      await store.create(state, []);
      await appendFile(
        join(dir, state.team.id, "events.jsonl"),
        JSON.stringify({
          commit: 2,
          at: new Date().toISOString(),
          type: "pending",
          actor: { type: "runtime", id: "runtime" },
          text: "uncommitted",
        }) + "\n",
      );
      expect(await store.events(state.team.id)).toEqual([]);
      await store.commit(state.team.id, (draft) => {
        draft.team.title = "Updated";
        return {
          events: [
            { type: "committed", actor: { type: "runtime", id: "runtime" }, text: "committed" },
          ],
          result: null,
        };
      });
      expect((await store.events(state.team.id)).map((event) => event.type)).toEqual(["committed"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("recovers a proven uncommitted partial tail and rejects corruption of committed history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kitchen-store-"));
    try {
      const store = new TeamStore(dir);
      const { state } = createTeamState({
        pack: kitchenPack,
        title: "Task",
        objective: "Check",
        cwd: "/repo",
        bossAgentId: "boss",
        roleProfiles: {},
      });
      const event = {
        type: "committed",
        actor: { type: "runtime" as const, id: "runtime" },
        text: "Kept",
      };
      await store.create(state, [event]);
      const file = join(dir, state.team.id, "events.jsonl");
      await appendFile(file, '{"type":"uncommitted');
      expect((await store.events(state.team.id)).map((value) => value.text)).toEqual(["Kept"]);
      await store.commit(state.team.id, (draft) => {
        draft.team.title = "Recovered";
        return { events: [], result: null };
      });
      expect((await store.events(state.team.id)).map((value) => value.text)).toEqual(["Kept"]);
      await writeFile(file, '{"corrupt":"committed');
      await expect(store.events(state.team.id)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
