import { publishCandidate } from "./publication.js";
import { captureTrackedFiles } from "./evidence.js";
import { KitchenSchedules, computeNextRunAt } from "./schedules.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseFactoryCompletion, factoryValidationFeedback } from "./completion.js";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackRegistry } from "./pack.js";
import { TeamService, type TeamServiceOptions } from "./service.js";
import { TEAM_ROLE_LABEL, type TeamState } from "./types.js";

interface FakeRecord {
  id: string;
  provider: string;
  cwd: string;
  labels: Record<string, string>;
  archivedAt?: string | null;
  runtimeInfo?: { model: string };
  currentModeId?: string;
  thinkingOptionId?: string;
  routingNotice?: { status: "waiting"; reason: string; resetsAt: string };
}

function fakeHost() {
  const records = new Map<string, FakeRecord>();
  records.set("boss", {
    id: "boss",
    provider: "codex",
    cwd: "/repo",
    labels: {},
    runtimeInfo: { model: "gpt-6.1-sol" },
    currentModeId: "full-access",
    thinkingOptionId: "medium",
  });
  const created: FakeRecord[] = [];
  const prompts: Array<{ agentId: string; prompt: string }> = [];
  let n = 0;
  const options = {
    logger: pino({ level: "silent" }),
    packs: new PackRegistry(),
    timers: false,
    controller: {
      get: async (id: string) => records.get(id) ?? null,
      list: async () => [...records.values()],
      isRunning: async () => false,
      create: async (input: {
        provider?: string;
        labels?: Record<string, string>;
        cwd?: string;
        mode?: string;
        thinking?: string;
        worktree?: { worktreeName?: string };
      }) => {
        n += 1;
        const record: FakeRecord = {
          id: `agent-${n}`,
          provider: input.provider ?? "codex",
          cwd: input.worktree
            ? `/repo/.worktrees/${input.worktree.worktreeName}`
            : (input.cwd ?? "/repo"),
          labels: input.labels ?? {},
          currentModeId: input.mode,
          thinkingOptionId: input.thinking,
        };
        records.set(record.id, record);
        created.push(record);
        return { id: record.id };
      },
      send: async (agentId: string, prompt: string) => {
        prompts.push({ agentId, prompt });
      },
    },
  };
  const agentFor = (role: string, itemTitlePrefix?: string, state?: TeamState) =>
    created.find(
      (r) =>
        r.labels[TEAM_ROLE_LABEL] === role &&
        (!itemTitlePrefix ||
          state?.items[r.labels["agent-factory.team.item"]!]?.title.startsWith(itemTitlePrefix)),
    )!;
  return { options, created, prompts, agentFor };
}

function makeService(root: string, host: ReturnType<typeof fakeHost>): TeamService {
  return new TeamService({ ...(host.options as unknown as TeamServiceOptions), storageRoot: root });
}

function itemByKey(state: TeamState, key: string) {
  return Object.values(state.items).find((i) => i.pack.key === key)!;
}

describe("TeamService", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pandaos-team-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists named workflows, executes ordered steps with the selected harness, and snapshots running agents", async () => {
    const host = fakeHost();
    const validate = async (input: { provider: string; model?: string }) => {
      if (
        input.provider !== "codex" ||
        (input.model && !["gpt-6.1-sol", "host-model"].includes(input.model))
      )
        throw new Error("Unadvertised model");
    };
    const svc = new TeamService({
      ...(host.options as unknown as TeamServiceOptions),
      storageRoot: root,
      controller: {
        ...host.options.controller,
        validateProvider: validate,
      } as unknown as TeamServiceOptions["controller"],
    });
    await svc.start();
    await svc.saveProfile(
      {
        id: "careful",
        name: "Careful planning",
        profile: {
          model: "host-model",
          provider: "codex",
          thinking: "high",
          mode: "read-only",
          instructions: "Keep tasks bounded",
          steps: [
            { id: "inspect", title: "Inspect", instructions: "Inspect the public contract" },
            { id: "plan", title: "Plan", instructions: "Write a dependency plan" },
          ],
        },
      },
      root,
    );
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Configured",
      objective: "Plan",
      roleProfiles: { po: { workflowProfileId: "careful" } },
    });
    await svc.dispatchAll();
    const po = host.agentFor("po");
    expect(po).toMatchObject({
      provider: "codex/host-model",
      currentModeId: "read-only",
      thinkingOptionId: "high",
    });
    const prompt = host.prompts.find((entry) => entry.agentId === po.id)!.prompt;
    expect(prompt).toContain("Keep tasks bounded");
    expect(prompt.indexOf("1. Inspect [inspect]")).toBeLessThan(prompt.indexOf("2. Plan [plan]"));
    const configured = await svc.configureWork(
      started.team.id,
      started.team.rootItemId,
      "po",
      { instructions: "Next binding only", thinking: "low" },
      "human",
    );
    const binding = Object.values(configured.bindings).find((entry) => entry.agentId === po.id)!;
    expect(binding.executedProfile).toMatchObject({
      instructions: "Keep tasks bounded",
      thinking: "high",
    });
    expect(configured.items[started.team.rootItemId]!.roleProfiles!.po).toMatchObject({
      instructions: "Next binding only",
      thinking: "low",
    });
    expect(po.thinkingOptionId).toBe("high");
    await svc.onTurnEnded(started.team.id, po.id, false);
    await svc.dispatchAll();
    expect(host.prompts.at(-1)!.prompt).toContain("Keep tasks bounded");
    expect(host.prompts.at(-1)!.prompt).not.toContain("Next binding only");
    await svc.plan(po.id, [
      { key: "A", title: "A", objective: "Implement", acceptanceCriteria: ["works"] },
    ]);
    const planned = (await svc.status(started.team.id)).state;
    const work = itemByKey(planned, "A");
    await svc.configureWork(
      started.team.id,
      work.id,
      "developer",
      { workflowProfileId: "careful", instructions: "Only this item developer" },
      "human",
    );
    await svc.report(po.id, { outcome: "planned", summary: "One bounded item" });
    await svc.dispatchAll();
    const developer = host.agentFor("developer");
    expect(developer).toMatchObject({
      provider: "codex/host-model",
      thinkingOptionId: "high",
      currentModeId: "read-only",
    });
    expect(host.prompts.find((entry) => entry.agentId === developer.id)!.prompt).toContain(
      "Only this item developer",
    );
    await svc.shutdown();
    const reloaded = makeService(root, host);
    expect((await reloaded.profiles.list())[0]!.name).toBe("Careful planning");
    await reloaded.profiles.remove("careful");
    expect(await reloaded.profiles.list()).toEqual([]);
    expect((await reloaded.store.get(started.team.id))!.team.roleProfiles.po!.instructions).toBe(
      "Keep tasks bounded",
    );
    await expect(
      svc.saveProfile(
        { id: "bad", name: "Bad", profile: { provider: "codex", model: "invented" } },
        root,
      ),
    ).rejects.toThrow("Unadvertised model");
    expect(await reloaded.profiles.list()).toEqual([]);
  });

  it("inherits workflow-only project profiles and rejects unresolved references and unknown roles before creating workers", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    await mkdir(join(root, ".agent-factory"));
    await writeFile(
      join(root, ".agent-factory", "project.json"),
      JSON.stringify({
        roles: {
          po: {
            instructions: "Project planning rule",
            steps: [{ id: "first", title: "First", instructions: "Study objective" }],
          },
        },
      }),
    );
    await svc.start();
    await expect(
      svc.startTeam({
        bossAgentId: "boss",
        title: "Missing",
        objective: "Plan",
        cwd: root,
        roleProfiles: { po: { workflowProfileId: "missing" } },
      }),
    ).rejects.toThrow("not found");
    await expect(
      svc.startTeam({
        bossAgentId: "boss",
        title: "Unknown",
        objective: "Plan",
        roleProfiles: { invented: {} },
      }),
    ).rejects.toThrow("Unknown workflow role");
    expect(host.created).toHaveLength(0);
    const state = await svc.startTeam({
      bossAgentId: "boss",
      title: "Project",
      objective: "Plan",
      cwd: root,
    });
    await svc.dispatchAll();
    expect(state.team.roleProfiles.po).toMatchObject({
      provider: "codex",
      model: "gpt-6.1-sol",
      instructions: "Project planning rule",
    });
    expect(host.prompts[0]!.prompt).toContain("Study objective");
    await svc.shutdown();
  });

  it("runs plan → implement → test → review → done and survives a daemon restart mid-work", async () => {
    const host = fakeHost();
    let svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Pilot",
      objective: "Add a thing",
    });
    const teamId = started.team.id;
    await svc.dispatchAll();

    const po = host.agentFor("po");
    expect(po).toBeDefined();
    expect(po).toMatchObject({ currentModeId: "full-access", thinkingOptionId: "medium" });
    expect(started.team.roleProfiles.po).toMatchObject({
      provider: "codex",
      model: "gpt-6.1-sol",
      mode: "full-access",
      thinking: "medium",
    });
    await svc.plan(po.id, [
      {
        key: "A",
        title: "First",
        objective: "do A",
        acceptanceCriteria: ["A works"],
        conflictsWith: ["B"],
      },
      { key: "B", title: "Second", objective: "do B", acceptanceCriteria: ["B works"] },
    ]);
    await svc.report(po.id, { outcome: "planned", summary: "Two items" });
    await svc.dispatchAll();

    let state = (await svc.status(teamId)).state;
    expect(itemByKey(state, "A").phase).toBe("implement");
    expect(itemByKey(state, "B").phase).toBe("ready");

    const devA = host.agentFor("developer", "A", state);
    const createdBeforeRestart = host.created.length;

    svc.stop();
    svc = makeService(root, host);
    await svc.start();
    await svc.onTurnEnded(teamId, devA.id, false);
    await svc.dispatchAll();
    expect(host.created.length).toBe(createdBeforeRestart);
    const events = (await svc.status(teamId)).events;
    expect(events.some((e) => e.type === "health.report-missing")).toBe(false);
    expect(host.prompts.at(-1)).toMatchObject({ agentId: devA.id });
    expect(host.prompts.at(-1)!.prompt).toContain("host restarted");

    await svc.report(devA.id, {
      outcome: "done",
      summary: "Implemented A",
      artifacts: [{ kind: "commit", ref: "abc123" }],
    });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    const testerA = host.agentFor("tester", "A", state);
    expect(testerA.cwd).toBe(devA.cwd);

    await svc.report(testerA.id, { outcome: "fail", summary: "A breaks on empty input" });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    expect(itemByKey(state, "A").phase).toBe("implement");
    expect(host.prompts.at(-1)!.agentId).toBe(devA.id);
    expect(host.prompts.at(-1)!.prompt).toContain("A breaks on empty input");

    await expect(svc.report(testerA.id, { outcome: "pass", summary: "late" })).rejects.toThrow(
      /older state/,
    );

    await svc.report(devA.id, { outcome: "done", summary: "Fixed empty input" });
    await svc.dispatchAll();
    await svc.report(testerA.id, { outcome: "pass", summary: "All criteria met" });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    const reviewerA = host.agentFor("reviewer", "A", state);
    await svc.report(reviewerA.id, { outcome: "changes", summary: "Missing error message" });
    await svc.dispatchAll();
    expect(itemByKey((await svc.status(teamId)).state, "A").phase).toBe("implement");
    await svc.report(devA.id, { outcome: "done", summary: "Added message" });
    await svc.dispatchAll();
    await svc.report(testerA.id, { outcome: "pass", summary: "ok" });
    await svc.dispatchAll();
    await svc.report(reviewerA.id, { outcome: "approve", summary: "ok" });
    await svc.dispatchAll();

    state = (await svc.status(teamId)).state;
    expect(itemByKey(state, "A").phase).toBe("done");
    expect(itemByKey(state, "B").phase).toBe("implement");

    const devB = host.agentFor("developer", "B", state);
    await svc.report(devB.id, { outcome: "done", summary: "B" });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    await svc.report(host.agentFor("tester", "B", state).id, { outcome: "pass", summary: "ok" });
    await svc.dispatchAll();
    state = (await svc.status(teamId)).state;
    const send = host.options.controller.send;
    let failDelivery = true;
    host.options.controller.send = async (agentId, prompt) => {
      if (agentId === "boss" && prompt.includes('Team "Pilot" finished')) {
        expect((await svc.status(teamId)).state.team.status).toBe("active");
        if (failDelivery) throw new Error("Boss temporarily unavailable");
      }
      await send(agentId, prompt);
    };
    await svc.report(host.agentFor("reviewer", "B", state).id, {
      outcome: "approve",
      summary: "ok",
    });
    await svc.dispatchAll();

    state = (await svc.status(teamId)).state;
    expect(state.items[state.team.rootItemId]!.phase).toBe("done");
    expect(state.team.status).toBe("active");
    const notification = Object.values(state.decisions).find(
      (decision) => decision.idempotencyKey === `done:${state.team.rootItemId}`,
    )!;
    expect(notification.status).toBe("retry");
    await svc.shutdown();
    svc = makeService(root, host);
    await svc.start();
    expect((await svc.status(teamId)).state.team.status).toBe("active");
    failDelivery = false;
    await svc.retryDecision(teamId, notification.id, "boss");
    await svc.dispatchAll();
    expect((await svc.status(teamId)).state.team.status).toBe("done");
    const bossNote = host.prompts.findLast((p) => p.agentId === "boss");
    expect(bossNote?.prompt).toContain('Team "Pilot" finished');
    const deliveredCount = host.prompts.length;
    await svc.store.commit(teamId, (draft) => {
      draft.team.status = "active";
      return { events: [], result: null };
    });
    await svc.shutdown();
    svc = makeService(root, host);
    await svc.start();
    expect((await svc.status(teamId)).state.team.status).toBe("done");
    await svc.dispatchAll();
    expect(host.prompts).toHaveLength(deliveredCount);
  });

  it("drops events of a commit whose state never landed", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({ bossAgentId: "boss", title: "Crash", objective: "x" });
    await svc.dispatchAll();
    await svc.store.commit(started.team.id, () => ({
      events: [
        { type: "test.notice", actor: { type: "runtime", id: "test" }, text: "First event" },
        { type: "test.notice", actor: { type: "runtime", id: "test" }, text: "Second event" },
      ],
      result: null,
    }));
    const state = (await svc.status(started.team.id)).state;
    const beforeEvents = (await svc.status(state.team.id)).events;
    const before = beforeEvents.length;
    expect(new Set(beforeEvents.map((event) => event.id)).size).toBe(before);
    expect(new Set(beforeEvents.map((event) => event.commit)).size).toBeLessThan(before);
    await appendFile(
      join(root, "teams", state.team.id, "events.jsonl"),
      `${JSON.stringify({ commit: state.commit + 1, at: new Date().toISOString(), type: "ghost", actor: { type: "runtime", id: "runtime" }, text: "ghost" })}\n`,
    );
    const fresh = makeService(root, host);
    const events = (await fresh.status(state.team.id)).events;
    expect(events.length).toBe(before);
    expect(events.map((event) => event.id)).toEqual(beforeEvents.map((event) => event.id));
    expect(events.some((e) => e.type === "ghost")).toBe(false);
  });

  it("pauses a team created with a different pack version", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    await svc.start();
    const state = await svc.startTeam({ bossAgentId: "boss", title: "Versioned", objective: "x" });
    await svc.dispatchAll();
    svc.stop();
    const packs = new PackRegistry();
    const pack = packs.get("software-basic")!;
    packs.register({ ...pack, version: pack.version + 1 });
    const upgraded = new TeamService({
      ...(host.options as unknown as TeamServiceOptions),
      storageRoot: root,
      packs,
    });
    await upgraded.start();
    const after = (await upgraded.status(state.team.id)).state;
    expect(after.team.status).toBe("paused");
    expect(after.team.pausedReason).toMatch(/pack-version-mismatch/);
  });
});

describe("provider errors", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pandaos-team-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("retries a seat that stopped with a provider error later instead of calling the boss", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({ bossAgentId: "boss", title: "Limits", objective: "x" });
    await svc.dispatchAll();
    const po = host.agentFor("po");
    await svc.onTurnEnded(started.team.id, po.id, true);
    const { state, events } = await svc.status(started.team.id);
    expect(events.some((e) => e.type === "health.provider-error")).toBe(true);
    expect(events.some((e) => e.type === "boss.notified")).toBe(false);
    const retry = Object.values(state.decisions).find((d) => d.payload.retry === true)!;
    expect(Date.parse(retry.availableAt)).toBeGreaterThan(Date.now());
  });
});

describe("Plugin recovery and controls", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-factory-controls-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not revive or inspect closed jobs during recovery, even with unavailable host metadata", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Closed",
      objective: "Keep closed",
    });
    await svc.shutdown();
    for (const status of ["done", "canceled"] as const) {
      await svc.store.commit(started.team.id, (draft) => {
        draft.team.status = status;
        return { events: [], result: null };
      });
      const before = (await svc.store.get(started.team.id))!;
      const loaded = new TeamService({
        ...(host.options as unknown as TeamServiceOptions),
        storageRoot: root,
        controller: {
          ...host.options.controller,
          get: async () => {
            throw new Error("Host unavailable");
          },
        } as unknown as TeamServiceOptions["controller"],
      });
      await loaded.start();
      expect((await loaded.store.get(started.team.id))!.team.status).toBe(status);
      expect((await loaded.store.get(started.team.id))!.commit).toBe(before.commit);
      await loaded.shutdown();
    }
  });

  it("waits for an actual host routing reset and retains that retry across reload", async () => {
    const host = fakeHost();
    let now = new Date(Date.now() + 1_000);
    const options = {
      ...(host.options as unknown as TeamServiceOptions),
      storageRoot: root,
      now: () => now,
    };
    let svc = new TeamService(options);
    await svc.start();
    const started = await svc.startTeam({ bossAgentId: "boss", title: "Reset", objective: "Wait" });
    await svc.dispatchAll();
    const po = host.agentFor("po");
    const resetsAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    po.routingNotice = {
      status: "waiting",
      reason: "Provider limit reached",
      resetsAt,
    };
    await svc.onTurnEnded(started.team.id, po.id, true);
    const retry = Object.values((await svc.store.get(started.team.id))!.decisions).find(
      (decision) => decision.payload.routingResetAt,
    )!;
    expect(retry.availableAt).toBe(new Date(Date.parse(resetsAt) + 1_000).toISOString());
    await expect(svc.retryDecision(started.team.id, retry.id, "human")).rejects.toThrow(
      "reported reset",
    );
    await svc.dispatchAll();
    expect(host.prompts.filter((entry) => entry.agentId === po.id)).toHaveLength(1);
    await svc.shutdown();
    svc = new TeamService(options);
    await svc.start();
    await svc.dispatchAll();
    expect(host.prompts.filter((entry) => entry.agentId === po.id)).toHaveLength(1);
    const productiveBefore = (await svc.store.get(started.team.id))!.team.runtime!.usage.activeMs;
    now = new Date(Date.parse(resetsAt) + 2_000);
    await svc.dispatchAll();
    expect(host.prompts.filter((entry) => entry.agentId === po.id)).toHaveLength(2);
    expect((await svc.store.get(started.team.id))!.team.runtime!.usage.activeMs).toBe(
      productiveBefore,
    );
    await svc.shutdown();
  });

  it("respects the configured concurrency slot", async () => {
    const host = fakeHost();
    const svc = new TeamService({
      ...host.options,
      storageRoot: root,
      maxConcurrentAgents: () => 1,
    });
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Queue",
      objective: "Two items",
    });
    await svc.dispatchAll();
    const po = host.agentFor("po");
    await svc.plan(po.id, [
      { key: "A", title: "A", objective: "A", acceptanceCriteria: ["works"] },
      { key: "B", title: "B", objective: "B", acceptanceCriteria: ["works"] },
    ]);
    await svc.report(po.id, { outcome: "planned", summary: "Two items" });
    await svc.dispatchAll();
    const state = (await svc.status(started.team.id)).state;
    expect(itemByKey(state, "A").phase).toBe("implement");
    expect(itemByKey(state, "B").phase).toBe("ready");
    await svc.shutdown();
  });

  it("keeps live workers running after plugin reload", async () => {
    const host = fakeHost();
    let svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Live",
      objective: "Keep working",
    });
    await svc.dispatchAll();
    const initialPromptCount = host.prompts.length;
    await svc.shutdown();
    svc = new TeamService({
      ...host.options,
      storageRoot: root,
      controller: {
        ...host.options.controller,
        get: async (id) => {
          const record = await host.options.controller.get(id);
          return record ? { ...record, running: id !== "boss" } : null;
        },
      },
    });
    await svc.start();
    await svc.dispatchAll();
    expect(host.prompts).toHaveLength(initialPromptCount);
    expect(host.created).toHaveLength(1);
    expect(
      (await svc.status(started.team.id)).events.some((event) => event.type === "recovery.resume"),
    ).toBe(false);
    await svc.shutdown();
  });

  it("ingests a finished worker report missed during plugin reload", async () => {
    const host = fakeHost();
    let svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Recovery",
      objective: "Recover output",
    });
    await svc.dispatchAll();
    await svc.shutdown();
    const po = host.agentFor("po");
    svc = new TeamService({
      ...host.options,
      storageRoot: root,
      controller: {
        ...host.options.controller,
        completion: async (id) =>
          id === po.id
            ? {
                report: { outcome: "planned", summary: "Plan finished before reload" },
                items: [{ key: "A", title: "A", objective: "A", acceptanceCriteria: ["works"] }],
              }
            : null,
      },
    });
    await svc.start();
    await svc.dispatchAll();
    const status = await svc.status(started.team.id);
    expect(status.events.some((event) => event.type === "recovery.report")).toBe(true);
    expect(host.prompts.filter((prompt) => prompt.agentId === po.id)).toHaveLength(1);
    expect(itemByKey(status.state, "A").phase).toBe("implement");
    await svc.shutdown();
  });

  it("pauses dispatch and prevents revival of canceled teams", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Pause",
      objective: "Pause dispatch",
    });
    await svc.dispatchAll();
    await svc.setStatus(started.team.id, "paused", "boss");
    const po = host.agentFor("po");
    await svc.plan(po.id, [
      { key: "A", title: "A", objective: "A", acceptanceCriteria: ["works"] },
    ]);
    await svc.report(po.id, { outcome: "planned", summary: "One item" });
    await svc.dispatchAll();
    expect(host.created).toHaveLength(1);
    await svc.setStatus(started.team.id, "active", "boss");
    await svc.dispatchAll();
    expect(host.created).toHaveLength(2);
    await svc.message(started.team.id, "Please focus on A", { type: "human", id: "person" });
    expect(host.prompts.at(-1)).toMatchObject({ agentId: "boss", prompt: "Please focus on A" });
    await svc.setStatus(started.team.id, "canceled", "boss");
    await expect(
      svc.message(started.team.id, "Restart", { type: "human", id: "person" }),
    ).rejects.toThrow("closed");
    await expect(svc.setStatus(started.team.id, "active", "boss")).rejects.toThrow("closed");
    await svc.shutdown();
  });

  it("allows a manual retry immediately before its automatic backoff expires", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Retry",
      objective: "Retry error",
    });
    await svc.dispatchAll();
    await svc.onTurnEnded(started.team.id, host.agentFor("po").id, true);
    const waiting = Object.values((await svc.status(started.team.id)).state.decisions).find(
      (decision) => decision.status === "pending" && decision.payload.retry,
    )!;
    expect(Date.parse(waiting.availableAt)).toBeGreaterThan(Date.now());
    await svc.retryDecision(started.team.id, waiting.id, "boss");
    await svc.dispatchAll();
    expect((await svc.status(started.team.id)).state.decisions[waiting.id]!.status).toBe(
      "succeeded",
    );
    expect(host.prompts.at(-1)?.agentId).toBe(host.agentFor("po").id);
    await svc.shutdown();
  });
});

it("corrects rejected report field types once, then advances from the valid final response", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-factory-report-correction-"));
  const host = fakeHost();
  const svc = makeService(root, host);
  try {
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Report correction",
      objective: "Plan a valid item",
    });
    await svc.dispatchAll();
    const po = host.agentFor("po");
    let feedback = "";
    try {
      parseFactoryCompletion([
        {
          type: "assistant_message",
          text: '```factory-report\n{"report":{"outcome":"planned","summary":"Plan","artifacts":["plan.md"],"criteria":["criterion"]},"items":[{"key":"A","title":"A","objective":"A","acceptanceCriteria":["works"]}]}\n```',
        },
      ]);
    } catch (error) {
      feedback = factoryValidationFeedback(error);
    }
    expect(feedback).toContain("report.artifacts.0");
    expect(feedback).toContain("report.criteria.0");
    expect(feedback.length).toBeLessThanOrEqual(800);
    await svc.onTurnEnded(started.team.id, po.id, false, undefined, feedback);
    await svc.dispatchAll();
    const prompt = host.prompts.at(-1)!.prompt;
    expect(prompt).toContain("Validation errors:");
    expect(prompt).toContain("report.artifacts.0");
    expect(prompt).toContain('"kind":"commit","ref"');
    expect(prompt).toContain('"id":"exact acceptance criterion ID above","met":true,"evidence"');
    expect(prompt).toContain("PO plans future acceptanceCriteria");
    const completed = parseFactoryCompletion([
      {
        type: "assistant_message",
        text: '```factory-report\n{"report":{"outcome":"planned","summary":"One valid item"},"items":[{"key":"A","title":"A","objective":"A","acceptanceCriteria":["works"]}]}\n```',
      },
    ])!;
    await svc.report(po.id, completed.report, completed.items);
    await svc.dispatchAll();
    expect(itemByKey((await svc.status(started.team.id)).state, "A").phase).toBe("implement");
    expect(
      host.created.filter((agent) => agent.labels[TEAM_ROLE_LABEL] === "developer"),
    ).toHaveLength(1);
  } finally {
    await svc.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a rejected PO report and its plan atomic so a corrected response can be accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-factory-atomic-report-"));
  const host = fakeHost();
  const svc = makeService(root, host);
  try {
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Atomic plan",
      objective: "Plan once",
    });
    await svc.dispatchAll();
    const po = host.agentFor("po");
    const items = [{ key: "A", title: "A", objective: "A", acceptanceCriteria: ["works"] }];
    await expect(
      svc.report(po.id, { outcome: "not-allowed", summary: "Invalid" }, items),
    ).rejects.toThrow("Unknown outcome");
    expect(Object.values((await svc.status(started.team.id)).state.items)).toHaveLength(1);
    await svc.report(po.id, { outcome: "planned", summary: "Corrected" }, items);
    await svc.dispatchAll();
    expect(itemByKey((await svc.status(started.team.id)).state, "A").phase).toBe("implement");
  } finally {
    await svc.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it("hands pending review checks from tester to reviewer without waiving product evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-factory-stage-criteria-"));
  const host = fakeHost();
  const svc = makeService(root, host);
  try {
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Stage criteria",
      objective: "Implement greeting; reviewer checks diff and tests",
    });
    await svc.dispatchAll();
    const po = host.agentFor("po");
    await svc.report(po.id, { outcome: "planned", summary: "Legacy plan with review milestone" }, [
      {
        key: "A",
        title: "Greeting",
        objective: "Implement greeting",
        acceptanceCriteria: [
          "Greeting returns expected text",
          "Reviewer checks diff and test evidence",
        ],
      },
    ]);
    await svc.dispatchAll();
    let state = (await svc.status(started.team.id)).state;
    await svc.report(host.agentFor("developer", "A", state).id, {
      outcome: "done",
      summary: "Greeting implemented",
    });
    await svc.dispatchAll();
    state = (await svc.status(started.team.id)).state;
    await svc.report(host.agentFor("tester", "A", state).id, {
      outcome: "pass",
      summary: "Product test passed; reviewer must inspect diff next",
      criteria: [
        { id: "A-1", met: true, evidence: "node --test greeting.test.mjs: 1 passed" },
        {
          id: "A-2",
          met: false,
          evidence: "Pending reviewer stage; no review was performed by the tester",
        },
      ],
    });
    await svc.dispatchAll();
    state = (await svc.status(started.team.id)).state;
    const item = itemByKey(state, "A");
    expect(item.phase).toBe("review");
    expect(item.acceptanceCriteria[0]!.met).toBe(true);
    expect(item.acceptanceCriteria[1]!.met).toBe(false);
    await svc.report(host.agentFor("reviewer", "A", state).id, {
      outcome: "approve",
      summary: "Diff and passing tests inspected",
      criteria: [
        {
          id: "A-2",
          met: true,
          evidence: "Inspected greeting diff and the tester's 1-pass test log",
        },
      ],
    });
    await svc.dispatchAll();
    state = (await svc.status(started.team.id)).state;
    expect(itemByKey(state, "A").phase).toBe("done");
    expect(itemByKey(state, "A").acceptanceCriteria[1]!.evidence).toContain(
      "Inspected greeting diff",
    );
  } finally {
    await svc.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

const PARENT_AGENT_ID_LABEL = "parentAgentId";
interface KitchenRecord {
  id: string;
  provider: string;
  cwd: string;
  labels: Record<string, string>;
  title?: string;
  workspaceId?: string;
  archivedAt?: string | null;
  runtimeInfo?: { model: string };
  usageTotals?: { inputTokens: number; outputTokens: number };
}
function kitchenFakeHost() {
  const records = new Map<string, KitchenRecord>();
  records.set("boss", {
    id: "boss",
    provider: "codex",
    cwd: "/repo",
    labels: {},
    runtimeInfo: { model: "gpt-6.1-sol" },
  });
  const created: KitchenRecord[] = [];
  const prompts: Array<{ agentId: string; prompt: string }> = [];
  const interrupted: string[] = [];
  let n = 0;
  const options = {
    logger: pino({ level: "silent" }),
    packs: new PackRegistry(),
    timers: false,
    validateProvider: async () => {},
    agentManager: {
      subscribe: () => () => {},
      getAgent: (id: string) => {
        const record = records.get(id);
        return record ? { ...record, lifecycle: "running" } : undefined;
      },
      moveAgentToWorkspace: async (id: string, target: { workspaceId: string; cwd: string }) => {
        Object.assign(records.get(id)!, target);
        return records.get(id)!;
      },
      detachAgent: async (id: string) => {
        delete records.get(id)!.labels[PARENT_AGENT_ID_LABEL];
      },
      updateAgentMetadata: async (
        id: string,
        updates: { title?: string; labels?: Record<string, string> },
      ) => {
        Object.assign(records.get(id)!, updates);
      },
      hasInFlightRun: () => false,
      cancelAgentRun: async (id: string) => {
        interrupted.push(id);
        return { status: "settled" };
      },
    },
    agentStorage: {
      get: async (id: string) => records.get(id) ?? null,
      list: async () => [...records.values()],
    },
    createAgent: async (input: {
      labels?: Record<string, string>;
      title?: string;
      workspaceId?: string;
      cwd?: string;
      worktree?: { worktreeName?: string };
    }) => {
      n += 1;
      const record: KitchenRecord = {
        id: `agent-${n}`,
        provider: "codex",
        cwd: input.worktree
          ? `${input.cwd ?? "/repo"}/.worktrees/${input.worktree.worktreeName}`
          : (input.cwd ?? "/repo"),
        labels: input.labels ?? {},
        title: input.title,
        workspaceId: input.workspaceId,
      };
      if (input.cwd?.startsWith(tmpdir())) await mkdir(record.cwd, { recursive: true });
      records.set(record.id, record);
      created.push(record);
      return { snapshot: { id: record.id } };
    },
    sendPrompt: async (params: { agentId: string; prompt: unknown }) => {
      prompts.push({ agentId: params.agentId, prompt: String(params.prompt) });
      return { disposition: "turn_started" };
    },
  };
  const agentFor = (role: string, itemTitlePrefix?: string, state?: TeamState) =>
    created.find(
      (r) =>
        r.labels[TEAM_ROLE_LABEL] === role &&
        (!itemTitlePrefix ||
          state?.items[r.labels["agent-factory.team.item"]!]?.title.startsWith(itemTitlePrefix)),
    )!;
  return { options, created, prompts, agentFor, interrupted, records };
}

type KitchenTestOptions = ReturnType<typeof kitchenFakeHost>["options"] & {
  controllerOverrides?: Partial<TeamServiceOptions["controller"]>;
  policyUsage?: TeamServiceOptions["policyUsage"];
  storageRoot: string;
  now?: () => Date;
  resolveWorkspace?: (
    id: string,
  ) => Promise<{ id: string; cwd: string; archivedAt?: string | null } | null>;
  findWorkspaceForCwd?: (cwd: string) => Promise<{ id: string; cwd: string } | null>;
};
const kitchenServices = new Set<TeamService>();
class KitchenTestService extends TeamService {
  constructor(options: KitchenTestOptions) {
    super({
      storageRoot: options.storageRoot,
      logger: options.logger,
      packs: options.packs,
      timers: options.timers,
      operatorCredential: () => "synthetic-test-operator-capability-32-chars",
      verificationSnapshot: async (cwd: string) =>
        cwd.startsWith("/repo")
          ? { head: "synthetic", status: "", files: {} }
          : captureTrackedFiles(cwd),
      now: options.now,
      policyUsage: options.policyUsage,
      controller: {
        get: async (id) => {
          const record = await options.agentStorage.get(id);
          return record
            ? { ...record, running: true, parentAgentId: record.labels[PARENT_AGENT_ID_LABEL] }
            : null;
        },
        list: () => options.agentStorage.list(),
        isRunning: async (id) => options.agentManager.hasInFlightRun(id),
        create: async (input) => {
          const result = await options.createAgent(input);
          return { id: result.snapshot.id };
        },
        send: async (agentId, prompt) => {
          await options.sendPrompt({ agentId, prompt });
        },
        cancel: async (id) => {
          await options.agentManager.cancelAgentRun(id);
        },
        update: (id, update) => options.agentManager.updateAgentMetadata(id, update),
        detach: (id) => options.agentManager.detachAgent(id),
        moveToWorkspace: async (id, workspaceId) => {
          const record = await options.agentStorage.get(id);
          await options.agentManager.moveAgentToWorkspace(id, { workspaceId, cwd: record!.cwd });
        },
        resolveWorkspace: options.resolveWorkspace ?? (async () => null),
        findWorkspaceForCwd: options.findWorkspaceForCwd ?? (async () => null),
        validateProvider: options.validateProvider,
        ...options.controllerOverrides,
      },
    } as TeamServiceOptions);
    kitchenServices.add(this);
  }
}
async function stopKitchenServices() {
  await Promise.all([...kitchenServices].map((service) => service.shutdown()));
  kitchenServices.clear();
}
function makeKitchenService(root: string, host: ReturnType<typeof kitchenFakeHost>): TeamService {
  return new KitchenTestService({ ...host.options, storageRoot: root });
}

describe("Kitchen runtime", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pandaos-kitchen-"));
  });
  afterEach(async () => {
    await stopKitchenServices();
    await rm(root, { recursive: true, force: true });
  });

  it("routes automatic Lead decisions into a real single pack and preserves the spec and classification across retries", async () => {
    const host = kitchenFakeHost();
    let classified = 0;
    const decisionSource = {
      classify: async () => {
        classified += 1;
        return {
          source: "jev" as const,
          model: "controlled-fixture",
          executionMode: "single" as const,
          confidence: 1,
          latencyMs: 1,
          reason: "Bounded change",
        };
      },
      judge: async () => ({
        source: "jev" as const,
        model: "controlled-fixture",
        verdict: "pass" as const,
        confidence: 1,
        latencyMs: 1,
        reason: "Fixture only",
      }),
    };
    const svc = new TeamService({
      storageRoot: root,
      packs: new PackRegistry(),
      logger: host.options.logger,
      timers: false,
      decisionSource,
      controller: {
        get: async (id) => host.records.get(id) ?? null,
        list: async () => [...host.records.values()],
        isRunning: async () => false,
        create: async (input) => ({ id: (await host.options.createAgent(input)).snapshot.id }),
        send: async (id, prompt) => {
          host.prompts.push({ agentId: id, prompt });
        },
        validateProvider: async () => {},
        update: async () => {},
        findWorkspaceForCwd: async () => null,
      } as unknown as TeamServiceOptions["controller"],
    });
    await mkdir(join(root, ".agent-factory"), { recursive: true });
    await writeFile(
      join(root, ".agent-factory", "project.json"),
      JSON.stringify({
        roles: {
          po: { instructions: "Planning only" },
          developer: { instructions: "Project implementation default" },
        },
      }),
    );
    await svc.saveProfile(
      {
        id: "single-developer",
        name: "Developer workflow",
        profile: {
          instructions: "Chosen Developer instructions",
          steps: [
            { id: "check", title: "Check", instructions: "Perform the chosen Developer check" },
          ],
        },
      },
      root,
    );
    const input = {
      title: "Single",
      objective: "One change",
      spec: "Do not change the API signature",
      cwd: root,
      provider: "codex",
      executionMode: "auto" as const,
      idempotencyKey: "auto-single",
      roleProfiles: { developer: { workflowProfileId: "single-developer" } },
      acceptanceCriteria: [{ id: "works", text: "Works" }],
    };
    const team = await svc.startKitchen(input);
    await svc.dispatchAll();
    expect(team.team.packId).toBe("kitchen-single");
    expect(team.team.kitchen?.classification?.model).toBe("controlled-fixture");
    expect(team.team.kitchen?.executionMode).toBe("single");
    expect(host.created.some((agent) => agent.labels[TEAM_ROLE_LABEL] === "po")).toBe(false);
    const worker = host.agentFor("integrator");
    expect(host.prompts.find((entry) => entry.agentId === worker.id)!.prompt).toContain(
      "Do not change the API signature",
    );
    const actual = (await svc.status(team.team.id)).state;
    const binding = Object.values(actual.bindings).find((seat) => seat.agentId === worker.id)!;
    expect(binding.executedProfile?.workflowProfileId).toBe("single-developer");
    expect(host.prompts.find((entry) => entry.agentId === worker.id)!.prompt).toContain(
      "Perform the chosen Developer check",
    );
    expect(actual.team.roleProfiles.po).toBeUndefined();
    expect((await svc.startKitchen(input)).team.id).toBe(team.team.id);
    expect(classified).toBe(1);
    await expect(
      svc.startKitchen({
        ...input,
        idempotencyKey: "typo-role",
        roleProfiles: { developre: { instructions: "Typo" } },
      }),
    ).rejects.toThrow("Unknown workflow role developre");
    await expect(
      svc.report(worker.id, { outcome: "done", summary: "Missing evidence" }),
    ).rejects.toThrow(/commit/);
    await svc.shutdown();
  });

  it("blocks unobservable token/cost policies before creating agents and bounds actual new worker starts", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const input = {
      title: "Budget",
      objective: "Bound work",
      cwd: root,
      provider: "codex",
      idempotencyKey: "budget",
      acceptanceCriteria: [{ id: "works", text: "Works" }],
    };
    await expect(service.startKitchen({ ...input, policy: { maxTokens: 1000 } })).rejects.toThrow(
      "unavailable",
    );
    await expect(service.startKitchen({ ...input, policy: { maxCostUsd: 1 } })).rejects.toThrow(
      "unavailable",
    );
    expect(host.created).toHaveLength(0);
    const team = await service.startKitchen({ ...input, policy: { maxAgentStarts: 1 } });
    await service.dispatchAll();
    const po = host.agentFor("po");
    await service.report(po.id, { outcome: "planned", summary: "One item" }, [
      { key: "A", title: "A", objective: "A", acceptanceCriteria: ["Works"] },
    ]);
    await service.dispatchAll();
    expect(host.created.filter((agent) => agent.labels[TEAM_ROLE_LABEL])).toHaveLength(1);
    const pending = Object.values((await service.store.get(team.team.id))!.decisions).find(
      (decision) => decision.lastError?.includes("maxAgentStarts"),
    );
    expect(pending?.status).toBe("retry");
    const trustedHost = kitchenFakeHost();
    const trusted = new KitchenTestService({
      ...trustedHost.options,
      storageRoot: join(root, "trusted-budget"),
      policyUsage: async () => ({
        scope: "team",
        cumulative: true,
        complete: true,
        tokens: 0,
        costUsd: 0,
      }),
    });
    const observed = await trusted.startKitchen({
      ...input,
      idempotencyKey: "observed-budget",
      policy: { maxTokens: 1000, maxCostUsd: 1 },
    });
    await trusted.dispatchAll();
    expect(trustedHost.created.filter((agent) => agent.labels[TEAM_ROLE_LABEL])).toHaveLength(1);
    expect(
      (
        await trusted.startKitchen({
          ...input,
          idempotencyKey: "observed-budget",
          policy: { maxTokens: 1000, maxCostUsd: 1 },
        })
      ).team.id,
    ).toBe(observed.team.id);
  });

  it("publishes only the explicit candidate and reuses a matching PR after a lost response", async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const commit = "a".repeat(40);
    let rows = "[]";
    const runner = async (executable: string, args: string[]) => {
      calls.push({ executable, args });
      if (args.includes("get-url")) return "git@github.com:example/fixture.git";
      if (args.includes("list")) return rows;
      if (args.includes("create")) {
        rows = JSON.stringify([
          { url: "https://github.com/example/fixture/pull/1", headRefOid: commit },
        ]);
        return "https://github.com/example/fixture/pull/1";
      }
      return "";
    };
    const params = {
      enabled: true,
      remote: "origin",
      branch: "kitchen/fixture",
      baseBranch: "main",
    };
    await expect(
      publishCandidate(
        root,
        commit,
        { ...params, enabled: false },
        { executable: "fixture-gh" },
        runner,
      ),
    ).rejects.toThrow("explicitly enabled");
    expect(calls).toHaveLength(0);
    expect(await publishCandidate(root, commit, params, { executable: "fixture-gh" }, runner)).toBe(
      "https://github.com/example/fixture/pull/1",
    );
    expect(await publishCandidate(root, commit, params, { executable: "fixture-gh" }, runner)).toBe(
      "https://github.com/example/fixture/pull/1",
    );
    expect(calls.filter((call) => call.args.includes("push"))).toHaveLength(1);
    expect(calls.find((call) => call.args.includes("push"))!.args).toEqual([
      "push",
      "origin",
      `${commit}:refs/heads/kitchen/fixture`,
    ]);
    expect(calls.filter((call) => call.args.includes("create"))).toHaveLength(1);
    expect(
      calls
        .filter((call) => call.executable === "fixture-gh")
        .every((call) => call.args.includes("github.com/example/fixture")),
    ).toBe(true);
  });

  it("creates one Boss and team for concurrent retries and survives a service reload", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const input = {
      title: "Kitchen",
      objective: "Ship it",
      cwd: root,
      provider: "codex",
      idempotencyKey: "same-request",
      acceptanceCriteria: [{ id: "works", text: "Works on empty input" }],
    };
    const [first, second] = await Promise.all([
      service.startKitchen(input),
      service.startKitchen(input),
    ]);
    await service.dispatchAll();
    expect(first.team.id).toBe(second.team.id);
    expect(first.items[first.team.rootItemId]!.acceptanceCriteria).toEqual(
      input.acceptanceCriteria,
    );
    const reloaded = makeKitchenService(root, host);
    expect((await reloaded.startKitchen(input)).team.id).toBe(first.team.id);
    expect(host.created.filter((agent) => !agent.labels[TEAM_ROLE_LABEL])).toHaveLength(1);
    await expect(reloaded.startKitchen({ ...input, objective: "Another request" })).rejects.toThrow(
      /Idempotency key/,
    );
    await expect(
      reloaded.startKitchen({
        ...input,
        roleProfiles: { developer: { instructions: "Different worker policy" } },
      }),
    ).rejects.toThrow(/Idempotency key/);
    expect(host.created.filter((agent) => !agent.labels[TEAM_ROLE_LABEL])).toHaveLength(1);
  });

  it("hands an ordinary project session into Kitchen with a backlink and queue kind", async () => {
    const host = kitchenFakeHost();
    host.records.get("boss")!.cwd = root;
    const service = makeKitchenService(root, host);
    const input = {
      title: "Bug handoff",
      objective: "Fix bug",
      cwd: root,
      provider: "codex",
      idempotencyKey: "handoff",
      acceptanceCriteria: [{ id: "fixed", text: "Bug reproduced and fixed" }],
      sourceAgentId: "boss",
      kind: "bug" as const,
    };
    await expect(service.startKitchen({ ...input, sourceAgentId: "missing" })).rejects.toThrow(
      /Source session/,
    );
    await expect(service.startKitchen({ ...input, provider: "opencode" })).rejects.toThrow(
      /provider must match/,
    );
    expect(host.created).toHaveLength(0);
    const team = await service.startKitchen(input);
    await service.dispatchAll();
    expect(team.team.kitchen?.sourceAgentId).toBe("boss");
    expect(team.team.kitchen?.kind).toBe("bug");
    expect(host.records.get(team.team.bossAgentId)!.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    expect(host.records.get(team.team.bossAgentId)!.title).toBe(input.title);
  });

  it("reuses only the selected matching workspace and protects the Boss until cancellation", async () => {
    const host = kitchenFakeHost();
    host.records.get("boss")!.cwd = root;
    host.records.get("boss")!.workspaceId = "existing";
    const service = new KitchenTestService({
      ...host.options,
      storageRoot: root,
      resolveWorkspace: async (id) => (id === "existing" ? { id, cwd: root } : { id, cwd: "/tmp" }),
    } as unknown as KitchenTestOptions);
    const input = {
      title: "Fix meeting import",
      objective: "Fix importer",
      cwd: root,
      provider: "codex",
      sourceAgentId: "boss",
      idempotencyKey: "reuse",
      acceptanceCriteria: [{ id: "fixed", text: "Importer works" }],
    };
    await expect(service.startKitchen({ ...input, workspaceId: "wrong" })).rejects.toThrow(
      /must match/,
    );
    expect(host.created).toHaveLength(0);
    const state = await service.startKitchen(input);
    const boss = host.records.get(state.team.bossAgentId)!;
    expect(boss.workspaceId).toBe("existing");
    expect(boss.title).toBe(input.title);
    expect(boss.labels["agent-factory.team.status"]).toBe("active");
    expect(boss.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    await expect(service.assertCanArchiveAgent(boss.id)).rejects.toThrow(/Finish or cancel/);
    await service.controlKitchen(state.team.id, "stop", "human");
    expect(boss.labels["agent-factory.team.status"]).toBe("paused");
    expect(await service.isProtectedKitchenBoss(boss.id)).toBe(true);
    await service.controlKitchen(state.team.id, "cancel", "human");
    expect(boss.labels["agent-factory.team.status"]).toBe("canceled");
    await expect(service.assertCanArchiveAgent(boss.id)).resolves.toBeUndefined();
  });

  it("repairs a legacy Boss into the source workspace without changing its directory or the source", async () => {
    const host = kitchenFakeHost();
    const source = host.records.get("boss")!;
    source.cwd = root;
    source.title = "Original session";
    source.workspaceId = "source-workspace";
    const service = new KitchenTestService({
      ...host.options,
      storageRoot: root,
      resolveWorkspace: async (id) => ({ id, cwd: root }),
    } as unknown as KitchenTestOptions);
    const state = await service.startKitchen({
      title: "Meeting import",
      objective: "Fix import",
      cwd: root,
      provider: "codex",
      sourceAgentId: source.id,
      idempotencyKey: "legacy",
      acceptanceCriteria: [{ id: "works", text: "Import works" }],
    });
    await service.dispatchAll();
    const boss = host.records.get(state.team.bossAgentId)!;
    boss.workspaceId = "old-boss-workspace";
    boss.labels[PARENT_AGENT_ID_LABEL] = source.id;
    boss.title = "Boss · Meeting import";
    await service.start();
    expect(boss.workspaceId).toBe(source.workspaceId);
    expect(boss.cwd).toBe(root);
    expect(boss.title).toBe(state.team.title);
    expect(boss.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    expect(source.title).toBe("Original session");
    expect(source.labels).toEqual({});
  });

  it("claims the same active job across different request keys and records every retry key", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const input = {
      title: "Kitchen",
      objective: "One objective",
      cwd: root,
      provider: "codex",
      acceptanceCriteria: [{ id: "goal", text: "Goal works" }],
      idempotencyKey: "first-key",
    };
    const [first, second] = await Promise.all([
      service.startKitchen(input),
      service.startKitchen({ ...input, idempotencyKey: "second-key" }),
    ]);
    expect(second.team.id).toBe(first.team.id);
    const reloaded = makeKitchenService(root, host);
    expect((await reloaded.startKitchen({ ...input, idempotencyKey: "second-key" })).team.id).toBe(
      first.team.id,
    );
    expect(host.created.filter((agent) => !agent.labels[TEAM_ROLE_LABEL])).toHaveLength(1);
    await expect(
      service.startKitchen({
        ...input,
        idempotencyKey: "conflicting-key",
        workflowMode: "self-organizing",
      }),
    ).rejects.toThrow(/different criteria/);
    await expect(
      service.startKitchen({
        ...input,
        idempotencyKey: "conflicting-criteria",
        acceptanceCriteria: [{ id: "different", text: "Different acceptance" }],
      }),
    ).rejects.toThrow(/different criteria/);
    expect(host.created.filter((agent) => !agent.labels[TEAM_ROLE_LABEL])).toHaveLength(1);
  });

  it("recovers the existing Boss when creation persisted before the start response failed", async () => {
    const host = kitchenFakeHost();
    const create = host.options.createAgent as unknown as KitchenTestOptions["createAgent"];
    let fail = true;
    const service = new KitchenTestService({
      ...(host.options as unknown as KitchenTestOptions),
      storageRoot: root,
      createAgent: async (input) => {
        const result = await create(input);
        if (fail) {
          fail = false;
          throw new Error("Lost start response");
        }
        return result;
      },
    });
    const input = {
      title: "Kitchen",
      objective: "Recover",
      cwd: root,
      provider: "codex",
      acceptanceCriteria: [{ id: "goal", text: "Goal works" }],
      idempotencyKey: "before-crash",
    };
    await expect(service.startKitchen(input)).rejects.toThrow("Lost start response");
    const restored = await makeKitchenService(root, host).startKitchen({
      ...input,
      idempotencyKey: "after-crash",
    });
    expect(restored.team.bossAgentId).toBe(host.created[0]!.id);
    expect(host.created.filter((agent) => !agent.labels[TEAM_ROLE_LABEL])).toHaveLength(1);
    expect((await makeKitchenService(root, host).startKitchen(input)).team.id).toBe(
      restored.team.id,
    );
  });

  it("rejects invalid paths, project profiles, packs and providers before creating a Boss", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const input = {
      title: "Kitchen",
      objective: "Ship it",
      cwd: root,
      provider: "codex",
      acceptanceCriteria: [{ id: "goal", text: "Goal works" }],
      idempotencyKey: "bad-request",
    };
    await expect(service.startKitchen({ ...input, cwd: join(root, "missing") })).rejects.toThrow();
    await expect(service.startKitchen({ ...input, packId: "missing" })).rejects.toThrow(
      /not installed/,
    );
    await mkdir(join(root, ".agent-factory"));
    await writeFile(join(root, ".agent-factory", "project.json"), "{ broken json");
    await expect(service.startKitchen(input)).rejects.toThrow();
    await rm(join(root, ".agent-factory"), { recursive: true });
    const rejected = new KitchenTestService({
      ...(host.options as unknown as KitchenTestOptions),
      storageRoot: root,
      validateProvider: async () => {
        throw new Error("Unknown provider");
      },
    });
    await expect(rejected.startKitchen(input)).rejects.toThrow("Unknown provider");
    expect(host.created).toHaveLength(0);
  });

  it("counts planners across all teams toward the four-Cook host cap and drains the queue", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const teams: TeamState[] = [];
    for (let i = 0; i < 5; i++)
      teams.push(
        await service.startTeam({ bossAgentId: "boss", title: `Team ${i}`, objective: "Plan" }),
      );
    await service.dispatchAll();
    expect(host.created).toHaveLength(4);
    expect(host.created.every((agent) => agent.labels[TEAM_ROLE_LABEL] === "po")).toBe(true);
    const first = host.created[0]!;
    await service.report(first.id, { outcome: "planned", summary: "No implementation needed" });
    await service.dispatchAll();
    expect(host.created).toHaveLength(5);
    const states = await Promise.all(teams.map((team) => service.status(team.team.id)));
    expect(
      states
        .flatMap(({ state }) => Object.values(state.bindings))
        .filter((binding) => binding.activeStartedAt),
    ).toHaveLength(4);
  });

  it("pauses only queued work but stop interrupts Cooks and rejects late reports", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const team = await service.startKitchen({
      title: "Control",
      objective: "Plan",
      cwd: root,
      provider: "codex",
      acceptanceCriteria: [{ id: "goal", text: "Goal works" }],
      idempotencyKey: "control",
    });
    await service.dispatchAll();
    const cook = host.created.find((agent) => agent.labels[TEAM_ROLE_LABEL])!;
    await service.controlKitchen(team.team.id, "pause", "operator");
    expect(host.interrupted).toEqual([]);
    await service.controlKitchen(team.team.id, "stop", "operator");
    expect(host.interrupted).toContain(cook.id);
    await expect(service.report(cook.id, { outcome: "planned", summary: "Late" })).rejects.toThrow(
      /not seated/,
    );
    const stopped = (await service.status(team.team.id)).state;
    expect(stopped.team.kitchen?.stopped).toBe(true);
    expect(
      Object.values(stopped.decisions).some((decision) =>
        ["pending", "retry", "leased"].includes(decision.status),
      ),
    ).toBe(false);
    await service.controlKitchen(team.team.id, "resume", "operator");
    await service.dispatchAll();
    expect(host.created.filter((agent) => agent.labels[TEAM_ROLE_LABEL])).toHaveLength(2);
    await service.controlKitchen(team.team.id, "cancel", "operator");
    await expect(service.controlKitchen(team.team.id, "resume", "operator")).rejects.toThrow(
      /cannot resume/,
    );
  });

  it("persists active time, excludes paused queue time and stops a role at 60 minutes", async () => {
    const host = kitchenFakeHost();
    const initial = Date.now() - 60_000;
    let now = new Date(initial);
    const service = new KitchenTestService({
      ...(host.options as unknown as KitchenTestOptions),
      storageRoot: root,
      now: () => now,
    });
    const team = await service.startTeam({
      bossAgentId: "boss",
      title: "Budget",
      objective: "Plan",
    });
    await service.controlKitchen(team.team.id, "pause", "operator");
    await service.dispatchAll();
    now = new Date(initial + 2 * 60 * 60_000);
    await service.healthAll();
    expect((await service.status(team.team.id)).state.team.runtime?.usage.activeMs).toBe(0);
    await service.controlKitchen(team.team.id, "resume", "operator");
    await service.dispatchAll();
    now = new Date(initial + 3 * 60 * 60_000);
    await service.healthAll();
    const state = (await service.status(team.team.id)).state;
    expect(state.team.runtime?.usage.activeMs).toBe(60 * 60_000);
    expect(state.team.status).toBe("paused");
    expect(state.team.runtime?.limitReason).toContain("60 minutes");
    expect(host.interrupted).toContain(host.created[0]!.id);
    const persisted = (await makeKitchenService(root, host).status(team.team.id)).state;
    expect(persisted.team.runtime).toEqual(state.team.runtime);
    await expect(service.controlKitchen(team.team.id, "resume", "operator")).rejects.toThrow(
      /limit reached/,
    );
  });

  it("accepts Verification only for the actual clean git HEAD", async () => {
    const git = promisify(execFile);
    const repo = join(root, "repo");
    await mkdir(repo);
    await git("git", ["-C", repo, "init", "-b", "main"]);
    await git("git", ["-C", repo, "config", "core.hooksPath", "/dev/null"]);
    await git("git", ["-C", repo, "config", "user.email", "kitchen-test@example.invalid"]);
    await git("git", ["-C", repo, "config", "user.name", "Kitchen test"]);
    await writeFile(join(repo, "result.txt"), "Verified result");
    await git("git", ["-C", repo, "add", "result.txt"]);
    await git("git", ["-C", repo, "commit", "-m", "Test input"]);
    let head = (await git("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    const host = kitchenFakeHost();
    const create = host.options.createAgent as unknown as KitchenTestOptions["createAgent"];
    const service = new KitchenTestService({
      ...(host.options as unknown as KitchenTestOptions),
      storageRoot: root,
      createAgent: async (input) => {
        const result = await create(input);
        if (input.worktree) {
          const cwd = join(root, result.snapshot.id);
          await git("git", ["-C", repo, "worktree", "add", "-b", result.snapshot.id, cwd, "main"]);
          host.records.get(result.snapshot.id)!.cwd = cwd;
          if (input.labels?.[TEAM_ROLE_LABEL] === "integrator") {
            await writeFile(join(cwd, "result.txt"), "Independent integration change");
            await git("git", ["-C", cwd, "add", "result.txt"]);
            await git("git", ["-C", cwd, "commit", "-m", "Integration conflict input"]);
          }
        }
        return result;
      },
    });
    const team = await service.startKitchen({
      title: "Physical verification",
      objective: "Verify",
      cwd: repo,
      provider: "codex",
      acceptanceCriteria: [{ id: "goal", text: "Goal works" }],
      idempotencyKey: "verify",
    });
    await service.dispatchAll();
    await expect(
      service.controlKitchen(team.team.id, "accept", "operator", {
        credential: "synthetic-test-operator-capability-32-chars",
        candidateCommit: "0".repeat(40),
      }),
    ).rejects.toThrow(/final verified candidate/);
    const planner = host.agentFor("po");
    await service.plan(planner.id, [
      {
        key: "A",
        title: "Result",
        objective: "Verify result",
        acceptanceCriteria: ["Result exists"],
      },
    ]);
    await service.report(planner.id, { outcome: "planned", summary: "One item" });
    await service.dispatchAll();
    let state = (await service.status(team.team.id)).state;
    const developer = host.agentFor("developer", "A", state);
    await writeFile(join(developer.cwd, "result.txt"), "Developer result");
    await git("git", ["-C", developer.cwd, "add", "result.txt"]);
    await git("git", ["-C", developer.cwd, "commit", "-m", "Developer change"]);
    head = (await git("git", ["-C", developer.cwd, "rev-parse", "HEAD"])).stdout.trim();
    await service.report(developer.id, {
      outcome: "done",
      summary: "Ready",
      artifacts: [{ kind: "commit", ref: head }],
    });
    await service.dispatchAll();
    state = (await service.status(team.team.id)).state;
    const firstReviewer = host.agentFor("reviewer", "A", state);
    await service.controlKitchen(team.team.id, "stop", "operator");
    await service.controlKitchen(team.team.id, "resume", "operator");
    await service.dispatchAll();
    const reviewer = host.created.findLast(
      (agent) => agent.labels[TEAM_ROLE_LABEL] === "reviewer",
    )!;
    expect(reviewer.id).not.toBe(firstReviewer.id);
    expect(reviewer.cwd).toBe(developer.cwd);
    expect(reviewer.cwd).not.toBe(repo);
    await service.report(reviewer.id, {
      outcome: "approve",
      summary: "Reviewed",
      artifacts: [{ kind: "commit", ref: head }],
    });
    await service.dispatchAll();
    state = (await service.status(team.team.id)).state;
    const verifier = host.agentFor("verifier", "A", state);
    await git("git", [
      "-C",
      verifier.cwd,
      "commit",
      "--allow-empty",
      "-m",
      "Unauthorized verifier mutation",
    ]);
    const tamperedHead = (
      await git("git", ["-C", verifier.cwd, "rev-parse", "HEAD"])
    ).stdout.trim();
    await expect(
      service.report(verifier.id, {
        outcome: "pass",
        summary: "Mutated verifier",
        artifacts: [{ kind: "commit", ref: tamperedHead }],
        criteria: itemByKey(state, "A").acceptanceCriteria.map((criterion) => ({
          id: criterion.id,
          met: true,
          evidence: "Untrusted claimed result",
        })),
      }),
    ).rejects.toThrow("protected-file");
    expect(
      (await service.store.get(team.team.id))!.items[itemByKey(state, "A").id]!.checks!.some(
        (check) => !check.passed,
      ),
    ).toBe(true);
    await service.shutdown();
    const replay = new KitchenTestService({
      ...host.options,
      storageRoot: root,
      controllerOverrides: {
        get: async (id) => {
          const record = host.records.get(id);
          return record ? { ...record, running: false } : null;
        },
        completion: async (id) =>
          id === verifier.id
            ? {
                report: {
                  outcome: "pass",
                  summary: "Recovered tampered verifier",
                  artifacts: [{ kind: "commit", ref: tamperedHead }],
                  criteria: itemByKey(state, "A").acceptanceCriteria.map((criterion) => ({
                    id: criterion.id,
                    met: true,
                    evidence: "Untrusted recovery claim",
                  })),
                },
              }
            : null,
      },
    });
    await replay.start();
    const recovered = (await replay.status(team.team.id)).state;
    expect(recovered.team.status).toBe("paused");
    expect(itemByKey(recovered, "A").phase).toBe("verify");
    expect(itemByKey(recovered, "A").checks!.some((check) => !check.passed)).toBe(true);
    expect(itemByKey(recovered, "A").pack.verifiedCommit).toBeUndefined();
    await replay.shutdown();
    await git("git", ["-C", verifier.cwd, "reset", "--hard", head]);
    await service.start();
    await service.controlKitchen(team.team.id, "resume", "operator");
    await service.dispatchAll();
    const payload = {
      outcome: "pass",
      summary: "Verified",
      artifacts: [{ kind: "commit" as const, ref: head }],
      criteria: itemByKey(state, "A").acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        met: true,
        evidence: "Read result.txt on final HEAD",
      })),
    };
    await expect(
      service.report(verifier.id, {
        ...payload,
        artifacts: [{ kind: "commit", ref: "a".repeat(40) }],
      }),
    ).rejects.toThrow(/current git HEAD/);
    await writeFile(join(verifier.cwd, "result.txt"), "Dirty result");
    await expect(service.report(verifier.id, payload)).rejects.toThrow(/clean worktree/);
    await git("git", ["-C", verifier.cwd, "restore", "result.txt"]);
    await expect(service.report(verifier.id, payload)).resolves.toContain("Report accepted");
    expect(itemByKey((await service.status(team.team.id)).state, "A").pack.verifiedCommit).toBe(
      head,
    );
    await service.dispatchAll();
    const integrator = host.created.find(
      (agent) => agent.labels[TEAM_ROLE_LABEL] === "integrator",
    )!;
    expect(integrator.cwd).not.toBe(repo);
    expect(
      (await git("git", ["-C", integrator.cwd, "ls-files", "--unmerged"])).stdout.trim(),
    ).not.toBe("");
    expect(host.prompts.find((prompt) => prompt.agentId === integrator.id)?.prompt).toContain(
      "Resolve any existing merge conflicts",
    );
    await writeFile(join(integrator.cwd, "result.txt"), "Combined result");
    await git("git", ["-C", integrator.cwd, "add", "result.txt"]);
    await git("git", ["-C", integrator.cwd, "commit", "-m", "Resolve integration conflict"]);
    const combinedHead = (
      await git("git", ["-C", integrator.cwd, "rev-parse", "HEAD"])
    ).stdout.trim();
    await service.report(integrator.id, {
      outcome: "done",
      summary: "Combined",
      artifacts: [{ kind: "commit", ref: combinedHead }],
    });
    await service.dispatchAll();
    state = (await service.status(team.team.id)).state;
    const finalVerifier = host.created.find(
      (agent) =>
        agent.labels[TEAM_ROLE_LABEL] === "verifier" &&
        agent.labels["agent-factory.team.item"] === state.team.rootItemId,
    )!;
    expect(finalVerifier.cwd).toBe(integrator.cwd);
    await service.report(finalVerifier.id, {
      outcome: "pass",
      summary: "Combined candidate verified",
      artifacts: [{ kind: "commit", ref: combinedHead }],
      criteria: state.items[state.team.rootItemId]!.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        met: true,
        evidence: "Verified combined candidate",
      })),
    });
    await service.dispatchAll();
    expect((await service.status(team.team.id)).state.items[state.team.rootItemId]!.phase).toBe(
      "ready-for-human",
    );
    await writeFile(join(integrator.cwd, "result.txt"), "Changed after verification");
    await expect(
      service.controlKitchen(team.team.id, "accept", "operator", {
        credential: "synthetic-test-operator-capability-32-chars",
        candidateCommit: combinedHead,
      }),
    ).rejects.toThrow(/clean worktree/);
    await git("git", ["-C", integrator.cwd, "add", "result.txt"]);
    await git("git", ["-C", integrator.cwd, "commit", "-m", "Changed candidate"]);
    await expect(
      service.controlKitchen(team.team.id, "accept", "operator", {
        credential: "synthetic-test-operator-capability-32-chars",
        candidateCommit: combinedHead,
      }),
    ).rejects.toThrow(/current git HEAD/);
    await git("git", ["-C", integrator.cwd, "checkout", combinedHead]);
    await expect(
      service.controlKitchen(team.team.id, "accept", "claimed-human", {
        credential: "wrong",
        candidateCommit: combinedHead,
      }),
    ).rejects.toThrow("credential rejected");
    expect((await service.store.get(team.team.id))!.team.kitchen?.acceptedCommit).toBeUndefined();
    const accepted = await service.controlKitchen(team.team.id, "accept", "operator", {
      credential: "synthetic-test-operator-capability-32-chars",
      candidateCommit: combinedHead,
    });
    expect(accepted.team.status).toBe("done");
    expect(accepted.items[accepted.team.rootItemId]!.phase).toBe("done");
    expect(accepted.team.kitchen?.acceptedCommit).toBe(combinedHead);
    expect(accepted.team.kitchen?.acceptedBy).toBe("operator");
    const acceptance = (await service.status(team.team.id)).events.filter(
      (event) => event.type === "team.accepted",
    );
    expect(acceptance).toHaveLength(1);
    expect(acceptance[0]!.actor).toEqual({ type: "human", id: "operator" });
    await service.controlKitchen(team.team.id, "accept", "operator", {
      credential: "synthetic-test-operator-capability-32-chars",
      candidateCommit: combinedHead,
    });
    expect(
      (await service.status(team.team.id)).events.filter((event) => event.type === "team.accepted"),
    ).toHaveLength(1);
  });

  it("commits delegated work with its report atomically and rejects requests in fixed mode", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const team = await service.startKitchen({
      title: "Delegation",
      objective: "Ship",
      cwd: root,
      provider: "codex",
      idempotencyKey: "delegation",
      workflowMode: "self-organizing",
      acceptanceCriteria: [{ id: "goal", text: "Works" }],
    });
    await service.dispatchAll();
    const po = host.agentFor("po");
    await service.report(po.id, { outcome: "planned", summary: "Plan" }, [
      { key: "A", title: "A Feature", objective: "Feature", acceptanceCriteria: ["Feature works"] },
    ]);
    await service.dispatchAll();
    let state = (await service.status(team.team.id)).state;
    const developer = host.agentFor("developer", "A", state);
    const request = {
      requestId: "helper",
      title: "Helper",
      objective: "Implement helper",
      acceptanceCriteria: ["Helper verified"],
    };
    await expect(
      service.report(developer.id, { outcome: "unknown", summary: "invalid" }, undefined, [
        request,
      ]),
    ).rejects.toThrow("Unknown outcome");
    state = (await service.status(team.team.id)).state;
    expect(Object.values(state.items).filter((item) => item.pack.workRequest)).toHaveLength(0);
    await service.report(
      developer.id,
      {
        outcome: "done",
        summary: "Need helper",
        needs: { kind: "split", text: "Helper required" },
      },
      undefined,
      [request],
    );
    await service.dispatchAll();
    state = (await service.status(team.team.id)).state;
    expect(itemByKey(state, "A").phase).toBe("waiting-for-work");
    expect(Object.values(state.items).filter((item) => item.pack.workRequest)).toHaveLength(1);
    const helper = Object.values(state.items).find((item) => item.pack.workRequest)!;
    const helperAgent = host.created.find(
      (agent) => agent.labels["agent-factory.team.item"] === helper.id,
    )!;
    await service.store.commit(team.team.id, (draft) => {
      draft.team.kitchen!.workflowMode = "fixed";
      return { events: [], result: null };
    });
    await expect(
      service.report(helperAgent.id, { outcome: "done", summary: "Request" }, undefined, [
        { ...request, requestId: "forbidden" },
      ]),
    ).rejects.toThrow("self-organizing");
    expect(Object.values((await service.status(team.team.id)).state.items)).toHaveLength(3);
  });

  it("rejects a Kitchen worker created in the source checkout before sending work", async () => {
    const host = kitchenFakeHost();
    const create = host.options.createAgent;
    host.options.createAgent = async (input) => {
      const result = await create(input);
      if (input.worktree) host.records.get(result.snapshot.id)!.cwd = root;
      return result;
    };
    const service = makeKitchenService(root, host);
    const team = await service.startKitchen({
      title: "Wrong checkout",
      objective: "Keep source untouched",
      cwd: root,
      provider: "codex",
      idempotencyKey: "checkout-guard",
      acceptanceCriteria: [{ id: "safe", text: "Source remains unchanged" }],
    });
    await service.dispatchAll();
    const po = host.agentFor("po");
    await service.report(po.id, { outcome: "planned", summary: "Planned" }, [
      { key: "change", title: "Change", objective: "Implement", acceptanceCriteria: ["Safe"] },
    ]);
    await service.dispatchAll();
    const worker = host.agentFor("developer");
    expect(worker).toBeDefined();
    expect(host.prompts.some((prompt) => prompt.agentId === worker.id)).toBe(false);
    expect(JSON.stringify((await service.status(team.team.id)).state.decisions)).toContain(
      "Kitchen checkout mismatch",
    );
  });

  it("does not synchronize metadata or pause closed Kitchen teams during recovery", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const team = await service.startKitchen({
      title: "Closed recovery",
      objective: "Stay closed",
      cwd: root,
      provider: "codex",
      idempotencyKey: "closed-recovery",
      acceptanceCriteria: [{ id: "closed", text: "Closed" }],
    });
    host.options.agentManager.updateAgentMetadata = async () => {
      throw new Error("Metadata unavailable");
    };
    for (const status of ["done", "canceled"] as const) {
      await service.store.commit(team.team.id, (draft) => {
        draft.team.status = status;
        return { events: [], result: null };
      });
      const before = await service.status(team.team.id);
      const reloaded = makeKitchenService(root, host);
      await reloaded.start();
      expect(await reloaded.status(team.team.id)).toEqual(before);
      await reloaded.shutdown();
    }
  });

  it("keeps completed and canceled teams unchanged when late usage exceeds a runtime limit", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const team = await service.startTeam({
      bossAgentId: "boss",
      title: "Closed runtime",
      objective: "Plan",
    });
    await service.dispatchAll();
    host.created[0]!.usageTotals = { inputTokens: 500_000, outputTokens: 100 };
    for (const status of ["done", "canceled"] as const) {
      await service.store.commit(team.team.id, (draft) => {
        draft.team.status = status;
        draft.team.runtime!.usage.activeMs = 5 * 60 * 60_000;
        return { events: [], result: null };
      });
      const before = await service.status(team.team.id);
      await service.healthAll();
      await service.dispatchAll();
      expect(await service.status(team.team.id)).toEqual(before);
      expect(host.interrupted).toEqual([]);
    }
  });

  it("stops at persisted aggregate and observed token limits without inventing missing usage", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const team = await service.startTeam({
      bossAgentId: "boss",
      title: "Aggregate",
      objective: "Plan",
    });
    await service.dispatchAll();
    await service.store.commit(team.team.id, (draft) => {
      draft.team.runtime!.usage.activeMs = 4 * 60 * 60_000;
      return { events: [], result: null };
    });
    await service.healthAll();
    expect((await service.status(team.team.id)).state.team.runtime?.limitReason).toContain(
      "four hours",
    );
    const another = await service.startTeam({
      bossAgentId: "boss",
      title: "Tokens",
      objective: "Plan",
    });
    await service.dispatchAll();
    let state = (await service.status(another.team.id)).state;
    expect(state.team.runtime?.usage.tokensAvailable).toBe(false);
    expect(state.team.runtime?.usage.observedTokens).toBeUndefined();
    const cook = host.created.find(
      (agent) => agent.labels["agent-factory.team"] === another.team.id,
    )!;
    cook.usageTotals = { inputTokens: 450_000, outputTokens: 50_000 };
    await service.healthAll();
    state = (await service.status(another.team.id)).state;
    expect(state.team.runtime?.usage.tokensAvailable).toBe(true);
    expect(state.team.runtime?.usage.observedTokens).toBe(500_000);
    expect(state.team.runtime?.limitReason).toContain("observed tokens");
  });
});

describe("Kitchen persisted schedule triggers", () => {
  let root: string;
  let now: Date;
  const managers: KitchenSchedules[] = [];
  const target = {
    title: "Scheduled job",
    objective: "Deliver result",
    cwd: "/repo",
    provider: "codex",
    acceptanceCriteria: [{ id: "works", text: "Works" }],
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "factory-schedules-"));
    now = new Date("2026-10-02T07:00:00Z");
  });
  afterEach(async () => {
    await Promise.all(managers.map((entry) => entry.stop()));
    managers.length = 0;
    await rm(root, { recursive: true, force: true });
  });
  function manager(startKitchen: TeamService["startKitchen"]) {
    const value = new KitchenSchedules({
      storageRoot: root,
      service: { startKitchen },
      now: () => now,
      timers: false,
    });
    managers.push(value);
    return value;
  }
  function state(id: string) {
    return { team: { id } } as TeamState;
  }
  it("persists a due slot before starting the same Kitchen and completes a bounded schedule", async () => {
    const seen: string[] = [];
    const scheduler = manager(async (input) => {
      const persisted = JSON.parse(await readFile(join(root, "schedules", "state.json"), "utf8"));
      const run = persisted.schedules[input.scheduleId!].runs[0];
      expect(run.status).toBe("running");
      expect(run.attempts).toBe(1);
      seen.push(input.idempotencyKey);
      return state("team_scheduled");
    });
    const schedule = await scheduler.save({
      name: "Nightly",
      cadence: { type: "every", everyMs: 60_000 },
      target,
      maxRuns: 1,
      actorId: "human",
    });
    now = new Date(now.getTime() + 60_000);
    await scheduler.tick();
    await scheduler.tick();
    const result = (await scheduler.list())[0];
    expect(seen).toEqual([`${schedule.id}:due:2026-10-02T07:01:00.000Z`]);
    expect(result.status).toBe("completed");
    expect(result.runs[0]).toMatchObject({
      status: "succeeded",
      teamId: "team_scheduled",
      error: null,
    });
    await expect(scheduler.control(schedule.id, "run-once", "human")).rejects.toThrow("limit");
  });
  it("recovers a lost successful kickoff response with the same durable key after reload", async () => {
    const teams = new Map<string, TeamState>();
    const calls: string[] = [];
    let lose = true;
    const startKitchen: TeamService["startKitchen"] = async (input) => {
      calls.push(input.idempotencyKey);
      const team = teams.get(input.idempotencyKey) ?? state("team_only");
      teams.set(input.idempotencyKey, team);
      if (lose) {
        lose = false;
        throw new Error("Response lost after Kitchen persisted");
      }
      return team;
    };
    const first = manager(startKitchen);
    const schedule = await first.save({
      name: "Retry",
      cadence: { type: "every", everyMs: 60_000 },
      target,
      actorId: "human",
    });
    await first.control(schedule.id, "run-once", "human");
    expect((await first.list())[0].runs[0].status).toBe("retry");
    await expect(first.control(schedule.id, "delete", "human")).rejects.toThrow("pending");
    await expect(first.save({ ...schedule, actorId: "human" })).rejects.toThrow("pending");
    await first.stop();
    now = new Date(now.getTime() + 60_000);
    const reloaded = manager(startKitchen);
    await reloaded.start();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(calls[1]);
    expect(teams.size).toBe(1);
    expect((await reloaded.list())[0].runs[0]).toMatchObject({
      status: "succeeded",
      attempts: 2,
      teamId: "team_only",
    });
  });
  it("deduplicates concurrent run-once calls, supports pause/resume/edit/delete and stops timers", async () => {
    let starts = 0;
    const scheduler = manager(async () => {
      starts++;
      return state("team_once");
    });
    const schedule = await scheduler.save({
      name: "Manual",
      cadence: { type: "every", everyMs: 60_000 },
      target,
      actorId: "human",
    });
    await scheduler.control(schedule.id, "pause", "human");
    now = new Date(now.getTime() + 120_000);
    await scheduler.tick();
    expect(starts).toBe(0);
    await Promise.all([
      scheduler.control(schedule.id, "run-once", "human"),
      scheduler.control(schedule.id, "run-once", "human"),
    ]);
    expect(starts).toBe(1);
    expect((await scheduler.list())[0].runs).toHaveLength(1);
    await scheduler.save({
      ...schedule,
      name: "Edited",
      cadence: { type: "cron", expression: "0 9 * * *", timezone: "Europe/Berlin" },
      actorId: "human",
    });
    const resumed = await scheduler.control(schedule.id, "resume", "human");
    expect(resumed!.status).toBe("active");
    expect(resumed!.nextRunAt).toBe("2026-10-03T07:00:00.000Z");
    await expect(scheduler.control(schedule.id, "pause", "")).rejects.toThrow("human");
    await scheduler.stop();
    now = new Date("2026-10-04T07:00:00Z");
    await scheduler.tick();
    expect(starts).toBe(1);
    expect(await scheduler.control(schedule.id, "delete", "human")).toBeNull();
    expect(await scheduler.list()).toEqual([]);
  });
  it("bounds failing kickoff retries, preserves their reason and refuses invalid cron/time zones", async () => {
    let starts = 0;
    const scheduler = manager(async () => {
      starts++;
      throw new Error("Provider unavailable");
    });
    const input = {
      name: "Broken",
      cadence: { type: "cron" as const, expression: "0 9 * * *", timezone: "Europe/Berlin" },
      target,
      actorId: "human",
    };
    await expect(
      scheduler.save({ ...input, cadence: { type: "cron", expression: "invalid" } }),
    ).rejects.toThrow();
    await expect(
      scheduler.save({
        ...input,
        cadence: { type: "cron", expression: "0 9 * * *", timezone: "Invalid/Zone" },
      }),
    ).rejects.toThrow("time zone");
    const schedule = await scheduler.save(input);
    await scheduler.control(schedule.id, "run-once", "human");
    now = new Date(now.getTime() + 60_000);
    await scheduler.tick();
    now = new Date(now.getTime() + 120_000);
    await scheduler.tick();
    await scheduler.tick();
    expect(starts).toBe(3);
    const result = (await scheduler.list())[0];
    expect(result.status).toBe("paused");
    expect(result.runs[0]).toMatchObject({
      status: "failed",
      attempts: 3,
      error: "Provider unavailable",
    });
  });
  it("runs one overdue slot and skips the missed backlog using the configured time zone", async () => {
    let starts = 0;
    const scheduler = manager(async () => {
      starts++;
      return state("team_due");
    });
    expect(
      computeNextRunAt(
        { type: "cron", expression: "0 9 * * *", timezone: "Europe/Berlin" },
        new Date("2026-10-01T07:01:00Z"),
      ).toISOString(),
    ).toBe("2026-10-02T07:00:00.000Z");
    await scheduler.save({
      name: "Daily",
      cadence: { type: "cron", expression: "0 9 * * *", timezone: "Europe/Berlin" },
      target,
      actorId: "human",
    });
    now = new Date("2026-10-05T08:00:00Z");
    await scheduler.tick();
    await scheduler.tick();
    expect(starts).toBe(1);
    expect((await scheduler.list())[0].nextRunAt).toBe("2026-10-06T07:00:00.000Z");
  });
});
