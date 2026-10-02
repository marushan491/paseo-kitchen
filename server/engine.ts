// Portions adapted from mastra-ai/mastra mastracode/factory, Apache-2.0. Modified for Agent Factory.
import { randomBytes } from "node:crypto";
import type { Board, Phase, WorkflowPack } from "./pack.js";
import type { TeamEventDraft } from "./store.js";
import type {
  Actor,
  Binding,
  Decision,
  DecisionKind,
  PlannedItem,
  Team,
  TeamReportPayload,
  TeamState,
  WorkItem,
} from "./types.js";

export const RUNTIME: Actor = { type: "runtime", id: "runtime" };

export interface WorkRequestInput {
  requestId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  parentId?: string;
  dependsOn?: string[];
  conflictsWith?: string[];
}

export class ReportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportRejectedError";
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export function boardOf(pack: WorkflowPack, item: WorkItem): Board {
  const board = pack.boards[item.board];
  if (!board) throw new Error(`Pack ${pack.id} has no board ${item.board}`);
  return board;
}

function phaseOf(pack: WorkflowPack, item: WorkItem, phaseId = item.phase): Phase {
  const phase = boardOf(pack, item).phases[phaseId];
  if (!phase) throw new Error(`Board ${item.board} has no phase ${phaseId}`);
  return phase;
}

export function isTerminal(pack: WorkflowPack, item: WorkItem): boolean {
  return phaseOf(pack, item).kind === "terminal";
}

export function isWorking(pack: WorkflowPack, item: WorkItem): boolean {
  return phaseOf(pack, item).kind === "working";
}

export function activeBinding(state: TeamState, item: WorkItem, role: string): Binding | null {
  const id = item.bindings[role];
  const binding = id ? state.bindings[id] : undefined;
  return binding && binding.status === "active" ? binding : null;
}

export function addDecision(
  state: TeamState,
  item: WorkItem,
  kind: DecisionKind,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Decision {
  const existing = Object.values(state.decisions).find((d) => d.idempotencyKey === idempotencyKey);
  if (existing) return existing;
  const now = new Date().toISOString();
  const decision: Decision = {
    id: newId("dec"),
    idempotencyKey,
    workItemId: item.id,
    kind,
    payload,
    phase: item.phase,
    status: "pending",
    attempts: 0,
    availableAt: now,
    createdAt: now,
  };
  state.decisions[decision.id] = decision;
  return decision;
}

export function createTeamState(params: {
  pack: WorkflowPack;
  title: string;
  objective: string;
  cwd: string;
  baseBranch?: string;
  bossAgentId: string;
  roleProfiles: Team["roleProfiles"];
}): { state: TeamState; events: TeamEventDraft[] } {
  const now = new Date().toISOString();
  const teamId = newId("team");
  const root: WorkItem = {
    id: newId("item"),
    teamId,
    packId: params.pack.id,
    packVersion: params.pack.version,
    board: "root",
    title: params.title,
    objective: params.objective,
    phase: params.pack.boards.root.initialPhase,
    phaseHistory: [
      {
        phase: params.pack.boards.root.initialPhase,
        enteredAt: now,
        by: { type: "boss", id: params.bossAgentId },
      },
    ],
    revision: 1,
    dependsOn: [],
    conflictsWith: [],
    acceptanceCriteria: [],
    artifacts: [],
    reports: [],
    returns: 0,
    bindings: {},
    pack: {},
  };
  const state: TeamState = {
    commit: 0,
    team: {
      id: teamId,
      title: params.title,
      objective: params.objective,
      cwd: params.cwd,
      baseBranch: params.baseBranch,
      bossAgentId: params.bossAgentId,
      packId: params.pack.id,
      packVersion: params.pack.version,
      rootItemId: root.id,
      status: "active",
      roleProfiles: params.roleProfiles,
      createdAt: now,
    },
    items: { [root.id]: root },
    bindings: {},
    decisions: {},
  };
  return {
    state,
    events: [
      {
        type: "team.started",
        actor: { type: "boss", id: params.bossAgentId },
        workItemId: root.id,
        text: `Team started: ${params.title}`,
      },
    ],
  };
}

function invalidateEvidence(item: WorkItem): void {
  for (const criterion of item.acceptanceCriteria) {
    delete criterion.met;
    delete criterion.evidence;
  }
  delete item.pack.verifiedCommit;
}

function invalidateEditableEvidence(
  pack: WorkflowPack,
  item: WorkItem,
  role: string | undefined,
): void {
  if (pack.requireVerification && role && pack.roles[role]?.canEdit) invalidateEvidence(item);
}

export function enterPhase(
  state: TeamState,
  pack: WorkflowPack,
  item: WorkItem,
  phaseId: string,
  actor: Actor,
  events: TeamEventDraft[],
  reason?: string,
): void {
  const target = phaseOf(pack, item, phaseId);
  const now = new Date().toISOString();
  const open = item.phaseHistory.at(-1);
  if (open && !open.exitedAt) open.exitedAt = now;
  const from = item.phase;
  item.phase = phaseId;
  item.phaseHistory.push({ phase: phaseId, enteredAt: now, by: actor });
  item.revision += 1;

  invalidateEditableEvidence(pack, item, target.role);

  for (const decision of Object.values(state.decisions)) {
    if (
      decision.workItemId === item.id &&
      decision.phase !== phaseId &&
      (decision.status === "pending" ||
        decision.status === "retry" ||
        decision.status === "proposed")
    ) {
      decision.status = "superseded";
    }
  }

  events.push({
    type: "item.phase",
    actor,
    workItemId: item.id,
    text: `${item.title}: ${phaseOf(pack, item, from).title} → ${target.title}${reason ? ` (${reason})` : ""}`,
    data: { from, to: phaseId, revision: item.revision },
  });

  if (target.kind === "working" && target.role) {
    const binding = activeBinding(state, item, target.role);
    if (binding) {
      binding.phase = phaseId;
      binding.revisionAtStart = item.revision;
      binding.turn = "starting";
      binding.nudges = 0;
      addDecision(
        state,
        item,
        "message-role",
        { bindingId: binding.id },
        `msg:${item.id}:${item.revision}`,
      );
    } else {
      addDecision(
        state,
        item,
        "start-role",
        { role: target.role, revision: item.revision },
        `start:${item.id}:${item.revision}`,
      );
    }
  }

  if (target.kind === "terminal") {
    for (const id of Object.values(item.bindings)) {
      const binding = state.bindings[id];
      if (binding && binding.status === "active") {
        binding.status = "revoked";
        binding.revokedAt = now;
      }
    }
  }
}

function reached(item: WorkItem, phaseId: string): boolean {
  return item.phaseHistory.some((h) => h.phase === phaseId);
}

function inheritChildCriteria(item: WorkItem, children: WorkItem[]): void {
  for (const child of children) {
    for (const criterion of child.acceptanceCriteria) {
      const id = `${child.id}:${criterion.id}`;
      if (item.acceptanceCriteria.some((existing) => existing.id === id)) continue;
      item.acceptanceCriteria.push({ id, text: `${child.title}: ${criterion.text}` });
    }
  }
}

function advanceWithChildren(
  state: TeamState,
  pack: WorkflowPack,
  item: WorkItem,
  target: string,
  events: TeamEventDraft[],
): void {
  const children = Object.values(state.items).filter((child) => child.parentId === item.id);
  const complete = children.every((child) => {
    if (!pack.requireVerification) return isTerminal(pack, child);
    return (
      child.phase === (pack.dependencyPhase ?? target) &&
      typeof child.pack.verifiedCommit === "string"
    );
  });
  if (!children.length || !complete) return;
  if (pack.requireVerification) inheritChildCriteria(item, children);
  enterPhase(state, pack, item, target, RUNTIME, events, "all items finished");
  if (isTerminal(pack, item)) {
    addDecision(
      state,
      item,
      "notify-human",
      { text: summarizeTeam(state, pack) },
      `done:${item.id}`,
    );
  }
}

function canScheduleItem(state: TeamState, pack: WorkflowPack, item: WorkItem): boolean {
  if (
    item.pack.workRequest &&
    item.phase === pack.boards.item.initialPhase &&
    state.items[item.parentId ?? ""]?.phase !== "waiting-for-work"
  )
    return false;
  const depsMet = item.dependsOn.every((dependency) => {
    const previous = state.items[dependency.id];
    if (!previous) return false;
    if (pack.requireVerification) return previous.phase === dependency.until;
    return reached(previous, dependency.until);
  });
  if (!depsMet) return false;
  const busy = Object.values(state.items).filter(
    (other) => other.id !== item.id && other.board === "item" && isWorking(pack, other),
  );
  if (item.exclusive && busy.length > 0) return false;
  return !busy.some(
    (other) =>
      other.exclusive ||
      item.conflictsWith.includes(other.id) ||
      other.conflictsWith.includes(item.id),
  );
}

export function schedule(state: TeamState, pack: WorkflowPack, events: TeamEventDraft[]): void {
  if (state.team.status !== "active") return;
  const items = Object.values(state.items);
  let working = items.filter((item) => item.board === "item" && isWorking(pack, item)).length;
  for (const item of items) {
    const phase = phaseOf(pack, item);
    if (phase.kind !== "resting") continue;
    if (phase.completeWithChildren) {
      advanceWithChildren(state, pack, item, phase.completeWithChildren, events);
      continue;
    }
    if (!phase.next) continue;
    if (item.board === "item") {
      if (working >= pack.maxParallel || !canScheduleItem(state, pack, item)) continue;
      working += 1;
    }
    enterPhase(state, pack, item, phase.next, RUNTIME, events);
  }
}

function validatePlan(planned: PlannedItem[]): void {
  const keys = new Set(planned.map((p) => p.key));
  if (keys.size !== planned.length) throw new ReportRejectedError("Item keys must be unique");
  for (const p of planned) {
    for (const ref of [...(p.dependsOn ?? []), ...(p.conflictsWith ?? [])]) {
      if (!keys.has(ref))
        throw new ReportRejectedError(`Item ${p.key} refers to unknown key ${ref}`);
    }
  }
  const byKey = new Map(planned.map((p) => [p.key, p]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new ReportRejectedError("Work item dependencies contain a cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key);
}

export function planItems(
  state: TeamState,
  pack: WorkflowPack,
  binding: Binding,
  planned: PlannedItem[],
  events: TeamEventDraft[],
): WorkItem[] {
  const root = state.items[binding.workItemId];
  const planner = pack.roles[binding.role];
  const canPlan = Boolean(planner?.tools.includes("item_plan"));
  if (!root || root.board !== "root" || root.phase !== binding.phase || !canPlan) {
    throw new ReportRejectedError(
      "item_plan is only available to the planning role while the team plans",
    );
  }
  if (Object.values(state.items).some((i) => i.parentId === root.id)) {
    throw new ReportRejectedError("The plan was already recorded; report your outcome instead");
  }
  validatePlan(planned);
  const now = new Date().toISOString();
  const idByKey = new Map(planned.map((p) => [p.key, newId("item")]));
  const created: WorkItem[] = [];
  for (const p of planned) {
    const item: WorkItem = {
      id: idByKey.get(p.key)!,
      teamId: state.team.id,
      packId: pack.id,
      packVersion: pack.version,
      board: "item",
      parentId: root.id,
      title: `${p.key} ${p.title}`,
      objective: p.objective,
      phase: pack.boards.item.initialPhase,
      phaseHistory: [
        {
          phase: pack.boards.item.initialPhase,
          enteredAt: now,
          by: { type: "role", id: binding.role },
        },
      ],
      revision: 1,
      dependsOn: (p.dependsOn ?? []).map((k) => ({
        id: idByKey.get(k)!,
        until: pack.dependencyPhase ?? "done",
      })),
      conflictsWith: (p.conflictsWith ?? []).map((k) => idByKey.get(k)!),
      exclusive: p.exclusive,
      acceptanceCriteria: p.acceptanceCriteria.map((text, i) => ({
        id: `${p.key}-${i + 1}`,
        text,
      })),
      artifacts: [],
      reports: [],
      returns: 0,
      bindings: {},
      pack: { key: p.key },
    };
    state.items[item.id] = item;
    created.push(item);
  }
  for (const item of created) {
    for (const other of item.conflictsWith) {
      const peer = state.items[other];
      if (peer && !peer.conflictsWith.includes(item.id)) peer.conflictsWith.push(item.id);
    }
  }
  events.push({
    type: "plan.recorded",
    actor: { type: "role", id: binding.role },
    workItemId: root.id,
    text: `Plan: ${created.map((c) => c.title).join(", ")}`,
    data: { items: created.map((c) => c.id) },
  });
  return created;
}

function requestParent(state: TeamState, pack: WorkflowPack, binding: Binding): WorkItem {
  const parent = state.items[binding.workItemId];
  if (
    !parent ||
    parent.board !== "item" ||
    binding.status !== "active" ||
    binding.turn === "reported" ||
    parent.phase !== binding.phase ||
    parent.revision !== binding.revisionAtStart ||
    !pack.roles[binding.role]?.tools.includes("item_request_work") ||
    !boardOf(pack, parent).phases["waiting-for-work"]
  )
    throw new ReportRejectedError(
      "Only an active worker may request bounded work for its current item",
    );
  return parent;
}

function validateWorkRequestInput(parent: WorkItem, input: WorkRequestInput): void {
  if (input.parentId && input.parentId !== parent.id)
    throw new ReportRejectedError("Requested work must belong to the caller's item");
  if (
    !input.requestId.trim() ||
    !input.title.trim() ||
    !input.objective.trim() ||
    !input.acceptanceCriteria.length ||
    input.acceptanceCriteria.some((criterion) => !criterion.trim())
  )
    throw new ReportRejectedError(
      "Requested work needs an id, title, goal and acceptance criteria",
    );
}

function workAncestors(state: TeamState, parent: WorkItem): Set<string> {
  let ancestor = parent;
  const ancestors = new Set([parent.id]);
  while (ancestor.parentId && state.items[ancestor.parentId]?.board === "item") {
    ancestor = state.items[ancestor.parentId]!;
    if (ancestors.has(ancestor.id)) throw new ReportRejectedError("Parent items contain a cycle");
    ancestors.add(ancestor.id);
  }
  return ancestors;
}

function validateDelegation(
  state: TeamState,
  pack: WorkflowPack,
  parent: WorkItem,
  input: WorkRequestInput,
): number {
  const ancestors = workAncestors(state, parent);
  const depth = ancestors.size;
  if (pack.maxDelegationDepth !== undefined && depth > pack.maxDelegationDepth)
    throw new ReportRejectedError("Delegation depth limit reached");
  const delegated = Object.values(state.items).filter(
    (item) => typeof item.pack.workRequest === "string",
  );
  if (pack.maxDelegatedItems !== undefined && delegated.length >= pack.maxDelegatedItems)
    throw new ReportRejectedError("Delegated work item limit reached");
  const refs = [...(input.dependsOn ?? []), ...(input.conflictsWith ?? [])];
  for (const ref of refs) {
    if (!state.items[ref] || state.items[ref]!.board !== "item" || ancestors.has(ref))
      throw new ReportRejectedError(`Invalid requested-work reference ${ref}`);
  }
  const dependsOnParent = (id: string, seen = new Set<string>()): boolean => {
    if (ancestors.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (
      state.items[id]?.dependsOn.some((dependency) => dependsOnParent(dependency.id, seen)) ?? false
    );
  };
  if ((input.dependsOn ?? []).some((id) => dependsOnParent(id)))
    throw new ReportRejectedError("Requested work would create a dependency cycle");
  return depth;
}

export function requestWork(
  state: TeamState,
  pack: WorkflowPack,
  binding: Binding,
  input: WorkRequestInput,
  events: TeamEventDraft[],
): WorkItem {
  const parent = requestParent(state, pack, binding);
  validateWorkRequestInput(parent, input);
  const requestKey = `${parent.id}:${input.requestId}`;
  const requestSpec = {
    title: input.title,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    dependsOn: input.dependsOn ?? [],
    conflictsWith: input.conflictsWith ?? [],
  };
  const existing = Object.values(state.items).find((item) => item.pack.workRequest === requestKey);
  if (existing) {
    if (JSON.stringify(existing.pack.workRequestSpec) !== JSON.stringify(requestSpec))
      throw new ReportRejectedError("A work request id cannot be reused for different work");
    return existing;
  }
  const depth = validateDelegation(state, pack, parent, input);
  const id = newId("item");
  const item: WorkItem = {
    id,
    teamId: state.team.id,
    packId: pack.id,
    packVersion: pack.version,
    board: "item",
    parentId: parent.id,
    title: input.title,
    objective: input.objective,
    phase: pack.boards.item.initialPhase,
    phaseHistory: [
      {
        phase: pack.boards.item.initialPhase,
        enteredAt: new Date().toISOString(),
        by: { type: "role", id: binding.role },
      },
    ],
    revision: 1,
    dependsOn: (input.dependsOn ?? []).map((ref) => ({
      id: ref,
      until: pack.dependencyPhase ?? "done",
    })),
    conflictsWith: input.conflictsWith ?? [],
    acceptanceCriteria: input.acceptanceCriteria.map((text, index) => ({
      id: `${id}-${index + 1}`,
      text,
    })),
    artifacts: [],
    reports: [],
    returns: 0,
    bindings: {},
    pack: {
      key: id,
      workRequest: requestKey,
      workRequestSpec: requestSpec,
      delegationDepth: depth,
    },
  };
  state.items[id] = item;
  parent.dependsOn.push({ id, until: pack.dependencyPhase ?? "done" });
  parent.revision += 1;
  binding.revisionAtStart = parent.revision;
  for (const ref of item.conflictsWith) {
    const peer = state.items[ref]!;
    if (!peer.conflictsWith.includes(id)) peer.conflictsWith.push(id);
  }
  events.push({
    type: "work.requested",
    actor: { type: "role", id: binding.role },
    workItemId: parent.id,
    text: `Requested work: ${item.title}`,
    data: { childId: id, depth },
  });
  return item;
}

function mergeReportEvidence(item: WorkItem, payload: TeamReportPayload): void {
  for (const artifact of payload.artifacts ?? []) {
    const known = item.artifacts.some((a) => a.kind === artifact.kind && a.ref === artifact.ref);
    if (!known && artifact.kind !== "branch") item.artifacts.push(artifact);
  }
  for (const c of payload.criteria ?? []) {
    const criterion = item.acceptanceCriteria.find((a) => a.id === c.id);
    if (criterion) {
      criterion.met = c.met;
      criterion.evidence = c.evidence;
    }
  }
}

function finalCommit(payload: TeamReportPayload, label: string): string {
  const commits = (payload.artifacts ?? []).filter((artifact) => artifact.kind === "commit");
  if (commits.length !== 1 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commits[0]!.ref)) {
    throw new ReportRejectedError(
      `${label} requires exactly one full ${label === "Integration" ? "combined" : "final"} commit artifact`,
    );
  }
  return commits[0]!.ref;
}

function validateCriteria(item: WorkItem, payload: TeamReportPayload): void {
  const criteria = payload.criteria ?? [];
  if (
    !item.acceptanceCriteria.length ||
    criteria.length !== item.acceptanceCriteria.length ||
    new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length ||
    item.acceptanceCriteria.some(
      (criterion) =>
        !criteria.some(
          (reported) =>
            reported.id === criterion.id && reported.met && reported.evidence.trim().length > 0,
        ),
    )
  ) {
    throw new ReportRejectedError(
      "Verification requires current evidence for every acceptance criterion",
    );
  }
}

function validateFinalReport(
  pack: WorkflowPack,
  binding: Binding,
  item: WorkItem,
  payload: TeamReportPayload,
): void {
  if (!pack.requireVerification || payload.needs) return;
  if (binding.role === "integrator" && payload.outcome === "done") {
    finalCommit(payload, "Integration");
  }
  if (binding.role === "verifier" && payload.outcome === "pass") {
    const commit = finalCommit(payload, "Verification");
    validateCriteria(item, payload);
    item.pack.verifiedCommit = commit;
  }
}

function validateReportBinding(
  item: WorkItem | undefined,
  binding: Binding,
): asserts item is WorkItem {
  if (!item) throw new ReportRejectedError("The work item no longer exists");
  if (binding.status !== "active") throw new ReportRejectedError("This seat was revoked");
  if (
    binding.turn === "reported" ||
    item.phase !== binding.phase ||
    item.revision !== binding.revisionAtStart
  ) {
    throw new ReportRejectedError(
      "This report is for an older state of the item; it was not applied. Stop and wait for new instructions.",
    );
  }
}

export function applyReport(
  state: TeamState,
  pack: WorkflowPack,
  binding: Binding,
  payload: TeamReportPayload,
  events: TeamEventDraft[],
): WorkItem {
  const item = state.items[binding.workItemId];
  validateReportBinding(item, binding);
  const phase = phaseOf(pack, item);
  const nextPhase = phase.outcomes?.[payload.outcome];
  if (!nextPhase) {
    throw new ReportRejectedError(
      `Unknown outcome "${payload.outcome}". Allowed: ${Object.keys(phase.outcomes ?? {}).join(", ")}`,
    );
  }
  validateFinalReport(pack, binding, item, payload);
  const actor: Actor = { type: "role", id: binding.role };
  mergeReportEvidence(item, payload);
  invalidateEditableEvidence(pack, item, binding.role);
  item.reports.push({
    role: binding.role,
    phase: item.phase,
    outcome: payload.outcome,
    summary: payload.summary,
  });
  binding.turn = "reported";
  binding.lastEventAt = new Date().toISOString();
  events.push({
    type: "report.accepted",
    actor,
    workItemId: item.id,
    text: payload.summary,
    data: { outcome: payload.outcome, bindingId: binding.id },
  });

  if (payload.needs?.kind === "human") {
    blockForBoss(state, pack, item, payload.needs.text, events);
    return item;
  }
  const children = Object.values(state.items).filter((child) => child.parentId === item.id);
  if (
    pack.requireVerification &&
    item.board === "item" &&
    children.some((child) => child.phase !== pack.dependencyPhase)
  ) {
    enterPhase(
      state,
      pack,
      item,
      "waiting-for-work",
      actor,
      events,
      "requested work must finish first",
    );
    schedule(state, pack, events);
    return item;
  }
  if (pack.requireVerification && payload.needs) {
    blockForBoss(state, pack, item, payload.needs.text, events);
    return item;
  }
  const firstEntry = (phaseId: string) => item.phaseHistory.findIndex((h) => h.phase === phaseId);
  const goesBack = firstEntry(nextPhase) !== -1 && firstEntry(nextPhase) < firstEntry(item.phase);
  if (goesBack) {
    item.returns += 1;
    if (item.returns > (phaseOf(pack, item).maxReturns ?? pack.maxReturns)) {
      blockForBoss(
        state,
        pack,
        item,
        `Returned ${item.returns} times; last: ${payload.summary}`,
        events,
      );
      return item;
    }
  }
  enterPhase(
    state,
    pack,
    item,
    nextPhase,
    actor,
    events,
    goesBack ? `returned by ${binding.role}` : undefined,
  );
  if (item.board === "root" && isTerminal(pack, item)) {
    addDecision(
      state,
      item,
      "notify-human",
      { text: summarizeTeam(state, pack) },
      `done:${item.id}`,
    );
  }
  schedule(state, pack, events);
  return item;
}

export function blockForBoss(
  state: TeamState,
  pack: WorkflowPack,
  item: WorkItem,
  why: string,
  events: TeamEventDraft[],
): void {
  if (boardOf(pack, item).phases.blocked) {
    enterPhase(state, pack, item, "blocked", RUNTIME, events, why);
  }
  addDecision(
    state,
    item,
    "notify-human",
    { text: `${item.title} needs you: ${why}` },
    `block:${item.id}:${item.revision}`,
  );
}

export function summarizeTeam(state: TeamState, pack: WorkflowPack): string {
  const items = Object.values(state.items).filter((i) => i.board === "item");
  const lines = items.map((i) => {
    const last = i.reports.at(-1);
    const refs = i.artifacts.map((a) => `${a.kind} ${a.ref}`).join(", ");
    return `- ${i.title}: ${phaseOf(pack, i).title}${last ? ` — ${last.summary}` : ""}${refs ? ` (${refs})` : ""}`;
  });
  return `Team "${state.team.title}" finished.\n${lines.join("\n")}`;
}
