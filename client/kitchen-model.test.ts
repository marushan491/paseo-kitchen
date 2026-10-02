import { describe, expect, it } from "vitest";
import type { TeamState, TeamEvent } from "../shared/factory-contracts.js";
import { acceptanceProblem, kitchenInsights, parseCriteria } from "./kitchen-model.js";

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
