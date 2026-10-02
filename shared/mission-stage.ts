import type { PaseoAgent } from "@getpaseo/client";
import { z } from "zod";
import type {
  Binding,
  FactoryPackSchema,
  FactoryWorkflowSchema,
  TeamState,
  WorkItem,
} from "./factory-contracts.js";
import { readAgentRoutingNotice } from "./agent-routing.js";

export type MissionPack = z.infer<typeof FactoryPackSchema>;
export type MissionWorkflow = Pick<z.infer<typeof FactoryWorkflowSchema>, "boards" | "roles">;
export function missionWorkflowFor(
  state: TeamState,
  packs: readonly MissionPack[],
): MissionWorkflow | undefined {
  if (state.team.workflowSnapshot) return state.team.workflowSnapshot;
  return packs.find(
    (pack) => pack.id === state.team.packId && pack.version === state.team.packVersion,
  )?.workflow;
}
export function missionAgentIds(teams: readonly TeamState[]): string[] {
  const ids = new Set<string>();
  for (const state of teams) {
    if (["done", "canceled"].includes(state.team.status)) continue;
    ids.add(state.team.bossAgentId);
    for (const binding of Object.values(state.bindings)) {
      if (binding.status === "active") ids.add(binding.agentId);
    }
  }
  return [...ids].filter(Boolean).sort();
}
export type MissionAgent = Pick<PaseoAgent, "id" | "status" | "pendingPermissions"> & {
  routingNotice?: unknown;
  lastError?: string | null;
};
export type MissionAgents = Readonly<Record<string, MissionAgent>>;
export type MissionStageStatus =
  | "waiting"
  | "queued"
  | "working"
  | "completed"
  | "skipped"
  | "needs-you"
  | "problem"
  | "unobserved";
export interface MissionStage {
  id: string;
  board: string;
  phase: string;
  role: string;
  title: string;
  status: MissionStageStatus;
  itemIds: string[];
  agentIds: string[];
  completedCount: number;
  skippedCount: number;
  totalCount: number;
  since?: string;
}
export interface MissionSummary {
  teamId: string;
  title: string;
  projectPath: string;
  status: "active" | "needs-you" | "paused" | "completed" | "canceled";
  statusLabel: string;
  currentStage: string;
  stages: MissionStage[];
  completedItems: number;
  totalItems: number;
  workingCount: number;
  unobservedCount: number;
  ageMs: number;
  updatedAt: string;
  needsYou: boolean;
  problem: string | null;
}

const kitchenPhases: Record<string, string> = {
  plan: "Plan",
  implement: "Build",
  review: "Review",
  verify: "Verify",
  integrate: "Integrate",
};
export function stageTitle(packId: string, board: string, phase: string, fallback: string): string {
  if (!["kitchen", "kitchen-single", "software-basic"].includes(packId)) return fallback;
  if (packId === "kitchen" && board === "root" && phase === "verify") return "Final verification";
  return kitchenPhases[phase] ?? fallback;
}

function workflowStages(
  workflow: MissionWorkflow,
  packId: string,
): Omit<
  MissionStage,
  "status" | "itemIds" | "agentIds" | "completedCount" | "skippedCount" | "totalCount" | "since"
>[] {
  const stages: ReturnType<typeof workflowStages> = [];
  const visited = new Set<string>();
  const visit = (board: string, phaseId: string) => {
    const key = `${board}:${phaseId}`;
    if (visited.has(key)) return;
    visited.add(key);
    const phase = workflow.boards[board]?.phases[phaseId];
    if (!phase) return;
    if (phase.kind === "working")
      stages.push({
        id: key,
        board,
        phase: phaseId,
        role: phase.role ?? "",
        title: stageTitle(packId, board, phaseId, phase.title),
      });
    if (phase.completeWithChildren) {
      for (const [childBoard, definition] of Object.entries(workflow.boards)) {
        if (childBoard !== "root") visit(childBoard, definition.initialPhase);
      }
    }
    for (const target of [
      phase.next,
      phase.completeWithChildren,
      ...Object.values(phase.outcomes ?? {}),
    ]) {
      if (target) visit(board, target);
    }
  };
  const root = workflow.boards.root;
  if (root) visit("root", root.initialPhase);
  for (const [board, definition] of Object.entries(workflow.boards)) {
    for (const phase of Object.keys(definition.phases)) visit(board, phase);
  }
  return stages;
}

function nextWorkingPhase(
  workflow: MissionWorkflow,
  board: string,
  phaseId: string,
): string | null {
  const seen = new Set<string>();
  let current: string | undefined = phaseId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const phase: MissionWorkflow["boards"][string]["phases"][string] | undefined =
      workflow.boards[board]?.phases[current];
    if (!phase || phase.kind !== "resting") return current;
    current = phase.next ?? phase.completeWithChildren;
  }
  return null;
}

const SkippedConditionSchema = z.object({
  matches: z.literal(false),
  skipped: z.literal(true),
  phaseEnteredAt: z.string(),
});

function stageSkipped(item: WorkItem, stage: Pick<MissionStage, "id" | "phase">): boolean {
  const receipts = item.pack.workflowConditions;
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) return false;
  const receipt = SkippedConditionSchema.safeParse(Reflect.get(receipts, stage.id));
  const entry = item.phaseHistory.findLast((step) => step.phase === stage.phase);
  return (
    receipt.success &&
    item.phase !== stage.phase &&
    receipt.data.phaseEnteredAt === entry?.enteredAt
  );
}

function stageCompleted(
  item: WorkItem,
  stage: MissionStage,
  workflow: MissionWorkflow,
  stages: MissionStage[],
): boolean {
  if (item.phase === stage.phase || item.phase === "canceled") return false;
  const index = item.phaseHistory.findLastIndex((entry) => entry.phase === stage.phase);
  const entry = item.phaseHistory[index];
  const next = item.phaseHistory[index + 1];
  if (!entry?.exitedAt || !next) return false;
  const boardStages = stages.filter((candidate) => candidate.board === stage.board);
  const rank = boardStages.findIndex((candidate) => candidate.id === stage.id);
  const nextPhase = nextWorkingPhase(workflow, stage.board, next.phase);
  const nextRank = boardStages.findIndex((candidate) => candidate.phase === nextPhase);
  const target = nextPhase ? workflow.boards[stage.board]?.phases[nextPhase] : undefined;
  if (nextRank <= rank && target?.kind !== "terminal") return false;
  if (nextPhase === "canceled" || !target) return false;
  return !item.phaseHistory.slice(index + 1).some((step) => {
    const position = boardStages.findIndex((candidate) => candidate.phase === step.phase);
    return position >= 0 && position <= rank;
  });
}

export function missionAgentWorking(agent: MissionAgent | undefined): boolean {
  if (!agent || agent.pendingPermissions.length) return false;
  const notice = readAgentRoutingNotice(agent);
  if (notice?.status === "waiting" || notice?.status === "exhausted") return false;
  return agent.status === "running";
}

function agentProblem(agent: MissionAgent | undefined): string | null {
  if (!agent) return null;
  const notice = readAgentRoutingNotice(agent);
  if (notice?.status === "waiting" || notice?.status === "exhausted") return notice.reason;
  return agent.status === "error" ? agent.lastError || "An agent could not continue." : null;
}

function liveBindings(state: TeamState): Binding[] {
  return Object.values(state.bindings).filter(
    (binding) => binding.status === "active" && ["starting", "running"].includes(binding.turn),
  );
}

function stageStatus(
  stage: MissionStage,
  state: TeamState,
  workflow: MissionWorkflow,
  agents: MissionAgents,
): MissionStageStatus {
  const bindings = liveBindings(state).filter(
    (binding) =>
      binding.phase === stage.phase && state.items[binding.workItemId]?.board === stage.board,
  );
  if (bindings.some((binding) => agents[binding.agentId]?.pendingPermissions.length))
    return "needs-you";
  if (bindings.some((binding) => agentProblem(agents[binding.agentId]))) return "problem";
  if (bindings.some((binding) => missionAgentWorking(agents[binding.agentId]))) return "working";
  const items = stage.itemIds.map((id) => state.items[id]);
  if (
    items.some(
      (item) =>
        item.phase === "blocked" &&
        item.phaseHistory.findLast(
          (entry) => workflow.boards[item.board]?.phases[entry.phase]?.kind === "working",
        )?.phase === stage.phase,
    )
  )
    return "needs-you";
  if (bindings.some((binding) => !agents[binding.agentId])) return "unobserved";
  if (stage.totalCount > 0 && stage.completedCount + stage.skippedCount === stage.totalCount)
    return stage.completedCount ? "completed" : "skipped";
  if (items.some((item) => item.phase === stage.phase)) return "queued";
  return "waiting";
}

export function missionStages(
  state: TeamState,
  workflow: MissionWorkflow | undefined,
  agents: MissionAgents = {},
): MissionStage[] {
  if (!workflow) return [];
  const stages: MissionStage[] = workflowStages(workflow, state.team.packId).map((stage) =>
    Object.assign({}, stage, {
      status: "waiting" as const,
      itemIds: Object.values(state.items)
        .filter((item) => item.board === stage.board && item.phase !== "canceled")
        .map((item) => item.id),
      agentIds: [
        ...new Set(
          Object.values(state.bindings)
            .filter(
              (binding) =>
                binding.phase === stage.phase &&
                state.items[binding.workItemId]?.board === stage.board &&
                !stageSkipped(state.items[binding.workItemId], stage),
            )
            .map((binding) => binding.agentId)
            .filter(Boolean),
        ),
      ],
      completedCount: 0,
      skippedCount: 0,
      totalCount: 0,
    }),
  );
  for (const stage of stages) {
    stage.totalCount = stage.itemIds.length;
    stage.completedCount = stage.itemIds.filter(
      (id) =>
        !stageSkipped(state.items[id], stage) &&
        stageCompleted(state.items[id], stage, workflow, stages),
    ).length;
    stage.skippedCount = stage.itemIds.filter((id) => stageSkipped(state.items[id], stage)).length;
    const entries = stage.itemIds.flatMap((id) =>
      state.items[id].phaseHistory.filter((entry) => entry.phase === stage.phase),
    );
    stage.since = entries
      .map((entry) => entry.enteredAt)
      .sort()
      .at(-1);
    stage.status = stageStatus(stage, state, workflow, agents);
  }
  return stages;
}

function completedItem(item: WorkItem, workflow: MissionWorkflow | undefined): boolean {
  return (
    item.phase !== "canceled" &&
    workflow?.boards[item.board]?.phases[item.phase]?.kind === "terminal"
  );
}

function summaryStatus(state: TeamState, needsYou: boolean): MissionSummary["status"] {
  if (state.team.status === "done") return "completed";
  if (state.team.status === "canceled") return "canceled";
  if (needsYou) return "needs-you";
  return state.team.status === "paused" ? "paused" : "active";
}

function progressItems(state: TeamState): WorkItem[] {
  const children = Object.values(state.items).filter(
    (item) => item.id !== state.team.rootItemId && item.phase !== "canceled",
  );
  if (children.length) return children;
  const root = state.items[state.team.rootItemId];
  return root ? [root] : [];
}

function missionProblem(state: TeamState, agents: MissionAgents, ids: string[]): string | null {
  const failed = Object.values(state.decisions).find((decision) => decision.status === "failed");
  return (
    ids.map((id) => agentProblem(agents[id])).find(Boolean) ||
    failed?.lastError ||
    (failed ? "An execution could not continue." : null) ||
    state.team.runtime?.limitReason ||
    null
  );
}

function missionNeedsYou(
  state: TeamState,
  agents: MissionAgents,
  ids: string[],
  problem: string | null,
): boolean {
  return (
    Boolean(problem) ||
    state.items[state.team.rootItemId]?.phase === "ready-for-human" ||
    Object.values(state.items).some((item) => item.phase === "blocked") ||
    ids.some((id) => Boolean(agents[id]?.pendingPermissions.length))
  );
}

function missionFinishedAt(state: TeamState, fallback: string): string {
  return (
    state.team.kitchen?.acceptedAt ||
    state.items[state.team.rootItemId]?.phaseHistory.findLast(
      (step) => step.phase === "done" || step.phase === "canceled",
    )?.enteredAt ||
    fallback
  );
}

export function missionSummary(
  state: TeamState,
  workflow?: MissionWorkflow,
  agents: MissionAgents = {},
  now = Date.now(),
): MissionSummary {
  const stages = missionStages(state, workflow, agents);
  const items = progressItems(state);
  const bindingIds = [...new Set(liveBindings(state).map((binding) => binding.agentId))];
  const agentIds = [...new Set([state.team.bossAgentId, ...bindingIds])];
  const open = state.team.status !== "done" && state.team.status !== "canceled";
  const problem = open ? missionProblem(state, agents, agentIds) : null;
  const needsYou = open && missionNeedsYou(state, agents, agentIds, problem);
  const status = summaryStatus(state, needsYou);
  const current = stages.filter((stage) =>
    ["working", "queued", "needs-you", "problem", "unobserved"].includes(stage.status),
  );
  const updatedAt = [
    state.team.createdAt,
    state.team.kitchen?.acceptedAt,
    ...Object.values(state.items).flatMap((item) =>
      item.phaseHistory.map((step) => step.exitedAt ?? step.enteredAt),
    ),
    ...Object.values(state.bindings).map((binding) => binding.lastEventAt),
  ]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)!;
  return {
    teamId: state.team.id,
    title: state.team.title,
    projectPath: state.team.cwd,
    status,
    statusLabel: {
      active: "Active",
      "needs-you": "Needs you",
      paused: "Paused",
      completed: "Done",
      canceled: "Canceled",
    }[status],
    currentStage: currentStage(state, stages, current),
    stages,
    completedItems: items.filter((item) => completedItem(item, workflow)).length,
    totalItems: items.length,
    workingCount: open ? agentIds.filter((id) => missionAgentWorking(agents[id])).length : 0,
    unobservedCount: open ? bindingIds.filter((id) => !agents[id]).length : 0,
    ageMs:
      Math.max(
        0,
        (open ? now : Date.parse(missionFinishedAt(state, updatedAt))) -
          Date.parse(state.team.createdAt),
      ) || 0,
    updatedAt,
    needsYou,
    problem,
  };
}

function currentStage(state: TeamState, stages: MissionStage[], current: MissionStage[]): string {
  if (state.team.status === "done") return "Done";
  if (state.team.status === "canceled") return "Canceled";
  if (state.items[state.team.rootItemId]?.phase === "ready-for-human") return "Final result ready";
  if (state.items[state.team.rootItemId]?.phase === "blocked") return "Question for you";
  if (!stages.length) return "Workflow unavailable";
  return (
    current
      .slice(0, 2)
      .map((stage) => stage.title)
      .join(" → ") || "Waiting for next stage"
  );
}

export type MissionFilter = "all" | "active" | "needs-you" | "completed";
export function filterMissions(
  summaries: readonly MissionSummary[],
  filter: MissionFilter,
): MissionSummary[] {
  return summaries
    .filter((summary) => {
      if (filter === "all") return true;
      if (filter === "needs-you") return summary.needsYou;
      if (filter === "completed") return summary.status === "completed";
      return !["completed", "canceled"].includes(summary.status);
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function missionAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "Just started";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d`;
}
