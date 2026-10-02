import { expect, it } from "vitest";
import { TeamStateSchema } from "../factory-contracts.js";
import { kitchenAgentIds, kitchenHumanRequests } from "./kitchen-scope.js";

it("includes recovered Kitchen bindings but only open mission questions and final acceptance in the selected project", () => {
  const state = TeamStateSchema.parse({
    commit: 1,
    team: {
      id: "mission",
      title: "Build checkout",
      objective: "Complete checkout",
      cwd: "/repo/shop",
      bossAgentId: "boss",
      packId: "kitchen",
      packVersion: 1,
      rootItemId: "root",
      status: "active",
      roleProfiles: {},
      createdAt: "2026-10-02T12:00:00Z",
      kitchen: {
        idempotencyKey: "key",
        requestFingerprint: "request",
        mode: "accompanied",
        sourceAgentId: "source",
      },
    },
    items: Object.fromEntries(
      ["root", "child"].map((id) => [
        id,
        {
          id,
          teamId: "mission",
          packId: "kitchen",
          packVersion: 1,
          board: id === "root" ? "root" : "work",
          title: id,
          objective: "Task",
          phase: "ready-for-human",
          phaseHistory: [],
          revision: 1,
          dependsOn: [],
          conflictsWith: [],
          acceptanceCriteria: [],
          artifacts: [],
          reports: [],
          returns: 0,
          bindings: {},
          pack: {},
        },
      ]),
    ),
    bindings: {
      cook: {
        id: "cook",
        workItemId: "child",
        role: "developer",
        phase: "implement",
        revisionAtStart: 1,
        decisionId: "decision",
        agentId: "recovered-cook",
        profile: "developer",
        status: "revoked",
        turn: "reported",
        nudges: 0,
        lastEventAt: "2026-10-02T12:00:00Z",
        createdAt: "2026-10-02T12:00:00Z",
      },
    },
    decisions: {},
  });
  expect(kitchenAgentIds([state])).toEqual(["boss", "recovered-cook", "source"]);
  expect(kitchenAgentIds([])).toEqual([]);
  expect(kitchenHumanRequests([state], "/repo/shop").map((request) => request.item.id)).toEqual([
    "root",
  ]);
  state.items.child!.phase = "blocked";
  state.items.child!.reports.push({
    role: "developer",
    phase: "implement",
    outcome: "blocked",
    summary: "Which payment provider should I integrate?",
  });
  expect(kitchenHumanRequests([state]).find((request) => request.item.id === "child")?.reason).toBe(
    "Which payment provider should I integrate?",
  );
  expect(kitchenHumanRequests([state], "/repo/other")).toEqual([]);
  state.team.status = "canceled";
  expect(kitchenHumanRequests([state])).toEqual([]);
});
