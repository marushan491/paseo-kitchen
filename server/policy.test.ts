import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  assertPolicyAllows,
  assertOutcomeJudged,
  type PolicyObservation,
} from "./policy.js";
import { verifyOperatorApproval } from "./approval.js";

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
