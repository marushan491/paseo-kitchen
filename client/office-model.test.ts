import { describe, expect, it } from "vitest";
import { TeamStateSchema, type TeamState } from "../shared/factory-contracts.js";
import { officeAgentIds, projectOffice, type OfficeAgentSnapshot } from "./office-model.js";
import { readAgentRoutingNotice } from "../shared/agent-routing.js";

function kitchen(id = "kitchen"): TeamState {
  return TeamStateSchema.parse({
    commit: 1,
    team: {
      id,
      title: `Kitchen ${id}`,
      objective: "Deliver tested work",
      cwd: "/fixture",
      bossAgentId: "boss",
      rootItemId: "root",
      packId: "kitchen",
      packVersion: 1,
      status: "active",
      roleProfiles: { Developer: { provider: "codex", model: "configured-model" } },
      createdAt: "2026-10-02",
    },
    items: {},
    bindings: {
      worker: {
        id: "worker",
        workItemId: "item",
        role: "Developer",
        phase: "execute",
        revisionAtStart: 1,
        decisionId: "decision",
        agentId: "worker-agent",
        profile: "developer",
        status: "active",
        turn: "running",
        nudges: 0,
        lastEventAt: "2026-10-02",
        createdAt: "2026-10-02",
      },
    },
    decisions: {},
  });
}

function agent(patch: Partial<OfficeAgentSnapshot> = {}): OfficeAgentSnapshot {
  return {
    id: "worker-agent",
    title: "Actual worker",
    status: "idle",
    provider: "opencode",
    model: "observed-model",
    pendingPermissions: [],
    ...patch,
  };
}

describe("Office authoritative projection", () => {
  it("creates no demo agents and leaves unobserved runtime activity unknown", () => {
    expect(projectOffice([])).toEqual([]);
    const desks = projectOffice([kitchen()]);
    expect(desks).toHaveLength(2);
    expect(desks[0]).toMatchObject({
      agentId: "boss",
      activity: "Not observed",
      observed: false,
      tone: "unknown",
    });
    expect(desks[1]).toMatchObject({
      agentId: "worker-agent",
      activity: "running",
      observed: false,
      tone: "unknown",
      provider: "codex",
    });
  });

  it("uses observed provider and model even when the configured role differs", () => {
    const worker = projectOffice([kitchen()], { "worker-agent": agent({ model: null }) })[1];
    expect(worker).toMatchObject({
      title: "Actual worker",
      provider: "opencode",
      model: null,
      activity: "idle",
      observed: true,
      tone: "settled",
    });
  });

  it("places actual specialist reviewers at Review instead of Head Chef", () => {
    const state = kitchen();
    state.bindings.worker.role = "security-reviewer";
    state.bindings.worker.phase = "security";
    expect(projectOffice([state])[1].stationId).toBe("review");
    state.bindings.worker.role = "database-reviewer";
    state.bindings.worker.phase = "database";
    expect(projectOffice([state])[1].stationId).toBe("review");
  });

  it("shows the executed profile rather than a later configured model", () => {
    const state = kitchen();
    state.bindings.worker.profile = "codex/executed-model";
    state.bindings.worker.executedProfile = { provider: "codex", model: "executed-model" };
    state.team.roleProfiles.Developer.model = "future-model";
    expect(projectOffice([state])[1]).toMatchObject({
      provider: "codex",
      model: "executed-model",
      observed: false,
    });
  });

  it("drops revoked and reported cooks from the map without removing mission evidence", () => {
    const state = kitchen();
    state.bindings.worker.status = "revoked";
    expect(projectOffice([state], { "worker-agent": agent({ status: "running" }) })).toHaveLength(
      1,
    );
    expect(state.bindings.worker.agentId).toBe("worker-agent");
    state.bindings.worker.status = "active";
    state.bindings.worker.turn = "reported";
    expect(projectOffice([state])).toHaveLength(1);
    state.team.status = "done";
    expect(projectOffice([state])).toEqual([]);
  });

  it("keeps distinct team identities and deduplicates live agent subscriptions", () => {
    const teams = [kitchen("b"), kitchen("a")];
    const forward = projectOffice(teams);
    expect(new Set(forward.map((desk) => desk.id)).size).toBe(4);
    expect(projectOffice(teams.toReversed())).toEqual(forward);
    expect(officeAgentIds(teams)).toEqual(["boss", "worker-agent"]);
  });

  it("projects actual attention separately from running status", () => {
    const worker = projectOffice([kitchen()], {
      "worker-agent": agent({ status: "running", requiresAttention: true }),
    })[1];
    expect(worker.tone).toBe("attention");
    expect(worker.activity).toBe("running");
  });

  it.each(["waiting", "exhausted"] as const)(
    "shows actual %s quota notices instead of active work",
    (status) => {
      const value = agent({
        status: "running",
        routingNotice: {
          status,
          reason: "Account quota exhausted",
          resetsAt: "2026-10-03T00:00:00Z",
        },
      });
      const desks = projectOffice([kitchen()], {
        boss: { ...value, id: "boss" },
        "worker-agent": value,
      });
      expect(desks.every((desk) => desk.tone === "attention")).toBe(true);
      expect(desks.map((desk) => desk.activity)).toEqual([
        `${status === "waiting" ? "Waiting" : "Exhausted"}: Account quota exhausted`,
        `${status === "waiting" ? "Waiting" : "Exhausted"}: Account quota exhausted`,
      ]);
      expect(desks.filter((desk) => desk.tone === "active")).toHaveLength(0);
      expect(readAgentRoutingNotice(value)?.resetsAt).toBe("2026-10-03T00:00:00Z");
    },
  );

  it("keeps old hosts and malformed optional notices unchanged", () => {
    expect(readAgentRoutingNotice(undefined)).toBeUndefined();
    expect(readAgentRoutingNotice({})).toBeUndefined();
    expect(
      readAgentRoutingNotice({ routingNotice: { status: "waiting", reason: 42 } }),
    ).toBeUndefined();
    expect(
      readAgentRoutingNotice({ routingNotice: { status: "invented", reason: "Unknown" } }),
    ).toBeUndefined();
    const worker = projectOffice([kitchen()], {
      "worker-agent": agent({ status: "running", routingNotice: { status: "waiting" } }),
    })[1];
    expect(worker).toMatchObject({ activity: "running", tone: "active" });
  });
});
