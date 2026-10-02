import {
  FactoryPolicySchema,
  type FactoryPolicy,
  type TeamEvent,
  type TeamState,
} from "../shared/factory-contracts.js";

export function acceptanceProblem(state: TeamState): string | null {
  const root = state.items[state.team.rootItemId];
  if (state.team.status === "done" || state.team.status === "canceled")
    return "This run is closed.";
  if (root?.phase !== "ready-for-human") return "Wait for final verification and human review.";
  if (
    typeof root.pack.verifiedCommit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(root.pack.verifiedCommit)
  )
    return "A full verified final commit is required.";
  if (
    !root.acceptanceCriteria.length ||
    root.acceptanceCriteria.some((criterion) => !criterion.met || !criterion.evidence?.trim())
  )
    return "Every acceptance criterion needs verified evidence.";
  if (
    Object.values(state.bindings).some(
      (binding) => binding.status === "active" && ["starting", "running"].includes(binding.turn),
    )
  )
    return "Wait for all Cooks to finish.";
  return null;
}

export function kitchenInsights(state: TeamState, events: readonly TeamEvent[]) {
  const items = Object.values(state.items);
  const active = Object.values(state.bindings).filter(
    (binding) => binding.status === "active" && ["starting", "running"].includes(binding.turn),
  );
  const activeItems = new Set(active.map((binding) => binding.workItemId));
  const children = items.filter((item) => item.board !== "root");
  return {
    active,
    needsYou: items.filter(
      (item) =>
        item.phase === "blocked" || (item.board === "root" && item.phase === "ready-for-human"),
    ),
    completed: children.filter((item) => item.phase === "done" || item.phase === "ready-for-human"),
    queued: children.filter(
      (item) =>
        !["done", "canceled", "blocked", "ready-for-human"].includes(item.phase) &&
        !activeItems.has(item.id),
    ),
    reports: events.filter((event) => event.type === "report.accepted").length,
    rejected: events.filter((event) => event.type === "report.rejected").length,
    returns: items.reduce((sum, item) => sum + item.returns, 0),
    messages: events.filter((event) => event.type === "human.message").length,
    escalations: events.filter((event) => event.type === "boss.notified").length,
  };
}

export function parseCriteria(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({ id: `criterion-${index + 1}`, text: line }));
}

export type PolicyDraft = Partial<Record<keyof FactoryPolicy, string>>;
export function parsePolicyDraft(draft: PolicyDraft) {
  const values: Record<string, unknown> = Object.fromEntries(
    Object.entries(draft)
      .filter(([key, value]) => key !== "requireOutcomeJudge" && value?.trim())
      .map(([key, value]) => [key, Number(value)]),
  );
  if (draft.requireOutcomeJudge === "required") values.requireOutcomeJudge = true;
  return FactoryPolicySchema.safeParse(values);
}
