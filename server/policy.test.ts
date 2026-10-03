import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  assertPolicyAllows,
  assertOutcomeJudged,
  type PolicyObservation,
} from "./policy.js";
import { verifyOperatorApproval } from "./approval.js";
import { AutonomySettingsSchema } from "../shared/preferences.js";
import {
  isBlockingQuestion,
  optionalQuestionDue,
  type HumanQuestion,
} from "../shared/question-policy.js";

describe("Optional question policy", () => {
  const question: HumanQuestion = {
    id: "question-1",
    revision: 1,
    category: "clarification",
    text: "Save or Apply?",
    askedAt: "2026-10-03T12:00:00Z",
    continueAt: "2026-10-03T12:01:00Z",
  };
  const now = new Date("2026-10-03T12:01:00Z");
  it("enforces the deadline, started replies, wait mode and updated waiting periods", () => {
    const defaults = AutonomySettingsSchema.parse({});
    expect(defaults).toEqual({
      autoAcceptPermissions: true,
      optionalQuestionBehavior: "continue",
      questionWaitSeconds: 60,
    });
    expect(optionalQuestionDue(question, defaults, new Date(now.getTime() - 1))).toBe(false);
    expect(optionalQuestionDue(question, defaults, now)).toBe(true);
    expect(
      optionalQuestionDue({ ...question, responseStartedAt: question.askedAt }, defaults, now),
    ).toBe(false);
    expect(
      optionalQuestionDue(question, { ...defaults, optionalQuestionBehavior: "wait" }, now),
    ).toBe(false);
    expect(optionalQuestionDue(question, { ...defaults, questionWaitSeconds: 120 }, now)).toBe(
      false,
    );
    expect(optionalQuestionDue({ ...question, askedAt: "invalid" }, defaults, now)).toBe(false);
  });
  it.each([
    "Password missing",
    "OAuth consent",
    "MFA code",
    "Benutzername nötig",
    "Approval to deploy",
    "Merge now?",
    "",
  ])("keeps actual access or authorization questions open: %s", (text) => {
    expect(isBlockingQuestion("clarification", text)).toBe(true);
    expect(optionalQuestionDue({ ...question, text }, AutonomySettingsSchema.parse({}), now)).toBe(
      false,
    );
  });
  it("rejects invalid timeouts and honors explicit blocker categories", () => {
    expect(AutonomySettingsSchema.safeParse({ questionWaitSeconds: 0 }).success).toBe(false);
    expect(AutonomySettingsSchema.safeParse({ questionWaitSeconds: 3601 }).success).toBe(false);
    expect(isBlockingQuestion("irreversible", "Proceed?")).toBe(true);
    expect(isBlockingQuestion("access", "Continue?")).toBe(true);
    expect(isBlockingQuestion("requirements", "Use a blue or purple button?")).toBe(false);
  });
});

const observation: PolicyObservation = {
  activeMs: 200,
  roleActiveMs: { developer: 100 },
  startedAgents: 1,
  delegationDepth: 2,
  usage: { scope: "team", cumulative: true, complete: true, tokens: 10, costUsd: 0.1 },
};

describe("Configured Kitchen policy", () => {
  it("fails closed for selected token and cost limits without cumulative coverage", () => {
    expect(evaluatePolicy({ maxTokens: 100, maxCostUsd: 1 }, {})).toHaveLength(2);
    expect(
      evaluatePolicy(
        { maxTokens: 100 },
        { usage: { scope: "team", cumulative: false, complete: true, tokens: 0 } },
      )[0].code,
    ).toBe("unavailable");
    expect(
      evaluatePolicy(
        { maxCostUsd: 1 },
        { usage: { scope: "team", cumulative: true, complete: false, costUsd: 0.1 } },
      )[0].code,
    ).toBe("unavailable");
    expect(() => assertPolicyAllows({ maxTokens: 100 }, {})).toThrow("unavailable");
    expect(evaluatePolicy({}, {})).toEqual([]);
  });

  it("enforces starts, measured time, USD cost and tokens at the exact limit", () => {
    const violations = evaluatePolicy(
      { maxTokens: 10, maxCostUsd: 0.1, maxAgentStarts: 1, totalActiveMs: 200, roleActiveMs: 100 },
      observation,
    );
    expect(violations).toHaveLength(5);
    expect(violations.every((violation) => violation.code === "limit")).toBe(true);
    expect(() =>
      assertPolicyAllows(
        {
          maxTokens: 11,
          maxCostUsd: 0.2,
          maxAgentStarts: 2,
          totalActiveMs: 201,
          roleActiveMs: 101,
          maxDelegationDepth: 2,
        },
        observation,
      ),
    ).not.toThrow();
  });

  it("limits observed plugin chain steps and requires configured judge availability", () => {
    expect(evaluatePolicy({ maxChainSteps: 2 }, {})[0].code).toBe("unavailable");
    expect(evaluatePolicy({ maxChainSteps: 2 }, { chainSteps: 2 })[0].code).toBe("limit");
    expect(evaluatePolicy({ maxChainSteps: 2 }, { chainSteps: 1 })).toEqual([]);
    expect(evaluatePolicy({ requireOutcomeJudge: true }, {})[0].code).toBe("unavailable");
    expect(evaluatePolicy({ requireOutcomeJudge: true }, { outcomeJudgeAvailable: true })).toEqual(
      [],
    );
    expect(evaluatePolicy({ requireOutcomeJudge: false }, {})).toEqual([]);
  });

  it("applies delegated-item limits only when selected and permits the exact count", () => {
    expect(evaluatePolicy({}, { delegatedItems: 100 })).toEqual([]);
    expect(evaluatePolicy({ maxDelegatedItems: 0 }, { delegatedItems: 0 })).toEqual([]);
    expect(evaluatePolicy({ maxDelegatedItems: 2 }, { delegatedItems: 2 })).toEqual([]);
    expect(evaluatePolicy({ maxDelegatedItems: 2 }, { delegatedItems: 3 })[0].code).toBe("limit");
    expect(evaluatePolicy({ maxDelegatedItems: 2 }, {})[0].code).toBe("unavailable");
  });

  it("requires actual passed judge evidence bound to the current candidate", () => {
    const candidate = "a".repeat(40);
    const receipt = {
      id: "jev",
      kind: "judge" as const,
      passed: true,
      summary: "Actual configured judgment",
      checkedAt: new Date().toISOString(),
      candidateCommit: candidate,
    };
    expect(() => assertOutcomeJudged({}, [], candidate)).not.toThrow();
    expect(() => assertOutcomeJudged({ requireOutcomeJudge: true }, [], candidate)).toThrow(
      "required",
    );
    expect(() =>
      assertOutcomeJudged({ requireOutcomeJudge: true }, [receipt], candidate),
    ).not.toThrow();
    expect(() =>
      assertOutcomeJudged({ requireOutcomeJudge: true }, [receipt], "b".repeat(40)),
    ).toThrow("required");
    expect(() =>
      assertOutcomeJudged(
        { requireOutcomeJudge: true },
        [{ ...receipt, passed: false }],
        candidate,
      ),
    ).toThrow("required");
  });

  it("permits configured depth itself and rejects deeper requests or invalid observations", () => {
    expect(evaluatePolicy({ maxDelegationDepth: 2 }, observation)).toEqual([]);
    expect(evaluatePolicy({ maxDelegationDepth: 1 }, observation)[0].code).toBe("limit");
    expect(evaluatePolicy({ totalActiveMs: 10 }, { activeMs: Number.NaN })[0].code).toBe(
      "unavailable",
    );
    expect(
      evaluatePolicy(
        { maxTokens: 100 },
        { usage: { scope: "team", cumulative: true, complete: true, tokens: -1 } },
      )[0].code,
    ).toBe("unavailable");
  });
});

describe("Operator credential approval", () => {
  const credential = "fixture-only-operator-credential-value";
  const commit = "a".repeat(40);
  it("requires server provisioning and rejects actor labels without a credential", () => {
    expect(() =>
      verifyOperatorApproval({
        configuredCredential: undefined,
        suppliedCredential: "human",
        candidateCommit: commit,
        requestedCommit: commit,
      }),
    ).toThrow("Provision");
    expect(() =>
      verifyOperatorApproval({
        configuredCredential: credential,
        suppliedCredential: "human",
        candidateCommit: commit,
        requestedCommit: commit,
      }),
    ).toThrow("rejected");
  });
  it("binds possession proof to the verified candidate and never records the secret", () => {
    expect(() =>
      verifyOperatorApproval({
        configuredCredential: credential,
        suppliedCredential: credential,
        candidateCommit: commit,
        requestedCommit: "b".repeat(40),
      }),
    ).toThrow("current verified");
    const proof = verifyOperatorApproval({
      configuredCredential: credential,
      suppliedCredential: credential,
      candidateCommit: commit,
      requestedCommit: commit,
      now: new Date("2026-10-02T00:00:00Z"),
    });
    expect(proof).toMatchObject({
      method: "plugin-credential",
      candidateCommit: commit,
      at: "2026-10-02T00:00:00.000Z",
    });
    expect(JSON.stringify(proof)).not.toContain(credential);
  });
});
