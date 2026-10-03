import { kitchenCompletionByWorkspace } from "../shared/dashboard/completion-model.js";
import { describe, expect, it } from "vitest";
import type { TeamState, TeamEvent } from "../shared/factory-contracts.js";
import {
  acceptanceProblem,
  canReverify,
  missionInitialObjective,
  kitchenInsights,
  parseCriteria,
  parsePolicyDraft,
  missionCriteria,
  missionName,
} from "./kitchen-model.js";

function ready(): TeamState {
  return {
    commit: 1,
    team: {
      id: "team_test",
      title: "Test",
      objective: "Works",
      cwd: "/repo",
      bossAgentId: "boss",
      packId: "kitchen",
      packVersion: 1,
      rootItemId: "root",
      status: "active",
      roleProfiles: {},
      createdAt: "2026-10-02",
    },
    items: {
      root: {
        id: "root",
        teamId: "team_test",
        packId: "kitchen",
        packVersion: 1,
        board: "root",
        title: "Test",
        objective: "Works",
        phase: "ready-for-human",
        phaseHistory: [],
        revision: 1,
        dependsOn: [],
        conflictsWith: [],
        acceptanceCriteria: [
          { id: "criterion", text: "Works", met: true, evidence: "Actual run passed" },
        ],
        artifacts: [],
        reports: [],
        returns: 0,
        bindings: {},
        pack: { verifiedCommit: "a".repeat(40) },
      },
    },
    bindings: {},
    decisions: {},
  };
}

describe("Kitchen acceptance", () => {
  it("shows the original mission goal and requires verification of the current native context", () => {
    expect(
      missionInitialObjective(
        "Build a calculator\n\n## Additional user context\nInternal notification\nReferences: {}",
      ),
    ).toBe("Build a calculator");
    const state = ready();
    state.team.kitchen = { nativeConversation: true };
    state.items.root.pack.nativeContextMessageId = "latest";
    state.items.root.pack.verifiedNativeContextMessageId = "old";
    expect(acceptanceProblem(state)).toContain("context changed");
    expect(canReverify(state)).toBe(true);
    state.items.root.pack.verifiedNativeContextMessageId = "latest";
    expect(acceptanceProblem(state)).toBeNull();
    state.team.status = "paused";
    expect(canReverify(state)).toBe(false);
    state.team.status = "done";
    expect(canReverify(state)).toBe(false);
  });

  it("keeps the actual goal as required acceptance evidence when optional success is empty", () => {
    const goal = "Restore login across restarts\nAlso handle expired credentials";
    expect(missionCriteria(goal, " \n ")).toEqual([{ id: "goal", text: goal }]);
    expect(
      missionCriteria(goal, "Login survives restart\nExpired credentials prompt sign-in"),
    ).toEqual([
      { id: "criterion-1", text: "Login survives restart" },
      { id: "criterion-2", text: "Expired credentials prompt sign-in" },
    ]);
    expect(missionCriteria(" ", "")).toEqual([]);
    expect(missionName("Login restoration", goal)).toBe("Login restoration");
    expect(missionName("", goal)).toBe("Restore login across restarts");
  });
  it("requires evidence bound to a full final candidate and a finished Cook", () => {
    const state = ready();
    expect(acceptanceProblem(state)).toBeNull();
    state.items.root.pack.verifiedCommit = "b".repeat(64);
    expect(acceptanceProblem(state)).toBeNull();
    state.items.root.pack.verifiedCommit = "short";
    expect(acceptanceProblem(state)).toContain("full verified final commit");
    state.items.root.pack.verifiedCommit = "a".repeat(40);
    state.items.root.acceptanceCriteria[0].evidence = " ";
    expect(acceptanceProblem(state)).toContain("verified evidence");
    state.items.root.acceptanceCriteria[0].evidence = "Passed";
    state.bindings.cook = {
      id: "cook",
      workItemId: "root",
      role: "verifier",
      phase: "verify",
      revisionAtStart: 1,
      decisionId: "decision",
      agentId: "agent",
      profile: "codex",
      status: "active",
      turn: "running",
      nudges: 0,
      errors: 0,
      lastEventAt: "now",
      createdAt: "now",
    };
    expect(acceptanceProblem(state)).toContain("all Cooks");
    state.bindings.cook.turn = "reported";
    expect(acceptanceProblem(state)).toBeNull();
    state.team.status = "done";
    expect(acceptanceProblem(state)).toContain("closed");
  });
  it("does not mistake child completion for human-ready final verification", () => {
    const state = ready();
    state.items.root.phase = "execute";
    expect(acceptanceProblem(state)).toContain("final verification");
  });
  it("keeps line-delimited criteria explicit", () => {
    expect(parseCriteria(" Works\n\nHandles errors ")).toEqual([
      { id: "criterion-1", text: "Works" },
      { id: "criterion-2", text: "Handles errors" },
    ]);
  });
  it("counts recorded events rather than inventing telemetry", () => {
    const state = ready();
    const events = [
      { type: "report.accepted" },
      { type: "report.rejected" },
      { type: "human.message" },
    ] as TeamEvent[];
    state.items.child = { ...state.items.root, id: "child", board: "item", parentId: "root" };
    expect(kitchenInsights(state, events).completed).toHaveLength(1);
    expect(kitchenInsights(state, events)).toMatchObject({ reports: 1, rejected: 1, messages: 1 });
  });
});

describe("Kitchen workspace completion", () => {
  it("uses public agent workspace identity and preserves active work instead of closing it", () => {
    const accepted = ready();
    accepted.team.status = "done";
    accepted.team.kitchen = {
      idempotencyKey: "key",
      requestFingerprint: "fingerprint",
      mode: "accompanied",
      acceptedAt: "2026-10-02T12:00:00Z",
      acceptedCommit: "a".repeat(40),
    };
    const agents = [{ id: "boss", workspaceId: "ws", status: "idle" }];
    expect(kitchenCompletionByWorkspace([accepted], agents, "host")).toEqual({
      "host:ws": "2026-10-02T12:00:00Z",
    });
    expect(
      kitchenCompletionByWorkspace(
        [accepted],
        [...agents, { id: "other", workspaceId: "ws", status: "running" }],
        "host",
      ),
    ).toEqual({});
    const active = ready();
    expect(kitchenCompletionByWorkspace([accepted, active], agents, "host")).toEqual({});
    expect(kitchenCompletionByWorkspace([accepted], [], "host")).toEqual({});
  });
});

it("validates explicit policy drafts without silently dropping chosen gates", () => {
  expect(
    parsePolicyDraft({
      maxTokens: "2000",
      maxChainSteps: "8",
      maxDelegationDepth: "0",
      requireOutcomeJudge: "required",
    }),
  ).toMatchObject({
    success: true,
    data: { maxTokens: 2000, maxChainSteps: 8, maxDelegationDepth: 0, requireOutcomeJudge: true },
  });
  expect(parsePolicyDraft({ maxCostUsd: "unmeasurable" }).success).toBe(false);
  expect(parsePolicyDraft({ maxAgentStarts: "0" }).success).toBe(false);
  expect(parsePolicyDraft({ maxTokens: " " })).toMatchObject({ success: true, data: {} });
});
