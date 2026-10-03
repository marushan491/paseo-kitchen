import { applyWorkflowDesign } from "./workflow-design.js";
import { definitionFromPack, packFromSnapshot } from "./workflow-definitions.js";
import { workflowHead } from "./workflow-runtime.js";
import { factorySettings } from "../shared/preferences.js";
import { AutonomySettingsSchema } from "../shared/preferences.js";
import { readHumanQuestion } from "../shared/question-policy.js";
import { workflowOf } from "./workflow-metadata.js";
import { workflowConnections, roleTemplate } from "../shared/role-builder.js";
import { FactoryWorkflowSchema, type RoleProfileOverride } from "../shared/factory-contracts.js";
import { kitchenPack } from "./pack.js";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  routingMode?: "auto" | "manual";
  routingNotice?: { status: "waiting"; reason: string; resetsAt: string };
}

function fakeHost(base = "/repo") {
  const records = new Map<string, FakeRecord>();
  records.set("boss", {
    id: "boss",
    provider: "codex",
    cwd: base,
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
        routingMode?: "auto" | "manual";
        worktree?: { worktreeName?: string };
      }) => {
        n += 1;
        const record: FakeRecord = {
          id: `agent-${n}`,
          provider: input.provider ?? "codex",
          cwd: input.worktree
            ? `${base}/.worktrees/${input.worktree.worktreeName}`
            : (input.cwd ?? base),
          labels: input.labels ?? {},
          currentModeId: input.mode,
          thinkingOptionId: input.thinking,
          routingMode: input.routingMode,
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
  it.each(["kitchen", "software-basic"])(
    "continues a %s optional question after sixty seconds without recording a human answer",
    async (packId) => {
      const host = fakeHost(root);
      let now = new Date("2099-10-03T10:00:00Z");
      const service = new TeamService({
        ...(host.options as unknown as TeamServiceOptions),
        storageRoot: root,
        inputActivitySupported: true,
        now: () => now,
      });
      await service.start();
      const team = await service.startTeam({
        bossAgentId: "boss",
        packId,
        title: "Autonomous feature",
        objective: "Implement the requested feature",
      });
      await service.dispatchAll();
      await service.report(host.agentFor("po").id, {
        outcome: "planned",
        summary: "Optional detail",
        needs: {
          kind: "human",
          category: "clarification",
          text: "Should the reversible button label be Save or Apply?",
        },
      });
      await service.dispatchAll();
      const question = readHumanQuestion(
        (await service.status(team.team.id)).state.items[team.team.rootItemId].pack
          .nativeHumanQuestion,
      )!;
      expect(question.continueAt).toBe("2099-10-03T10:01:00.000Z");
      now = new Date(now.getTime() + 59000);
      await service.dispatchAll();
      expect((await service.status(team.team.id)).state.items[team.team.rootItemId].phase).toBe(
        "blocked",
      );
      now = new Date(now.getTime() + 1000);
      await service.dispatchAll();
      const after = await service.status(team.team.id);
      expect(after.state.items[team.team.rootItemId].phase).toBe("plan");
      expect(
        after.state.items[team.team.rootItemId].reports.some(
          (report) => report.outcome === "answer",
        ),
      ).toBe(false);
      expect(after.events.filter((event) => event.type === "question.continued")).toHaveLength(1);
      expect(
        host.prompts.filter((entry) => entry.agentId !== "boss").map((entry) => entry.prompt),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Silence is not an answer or authorization"),
        ]),
      );
      await service.dispatchAll();
      expect(
        (await service.status(team.team.id)).events.filter(
          (event) => event.type === "question.continued",
        ),
      ).toHaveLength(1);
      await service.shutdown();
    },
  );

  it("keeps a started reply across service reload and honors wait mode and real access blockers", async () => {
    const host = fakeHost(root);
    let now = new Date("2099-10-03T10:00:00Z");
    let settings = AutonomySettingsSchema.parse({});
    const options = {
      ...(host.options as unknown as TeamServiceOptions),
      storageRoot: root,
      inputActivitySupported: true,
      now: () => now,
      autonomySettings: () => settings,
    };
    let service = new TeamService(options);
    await service.start();
    const team = await service.startTeam({
      bossAgentId: "boss",
      packId: "kitchen",
      title: "Reply protection",
      objective: "Deliver the feature",
    });
    await service.dispatchAll();
    await service.report(host.agentFor("po").id, {
      outcome: "planned",
      summary: "Optional",
      needs: { kind: "human", text: "Which reversible label should I use?" },
    });
    await service.dispatchAll();
    await service.noteInputActivity("foreign-agent");
    expect(
      readHumanQuestion(
        (await service.status(team.team.id)).state.items[team.team.rootItemId].pack
          .nativeHumanQuestion,
      )?.responseStartedAt,
    ).toBeUndefined();
    await service.noteInputActivity("boss");
    await service.shutdown();
    service = new TeamService(options);
    await service.start();
    now = new Date(now.getTime() + 120000);
    await service.dispatchAll();
    expect((await service.status(team.team.id)).state.items[team.team.rootItemId].phase).toBe(
      "blocked",
    );
    expect(
      readHumanQuestion(
        (await service.status(team.team.id)).state.items[team.team.rootItemId].pack
          .nativeHumanQuestion,
      )?.responseStartedAt,
    ).toBe("2099-10-03T10:00:00.000Z");
    await service.message(team.team.id, "Use Save", { type: "human", id: "operator" });
    await service.dispatchAll();
    let state = (await service.status(team.team.id)).state;
    let po = state.bindings[state.items[team.team.rootItemId].bindings.po].agentId;
    settings = AutonomySettingsSchema.parse({ optionalQuestionBehavior: "wait" });
    await service.report(po, {
      outcome: "planned",
      summary: "Optional",
      needs: { kind: "human", text: "Save or Apply?" },
    });
    now = new Date(now.getTime() + 120000);
    await service.dispatchAll();
    expect((await service.status(team.team.id)).state.items[team.team.rootItemId].phase).toBe(
      "blocked",
    );
    await service.message(team.team.id, "Use Apply", { type: "human", id: "operator" });
    await service.dispatchAll();
    state = (await service.status(team.team.id)).state;
    po = state.bindings[state.items[team.team.rootItemId].bindings.po].agentId;
    settings = AutonomySettingsSchema.parse({});
    await service.report(po, {
      outcome: "planned",
      summary: "Access missing",
      needs: { kind: "human", category: "access", text: "OAuth login needs your consent" },
    });
    now = new Date(now.getTime() + 3600000);
    await service.dispatchAll();
    expect((await service.status(team.team.id)).state.items[team.team.rootItemId].phase).toBe(
      "blocked",
    );
    await service.shutdown();
  });

  it("never automatically resumes questions without cross-client input protection", async () => {
    const host = fakeHost(root);
    let now = new Date("2099-10-03T10:00:00Z");
    const service = new TeamService({
      ...(host.options as unknown as TeamServiceOptions),
      storageRoot: root,
      now: () => now,
    });
    await service.start();
    const team = await service.startTeam({
      bossAgentId: "boss",
      packId: "kitchen",
      title: "Old host",
      objective: "Preserve replies",
    });
    await service.dispatchAll();
    await service.report(host.agentFor("po").id, {
      outcome: "planned",
      summary: "Question",
      needs: { kind: "human", text: "Save or Apply?" },
    });
    now = new Date(now.getTime() + 120000);
    await service.dispatchAll();
    expect((await service.status(team.team.id)).state.items[team.team.rootItemId].phase).toBe(
      "blocked",
    );
    expect(service.autonomyGuidance()).toContain("wait for the operator");
    await service.shutdown();
  });
  it("tracks provider questions only for Kitchen agents, preserves recovered drafts and expires optional questions once", async () => {
    const host = fakeHost(root);
    let now = new Date("2099-10-03T10:00:00Z");
    const resumeProviderQuestion = vi.fn(async () => true);
    const service = new TeamService({
      ...(host.options as unknown as TeamServiceOptions),
      storageRoot: root,
      inputActivitySupported: true,
      now: () => now,
      resumeProviderQuestion,
    });
    await service.start();
    const team = await service.startTeam({
      bossAgentId: "boss",
      title: "Question handling",
      objective: "Keep independent work moving",
    });
    await service.trackProviderQuestion("unrelated-chat", { id: "foreign", text: "Label?" });
    await service.trackProviderQuestion("boss", { id: "optional", text: "Save or Apply?" });
    await service.trackProviderQuestion("boss", { id: "started", text: "Blue or purple?" });
    await service.trackProviderQuestion("boss", {
      id: "started",
      text: "Blue or purple?",
      responseStartedAt: now.toISOString(),
    });
    await service.trackProviderQuestion("boss", {
      id: "access",
      text: "Please complete OAuth consent",
    });
    now = new Date(now.getTime() + 60000);
    await service.dispatchAll();
    expect(resumeProviderQuestion).toHaveBeenCalledExactlyOnceWith(
      "boss",
      "optional",
      expect.stringContaining("Silence is not an answer or authorization"),
    );
    const questions = (await service.status(team.team.id)).state.items[team.team.rootItemId].pack
      .providerHumanQuestions as Record<string, unknown>;
    expect(Object.keys(questions).sort()).toEqual(["boss:access", "boss:started"]);
    await service.dispatchAll();
    expect(resumeProviderQuestion).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });
  it("retries provider continuation delivery across reload after a guarded dismissal", async () => {
    const host = fakeHost(root);
    let now = new Date("2099-10-03T10:00:00Z");
    let unavailable = true;
    const send = vi.fn(async (_agentId: string, prompt: string) => {
      if (prompt.includes("Silence is not an answer or authorization") && unavailable)
        throw new Error("Disconnected");
    });
    const resumeProviderQuestion = vi.fn(async () => true);
    const options = {
      ...(host.options as unknown as TeamServiceOptions),
      controller: {
        ...(host.options.controller as unknown as TeamServiceOptions["controller"]),
        send,
      },
      storageRoot: root,
      inputActivitySupported: true,
      now: () => now,
      resumeProviderQuestion,
    };
    let service = new TeamService(options);
    await service.start();
    const team = await service.startTeam({
      bossAgentId: "boss",
      title: "Delivery retry",
      objective: "Continue safely",
    });
    await service.trackProviderQuestion("boss", { id: "optional", text: "Save or Apply?" });
    now = new Date(now.getTime() + 60000);
    await service.dispatchAll();
    const before = await service.status(team.team.id);
    expect(before.events.filter((event) => event.type === "question.continued")).toHaveLength(0);
    expect(
      Object.keys(
        before.state.items[team.team.rootItemId].pack.autonomyMessages as Record<string, unknown>,
      ),
    ).toHaveLength(1);
    await service.shutdown();
    unavailable = false;
    service = new TeamService(options);
    await service.start();
    await service.dispatchAll();
    const after = await service.status(team.team.id);
    expect(after.state.items[team.team.rootItemId].pack.autonomyMessages).toEqual({});
    expect(after.events.filter((event) => event.type === "question.continued")).toHaveLength(1);
    expect(resumeProviderQuestion).toHaveBeenCalledTimes(1);
    const attempts = send.mock.calls.filter((call) =>
      call[1].includes("Silence is not an answer or authorization"),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0].slice(2)).toEqual(attempts[1].slice(2));
    await service.shutdown();
  });
  it("keeps equal provider request IDs isolated to their actual active agents", async () => {
    const host = fakeHost(root);
    let now = new Date("2099-10-03T10:00:00Z");
    const resumeProviderQuestion = vi.fn(async () => true);
    const service = new TeamService({
      ...(host.options as unknown as TeamServiceOptions),
      storageRoot: root,
      inputActivitySupported: true,
      now: () => now,
      resumeProviderQuestion,
    });
    await service.start();
    const team = await service.startTeam({
      bossAgentId: "boss",
      title: "Isolated questions",
      objective: "Keep agent identities",
    });
    await service.dispatchAll();
    const worker = host.agentFor("po");
    await service.trackProviderQuestion("boss", { id: "same", text: "Save or Apply?" });
    await service.trackProviderQuestion(worker.id, { id: "same", text: "Blue or purple?" });
    await service.noteInputActivity(worker.id, "same");
    now = new Date(now.getTime() + 60000);
    await service.dispatchAll();
    expect(resumeProviderQuestion).toHaveBeenCalledExactlyOnceWith(
      "boss",
      "same",
      expect.any(String),
    );
    await service.store.commit(team.team.id, (draft) => {
      for (const binding of Object.values(draft.bindings)) binding.status = "revoked";
      return { events: [], result: null };
    });
    expect(await service.isManagedAgent(worker.id)).toBe(false);
    await service.shutdown();
  });
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pandaos-team-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(["continue", "wait"] as const)(
    "dispatches independent ready work immediately while an access question waits under %s policy",
    async (optionalQuestionBehavior) => {
      const host = fakeHost(root);
      const svc = new TeamService({
        ...(host.options as unknown as TeamServiceOptions),
        storageRoot: root,
        inputActivitySupported: true,
        maxConcurrentAgents: () => 1,
        autonomySettings: () => AutonomySettingsSchema.parse({ optionalQuestionBehavior }),
      });
      await svc.start();
      const started = await svc.startTeam({
        bossAgentId: "boss",
        title: "Independent access checks",
        objective: "Complete scoped independent tasks",
      });
      await svc.trackProviderQuestion("boss", { id: "login", text: "Complete OAuth login" });
      await svc.dispatchAll();
      const po = host.agentFor("po");
      expect(po).toBeDefined();
      await svc.report(po.id, { outcome: "planned", summary: "Three scoped tasks" }, [
        {
          key: "A",
          title: "Authenticated import",
          objective: "Read authenticated source",
          acceptanceCriteria: ["Source read"],
        },
        {
          key: "B",
          title: "Local display",
          objective: "Build local display independently",
          acceptanceCriteria: ["Display works"],
        },
        {
          key: "C",
          title: "Import display",
          objective: "Display authenticated source",
          acceptanceCriteria: ["Imported source shown"],
          dependsOn: ["A"],
        },
      ]);
      await svc.dispatchAll();
      const before = (await svc.status(started.team.id)).state;
      const work = itemByKey(before, "A");
      expect(work.phase).toBe("implement");
      expect(itemByKey(before, "B").phase).toBe("ready");
      const developer = host.agentFor("developer", "A", before);
      await svc.report(developer.id, {
        outcome: "done",
        summary: "Configured source requires user login",
        needs: { kind: "human", category: "access", text: "Complete OAuth login" },
      });
      await svc.dispatchAll();
      const after = (await svc.status(started.team.id)).state;
      expect(after.team.status).toBe("active");
      expect(after.items[work.id]!.phase).toBe("blocked");
      const question = readHumanQuestion(after.items[work.id]!.pack.nativeHumanQuestion)!;
      expect(question.category).toBe("access");
      expect(question.continueAt).toBeUndefined();
      expect(itemByKey(after, "B").phase).toBe("implement");
      expect(host.agentFor("developer", "B", after)).toBeDefined();
      expect(itemByKey(after, "C").phase).toBe("ready");
      expect(host.agentFor("developer", "C", after)).toBeUndefined();
      expect(
        (
          after.items[after.team.rootItemId]!.pack.providerHumanQuestions as Record<string, unknown>
        )["boss:login"],
      ).toBeDefined();
      expect(after.items[work.id]!.reports.some((report) => report.outcome === "answer")).toBe(
        false,
      );
      await svc.shutdown();
    },
  );

  it.each([
    { name: "inherits Chef Auto", override: undefined, expected: "auto" },
    {
      name: "inherits Chef Auto with role instructions",
      override: { instructions: "Inspect requirements" },
      expected: "auto",
    },
    {
      name: "fixes an explicit provider and model",
      override: { provider: "opencode", model: "opencode/free-test-model" },
      expected: "manual",
    },
    {
      name: "fixes an explicit model",
      override: { model: "opencode/other-free-test-model" },
      expected: "manual",
    },
    {
      name: "honors explicit role Auto",
      override: { provider: "opencode", model: "opencode/free-test-model", routingMode: "auto" },
      expected: "auto",
    },
    { name: "honors explicit role Fixed", override: { routingMode: "manual" }, expected: "manual" },
  ])("Cook routing $name", async ({ override, expected }) => {
    const host = fakeHost(root);
    const boss = (await host.options.controller.get("boss"))!;
    boss.provider = "opencode";
    boss.runtimeInfo = { model: "opencode/free-test-model" };
    boss.labels["pandaos.routing.mode"] = "auto";
    const svc = makeService(root, host);
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Inventory search",
      objective: "Implement inventory search",
      roleProfiles: override ? { po: override as RoleProfileOverride } : undefined,
    });
    await svc.dispatchAll();
    expect(started.team.roleProfiles.po!.routingMode).toBe(expected);
    const po = host.agentFor("po");
    expect(po.routingMode).toBe(expected);
    const binding = Object.values((await svc.status(started.team.id)).state.bindings).find(
      (entry) => entry.agentId === po.id,
    )!;
    expect(binding.executedProfile!.routingMode).toBe(expected);
    await svc.shutdown();
  });

  it("persists Auto role presets and fixes legacy provider presets without an Auto selection", async () => {
    const svc = makeService(root, fakeHost(root));
    await svc.profiles.save({
      id: "automatic",
      name: "Automatic planner",
      profile: { provider: "opencode", model: "opencode/free-test-model", routingMode: "auto" },
    });
    await svc.profiles.save({
      id: "fixed",
      name: "Fixed planner",
      profile: { provider: "opencode", model: "opencode/free-test-model" },
    });
    const restored = makeService(root, fakeHost(root));
    const base = {
      provider: "opencode",
      model: "opencode/other-free-test-model",
      routingMode: "auto" as const,
    };
    expect(await restored.profiles.resolve(base, { workflowProfileId: "automatic" })).toMatchObject(
      { routingMode: "auto", model: "opencode/free-test-model" },
    );
    expect(await restored.profiles.resolve(base, { workflowProfileId: "fixed" })).toMatchObject({
      routingMode: "manual",
      model: "opencode/free-test-model",
    });
  });

  it("maps a named role to an executable slot, carries its brief into the actual prompt and keeps verification returns", async () => {
    const host = fakeHost();
    const svc = makeService(root, host);
    const workflow = FactoryWorkflowSchema.parse(workflowOf(kitchenPack));
    const profile = roleTemplate(workflow, "po", "technical-planner");
    profile.name = "Technical planner";
    profile.brief = {
      task: "Plan an accessible settings flow",
      responsibility: "Own scoped tasks and dependencies",
      outcome: "Return an observable plan with criterion evidence",
    };
    await svc.saveProfile(profile, root);
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Settings",
      objective: "Improve settings",
      roleProfiles: { po: { workflowProfileId: profile.id } },
    });
    await svc.dispatchAll();
    const prompt = host.prompts.find((entry) => entry.agentId === host.agentFor("po").id)!.prompt;
    expect(prompt).toContain("Role: Technical planner");
    expect(prompt).toContain("Task: Plan an accessible settings flow");
    expect(prompt).toContain("Responsibility: Own scoped tasks and dependencies");
    expect(prompt).toContain("Expected outcome: Return an observable plan with criterion evidence");
    expect(prompt).toContain("factory-report");
    await expect(
      svc.configureWork(
        started.team.id,
        started.team.rootItemId,
        "developer",
        { workflowProfileId: profile.id },
        "human",
      ),
    ).rejects.toThrow("mapped to po, not developer");
    const restored = makeService(root, host);
    expect((await restored.profiles.list())[0]).toMatchObject({
      name: profile.name,
      targetRole: "po",
      brief: profile.brief,
    });
    await svc.saveProfile(roleTemplate(workflow, "developer", "single-builder"), root);
    await expect(
      svc.profiles.resolve(
        { provider: "codex" },
        { workflowProfileId: "single-builder" },
        "integrator",
        "kitchen-single",
      ),
    ).resolves.toMatchObject({ provider: "codex", workflowProfileId: "single-builder" });
    const edges = workflowConnections(workflow);
    expect(edges).toContainEqual({
      id: "item:review:changes",
      board: "item",
      from: "review",
      to: "implement",
      label: "changes",
    });
    expect(edges).toContainEqual({
      id: "root:verify:fail",
      board: "root",
      from: "verify",
      to: "integrate",
      label: "fail",
    });
    expect(edges).toContainEqual({
      id: "root:execute:all child results verified",
      board: "root",
      from: "execute",
      to: "integrate",
      label: "all child results verified",
    });
    await svc.shutdown();
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
          skills: ["paseo-plugin"],
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
      routingMode: "manual",
      currentModeId: "read-only",
      thinkingOptionId: "high",
    });
    const prompt = host.prompts.find((entry) => entry.agentId === po.id)!.prompt;
    expect(prompt).toContain("Keep tasks bounded");
    expect(prompt).toContain("paseo-plugin");
    expect(prompt).toContain("harness's installed skills");
    expect(prompt.indexOf("1. Inspect [inspect]")).toBeLessThan(prompt.indexOf("2. Plan [plan]"));
    const configured = await svc.configureWork(
      started.team.id,
      started.team.rootItemId,
      "po",
      { instructions: "Next binding only", thinking: "low", routingMode: "auto" },
      "human",
    );
    const binding = Object.values(configured.bindings).find((entry) => entry.agentId === po.id)!;
    expect(binding.executedProfile).toMatchObject({
      instructions: "Keep tasks bounded",
      thinking: "high",
      routingMode: "manual",
    });
    expect(configured.items[started.team.rootItemId]!.roleProfiles!.po).toMatchObject({
      instructions: "Next binding only",
      thinking: "low",
      routingMode: "auto",
    });
    expect(po.thinkingOptionId).toBe("high");
    expect(po.routingMode).toBe("manual");
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

  it.each(["auth/login.ts", "README.md"])(
    "runs the saved conditional workflow against actual changed file %s",
    async (changedFile) => {
      const source = join(root, "source");
      await mkdir(source);
      const git = promisify(execFile);
      await git("git", ["init", source]);
      await git("git", ["-C", source, "config", "user.name", "Workflow fixture"]);
      await git("git", ["-C", source, "config", "user.email", "fixture@example.invalid"]);
      await writeFile(join(source, "README.md"), "Initial");
      await git("git", ["-C", source, "add", "README.md"]);
      await git("git", ["-C", source, "commit", "-m", "Initial"]);
      const host = fakeHost(source),
        create = host.options.controller.create;
      host.options.controller.create = async (input) => {
        const result = await create(input),
          record = await host.options.controller.get(result.id);
        if (input.worktree) {
          await mkdir(join(source, ".worktrees"), { recursive: true });
          await git("git", ["-C", source, "worktree", "add", "--detach", record!.cwd, "HEAD"]);
        }
        return result;
      };
      const svc = new TeamService({ ...host.options, storageRoot: root });
      const definition = await svc.workflows.save(
        applyWorkflowDesign(
          definitionFromPack(kitchenPack, "secure-team"),
          "security",
          "Review authentication changes",
        ),
        0,
      );
      const started = await svc.startTeam({
        bossAgentId: "boss",
        title: "Workflow",
        objective: "Implement safely",
        workflowSnapshot: definition,
      });
      await svc.dispatchAll();
      const po = host.agentFor("po");
      await svc.plan(po.id, [
        {
          key: "A",
          title: "Implementation",
          objective: "Change one file",
          acceptanceCriteria: ["works"],
        },
      ]);
      await svc.report(po.id, { outcome: "planned", summary: "One item" });
      await svc.dispatchAll();
      const developer = host.agentFor("developer");
      if (changedFile.includes("/")) await mkdir(join(developer.cwd, "auth"));
      await writeFile(join(developer.cwd, changedFile), "Implemented");
      await git("git", ["-C", developer.cwd, "add", changedFile]);
      await git("git", ["-C", developer.cwd, "commit", "-m", "Implement"]);
      await svc.report(developer.id, { outcome: "done", summary: "Implementation committed" });
      await svc.dispatchAll();
      await svc.report(host.agentFor("reviewer").id, { outcome: "approve", summary: "Reviewed" });
      await svc.dispatchAll();
      const state = (await svc.status(started.team.id)).state,
        item = itemByKey(state, "A");
      expect(state.team.workflowSnapshot!.revision).toBe(1);
      expect(item.pack.workflowCondition).toMatchObject({
        files: [changedFile],
        candidateCommit: await workflowHead(developer.cwd),
        matches: changedFile.startsWith("auth/"),
      });
      expect(item.pack.workflowConditions).toMatchObject({
        "item:security-review": {
          matches: changedFile.startsWith("auth/"),
          skipped: !changedFile.startsWith("auth/"),
          phaseEnteredAt: item.phaseHistory.findLast((entry) => entry.phase === "security-review")!
            .enteredAt,
        },
      });
      if (changedFile.startsWith("auth/")) {
        expect(host.agentFor("security-reviewer")).toBeDefined();
        expect(item.phase).toBe("security-review");
        const security = host.agentFor("security-reviewer");
        await svc.report(security.id, {
          outcome: "pass",
          summary: "Clarification needed",
          needs: {
            kind: "head-chef",
            category: "clarification",
            text: "May I use the existing authentication contract?",
          },
        });
        const blocked = (await svc.status(started.team.id)).state.items[item.id];
        const pending = blocked.pack.headChefQuestion as {
          requestId: string;
          workItemId: string;
          revision: number;
        };
        expect(blocked.phase).toBe("blocked");
        expect(host.prompts.at(-1)!.agentId).toBe("boss");
        const answer = {
          outcome: "head-chef-answer",
          summary: JSON.stringify({
            ...pending,
            answer: "Use the existing contract within the declared goal.",
          }),
        };
        expect(await svc.acceptHeadChefAnswer("foreign-agent", answer)).toBe(false);
        expect(await svc.acceptHeadChefAnswer("boss", answer)).toBe(true);
        await svc.dispatchAll();
        expect((await svc.status(started.team.id)).state.items[item.id].phase).toBe(
          "security-review",
        );
        expect(host.prompts.filter((prompt) => prompt.agentId === security.id)).toHaveLength(2);
        await expect(svc.acceptHeadChefAnswer("boss", answer)).rejects.toThrow("stale");
      } else {
        expect(host.agentFor("security-reviewer")).toBeUndefined();
        expect(host.agentFor("verifier")).toBeDefined();
        expect(item.phase).toBe("verify");
      }
      const changed = applyWorkflowDesign(definition, "database", "Check migrations");
      await svc.workflows.save(changed, 1);
      expect((await svc.status(started.team.id)).state.team.workflowSnapshot!.revision).toBe(1);
      expect(
        packFromSnapshot((await svc.status(started.team.id)).state.team.workflowSnapshot!).roles[
          "database-reviewer"
        ],
      ).toBeUndefined();
      await svc.shutdown();
    },
  );

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

  it("dispatches twelve configured capacity slots and restores persisted capacity after reload", async () => {
    const settingsPath = join(root, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify(factorySettings.schema.parse({ maxConcurrentAgents: 12 })),
    );
    const readSettings = async () =>
      factorySettings.schema.parse(JSON.parse(await readFile(settingsPath, "utf8")));
    const source = join(root, "source");
    await mkdir(source);
    const host = fakeHost(source);
    const create = host.options.controller.create;
    host.options.controller.create = async (input) => {
      const result = await create(input);
      const record = await host.options.controller.get(result.id);
      await mkdir(record!.cwd, { recursive: true });
      return result;
    };
    let configured = (await readSettings()).maxConcurrentAgents;
    const options = { ...host.options, storageRoot: root, maxConcurrentAgents: () => configured };
    let svc = new TeamService(options);
    await svc.start();
    const started = await svc.startTeam({
      bossAgentId: "boss",
      title: "Capacity",
      objective: "Thirteen independent items",
      packId: "kitchen",
    });
    await svc.dispatchAll();
    const po = host.agentFor("po");
    await svc.plan(
      po.id,
      Array.from({ length: 13 }, (_, index) => ({
        key: `item-${index}`,
        title: `Item ${index}`,
        objective: "Implement independently",
        acceptanceCriteria: ["works"],
      })),
    );
    await svc.report(po.id, { outcome: "planned", summary: "Thirteen independent items" });
    await svc.dispatchAll();
    const state = (await svc.status(started.team.id)).state;
    expect(
      Object.values(state.items).filter((item) => item.parentId && item.phase === "implement"),
    ).toHaveLength(12);
    expect(itemByKey(state, "item-12").phase).toBe("ready");
    expect(state.team.runtime!.limits.maxActiveCooks).toBe(12);
    expect(Object.values(state.bindings).filter((binding) => binding.activeStartedAt)).toHaveLength(
      12,
    );
    expect(host.prompts).toHaveLength(13);
    await svc.store.commit(started.team.id, (draft) => {
      draft.team.runtime!.limits.maxActiveCooks = 4;
      return { events: [], result: null };
    });
    await svc.shutdown();
    configured = (await readSettings()).maxConcurrentAgents;
    svc = new TeamService({
      ...options,
      controller: {
        ...options.controller,
        get: async (id) => {
          const record = await options.controller.get(id);
          return record ? { ...record, running: id !== "boss" } : null;
        },
      },
    });
    await svc.start();
    const recovered = (await svc.status(started.team.id)).state;
    expect(recovered.team.runtime!.limits.maxActiveCooks).toBe(12);
    expect(
      Object.values(recovered.bindings).filter((binding) => binding.activeStartedAt),
    ).toHaveLength(12);
    await svc.shutdown();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects invalid capacity %s before dispatch or creating agents",
    async (capacity) => {
      expect(factorySettings.schema.safeParse({ maxConcurrentAgents: capacity }).success).toBe(
        false,
      );
      const host = fakeHost();
      const svc = new TeamService({
        ...host.options,
        storageRoot: root,
        maxConcurrentAgents: () => capacity,
      });
      await expect(svc.start()).rejects.toThrow("positive safe integer");
      expect(host.created).toHaveLength(0);
      await svc.shutdown();
    },
  );

  it.each([12, 16, 20, Number.MAX_SAFE_INTEGER])(
    "persists positive safe capacity %s without clamping",
    async (capacity) => {
      const path = join(root, "capacity.json");
      await writeFile(
        path,
        JSON.stringify(factorySettings.schema.parse({ maxConcurrentAgents: capacity })),
      );
      expect(
        factorySettings.schema.parse(JSON.parse(await readFile(path, "utf8"))).maxConcurrentAgents,
      ).toBe(capacity);
    },
  );

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
          : (input.cwd ?? base),
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
  maxConcurrentAgents?: TeamServiceOptions["maxConcurrentAgents"];
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
      maxConcurrentAgents: options.maxConcurrentAgents,
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

  it.each(["research", "split"] as const)(
    "corrects an unregistered %s wait once without reporting the binding or trapping the Cook",
    async (kind) => {
      const host = kitchenFakeHost();
      const service = makeKitchenService(root, host);
      const started = await service.startKitchen({
        title: "Registered work only",
        objective: "Deliver verified scoped work",
        cwd: root,
        provider: "opencode",
        idempotencyKey: "research-correction",
        workflowMode: "self-organizing",
        acceptanceCriteria: [{ id: "goal", text: "Scoped work is verified" }],
      });
      await service.dispatchAll();
      await service.report(host.agentFor("po").id, { outcome: "planned", summary: "One item" }, [
        {
          key: "A",
          title: "Feature",
          objective: "Complete feature",
          acceptanceCriteria: ["Feature works"],
        },
      ]);
      await service.dispatchAll();
      const before = (await service.status(started.team.id)).state;
      const item = itemByKey(before, "A");
      const developer = host.agentFor("developer", "A", before);
      const bindingId = item.bindings.developer!;
      const agentsBefore = host.created.length;
      let feedback = "";
      try {
        await service.report(developer.id, {
          outcome: "done",
          summary: "Waiting for nonexistent child",
          needs: { kind, text: "A helper is investigating" },
        });
      } catch (error) {
        feedback = factoryValidationFeedback(error);
      }
      expect(feedback).toContain("unfinished registered work request");
      const rejected = (await service.status(started.team.id)).state;
      expect(rejected.items[item.id]!.phase).toBe("implement");
      expect(rejected.bindings[bindingId]!.turn).toBe("running");
      expect(rejected.items[item.id]!.reports).toEqual([]);
      expect(rejected.items[item.id]!.pack.nativeHumanQuestion).toBeUndefined();
      await service.onTurnEnded(started.team.id, developer.id, false, undefined, feedback);
      await service.dispatchAll();
      const retried = (await service.status(started.team.id)).state;
      expect(retried.bindings[bindingId]!.turn).toBe("running");
      expect(retried.bindings[bindingId]!.nudges).toBe(1);
      expect(host.created).toHaveLength(agentsBefore);
      expect(host.prompts.findLast((prompt) => prompt.agentId === developer.id)!.prompt).toContain(
        feedback,
      );
      expect(
        Object.values(retried.decisions).filter((decision) => decision.payload.nudge),
      ).toHaveLength(1);
      await service.report(
        developer.id,
        {
          outcome: "done",
          summary: "Actual scoped dependency registered",
          needs: { kind, text: "Waiting for the recorded child" },
        },
        undefined,
        [
          {
            requestId: "actual-helper",
            title: "Helper",
            objective: "Complete scoped helper",
            acceptanceCriteria: ["Helper is verified"],
          },
        ],
      );
      await service.dispatchAll();
      const waiting = (await service.status(started.team.id)).state;
      expect(waiting.items[item.id]!.phase).toBe("waiting-for-work");
      expect(waiting.bindings[bindingId]!.turn).toBe("reported");
      expect(
        Object.values(waiting.items).filter((child) => child.parentId === item.id),
      ).toHaveLength(1);
      expect(waiting.team.status).toBe("active");
    },
  );

  it("recovers a mixed research blocker through Team chat without replacing the plan or accepting missing evidence", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const started = await service.startKitchen({
      title: "Scoped inventory",
      objective: "Complete inventory before dependent work",
      cwd: root,
      provider: "opencode",
      idempotencyKey: "mixed-blocker",
      workflowMode: "self-organizing",
      acceptanceCriteria: [{ id: "goal", text: "Scoped work is verified" }],
    });
    await service.dispatchAll();
    await service.report(host.agentFor("po").id, { outcome: "planned", summary: "Scoped plan" }, [
      {
        key: "A",
        title: "Inventory",
        objective: "Verify builds and record public IDs",
        acceptanceCriteria: ["Phone shells build", "Unknown public IDs stay explicitly unknown"],
      },
      ...Array.from({ length: 31 }, (_, index) => ({
        key: `NEXT-${index}`,
        title: `Dependent task ${index}`,
        objective: "Deliver scoped dependent behavior",
        acceptanceCriteria: ["Behavior works"],
        dependsOn: ["A"],
      })),
    ]);
    await service.dispatchAll();
    const initial = (await service.status(started.team.id)).state;
    const inventory = itemByKey(initial, "A");
    const originalItems = Object.keys(initial.items).sort();
    const developer = host.agentFor("developer", "A", initial);
    developer.workspaceId = "owned-inventory-workspace";
    const ownedCwd = developer.cwd;
    await service.report(developer.id, {
      outcome: "done",
      summary: "Inventory recorded with unknown portal ID; simulator evidence missing",
      needs: {
        kind: "human",
        text: "Waiting for an unregistered simulator child and a portal issuer ID",
      },
    });
    await service.dispatchAll();
    await service.store.commit(started.team.id, (draft) => {
      delete draft.items[inventory.id]!.pack.nativeHumanQuestion;
      return { events: [], result: null };
    });
    const blocked = (await service.status(started.team.id)).state;
    expect(blocked.items[inventory.id]!.phase).toBe("blocked");
    expect(blocked.items[inventory.id]!.pack.nativeHumanQuestion).toBeUndefined();
    expect(Object.values(blocked.items).filter((item) => item.parentId === inventory.id)).toEqual(
      [],
    );
    expect(
      Object.values(blocked.decisions).every(
        (decision) => !["retry", "failed"].includes(decision.status),
      ),
    ).toBe(true);
    const agentsBefore = host.created.length;
    const instruction =
      "Continue inventory against its actual criteria. Unknown IDs remain unknown. Register the missing simulator workRequest; portal login remains unresolved and belongs only to work that requires it. Continue satisfiable work without inventing evidence.";
    await service.message(started.team.id, instruction, { type: "human", id: "operator" });
    await service.dispatchAll();
    const resumed = (await service.status(started.team.id)).state;
    expect(Object.keys(resumed.items).sort()).toEqual(originalItems);
    expect(resumed.items[inventory.id]!.phase).toBe("implement");
    expect(resumed.items[inventory.id]!.bindings.developer).toBe(inventory.bindings.developer);
    expect(host.created).toHaveLength(agentsBefore);
    expect(host.records.get(developer.id)).toMatchObject({
      cwd: ownedCwd,
      workspaceId: "owned-inventory-workspace",
    });
    expect(
      resumed.items[inventory.id]!.acceptanceCriteria.every(
        (criterion) => !criterion.met && !criterion.evidence,
      ),
    ).toBe(true);
    expect(host.prompts.findLast((prompt) => prompt.agentId === developer.id)!.prompt).toContain(
      instruction,
    );
    const request = {
      requestId: "simulator-finish",
      title: "Finish simulator build evidence",
      objective: "Execute the missing authorized simulator build",
      acceptanceCriteria: ["Actual build transcript identifies the candidate"],
    };
    await service.requestWork(developer.id, request);
    await service.requestWork(developer.id, request);
    await service.report(developer.id, {
      outcome: "done",
      summary: "Waiting for recorded verification work",
      needs: { kind: "research", text: "Simulator evidence must be verified" },
    });
    await service.dispatchAll();
    const waiting = (await service.status(started.team.id)).state;
    expect(waiting.items[inventory.id]!.phase).toBe("waiting-for-work");
    const children = Object.values(waiting.items).filter((item) => item.parentId === inventory.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.phase).toBe("implement");
    expect(originalItems.every((id) => waiting.items[id])).toBe(true);
    expect(
      Object.values(waiting.items)
        .filter((item) => item.pack.key?.toString().startsWith("NEXT-"))
        .every((item) => item.phase === "ready" && item.dependsOn[0]!.id === inventory.id),
    ).toBe(true);
    expect(waiting.items[inventory.id]!.pack.verifiedCommit).toBeUndefined();
  });

  it("reuses a native HeadChef and deduplicates accepted followups without claiming human authority", async () => {
    const host = kitchenFakeHost();
    Object.assign(host.records.get("boss")!, {
      cwd: root,
      workspaceId: "native-workspace",
      title: "Existing chat",
    });
    const service = new KitchenTestService({
      ...host.options,
      storageRoot: root,
      resolveWorkspace: async () => ({ id: "native-workspace", cwd: root }),
    });
    const input = {
      title: "Kitchen mission",
      objective: "Implement the actual task",
      cwd: root,
      workspaceId: "native-workspace",
      sourceAgentId: "boss",
      headChefAgentId: "boss",
      provider: "codex",
      acceptanceCriteria: [{ id: "goal", text: "Task works" }],
      idempotencyKey: "native-start",
    };
    const started = await service.startKitchen(input);
    await service.dispatchAll();
    expect(started.team.bossAgentId).toBe("boss");
    expect(host.records.get("boss")!.title).toBe("Existing chat");
    expect(host.created.every((agent) => agent.labels[TEAM_ROLE_LABEL])).toBe(true);
    expect((await service.startKitchen(input)).team.id).toBe(started.team.id);
    await service.registerNativeInitialMessage(started.team.id, "native:native-start");
    await expect(service.registerNativeInitialMessage(started.team.id, "other")).rejects.toThrow(
      /another delivery/,
    );
    await service.acceptUserMessage({
      agentId: "boss",
      eventId: "native:native-start",
      text: input.objective,
    });
    const before = host.prompts.filter((prompt) => prompt.agentId === "boss").length;
    const followup = {
      agentId: "boss",
      eventId: "followup-1",
      origin: { kind: "client" as const },
      text: "Also preserve existing data",
      context: { attachments: [{ name: "spec.txt" }] },
    };
    await Promise.all([service.acceptUserMessage(followup), service.acceptUserMessage(followup)]);
    const state = (await service.status(started.team.id)).state;
    expect(state.team.objective.split(followup.text)).toHaveLength(2);
    expect(state.items[state.team.rootItemId].objective).toContain(followup.text);
    expect(host.prompts.filter((prompt) => prompt.agentId === "boss")).toHaveLength(before);
    expect(
      (await service.status(started.team.id)).events.filter(
        (event) => event.type === "conversation.context" && event.data?.eventId === "followup-1",
      ),
    ).toMatchObject([{ actor: { type: "boss", id: "boss" } }]);
    await expect(
      service.acceptUserMessage({ ...followup, text: "Different text" }),
    ).rejects.toThrow(/different content/);
    expect(await service.acceptUserMessage({ ...followup, agentId: "foreign" })).toBe(false);
    host.records.get("boss")!.title = "Actual task title";
    await service.syncNativeHeadChefTitle("boss");
    expect((await service.status(started.team.id)).state.team.title).toBe("Actual task title");
    await service.report(host.agentFor("po").id, {
      outcome: "planned",
      summary: "Need the user's desired behavior",
      needs: { kind: "human", category: "requirements", text: "What should this do?" },
    });
    expect((await service.status(started.team.id)).state.items[started.team.rootItemId].phase).toBe(
      "blocked",
    );
    await service.acceptUserMessage({
      agentId: "boss",
      eventId: "unknown-answer",
      text: "Answer without provenance",
    });
    expect((await service.status(started.team.id)).state.items[started.team.rootItemId].phase).toBe(
      "blocked",
    );
    await service.acceptUserMessage({
      agentId: "boss",
      eventId: "client-answer",
      text: "Preserve current behavior",
      origin: { kind: "client", clientType: "app" },
    });
    expect(
      (await service.status(started.team.id)).state.items[started.team.rootItemId].phase,
    ).not.toBe("blocked");
    await service.report(host.agentFor("po").id, {
      outcome: "planned",
      summary: "Need authorization",
      needs: { kind: "human", category: "irreversible", text: "Publish?" },
    });
    await service.acceptUserMessage({
      agentId: "boss",
      eventId: "unsafe-answer",
      text: "Yes",
      origin: { kind: "client" },
    });
    expect((await service.status(started.team.id)).state.items[started.team.rootItemId].phase).toBe(
      "blocked",
    );
    await service.shutdown();
    const reloaded = new KitchenTestService({
      ...host.options,
      storageRoot: root,
      resolveWorkspace: async () => ({ id: "native-workspace", cwd: root }),
    });
    await reloaded.registerNativeInitialMessage(started.team.id, "native:native-start");
    await reloaded.acceptUserMessage(followup);
    expect(
      (await reloaded.status(started.team.id)).state.team.objective.split(followup.text),
    ).toHaveLength(2);
    await expect(
      service.startKitchen({ ...input, idempotencyKey: "second", objective: "Another task" }),
    ).rejects.toThrow(/another active mission/);
  });

  it("defers native dispatch across reload until the exact rich initial brief is accepted", async () => {
    const host = kitchenFakeHost();
    Object.assign(host.records.get("boss")!, { cwd: root, workspaceId: "native-workspace" });
    const send = vi.fn(async () => {});
    let clock = new Date(Date.now() + 1000);
    const options = {
      ...host.options,
      storageRoot: root,
      resolveWorkspace: async () => ({ id: "native-workspace", cwd: root }),
      controllerOverrides: { send },
      maxConcurrentAgents: () => 1,
      now: () => clock,
    };
    const service = new KitchenTestService(options);
    const started = await service.startKitchen({
      title: "Native",
      objective: "Read the image brief",
      cwd: root,
      workspaceId: "native-workspace",
      headChefAgentId: "boss",
      provider: "codex",
      acceptanceCriteria: [{ id: "goal", text: "Meets brief" }],
      idempotencyKey: "deferred",
      pendingInitialBrief: true,
      initialBriefHasImages: true,
    });
    await service.registerNativeInitialMessage(started.team.id, "native:deferred");
    await service.dispatchAll();
    expect(host.created).toHaveLength(0);
    await expect(service.releaseNativeInitialBrief(started.team.id, "wrong")).rejects.toThrow(
      /does not match/,
    );
    await service.shutdown();
    const reloaded = new KitchenTestService(options);
    await reloaded.dispatchAll();
    expect(host.created).toHaveLength(0);
    await reloaded.acceptUserMessage({
      agentId: "boss",
      eventId: "native:deferred",
      text: "Read image",
    });
    await reloaded.dispatchAll();
    expect(host.agentFor("po")).toBeDefined();
    expect(send).toHaveBeenCalledWith(host.agentFor("po").id, expect.any(String), undefined, {
      nativeBrief: { agentId: "boss", messageId: "native:deferred", requireRich: true },
    });
    await reloaded.releaseNativeInitialBrief(started.team.id, "native:deferred");
    await reloaded.dispatchAll();
    expect(host.created).toHaveLength(1);
    const beforeSteer = (await reloaded.status(started.team.id)).state;
    const activeMs = Object.values(beforeSteer.bindings)[0]!.activeMs;
    clock = new Date(clock.getTime() + 1_000);
    send.mockClear();
    const objectiveBeforeNotification = beforeSteer.team.objective;
    await reloaded.acceptUserMessage({
      agentId: "boss",
      eventId: "plugin-notification",
      text: "Team finished",
      origin: { kind: "plugin" },
    });
    await reloaded.acceptUserMessage({
      agentId: "boss",
      eventId: "unknown-notification",
      text: "Task done",
    });
    await reloaded.dispatchAll();
    const afterNotification = (await reloaded.status(started.team.id)).state;
    expect(afterNotification.team.objective).toBe(objectiveBeforeNotification);
    expect(
      afterNotification.items[started.team.rootItemId].pack.nativeContextMessageId,
    ).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    await reloaded.acceptUserMessage({
      agentId: "boss",
      eventId: "native-image-followup",
      text: "Use the attached revised design",
      context: { attachments: [{ type: "image", mimeType: "image/png", index: 0 }] },
      origin: { kind: "client" },
    });
    await reloaded.dispatchAll();
    expect(send).toHaveBeenCalledWith(
      host.agentFor("po").id,
      expect.stringContaining("Use the attached revised design"),
      "steer",
      {
        nativeInitialBrief: { agentId: "boss", messageId: "native:deferred", requireRich: true },
        nativeBrief: { agentId: "boss", messageId: "native-image-followup", requireRich: true },
      },
    );
    send.mockClear();
    await reloaded.acceptUserMessage({
      agentId: "boss",
      eventId: "native-text-followup",
      text: "Keep both visual requirements",
      origin: { kind: "client" },
    });
    await reloaded.dispatchAll();
    expect(send).toHaveBeenCalledWith(host.agentFor("po").id, expect.any(String), "steer", {
      nativeInitialBrief: { agentId: "boss", messageId: "native:deferred", requireRich: true },
      nativeBrief: { agentId: "boss", messageId: "native-text-followup", requireRich: false },
    });
    await reloaded.acceptUserMessage({
      agentId: "boss",
      eventId: "plugin-after-followup",
      text: "Internal notification",
      origin: { kind: "plugin" },
    });
    expect(
      (await reloaded.status(started.team.id)).state.items[started.team.rootItemId].pack
        .nativeContextMessageId,
    ).toBe("native-text-followup");
    expect(host.created).toHaveLength(1);
    expect(
      Object.values((await reloaded.status(started.team.id)).state.bindings)[0]!.activeMs,
    ).toBeGreaterThanOrEqual(activeMs + 1_000);
  });

  it("rejects native HeadChef workspace and provider mismatches and reports unavailable project presets", async () => {
    const host = kitchenFakeHost();
    Object.assign(host.records.get("boss")!, { cwd: root, workspaceId: "native-workspace" });
    const service = makeKitchenService(root, host);
    const input = {
      title: "Native",
      objective: "Task",
      cwd: root,
      workspaceId: "wrong",
      headChefAgentId: "boss",
      provider: "codex",
      acceptanceCriteria: [{ id: "goal", text: "Works" }],
      idempotencyKey: "invalid",
    };
    await expect(service.startKitchen(input)).rejects.toThrow(/workspace/);
    await expect(
      service.startKitchen({ ...input, workspaceId: "native-workspace", provider: "claude" }),
    ).rejects.toThrow(/provider/);
    expect(host.created).toHaveLength(0);
    await mkdir(join(root, ".agent-factory"));
    await writeFile(
      join(root, ".agent-factory", "project.json"),
      JSON.stringify({
        workflowId: "missing",
        headChef: { provider: "codex", model: "gpt-6.1-sol" },
      }),
    );
    expect(await service.listProjectPacks(root)).toMatchObject({
      defaultWorkflowId: "missing",
      headChefProfile: { provider: "codex" },
      unavailableReason: expect.any(String),
    });
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

  it("shares twelve configured capacity slots across teams and drains queued starts", async () => {
    const host = kitchenFakeHost();
    const service = new KitchenTestService({
      ...host.options,
      storageRoot: root,
      maxConcurrentAgents: () => 12,
    });
    const teams: TeamState[] = [];
    for (let index = 0; index < 13; index++)
      teams.push(
        await service.startTeam({
          bossAgentId: "boss",
          title: `Capacity ${index}`,
          objective: "Plan",
        }),
      );
    await service.dispatchAll();
    expect(host.created).toHaveLength(12);
    await service.report(host.created[0]!.id, {
      outcome: "planned",
      summary: "No implementation needed",
    });
    await service.dispatchAll();
    expect(host.created).toHaveLength(13);
    const states = await Promise.all(teams.map((team) => service.status(team.team.id)));
    expect(
      states
        .flatMap(({ state }) => Object.values(state.bindings))
        .filter((binding) => binding.activeStartedAt),
    ).toHaveLength(12);
    expect(states.every(({ state }) => state.team.runtime!.limits.maxActiveCooks === 12)).toBe(
      true,
    );
    await service.shutdown();
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

  it("persists active time, excludes paused queue time and stops at an explicit role budget", async () => {
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
      policy: { roleActiveMs: 60 * 60_000 },
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
    expect(state.team.runtime?.limitReason).toContain("roleActiveMs");
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
    await service.store.commit(team.team.id, (draft) => {
      draft.team.kitchen!.nativeConversation = true;
      draft.items[draft.team.rootItemId].pack.nativeInitialMessageId = "native:initial";
      return { events: [], result: null };
    });
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
    await service.acceptUserMessage({
      agentId: team.team.bossAgentId,
      eventId: "native:during-verification",
      text: "Check the combined behavior against this clarification",
      origin: { kind: "client" },
    });
    await expect(
      service.report(finalVerifier.id, {
        outcome: "pass",
        summary: "Stale verifier response",
        artifacts: [{ kind: "commit", ref: combinedHead }],
        criteria: state.items[state.team.rootItemId].acceptanceCriteria.map((criterion) => ({
          id: criterion.id,
          met: true,
          evidence: "Old context only",
        })),
      }),
    ).rejects.toThrow(/Mission context changed/);
    await service.dispatchAll();
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
    const initialVerified = (await service.status(team.team.id)).state;
    expect(
      initialVerified.items[initialVerified.team.rootItemId].pack.verifiedNativeContextMessageId,
    ).toBe("native:during-verification");
    const cooksBefore = host.created.length;
    await service.acceptUserMessage({
      agentId: team.team.bossAgentId,
      eventId: "native:revised-requirements",
      text: "Also independently recheck the combined behavior",
      origin: { kind: "client" },
    });
    await service.dispatchAll();
    expect(host.created).toHaveLength(cooksBefore);
    await expect(
      service.controlKitchen(team.team.id, "accept", "operator", {
        credential: "synthetic-test-operator-capability-32-chars",
        candidateCommit: combinedHead,
      }),
    ).rejects.toThrow(/Mission context changed/);
    await service.controlKitchen(team.team.id, "pause", "operator");
    await expect(service.controlKitchen(team.team.id, "reverify", "operator")).rejects.toThrow(
      /Resume/,
    );
    await service.controlKitchen(team.team.id, "resume", "operator");
    await service.controlKitchen(team.team.id, "reverify", "operator");
    await service.dispatchAll();
    const rechecked = (await service.status(team.team.id)).state;
    expect(rechecked.team.id).toBe(team.team.id);
    expect(host.created).toHaveLength(cooksBefore + 1);
    const freshVerifier = host.created.at(-1)!;
    expect(freshVerifier.labels[TEAM_ROLE_LABEL]).toBe("verifier");
    expect(freshVerifier.cwd).toBe(integrator.cwd);
    expect(rechecked.items[rechecked.team.rootItemId].pack.verifiedCommit).toBeUndefined();
    expect(itemByKey(rechecked, "A").pack.verifiedCommit).toBe(head);
    await service.report(freshVerifier.id, {
      outcome: "pass",
      summary: "Current context independently checked",
      artifacts: [{ kind: "commit", ref: combinedHead }],
      criteria: rechecked.items[rechecked.team.rootItemId].acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        met: true,
        evidence: "Combined HEAD checked against revised requirements",
      })),
    });
    await service.dispatchAll();
    expect(
      (await service.status(team.team.id)).state.items[team.team.rootItemId].pack
        .verifiedNativeContextMessageId,
    ).toBe("native:revised-requirements");
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

  it("persists goal-driven nested next-work dispatch and resumes an actual human question after reload", async () => {
    const host = kitchenFakeHost();
    let service = makeKitchenService(root, host);
    const input = {
      title: "Goal-driven",
      objective: "Deliver the scoped feature and its dependencies",
      cwd: root,
      provider: "codex",
      idempotencyKey: "goal-driven",
      acceptanceCriteria: [{ id: "goal", text: "Scoped feature is verified" }],
    };
    const team = await service.startKitchen(input);
    expect(team.team.kitchen).toMatchObject({
      missionMode: "goal-driven",
      workflowMode: "self-organizing",
    });
    expect(team.team.runtime?.limits).toEqual({ maxActiveCooks: 4 });
    await service.dispatchAll();
    await service.report(
      host.agentFor("po").id,
      { outcome: "planned", summary: "Scoped backlog" },
      [
        {
          key: "A",
          title: "Feature",
          objective: "Deliver scoped behavior",
          acceptanceCriteria: ["Feature works"],
        },
        {
          key: "B",
          title: "Next feature",
          objective: "Finish dependent behavior",
          acceptanceCriteria: ["Dependent behavior works"],
          dependsOn: ["A"],
        },
      ],
    );
    await service.dispatchAll();
    let state = (await service.status(team.team.id)).state;
    let item = itemByKey(state, "A");
    for (let depth = 1; depth <= 3; depth++) {
      const agent = host.created.find(
        (record) =>
          record.labels["agent-factory.team.item"] === item.id &&
          record.labels[TEAM_ROLE_LABEL] === "developer",
      )!;
      expect(host.prompts.find((entry) => entry.agentId === agent.id)!.prompt).toContain(
        "Goal-driven mission",
      );
      await service.report(
        agent.id,
        {
          outcome: "done",
          summary: "Missing scoped dependency discovered",
          needs: { kind: "split", text: "Dependency required for the declared goal" },
        },
        undefined,
        [
          {
            requestId: `needed-${depth}`,
            title: `Dependency ${depth}`,
            objective: "Implement required scoped dependency",
            acceptanceCriteria: ["Dependency is verified"],
          },
        ],
      );
      await service.dispatchAll();
      state = (await service.status(team.team.id)).state;
      expect(state.items[item.id]!.phase).toBe("waiting-for-work");
      item = Object.values(state.items).find((candidate) => candidate.parentId === item.id)!;
      expect(item.pack.delegationDepth).toBe(depth);
      expect(item.phase).toBe("implement");
    }
    const worker = host.created.find(
      (record) =>
        record.labels["agent-factory.team.item"] === item.id &&
        record.labels[TEAM_ROLE_LABEL] === "developer",
    )!;
    await service.report(worker.id, {
      outcome: "done",
      summary: "Product decision required",
      needs: { kind: "human", text: "Should the feature use red or blue?" },
    });
    const starts = host.created.length;
    await service.shutdown();
    service = makeKitchenService(root, host);
    await service.start();
    state = (await service.status(team.team.id)).state;
    expect(state.team.kitchen?.missionMode).toBe("goal-driven");
    expect(state.items[item.id]!.phase).toBe("blocked");
    expect(
      Object.values(state.decisions).some(
        (decision) =>
          decision.kind === "notify-human" && String(decision.payload.text).includes("red or blue"),
      ),
    ).toBe(true);
    expect(host.created).toHaveLength(starts);
    expect(itemByKey(state, "B").phase).toBe("ready");
    await service.message(team.team.id, "Use blue.", { type: "human", id: "operator" });
    await service.dispatchAll();
    state = (await service.status(team.team.id)).state;
    expect(state.items[item.id]!.phase).toBe("implement");
    expect(host.prompts.at(-1)?.prompt).toContain("Use blue.");
    expect((await service.startKitchen(input)).team.id).toBe(team.team.id);
    expect(
      Object.values(state.items).filter((candidate) => candidate.pack.workRequest),
    ).toHaveLength(3);
  });

  it("keeps planned missions fixed and rejects an explicitly zero delegated-item budget", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const input = {
      title: "Explicit mode",
      objective: "Deliver behavior",
      cwd: root,
      provider: "codex",
      acceptanceCriteria: [{ id: "goal", text: "Works" }],
    };
    const planned = await service.startKitchen({
      ...input,
      idempotencyKey: "planned",
      missionMode: "planned",
    });
    expect(planned.team.kitchen).toMatchObject({ missionMode: "planned", workflowMode: "fixed" });
    const limited = await service.startKitchen({
      ...input,
      idempotencyKey: "limited-requests",
      title: "Explicit delegation limit",
      objective: "Deliver limited behavior",
      policy: { maxDelegatedItems: 0 },
    });
    await service.dispatchAll();
    const po = host.created.find(
      (record) =>
        record.labels["agent-factory.team"] === limited.team.id &&
        record.labels[TEAM_ROLE_LABEL] === "po",
    )!;
    await service.report(po.id, { outcome: "planned", summary: "Plan" }, [
      { key: "A", title: "Feature", objective: "Feature", acceptanceCriteria: ["Feature works"] },
    ]);
    await service.dispatchAll();
    const state = (await service.status(limited.team.id)).state;
    const developer = host.agentFor("developer", "A", state);
    await expect(
      service.report(developer.id, { outcome: "done", summary: "Extra work" }, undefined, [
        {
          requestId: "extra",
          title: "Extra",
          objective: "Extra",
          acceptanceCriteria: ["Extra works"],
        },
      ]),
    ).rejects.toThrow("item limit");
    expect(Object.values((await service.status(limited.team.id)).state.items)).toHaveLength(2);
    await expect(
      service.startKitchen({
        ...input,
        idempotencyKey: "mismatch",
        missionMode: "goal-driven",
        workflowMode: "fixed",
      }),
    ).rejects.toThrow("must agree");
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

  it("keeps legacy budget pauses paused after reload and allows explicit resume", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const team = await service.startKitchen({
      title: "Old default budget",
      objective: "Resume a user-controlled mission",
      cwd: root,
      provider: "codex",
      idempotencyKey: "legacy-budget",
      acceptanceCriteria: [{ id: "goal", text: "Verified" }],
    });
    await service.store.commit(team.team.id, (draft) => {
      draft.team.status = "paused";
      draft.team.pausedReason = "Team reached four hours aggregate active time";
      draft.team.runtime!.limitReason = draft.team.pausedReason;
      draft.team.runtime!.limits.totalActiveMs = 4 * 60 * 60_000;
      draft.team.kitchen!.stopped = true;
      return { events: [], result: null };
    });
    await service.shutdown();
    const reloaded = makeKitchenService(root, host);
    await reloaded.start();
    let state = (await reloaded.status(team.team.id)).state;
    expect(state.team.status).toBe("paused");
    expect(state.team.runtime!.limitReason).toBeUndefined();
    expect(state.team.runtime!.limits.totalActiveMs).toBeUndefined();
    await reloaded.controlKitchen(team.team.id, "resume", "operator");
    state = (await reloaded.status(team.team.id)).state;
    expect(state.team.status).toBe("active");
    await reloaded.shutdown();
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

  it("enforces explicit aggregate time while unbudgeted observed usage stays informational", async () => {
    const host = kitchenFakeHost();
    const service = makeKitchenService(root, host);
    const team = await service.startTeam({
      bossAgentId: "boss",
      title: "Aggregate",
      objective: "Plan",
      policy: { totalActiveMs: 4 * 60 * 60_000 },
    });
    await service.dispatchAll();
    await service.store.commit(team.team.id, (draft) => {
      draft.team.runtime!.usage.activeMs = 4 * 60 * 60_000;
      return { events: [], result: null };
    });
    await service.healthAll();
    expect((await service.status(team.team.id)).state.team.runtime?.limitReason).toContain(
      "totalActiveMs",
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
    await service.store.commit(another.team.id, (draft) => {
      draft.team.runtime!.usage.activeMs = 5 * 60 * 60_000;
      draft.team.runtime!.usage.roleActiveMs.developer = 90 * 60_000;
      return { events: [], result: null };
    });
    await service.healthAll();
    state = (await service.status(another.team.id)).state;
    expect(state.team.runtime?.usage.tokensAvailable).toBe(true);
    expect(state.team.runtime?.usage.observedTokens).toBe(500_000);
    expect(state.team.runtime?.limitReason).toBeUndefined();
    expect(state.team.runtime?.limits.observedTokens).toBeUndefined();
    expect(state.team.status).toBe("active");
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
