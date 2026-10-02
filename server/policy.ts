import {
  FactoryPolicySchema,
  type FactoryPolicy,
  type EvidenceResult,
} from "../shared/factory-contracts.js";

export interface PolicyObservation {
  activeMs?: number;
  roleActiveMs?: Readonly<Record<string, number>>;
  startedAgents?: number;
  chainSteps?: number;
  outcomeJudgeAvailable?: boolean;
  delegationDepth?: number;
  delegatedItems?: number;
  usage?: {
    scope: "team";
    cumulative: boolean;
    complete: boolean;
    tokens?: number;
    costUsd?: number;
  };
}

export interface PolicyViolation {
  code: "unavailable" | "limit";
  dimension: keyof FactoryPolicy;
  message: string;
}

export function evaluatePolicy(
  input: FactoryPolicy,
  observation: PolicyObservation,
): PolicyViolation[] {
  const policy = FactoryPolicySchema.parse(input);
  const violations: PolicyViolation[] = [];
  const usage = observation.usage;
  const complete = usage?.scope === "team" && usage.cumulative && usage.complete;
  check("maxTokens", complete ? usage.tokens : undefined, policy.maxTokens, violations);
  check("maxCostUsd", complete ? usage.costUsd : undefined, policy.maxCostUsd, violations);
  check("maxAgentStarts", observation.startedAgents, policy.maxAgentStarts, violations);
  check("maxChainSteps", observation.chainSteps, policy.maxChainSteps, violations);
  if (policy.requireOutcomeJudge && observation.outcomeJudgeAvailable !== true) {
    violations.push({
      code: "unavailable",
      dimension: "requireOutcomeJudge",
      message: "requireOutcomeJudge: configured outcome judge unavailable",
    });
  }
  check("totalActiveMs", observation.activeMs, policy.totalActiveMs, violations);
  if (policy.roleActiveMs !== undefined) {
    const times = Object.values(observation.roleActiveMs ?? {});
    const observed =
      observation.roleActiveMs && times.every(valid) ? Math.max(0, ...times) : undefined;
    check("roleActiveMs", observed, policy.roleActiveMs, violations);
  }
  check(
    "maxDelegationDepth",
    observation.delegationDepth,
    policy.maxDelegationDepth,
    violations,
    true,
  );
  check(
    "maxDelegatedItems",
    observation.delegatedItems,
    policy.maxDelegatedItems,
    violations,
    true,
  );
  return violations;
}

export function assertPolicyAllows(policy: FactoryPolicy, observation: PolicyObservation): void {
  const failures = evaluatePolicy(policy, observation);
  if (failures.length) throw new Error(failures.map((failure) => failure.message).join("; "));
}

export function assertOutcomeJudged(
  policy: FactoryPolicy,
  checks: readonly EvidenceResult[],
  candidateCommit: string,
): void {
  if (!FactoryPolicySchema.parse(policy).requireOutcomeJudge) return;
  const judgments = checks.filter((receipt) => receipt.kind === "judge");
  if (
    !judgments.length ||
    judgments.some((receipt) => !receipt.passed || receipt.candidateCommit !== candidateCommit)
  ) {
    throw new Error(
      "requireOutcomeJudge: a passed outcome judgment for the current verified commit is required",
    );
  }
}

function valid(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function check(
  dimension: keyof FactoryPolicy,
  observed: number | undefined,
  limit: number | undefined,
  violations: PolicyViolation[],
  inclusive = false,
) {
  if (limit === undefined) return;
  if (!valid(observed)) {
    violations.push({
      code: "unavailable",
      dimension,
      message: `${dimension}: trustworthy cumulative observation unavailable`,
    });
    return;
  }
  if (inclusive ? observed > limit : observed >= limit)
    violations.push({
      code: "limit",
      dimension,
      message: `${dimension}: ${observed} reached configured limit ${limit}`,
    });
}
