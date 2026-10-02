import { buildLeitstandInbox } from "./inbox-model.js";
import { recentCompletedSessions } from "./overview.js";
import type { ScheduleSummary } from "./schedules.js";
import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "./projection-types.js";
import type { Agent } from "./projection-types.js";
import {
  arrangeBoardColumns,
  buildLeitstandBoard,
  buildLeitstandSession,
  formatModelLabel,
  groupRootAgentsByWorkspace,
  projectMonogram,
  resolveScheduleProject,
  selectSessionPullRequests,
  summarizeStack,
  type LeitstandSchedule,
  type LeitstandSession,
} from "./session-model.js";

const T = new Date("2026-09-30T10:00:00.000Z");

const AGENT_DEFAULTS: Agent = {
  serverId: "srv",
  id: "agent",
  provider: "claude",
  status: "idle",
  turn: { phase: "idle", cancellationRequestId: null },
  createdAt: T,
  updatedAt: T,
  lastUserMessageAt: null,
  lastActivityAt: T,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  lastError: null,
  title: "Dev",
  cwd: "/repo/app",
  workspaceId: "ws-1",
  model: "sonnet",
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...overrides };
}

function entry(overrides: Partial<SidebarWorkspaceEntry> = {}): SidebarWorkspaceEntry {
  return {
    workspaceKey: "srv:ws-1",
    serverId: "srv",
    workspaceId: "ws-1",
    projectViewKey: "project-a",
    projectName: "app",
    projectRootPath: "/repo/app",
    workspaceDirectory: "/repo/app",
    workspaceDirectoryLabel: "~/repo/app",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "Atlas TEST-2081",
    title: null,
    currentBranch: "feature/DEMO-35-model",
    statusBucket: "running",
    statusEnteredAt: T,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    relatedPullRequests: [],
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    ...overrides,
  };
}

function leitstandSession(overrides: Partial<LeitstandSession> = {}): LeitstandSession {
  return {
    ...buildLeitstandSession({ entry: entry(), githubRuntime: null, agents: [] }),
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: "sched-1",
    name: "Daily",
    prompt: "Prepare the daily",
    cadence: { type: "every", everyMs: 3_600_000 },
    target: { type: "new-agent", config: { provider: "claude", cwd: "/repo/app/packages" } },
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    nextRunAt: "2026-09-30T12:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    ...overrides,
  };
}

describe("selectSessionPullRequests", () => {
  it("orders the related set by stack position, bottom first, with the real states", () => {
    const prs = selectSessionPullRequests(
      entry({
        relatedPullRequests: [
          {
            number: 3,
            url: "u3",
            state: "open",
            origin: "stack",
            stackIndex: 2,
            checksStatus: "failure",
          },
          { number: 1, url: "u1", state: "merged", origin: "stack", stackIndex: 0, title: "Base" },
          { number: 2, url: "u2", state: "open", origin: "stack", stackIndex: 1, isDraft: true },
        ],
      }),
      null,
    );
    expect(prs).toEqual([
      { number: 1, url: "u1", title: "Base", state: "merged", isDraft: false, checksStatus: null },
      { number: 2, url: "u2", title: null, state: "open", isDraft: true, checksStatus: null },
      { number: 3, url: "u3", title: null, state: "open", isDraft: false, checksStatus: "failure" },
    ]);
  });

  it("falls back to the checked-out branch's change request with its title and draft flag", () => {
    const prs = selectSessionPullRequests(
      entry({
        prHint: {
          url: "https://github.com/acme/app/pull/7",
          number: 7,
          state: "open",
          forge: "github",
          checksStatus: "success",
        },
      }),
      {
        pullRequest: {
          url: "https://github.com/acme/app/pull/7",
          title: "TEST-12 Fix the thing",
          state: "open",
          baseRefName: "main",
          headRefName: "fix",
          isMerged: false,
          isDraft: true,
        },
      },
    );
    expect(prs).toEqual([
      {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        title: "TEST-12 Fix the thing",
        state: "open",
        isDraft: true,
        checksStatus: "success",
      },
    ]);
  });
});

describe("buildLeitstandSession", () => {
  it("collects ticket keys from the name, the branch and every PR title", () => {
    const session = buildLeitstandSession({
      entry: entry({
        relatedPullRequests: [
          { number: 1, url: "u1", state: "open", origin: "stack", title: "OPS-4 infra" },
        ],
      }),
      githubRuntime: null,
      agents: [],
    });
    expect(session.jiraKeys).toEqual(["TEST-2081", "DEMO-35", "OPS-4"]);
    expect(session.context).toBe("feature/DEMO-35-model");
  });
});

describe("groupRootAgentsByWorkspace", () => {
  it("keeps live root agents and reads their state, permission and error", () => {
    const grouped = groupRootAgentsByWorkspace([
      makeAgent({
        id: "root",
        pendingPermissions: [
          { id: "p1", provider: "claude", name: "Bash", kind: "tool", title: "Run tests" },
        ],
      }),
      makeAgent({ id: "sub", parentAgentId: "root" }),
      makeAgent({ id: "gone", archivedAt: T }),
      makeAgent({ id: "broken", workspaceId: "ws-2", status: "error", lastError: "boom" }),
      makeAgent({
        id: "busy",
        workspaceId: "ws-2",
        turn: { phase: "open", turnId: "t1", startedAt: T, cancellationRequestId: null },
      }),
    ]);
    expect(grouped.get("ws-1")).toEqual([
      expect.objectContaining({
        id: "root",
        bucket: "needs_input",
        pendingPermission: { id: "p1", title: "Run tests" },
      }),
    ]);
    expect(grouped.get("ws-2")).toEqual([
      expect.objectContaining({ id: "broken", bucket: "failed", lastError: "boom" }),
      expect.objectContaining({ id: "busy", bucket: "running" }),
    ]);
  });
});

describe("buildLeitstandBoard", () => {
  const scheduleEntry = (
    overrides: Partial<ScheduleSummary>,
    projectViewKey = "project-a",
  ): LeitstandSchedule => ({
    key: `srv:${overrides.id ?? "sched-1"}`,
    serverId: "srv",
    schedule: schedule(overrides),
    projectViewKey,
    projectName: "app",
  });

  it("splits sessions into running, waiting and done, newest first, and plans schedules by next run", () => {
    const board = buildLeitstandBoard({
      sessions: [
        leitstandSession({ key: "a", bucket: "done", since: new Date("2026-09-29T00:00:00Z") }),
        leitstandSession({
          key: "closed",
          bucket: "done",
          since: new Date("2026-09-29T01:00:00Z"),
          handedBackAt: new Date("2026-09-29T01:00:00Z"),
          doneAt: new Date("2026-09-29T02:00:00Z"),
        }),
        leitstandSession({
          key: "reopened",
          bucket: "done",
          since: new Date("2026-09-29T03:00:00Z"),
          handedBackAt: new Date("2026-09-29T03:00:00Z"),
          doneAt: new Date("2026-09-29T02:00:00Z"),
        }),
        leitstandSession({
          key: "b",
          bucket: "needs_input",
          since: new Date("2026-09-30T09:00:00Z"),
        }),
        leitstandSession({ key: "c", bucket: "running", since: new Date("2026-09-30T09:30:00Z") }),
        leitstandSession({
          key: "d",
          bucket: "attention",
          since: new Date("2026-09-30T08:00:00Z"),
        }),
        leitstandSession({ key: "e", bucket: "failed", since: null }),
      ],
      schedules: [
        scheduleEntry({ id: "late", nextRunAt: "2026-10-01T08:00:00.000Z" }),
        scheduleEntry({ id: "soon", nextRunAt: "2026-09-30T11:00:00.000Z" }),
        scheduleEntry({ id: "paused", status: "paused" }),
        scheduleEntry({ id: "never", nextRunAt: null }),
      ],
      projectViewKey: null,
    });
    expect(board.running.map((s) => s.key)).toEqual(["c"]);
    expect(board.waiting.map((s) => s.key)).toEqual(["b", "d", "reopened", "a", "e"]);
    expect(board.done.map((s) => s.key)).toEqual(["closed"]);
    expect(board.planned.map((s) => s.schedule.id)).toEqual(["soon", "late"]);
  });

  it("filters sessions and schedules by project", () => {
    const board = buildLeitstandBoard({
      sessions: [
        leitstandSession({ key: "a" }),
        leitstandSession({ key: "b", projectViewKey: "project-b" }),
      ],
      schedules: [scheduleEntry({ id: "x" }), scheduleEntry({ id: "y" }, "project-b")],
      projectViewKey: "project-b",
    });
    expect(board.running.map((s) => s.key)).toEqual(["b"]);
    expect(board.planned.map((s) => s.schedule.id)).toEqual(["y"]);
  });
});

describe("resolveScheduleProject", () => {
  it("places a new-agent schedule by its cwd inside a project root", () => {
    expect(
      resolveScheduleProject({ serverId: "srv", schedule: schedule() }, [leitstandSession()]),
    ).toEqual({ projectViewKey: "project-a", projectName: "app" });
  });

  it("does not match a sibling directory that only shares a prefix", () => {
    const target = {
      type: "new-agent" as const,
      config: { provider: "claude", cwd: "/repo/app-other" },
    };
    expect(
      resolveScheduleProject({ serverId: "srv", schedule: schedule({ target }) }, [
        leitstandSession(),
      ]),
    ).toEqual({ projectViewKey: null, projectName: null });
  });

  it("places an agent schedule by the session holding the agent", () => {
    const agentId = "00000000-0000-4000-8000-000000000000";
    const session = leitstandSession({
      projectViewKey: "project-z",
      projectName: "zeta",
      agents: [
        {
          id: agentId,
          title: null,
          provider: "codex",
          model: null,
          personFacing: true,
          bucket: "done",
          lastActivityAt: T,
          pendingPermission: null,
          lastError: null,
        },
      ],
    });
    expect(
      resolveScheduleProject(
        { serverId: "srv", schedule: schedule({ target: { type: "agent", agentId } }) },
        [session],
      ),
    ).toEqual({ projectViewKey: "project-z", projectName: "zeta" });
  });
});

describe("projectMonogram and summarizeStack", () => {
  it("builds a two-letter tag", () => {
    expect(projectMonogram("acme-platform")).toBe("AP");
    expect(projectMonogram("pandaos")).toBe("PA");
    expect(projectMonogram("atlas platform")).toBe("AP");
  });

  it("counts merged layers of the stack", () => {
    const session = leitstandSession({
      pullRequests: [
        { number: 1, url: "u", title: null, state: "merged", isDraft: false, checksStatus: null },
        { number: 2, url: "u", title: null, state: "open", isDraft: false, checksStatus: null },
      ],
    });
    expect(summarizeStack(session.pullRequests)).toEqual({ merged: 1, total: 2 });
  });
});

describe("formatModelLabel", () => {
  it("names models the way people say them", () => {
    expect(formatModelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(formatModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(formatModelLabel("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(formatModelLabel("openai/gpt-6-luna")).toBe("GPT-6 Luna");
    expect(formatModelLabel("gpt-5.5")).toBe("GPT-5.5");
    expect(formatModelLabel("kimi-k2")).toBe("kimi-k2");
  });
});

describe("arrangeBoardColumns", () => {
  const topic = { id: "top_riesling", title: "Riesling", description: null };

  it("puts a topic once, in the column of its most urgent child, children most urgent first", () => {
    const phase1 = leitstandSession({
      key: "p1",
      bucket: "done",
      topic,
      since: new Date("2026-09-29T00:00:00Z"),
    });
    const phase2 = leitstandSession({
      key: "p2",
      bucket: "needs_input",
      topic,
      since: new Date("2026-09-30T09:00:00Z"),
    });
    const loose = leitstandSession({
      key: "x",
      bucket: "done",
      since: new Date("2026-09-30T08:00:00Z"),
      doneAt: new Date("2026-09-30T08:00:00Z"),
    });
    const columns = arrangeBoardColumns(
      buildLeitstandBoard({
        sessions: [phase1, phase2, loose],
        schedules: [],
        projectViewKey: null,
      }),
    );
    expect(columns.running).toHaveLength(0);
    expect(columns.waiting).toHaveLength(1);
    const [card] = columns.waiting;
    expect(card?.kind).toBe("topic");
    if (card?.kind !== "topic") return;
    expect(card.bucket).toBe("needs_input");
    expect(card.children.map((child) => child.key)).toEqual(["p2", "p1"]);
    expect(
      columns.done.map((item) => (item.kind === "session" ? item.session.key : item.key)),
    ).toEqual(["x"]);
  });
});

it("bounds recent completion history by workspaces and sorts by actual completion time", () => {
  const base = leitstandSession();
  const entries = Array.from({ length: 5 }, (_, index) => ({
    ...base,
    key: String(index),
    doneAt: new Date(1000 * index),
  }));
  expect(recentCompletedSessions(entries).map((recent) => recent.key)).toEqual(["4", "3", "2"]);
  expect(entries.map((recent) => recent.key)).toEqual(["0", "1", "2", "3", "4"]);
});

it.each(["waiting", "exhausted"] as const)(
  "published routing %s shows blocked work and its actual reason instead of busy work",
  (status) => {
    const raw = makeAgent({
      id: "blocked",
      workspaceId: "ws",
      status: "running",
      turn: { phase: "open" },
      routingNotice: {
        status,
        reason: "Provider quota is unavailable",
        resetsAt: "2026-10-03T08:00:00.000Z",
      },
    });
    const agents = groupRootAgentsByWorkspace([raw]).get("ws") || [];
    const projected = buildLeitstandSession({
      entry: entry({ statusBucket: "running" }),
      githubRuntime: null,
      agents,
    });
    expect(projected.bucket).toBe("needs_input");
    expect(agents.filter((candidate) => candidate.bucket === "running")).toHaveLength(0);
    expect(
      buildLeitstandInbox({
        sessions: [projected],
        schedules: [],
        snoozedUntil: {},
        nowMs: T.getTime(),
      }).items,
    ).toEqual([
      expect.objectContaining({
        kind: "routing_wait",
        agentId: "blocked",
        reason: "Provider quota is unavailable",
        resetsAt: "2026-10-03T08:00:00.000Z",
      }),
    ]);
    const original =
      groupRootAgentsByWorkspace([
        makeAgent({ id: "plain", workspaceId: "ws", status: "running", turn: { phase: "open" } }),
      ]).get("ws") || [];
    expect(original[0].bucket).toBe("running");
  },
);

it("Kitchen includes bound child permissions that the ordinary workspace overview leaves to their parent", () => {
  const input = [
    makeAgent({ id: "lead" }),
    makeAgent({
      id: "cook",
      parentAgentId: "lead",
      labels: { "paseo.origin": "agent" },
      pendingPermissions: [
        {
          id: "allow",
          provider: "claude",
          name: "Bash",
          kind: "tool",
          title: "Allow verification",
        },
      ],
    }),
  ];
  expect(
    groupRootAgentsByWorkspace(input)
      .get("ws-1")
      ?.map((agent) => agent.id),
  ).toEqual(["lead"]);
  const cooked = groupRootAgentsByWorkspace(input, true)
    .get("ws-1")
    ?.find((agent) => agent.id === "cook");
  expect(cooked).toMatchObject({
    personFacing: true,
    bucket: "needs_input",
    pendingPermission: { id: "allow" },
  });
});
