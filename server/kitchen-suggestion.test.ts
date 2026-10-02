import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type {
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { afterEach, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { registerKitchenSuggestions, suggestionObjective } from "./kitchen-suggestion.js";
import { KitchenSuggestionSchema, readKitchenSuggestion } from "../shared/kitchen-suggestion.js";
import { TEAM_LABEL, TEAM_ROLE_LABEL } from "../shared/factory-contracts.js";
import type { JevClassification, SystemOneConfig } from "./system-one.js";

type Event = PluginLifecycleEvents["agent.turn_ended"];
const goal =
  "Build an application for the project with a frontend dashboard, backend API, login and database. Implement independent tests and deploy the complete workflow.";
const team: JevClassification = {
  source: "jev",
  model: "jev-test",
  executionMode: "team",
  confidence: 0.9,
  latencyMs: 1,
  reason: "Several dependency branches",
};
const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });

function setup(config: SystemOneConfig = { enabled: true }) {
  let callback: ((event: Event, context: PluginHookContext) => Promise<void>) | undefined;
  const remove = vi.fn();
  const server = {
    on: vi.fn((_name, fn) => {
      callback = fn;
      return remove;
    }),
  } as unknown as PluginServerContext;
  const snapshot = {
    id: "chat",
    cwd: "/repo",
    workspaceId: "workspace",
    labels: {},
    archivedAt: null,
  } as PaseoAgent;
  const appended: AgentTimelineItem[] = [];
  const append = vi.fn(async (item) => {
    appended.push({ ...item, pluginId: "custom-kitchen-install" });
  });
  const handle = {
    refresh: vi.fn(async () => ({ agent: snapshot, project: null })),
    timeline: { append },
  };
  const paseo = { agents: { ref: vi.fn(() => handle) } } as unknown as PaseoApi;
  const classify = vi.fn(async () => team);
  interface State {
    team: { bossAgentId: string; kitchen?: { sourceAgentId?: string } };
    bindings: Record<string, { agentId: string }>;
  }
  const states = new Map<string, State>();
  const store = {
    listIds: vi.fn(async () => [...states.keys()]),
    get: vi.fn(async (id: string) => states.get(id) ?? null),
  };
  const service = vi.fn(async () => ({ store }));
  const cleanup = registerKitchenSuggestions(server, {
    config: async () => config,
    decisionSource: { classify },
    service,
  });
  const agent = {
    id: "chat",
    cwd: "/repo",
    workspaceId: "workspace",
    parentAgentId: null,
    provider: "codex",
    title: null,
  };
  const emit = (
    timeline: AgentTimelineItem[] = [user(goal)],
    overrides: Partial<Event> = {},
    signal = new AbortController().signal,
  ) =>
    callback?.(
      { agent, turnId: "turn", outcome: { kind: "completed" }, timeline, ...overrides },
      { paseo, signal },
    );
  return {
    classify,
    appended,
    append,
    snapshot,
    handle,
    states,
    store,
    service,
    agent,
    emit,
    cleanup,
    remove,
    server,
  };
}

afterEach(() => vi.unstubAllEnvs());

it("smalltalk and setup do not consume the one classification opportunity; a later substantial goal creates a source-bound offer", async () => {
  const ctx = setup();
  await ctx.emit([user("hi")]);
  await ctx.emit([
    user("hi"),
    user("Please tell me how to set up this repository before we start."),
  ]);
  expect(ctx.classify).not.toHaveBeenCalled();
  await ctx.emit([
    user("hi"),
    user("Please tell me how to set up this repository before we start."),
    user(goal),
  ]);
  expect(ctx.classify).toHaveBeenCalledTimes(1);
  expect(ctx.classify.mock.calls[0]?.[0]).toMatchObject({
    objective: goal,
    provider: "codex",
    sourceAgentId: "chat",
    workspaceId: "workspace",
    cwd: "/repo",
  });
  expect(
    KitchenSuggestionSchema.parse(ctx.appended[0]?.type === "plugin" ? ctx.appended[0].data : null),
  ).toMatchObject({
    objective: goal,
    sourceAgentId: "chat",
    workspaceId: "workspace",
    cwd: "/repo",
  });
  await ctx.emit();
  expect(ctx.classify).toHaveBeenCalledTimes(1);
  expect(ctx.append).toHaveBeenCalledTimes(1);
  ctx.cleanup();
  expect(ctx.remove).toHaveBeenCalledTimes(1);
});

it("bounds chat context to three substantive messages and 4000 characters", () => {
  const input = [
    user("hi"),
    user(goal),
    user("Detailed API requirements ".repeat(200)),
    user("User roles and database requirements"),
    user("SECRET_FOURTH_MESSAGE"),
  ];
  const objective = suggestionObjective(input)!;
  expect(objective).toHaveLength(4000);
  expect(objective).not.toContain("SECRET_FOURTH_MESSAGE");
  expect(
    suggestionObjective([
      user(
        "Add a test for the existing backend API project to ensure that the current endpoint returns its expected result.",
      ),
    ]),
  ).toBeNull();
});

it.each([
  { enabled: false },
  { enabled: true, excludedPaths: ["/repo"] },
  { enabled: true, excludedPaths: ["~"] },
])(
  "disabled and excluded projects send no classification ($enabled/$excludedPaths)",
  async (config) => {
    const ctx = setup(config);
    if (config.excludedPaths?.includes("~")) {
      ctx.agent.cwd = `${homedir()}/private-project`;
      ctx.snapshot.cwd = ctx.agent.cwd;
    }
    await ctx.emit();
    expect(ctx.classify).not.toHaveBeenCalled();
    expect(ctx.service).not.toHaveBeenCalled();
  },
);

it.each([TEAM_LABEL, TEAM_ROLE_LABEL])(
  "does not offer existing labeled Kitchen agents (%s)",
  async (label) => {
    const ctx = setup();
    ctx.snapshot.labels[label] = "kitchen-role";
    await ctx.emit();
    expect(ctx.classify).not.toHaveBeenCalled();
  },
);

it.each(["boss", "source", "binding"])(
  "does not offer persisted team %s agents, including unlabeled source chats",
  async (membership) => {
    const ctx = setup();
    ctx.states.set("team_one", {
      team: {
        bossAgentId: membership === "boss" ? "chat" : "boss",
        kitchen: { sourceAgentId: membership === "source" ? "chat" : "other" },
      },
      bindings: membership === "binding" ? { cook: { agentId: "chat" } } : {},
    });
    await ctx.emit();
    expect(ctx.classify).not.toHaveBeenCalled();
    expect(ctx.store.get).toHaveBeenCalledWith("team_one");
  },
);

it("does not offer failed/canceled turns, child workers, missing workspaces or already existing rows", async () => {
  const ctx = setup();
  await ctx.emit(undefined, { outcome: { kind: "failed", error: { message: "Failure" } } });
  await ctx.emit(undefined, { outcome: { kind: "canceled", reason: "User canceled" } });
  await ctx.emit(undefined, { agent: { ...ctx.agent, parentAgentId: "parent" } });
  await ctx.emit(undefined, { agent: { ...ctx.agent, workspaceId: null } });
  expect(ctx.classify).not.toHaveBeenCalled();
  await ctx.emit();
  const restored = setup();
  await restored.emit([user(goal), ...ctx.appended]);
  expect(restored.classify).not.toHaveBeenCalled();
  expect(readKitchenSuggestion(ctx.appended, "other-agent")).toBeNull();
});

it.each([
  { ...team, executionMode: "single" as const },
  { ...team, executionMode: "human" as const },
  { ...team, confidence: 0.69 },
])(
  "uncertain and single decisions remain quiet and never start work ($executionMode/$confidence)",
  async (result) => {
    const ctx = setup();
    ctx.classify.mockResolvedValue(result);
    await ctx.emit();
    await ctx.emit();
    expect(ctx.classify).toHaveBeenCalledTimes(1);
    expect(ctx.append).not.toHaveBeenCalled();
  },
);

it("honors a higher configured threshold and keeps classification errors quiet", async () => {
  const ctx = setup({ enabled: true, minimumConfidence: 0.95 });
  await ctx.emit();
  expect(ctx.append).not.toHaveBeenCalled();
  const broken = setup();
  broken.classify.mockRejectedValue(new Error("Service unavailable"));
  await expect(broken.emit()).resolves.toBeUndefined();
  await broken.emit();
  expect(broken.classify).toHaveBeenCalledTimes(1);
});

it("deduplicates concurrent turns and discards a late classification after cancellation or team adoption", async () => {
  const ctx = setup();
  let finish!: (value: JevClassification) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  ctx.classify.mockImplementation(() => {
    began();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const controller = new AbortController();
  const first = ctx.emit(undefined, {}, controller.signal);
  await started;
  await ctx.emit();
  controller.abort();
  finish(team);
  await first;
  expect(ctx.classify).toHaveBeenCalledTimes(1);
  expect(ctx.append).not.toHaveBeenCalled();
  const adopted = setup();
  adopted.classify.mockImplementation(async () => {
    adopted.states.set("team", {
      team: { bossAgentId: "boss", kitchen: { sourceAgentId: "chat" } },
      bindings: {},
    });
    return team;
  });
  await adopted.emit();
  expect(adopted.append).not.toHaveBeenCalled();
});

it("older hosts without the optional hooks or timeline append continue without an offer", async () => {
  expect(
    registerKitchenSuggestions(
      {} as PluginServerContext,
      {} as Parameters<typeof registerKitchenSuggestions>[1],
    ),
  ).toBeTypeOf("function");
  const ctx = setup();
  Object.assign(ctx.handle.timeline, { append: undefined });
  await ctx.emit();
  expect(ctx.classify).not.toHaveBeenCalled();
  vi.stubEnv("KITCHEN_SUGGESTIONS_ENABLED", "false");
  const disabled = setup();
  expect(disabled.server.on).not.toHaveBeenCalled();
});
