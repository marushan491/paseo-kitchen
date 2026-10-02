import { expect, it } from "vitest";
import {
  kitchenPack,
  kitchenSinglePack,
  softwareBasicPack,
  type WorkflowPack,
} from "../server/pack.js";
import { kitchenHumanRequests } from "./dashboard/kitchen-scope.js";
import { definitionFromPack } from "../server/workflow-definitions.js";
import { createTeamState } from "../server/engine.js";
import { FactoryWorkflowSchema, type TeamState, type WorkItem } from "./factory-contracts.js";
import {
  filterMissions,
  missionStages,
  missionSummary,
  missionWorkflowFor,
  missionAgentIds,
  missionInProject,
  stageTitle,
  type MissionAgents,
} from "./mission-stage.js";

function fixture(pack: WorkflowPack = kitchenPack) {
  const { state } = createTeamState({
    pack,
    title: "Persistent login",
    objective: "Keep sessions after restart",
    cwd: "/projects/login",
    bossAgentId: "boss",
    roleProfiles: {},
  });
  state.team.createdAt = "2026-10-02T12:00:00.000Z";
  const root = state.items[state.team.rootItemId];
  root.phaseHistory[0].enteredAt = state.team.createdAt;
  return { state, root, workflow: FactoryWorkflowSchema.parse(pack) };
}
function enter(item: WorkItem, phase: string) {
  const at = new Date(
    Date.parse("2026-10-02T12:00:00Z") + item.phaseHistory.length * 60_000,
  ).toISOString();
  item.phaseHistory.at(-1)!.exitedAt = at;
  item.phaseHistory.push({ phase, enteredAt: at, by: { type: "runtime", id: "runtime" } });
  item.phase = phase;
}
function child(state: TeamState, id = "task") {
  const root = state.items[state.team.rootItemId];
  const item: WorkItem = {
    ...root,
    id,
    board: "item",
    parentId: root.id,
    phase: "ready",
    phaseHistory: [
      { phase: "ready", enteredAt: state.team.createdAt, by: { type: "runtime", id: "runtime" } },
    ],
    bindings: {},
  };
  state.items[id] = item;
  return item;
}
function bind(state: TeamState, item: WorkItem, role = "developer") {
  state.bindings.worker = {
    id: "worker",
    workItemId: item.id,
    role,
    phase: item.phase,
    revisionAtStart: item.revision,
    decisionId: "decision",
    agentId: "agent",
    profile: role,
    status: "active",
    turn: "running",
    nudges: 0,
    errors: 0,
    createdAt: state.team.createdAt,
    lastEventAt: state.team.createdAt,
  };
}
const working: MissionAgents = {
  agent: { id: "agent", status: "running", pendingPermissions: [] },
};

it("uses the actual Kitchen workflow graph and inserts child work before integration", () => {
  const { state, root, workflow } = fixture();
  enter(root, "plan");
  enter(root, "execute");
  const item = child(state);
  enter(item, "implement");
  bind(state, item);
  const summary = missionSummary(state, workflow, working);
  expect(summary.stages.map((stage) => stage.title)).toEqual([
    "Plan",
    "Build",
    "Review",
    "Verify",
    "Integrate",
    "Final verification",
  ]);
  expect(summary.stages[0].status).toBe("completed");
  expect(summary.stages[1].status).toBe("working");
  expect(summary.stages[4].status).toBe("waiting");
  expect(summary.currentStage).toBe("Build");
  expect(summary.workingCount).toBe(1);
  expect(summary).toMatchObject({ completedItems: 0, totalItems: 1 });
});

it("Single exposes only its real implementation/review/verification stages", () => {
  const { state, workflow } = fixture(kitchenSinglePack);
  expect(missionStages(state, workflow).map((stage) => stage.title)).toEqual([
    "Build",
    "Review",
    "Verify",
  ]);
  const basic = fixture(softwareBasicPack);
  expect(missionStages(basic.state, basic.workflow).map((stage) => stage.title)).toEqual([
    "Plan",
    "Build",
    "Test",
    "Review",
  ]);
});

it("a return to implementation removes later completion and recomputes partial progress", () => {
  const { state, workflow } = fixture();
  const first = child(state, "first");
  for (const phase of ["implement", "review", "verify", "ready-for-human"]) enter(first, phase);
  const second = child(state, "second");
  enter(second, "implement");
  let stages = missionStages(state, workflow);
  expect(stages.find((stage) => stage.title === "Build")).toMatchObject({
    completedCount: 1,
    totalCount: 2,
    status: "queued",
  });
  expect(missionSummary(state, workflow)).toMatchObject({ completedItems: 1, totalItems: 2 });
  enter(first, "implement");
  stages = missionStages(state, workflow);
  expect(stages.find((stage) => stage.title === "Review")?.completedCount).toBe(0);
  expect(stages.find((stage) => stage.title === "Verify")?.completedCount).toBe(0);
  expect(missionSummary(state, workflow).completedItems).toBe(0);
});

it("a blocked report does not count the unfinished stage as completed", () => {
  const { state, workflow } = fixture();
  const item = child(state);
  enter(item, "implement");
  enter(item, "blocked");
  const summary = missionSummary(state, workflow);
  expect(summary.status).toBe("needs-you");
  expect(summary.stages.find((stage) => stage.title === "Build")).toMatchObject({
    completedCount: 0,
    status: "needs-you",
  });
});

it("final verification readiness is Needs you until explicit acceptance, with frozen completed age", () => {
  const { state, root, workflow } = fixture(kitchenSinglePack);
  for (const phase of ["implement", "review", "verify", "ready-for-human"]) enter(root, phase);
  let summary = missionSummary(state, workflow, {}, Date.parse("2026-10-02T13:00:00Z"));
  expect(summary).toMatchObject({
    status: "needs-you",
    currentStage: "Final result ready",
    completedItems: 1,
    workingCount: 0,
  });
  expect(filterMissions([summary], "completed")).toEqual([]);
  enter(root, "done");
  state.team.status = "done";
  state.team.kitchen = {
    idempotencyKey: "test",
    requestFingerprint: "test",
    mode: "accompanied",
    acceptedAt: "2026-10-02T12:05:00Z",
  };
  summary = missionSummary(state, workflow, {}, Date.parse("2026-10-03T13:00:00Z"));
  expect(summary).toMatchObject({
    status: "completed",
    needsYou: false,
    currentStage: "Done",
    ageMs: 300_000,
  });
  expect(filterMissions([summary], "completed")).toHaveLength(1);
});

it("provider quota wait and real permissions override a recorded running binding", () => {
  const { state, workflow } = fixture();
  const item = child(state);
  enter(item, "implement");
  bind(state, item);
  const parked = {
    agent: {
      ...working.agent,
      routingNotice: { status: "waiting", reason: "Weekly quota resets tomorrow" },
    },
  };
  const summary = missionSummary(state, workflow, parked);
  expect(summary).toMatchObject({
    status: "needs-you",
    workingCount: 0,
    problem: "Weekly quota resets tomorrow",
  });
  expect(summary.stages.find((stage) => stage.title === "Build")?.status).toBe("problem");
  const permissions = {
    agent: { ...working.agent, pendingPermissions: [{ id: "permission" }] },
  } as MissionAgents;
  expect(missionSummary(state, workflow, permissions).workingCount).toBe(0);
  expect(
    missionStages(state, workflow, permissions).find((stage) => stage.title === "Build")?.status,
  ).toBe("needs-you");
});

it("finished ordinary Cook turns do not ask the human to take over; missing snapshots remain unobserved", () => {
  const { state, workflow } = fixture();
  const item = child(state);
  enter(item, "implement");
  bind(state, item);
  const idle = {
    agent: { ...working.agent, status: "idle", requiresAttention: true },
  } as MissionAgents;
  expect(missionSummary(state, workflow, idle)).toMatchObject({ needsYou: false, workingCount: 0 });
  const unknown = missionSummary(state, workflow);
  expect(unknown).toMatchObject({ workingCount: 0, unobservedCount: 1 });
  expect(unknown.stages.find((stage) => stage.title === "Build")?.status).toBe("unobserved");
});

it("custom packs retain their declared stage titles and actual cyclic transition order", () => {
  const { state, workflow } = fixture();
  state.team.packId = "editorial-review";
  workflow.boards.root = {
    initialPhase: "intake",
    phases: {
      intake: { title: "Intake", kind: "resting", next: "draft" },
      draft: {
        title: "Draft manuscript",
        kind: "working",
        role: "writer",
        outcomes: { ready: "review" },
      },
      review: {
        title: "Peer critique",
        kind: "working",
        role: "critic",
        outcomes: { revise: "draft", approve: "accepted" },
      },
      accepted: { title: "Accepted manuscript", kind: "terminal" },
    },
  };
  delete workflow.boards.item;
  const titles = missionStages(state, workflow).map((stage) => stage.title);
  expect(titles).toEqual(["Draft manuscript", "Peer critique"]);
  expect(stageTitle("editorial-review", "root", "review", "Peer critique")).toBe("Peer critique");
});

it("canceled records remain reachable via All and missing pack state never fabricates Kitchen stages", () => {
  const { state } = fixture();
  state.team.status = "canceled";
  const summary = missionSummary(state);
  expect(summary).toMatchObject({
    status: "canceled",
    stages: [],
    workingCount: 0,
    needsYou: false,
  });
  expect(filterMissions([summary], "active")).toEqual([]);
  expect(filterMissions([summary], "completed")).toEqual([]);
  expect(filterMissions([summary], "all")).toEqual([summary]);
});

it("projects the executed custom workflow snapshot even after its catalog changes", () => {
  const { state } = fixture();
  const snapshot = definitionFromPack(kitchenPack, "custom-team");
  snapshot.revision = 2;
  snapshot.boards.item.phases.implement.title = "Build approved login flow";
  state.team.workflowSnapshot = snapshot;
  state.team.packId = "workflow-custom-team";
  state.team.packVersion = 2;
  const installed = [{ ...kitchenPack, workflow: FactoryWorkflowSchema.parse(kitchenPack) }];
  const executed = missionWorkflowFor(state, installed);
  expect(executed).toBe(snapshot);
  expect(
    missionStages(state, executed).some((stage) => stage.title === "Build approved login flow"),
  ).toBe(true);
  expect(state.team.workflowSnapshot.revision).toBe(2);
});

it("uses only the exact installed pack version when no mission snapshot exists", () => {
  const { state, workflow } = fixture();
  const installed = [{ ...kitchenPack, workflow }];
  expect(missionWorkflowFor(state, installed)).toBe(workflow);
  expect(
    missionWorkflowFor(state, [{ ...installed[0], version: kitchenPack.version + 1 }]),
  ).toBeUndefined();
});

function conditionalStage() {
  const { state } = fixture();
  const workflow = definitionFromPack(kitchenPack, "conditional-team");
  workflow.roles["security-reviewer"] = {
    id: "security-reviewer",
    title: "Security Reviewer",
    instructions: "Check authentication",
    skills: [],
    canEdit: false,
    workspace: "item-worktree",
    tools: [],
  };
  workflow.boards.item.phases.review.outcomes!.approve = "security-review";
  workflow.boards.item.phases["security-review"] = {
    title: "Security Reviewer",
    kind: "working",
    role: "security-reviewer",
    outcomes: { pass: "verify", findings: "implement" },
    condition: { kind: "changed-files", any: [{ prefix: "auth/" }] },
    skipTo: "verify",
  };
  state.team.workflowSnapshot = workflow;
  const item = child(state);
  enter(item, "implement");
  enter(item, "review");
  enter(item, "security-review");
  const phaseEnteredAt = item.phaseHistory.at(-1)!.enteredAt;
  item.pack.workflowConditions = {
    "item:security-review": { matches: false, skipped: true, phaseEnteredAt },
  };
  enter(item, "verify");
  return { state, item, workflow, phaseEnteredAt };
}

it("labels a persisted conditional skip instead of claiming a completed check", () => {
  const { state, workflow } = conditionalStage();
  const stage = missionStages(state, workflow).find((entry) => entry.phase === "security-review");
  expect(stage).toMatchObject({
    status: "skipped",
    skippedCount: 1,
    completedCount: 0,
    agentIds: [],
  });
});

it("invalidates a previous skip when the item enters that phase again", () => {
  const { state, item, workflow } = conditionalStage();
  enter(item, "implement");
  enter(item, "review");
  enter(item, "security-review");
  const stage = missionStages(state, workflow).find((entry) => entry.phase === "security-review");
  expect(stage).toMatchObject({ status: "queued", skippedCount: 0, completedCount: 0 });
});

it("keeps checked and skipped counts separate for a conditional stage", () => {
  const { state, workflow } = conditionalStage();
  const checked = child(state, "checked");
  enter(checked, "implement");
  enter(checked, "review");
  enter(checked, "security-review");
  checked.pack = { ...checked.pack, workflowConditions: {} };
  enter(checked, "verify");
  const stage = missionStages(state, workflow).find((entry) => entry.phase === "security-review");
  expect(stage).toMatchObject({
    status: "completed",
    skippedCount: 1,
    completedCount: 1,
    totalCount: 2,
  });
});

it("does not treat malformed or unconfirmed condition receipts as a skip", () => {
  const { state, item, workflow, phaseEnteredAt } = conditionalStage();
  item.pack.workflowConditions = {
    "item:security-review": { matches: true, skipped: true, phaseEnteredAt },
  };
  expect(
    missionStages(state, workflow).find((stage) => stage.phase === "security-review")?.skippedCount,
  ).toBe(0);
  item.pack.workflowConditions = {
    "item:security-review": { matches: false, skipped: true, phaseEnteredAt: "previous entry" },
  };
  expect(
    missionStages(state, workflow).find((stage) => stage.phase === "security-review")?.skippedCount,
  ).toBe(0);
});

it("observes only mission bosses and active bindings with stable deduplicated IDs", () => {
  const { state } = fixture();
  const item = child(state);
  bind(state, item);
  state.bindings.revoked = {
    ...state.bindings.worker,
    id: "revoked",
    agentId: "unrelated-old-agent",
    status: "revoked",
  };
  state.bindings.duplicate = { ...state.bindings.worker, id: "duplicate" };
  state.team.kitchen = {
    idempotencyKey: "mission",
    mode: "accompanied",
    sourceAgentId: "ordinary-source-chat",
  };
  expect(missionAgentIds([state])).toEqual(["agent", "boss"]);
  expect(missionAgentIds([state, state])).toEqual(["agent", "boss"]);
  state.team.status = "done";
  expect(missionAgentIds([state])).toEqual([]);
  state.team.status = "canceled";
  expect(missionAgentIds([state])).toEqual([]);
});

it("keeps external-worktree missions in their observed project and preserves legacy boundaries", () => {
  const { state, root } = fixture();
  state.team.cwd = "/outside/worktrees/login-feature";
  root.pack.nativeProjectRootPath = "/projects/login";
  root.phase = "blocked";
  expect(missionInProject(state, "/projects/login")).toBe(true);
  expect(missionInProject(state, "/outside/worktrees/login-feature")).toBe(false);
  expect(missionInProject(state, "/projects")).toBe(false);
  expect(missionInProject(state)).toBe(true);
  expect(kitchenHumanRequests([state], "/projects/login")).toHaveLength(1);
  expect(kitchenHumanRequests([state], "/projects/other")).toHaveLength(0);
  delete root.pack.nativeProjectRootPath;
  state.team.cwd = "/projects/login/nested-worktree";
  expect(missionInProject(state, "/projects/login")).toBe(true);
  state.team.cwd = "/projects/login-other";
  expect(missionInProject(state, "/projects/login")).toBe(false);
  root.pack.nativeProjectRootPath = { unconfirmed: "/projects/login" };
  expect(missionInProject(state, "/projects/login")).toBe(false);
});
