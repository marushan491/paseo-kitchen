import { expect, it } from "vitest";
import { kitchenPack } from "../server/pack.js";
import { createTeamState } from "../server/engine.js";
import { FactoryWorkflowSchema, type TeamEvent } from "./factory-contracts.js";
import { missionActivity } from "./mission-story.js";

function fixture() {
  const { state } = createTeamState({
    pack: kitchenPack,
    title: "Login",
    objective: "Persist login",
    cwd: "/project",
    bossAgentId: "boss",
    roleProfiles: {},
  });
  return { state, workflow: FactoryWorkflowSchema.parse(kitchenPack) };
}
function event(type: string, patch: Partial<TeamEvent> = {}): TeamEvent {
  return {
    id: type,
    type,
    at: "2026-10-02T12:00:00Z",
    commit: 1,
    actor: { type: "runtime", id: "runtime" },
    text: "Recorded description",
    ...patch,
  };
}

it("phase changes describe real stage entry without claiming a provider has launched", () => {
  const { state, workflow } = fixture();
  const entry = event("item.phase", { workItemId: state.team.rootItemId, data: { to: "verify" } });
  const activity = missionActivity(state, [entry], workflow);
  expect(activity[0]).toMatchObject({
    title: "Entered Final verification",
    description: "Recorded description",
  });
  expect(activity[0].title).not.toMatch(/working|started/i);
});

it("ready-for-human describes review readiness; only recorded acceptance describes human acceptance", () => {
  const { state, workflow } = fixture();
  const entries = [
    event("item.phase", { workItemId: state.team.rootItemId, data: { to: "ready-for-human" } }),
    event("team.accepted"),
  ];
  expect(missionActivity(state, entries, workflow).map((entry) => entry.title)).toEqual([
    "You accepted the result",
    "Result ready for your review",
  ]);
});

it("returned reports explicitly request corrections rather than successful completion", () => {
  const { state, workflow } = fixture();
  state.bindings.review = {
    id: "review",
    workItemId: state.team.rootItemId,
    role: "verifier",
    phase: "verify",
    revisionAtStart: 1,
    decisionId: "decision",
    agentId: "agent",
    profile: "profile",
    status: "revoked",
    turn: "reported",
    nudges: 0,
    errors: 0,
    createdAt: "2026-10-02",
    lastEventAt: "2026-10-02",
  };
  const entry = event("report.accepted", {
    workItemId: state.team.rootItemId,
    text: "Login still expires after restart",
    data: { bindingId: "review", outcome: "fail" },
  });
  expect(missionActivity(state, [entry], workflow)[0]).toMatchObject({
    title: "Final verification requested corrections",
    description: "Login still expires after restart",
  });
});

it("unobserved phase definitions and technical lease events do not fabricate primary activity", () => {
  const { state } = fixture();
  const entries = [
    event("item.phase", { workItemId: state.team.rootItemId, data: { to: "made-up-step" } }),
    event("decision.leased", { text: "Internal lease token" }),
    event("binding.usage"),
    event("human.message", { text: "Use the existing login flow" }),
  ];
  expect(missionActivity(state, entries)).toEqual([
    {
      id: "human.message",
      at: "2026-10-02T12:00:00Z",
      title: "You replied",
      description: "Use the existing login flow",
    },
  ]);
});

it("retains only the newest bounded human-facing entries while full events stay untouched", () => {
  const { state } = fixture();
  const entries = Array.from({ length: 20 }, (_, index) =>
    event("human.message", { id: `event-${index}`, text: "Description ".repeat(100) }),
  );
  const activity = missionActivity(state, entries, undefined, 3);
  expect(activity.map((entry) => entry.id)).toEqual(["event-19", "event-18", "event-17"]);
  expect(activity.every((entry) => entry.description.length === 600)).toBe(true);
  expect(entries).toHaveLength(20);
  expect(entries[0].text.length).toBeGreaterThan(600);
});
