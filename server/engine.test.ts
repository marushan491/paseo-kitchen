import { describe, expect, it } from "vitest";
import {
  applyReport,
  createTeamState,
  enterPhase,
  planItems,
  requestWork,
  RUNTIME,
  schedule,
} from "./engine.js";
import {
  kitchenGardenerPack,
  kitchenInsightsPack,
  kitchenPack,
  PackRegistry,
  softwareBasicPack,
} from "./pack.js";
import type { TeamEventDraft } from "./store.js";
import type { Binding, TeamReportPayload, TeamState, WorkItem } from "./types.js";

const COMMIT = "a".repeat(40);

function seat(state: TeamState, item: WorkItem, role: string): Binding {
  const binding: Binding = {
    id: `${item.id}-${role}`,
    workItemId: item.id,
    role,
    phase: item.phase,
    revisionAtStart: item.revision,
    decisionId: "decision",
    agentId: role,
    profile: "codex",
    status: "active",
    turn: "running",
    nudges: 0,
    errors: 0,
    lastEventAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  state.bindings[binding.id] = binding;
  item.bindings[role] = binding.id;
  return binding;
}

function planned() {
  const { state } = createTeamState({
    pack: kitchenPack,
    title: "Kitchen",
    objective: "Build safely",
    cwd: "/repo",
    bossAgentId: "boss",
    roleProfiles: {},
  });
  const events: TeamEventDraft[] = [];
  schedule(state, kitchenPack, events);
  const root = state.items[state.team.rootItemId]!;
  root.acceptanceCriteria = [{ id: "root-e2e", text: "The integrated application works" }];
  const po = seat(state, root, "po");
  const [item] = planItems(
    state,
    kitchenPack,
    po,
    [
      {
        key: "A",
        title: "Thing",
        objective: "Implement thing",
        acceptanceCriteria: ["Runs", "Handles empty input"],
      },
    ],
    events,
  );
  applyReport(state, kitchenPack, po, { outcome: "planned", summary: "Planned" }, events);
  return { state, events, root, item: item!, developer: seat(state, item!, "developer") };
}

function verificationReport(item: WorkItem): TeamReportPayload {
  return {
    outcome: "pass",
    summary: "Verified",
    artifacts: [{ kind: "commit", ref: COMMIT }],
    criteria: item.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      met: true,
      evidence: "Real check passed",
    })),
  };
}

function verifyItem(state: TeamState, item: WorkItem, events: TeamEventDraft[]) {
  enterPhase(state, kitchenPack, item, "verify", RUNTIME, events);
  applyReport(state, kitchenPack, seat(state, item, "verifier"), verificationReport(item), events);
}

describe("Kitchen workflow", () => {
  it.each(["research", "split"] as const)(
    "rejects a %s report without registered work before changing evidence or the running binding",
    (kind) => {
      const { state, events, item, developer } = planned();
      const before = structuredClone(state);
      const previousEvents = structuredClone(events);
      expect(() =>
        applyReport(
          state,
          kitchenPack,
          developer,
          {
            outcome: "done",
            summary: "Waiting for an unregistered child",
            artifacts: [{ kind: "commit", ref: COMMIT }],
            criteria: [{ id: "A-1", met: true, evidence: "Unverified claim" }],
            needs: { kind, text: "A helper will finish this" },
          },
          events,
        ),
      ).toThrow("unfinished registered work request");
      expect(state).toEqual(before);
      expect(events).toEqual(previousEvents);
      expect(item.phase).toBe("implement");
      expect(developer.turn).toBe("running");
    },
  );

  it("keeps genuine access requests as a human blocker without requiring a delegated child", () => {
    const { state, events, item, developer } = planned();
    applyReport(
      state,
      kitchenPack,
      developer,
      {
        outcome: "done",
        summary: "Authentication needs the user",
        needs: { kind: "human", category: "access", text: "Complete OAuth consent" },
      },
      events,
    );
    expect(item.phase).toBe("blocked");
    expect(developer.turn).toBe("reported");
    expect(state.team.status).toBe("active");
  });

  it("rejects another research wait after all registered children are verified", () => {
    const { state, events, item, developer } = planned();
    const child = requestWork(
      state,
      kitchenPack,
      developer,
      {
        requestId: "helper",
        title: "Helper",
        objective: "Finish helper",
        acceptanceCriteria: ["Helper works"],
      },
      events,
    );
    child.phase = kitchenPack.dependencyPhase!;
    child.pack.verifiedCommit = COMMIT;
    expect(() =>
      applyReport(
        state,
        kitchenPack,
        developer,
        {
          outcome: "done",
          summary: "Still waiting",
          needs: { kind: "research", text: "More investigation" },
        },
        events,
      ),
    ).toThrow("unfinished registered work request");
    expect(item.phase).toBe("implement");
    expect(developer.turn).toBe("running");
  });

  it("keeps software-basic registered and finishes only after independent verification", () => {
    expect(new PackRegistry().list().map((pack) => pack.id)).toEqual([
      "software-basic",
      "kitchen",
      "kitchen-single",
      "kitchen-insights",
      "kitchen-gardener",
    ]);
    expect(softwareBasicPack.boards.item.phases.review!.outcomes!.approve).toBe("done");
    const { state, events, root, item, developer } = planned();
    applyReport(state, kitchenPack, developer, { outcome: "done", summary: "Implemented" }, events);
    expect(item.phase).toBe("review");
    expect(kitchenPack.roles.reviewer!.canEdit).toBe(true);
    const reviewer = seat(state, item, "reviewer");
    applyReport(state, kitchenPack, reviewer, { outcome: "approve", summary: "Reviewed" }, events);
    expect(item.phase).toBe("verify");
    expect(root.phase).toBe("execute");
    expect(kitchenPack.roles.verifier!.canEdit).toBe(false);
    applyReport(
      state,
      kitchenPack,
      seat(state, item, "verifier"),
      verificationReport(item),
      events,
    );
    expect(item.phase).toBe("ready-for-human");
    expect(root.phase).toBe("integrate");
    expect(item.pack.verifiedCommit).toBe(COMMIT);
    expect(item.acceptanceCriteria.every((criterion) => criterion.met)).toBe(true);
    expect(kitchenPack.roles.integrator!.workspace).toBe("own-worktree");
    expect(root.acceptanceCriteria).toHaveLength(3);
    expect(root.acceptanceCriteria.every((criterion) => criterion.met === undefined)).toBe(true);
    expect(
      Object.values(state.decisions).some(
        (decision) => decision.idempotencyKey === `done:${root.id}`,
      ),
    ).toBe(false);
    const integrator = seat(state, root, "integrator");
    expect(() =>
      applyReport(state, kitchenPack, integrator, { outcome: "done", summary: "Combined" }, events),
    ).toThrow(/Integration requires/);
    const combinedCommit = "b".repeat(40);
    applyReport(
      state,
      kitchenPack,
      integrator,
      {
        outcome: "done",
        summary: "Combined",
        artifacts: [{ kind: "commit", ref: combinedCommit }],
      },
      events,
    );
    expect(root.phase).toBe("verify");
    const finalVerifier = seat(state, root, "verifier");
    expect(() =>
      applyReport(state, kitchenPack, finalVerifier, verificationReport(item), events),
    ).toThrow(/every acceptance criterion/);
    applyReport(
      state,
      kitchenPack,
      finalVerifier,
      { outcome: "fail", summary: "Combined end-to-end flow fails" },
      events,
    );
    expect(root.phase).toBe("integrate");
    expect(root.returns).toBe(1);
    expect(root.pack.verifiedCommit).toBeUndefined();
    applyReport(
      state,
      kitchenPack,
      seat(state, root, "integrator"),
      {
        outcome: "done",
        summary: "Fixed combined flow",
        artifacts: [{ kind: "commit", ref: combinedCommit }],
      },
      events,
    );
    seat(state, root, "verifier");
    applyReport(
      state,
      kitchenPack,
      state.bindings[root.bindings.verifier!]!,
      { ...verificationReport(root), artifacts: [{ kind: "commit", ref: combinedCommit }] },
      events,
    );
    expect(root.phase).toBe("ready-for-human");
    expect(root.pack.verifiedCommit).toBe(combinedCommit);
    expect(
      Object.values(state.decisions).some(
        (decision) => decision.idempotencyKey === `done:${root.id}`,
      ),
    ).toBe(true);
  });

  it("rejects missing final commit, incomplete evidence and duplicate criterion claims", () => {
    const { state, events, item } = planned();
    enterPhase(state, kitchenPack, item, "verify", RUNTIME, events);
    const verifier = seat(state, item, "verifier");
    const valid = verificationReport(item);
    for (const invalid of [
      { ...valid, artifacts: [] },
      { ...valid, artifacts: [{ kind: "commit" as const, ref: "abc123" }] },
      { ...valid, criteria: valid.criteria!.slice(0, 1) },
      { ...valid, criteria: [valid.criteria![0]!, valid.criteria![0]!] },
      {
        ...valid,
        criteria: valid.criteria!.map((criterion) => ({
          id: criterion.id,
          met: criterion.met,
          evidence: " ",
        })),
      },
    ]) {
      expect(() => applyReport(state, kitchenPack, verifier, invalid, events)).toThrow(
        /Verification requires/,
      );
      expect(item.phase).toBe("verify");
      expect(verifier.turn).toBe("running");
    }
    applyReport(state, kitchenPack, verifier, valid, events);
    expect(item.phase).toBe("ready-for-human");
  });

  it("invalidates verification when editable work resumes and blocks the fourth return", () => {
    const { state, events, item } = planned();
    item.acceptanceCriteria[0]!.met = true;
    item.acceptanceCriteria[0]!.evidence = "Old check";
    item.pack.verifiedCommit = COMMIT;
    enterPhase(state, kitchenPack, item, "review", RUNTIME, events);
    expect(item.acceptanceCriteria[0]!.met).toBeUndefined();
    expect(item.pack.verifiedCommit).toBeUndefined();
    for (let attempt = 1; attempt <= 4; attempt++) {
      enterPhase(state, kitchenPack, item, "verify", RUNTIME, events);
      const verifier = seat(state, item, "verifier");
      applyReport(
        state,
        kitchenPack,
        verifier,
        { outcome: "fail", summary: "Failed check" },
        events,
      );
      expect(item.phase).toBe(attempt <= 3 ? "implement" : "blocked");
    }
  });

  it("deduplicates bounded work, waits for its final verification, then resumes the same parent", () => {
    const { state, events, item, developer } = planned();
    const request = {
      requestId: "helper",
      title: "Helper",
      objective: "Implement helper",
      acceptanceCriteria: ["Helper works"],
    };
    const child = requestWork(state, kitchenPack, developer, request, events);
    expect(requestWork(state, kitchenPack, developer, request, events).id).toBe(child.id);
    expect(() =>
      requestWork(
        state,
        kitchenPack,
        developer,
        { ...request, objective: "Different work" },
        events,
      ),
    ).toThrow(/different work/);
    schedule(state, kitchenPack, events);
    expect(child.phase).toBe("ready");
    applyReport(
      state,
      kitchenPack,
      developer,
      {
        outcome: "done",
        summary: "Needs helper",
        needs: { kind: "split", text: "Helper requested" },
      },
      events,
    );
    expect(item.phase).toBe("waiting-for-work");
    expect(child.phase).toBe("implement");
    verifyItem(state, child, events);
    expect(item.phase).toBe("implement");
    expect(state.bindings[developer.id]!.phase).toBe("implement");
    expect(state.bindings[developer.id]!.turn).toBe("starting");
  });

  it("rejects third-level delegation, foreign parent claims, cyclic refs and more than ten requests", () => {
    const limitedPack = { ...kitchenPack, maxDelegationDepth: 2, maxDelegatedItems: 10 };
    const { state, events, item, developer } = planned();
    const request = {
      requestId: "one",
      title: "Helper",
      objective: "Helper",
      acceptanceCriteria: ["Works"],
    };
    expect(() =>
      requestWork(state, limitedPack, developer, { ...request, parentId: "other" }, events),
    ).toThrow(/caller's item/);
    expect(() =>
      requestWork(state, limitedPack, developer, { ...request, dependsOn: [item.id] }, events),
    ).toThrow(/reference/);
    const child = requestWork(state, limitedPack, developer, request, events);
    applyReport(state, limitedPack, developer, { outcome: "done", summary: "Waiting" }, events);
    const childDeveloper = seat(state, child, "developer");
    const grandchild = requestWork(
      state,
      limitedPack,
      childDeveloper,
      { ...request, requestId: "two" },
      events,
    );
    applyReport(
      state,
      limitedPack,
      childDeveloper,
      { outcome: "done", summary: "Waiting" },
      events,
    );
    expect(() =>
      requestWork(state, limitedPack, seat(state, grandchild, "developer"), request, events),
    ).toThrow(/depth limit/);
    const fresh = planned();
    for (let index = 0; index < 10; index++)
      requestWork(
        fresh.state,
        limitedPack,
        fresh.developer,
        { ...request, requestId: String(index) },
        fresh.events,
      );
    expect(() =>
      requestWork(
        fresh.state,
        limitedPack,
        fresh.developer,
        { ...request, requestId: "eleven" },
        fresh.events,
      ),
    ).toThrow(/item limit/);
  });

  it("rejects cyclic initial plans and does not treat canceled children as verified completion", () => {
    const { state } = createTeamState({
      pack: kitchenPack,
      title: "Cycle",
      objective: "Cycle",
      cwd: "/repo",
      bossAgentId: "boss",
      roleProfiles: {},
    });
    const events: TeamEventDraft[] = [];
    schedule(state, kitchenPack, events);
    const root = state.items[state.team.rootItemId]!;
    const po = seat(state, root, "po");
    expect(() =>
      planItems(
        state,
        kitchenPack,
        po,
        [
          { key: "A", title: "A", objective: "A", acceptanceCriteria: ["A"], dependsOn: ["B"] },
          { key: "B", title: "B", objective: "B", acceptanceCriteria: ["B"], dependsOn: ["A"] },
        ],
        events,
      ),
    ).toThrow(/cycle/);
    const fresh = planned();
    enterPhase(fresh.state, kitchenPack, fresh.item, "canceled", RUNTIME, fresh.events);
    schedule(fresh.state, kitchenPack, fresh.events);
    expect(fresh.root.phase).toBe("execute");
  });
});

describe.each([kitchenInsightsPack, kitchenGardenerPack])("$title analytical workflow", (pack) => {
  it("registers one read-only role and completes proposals without product verification", () => {
    expect(new PackRegistry().get(pack.id)).toBe(pack);
    expect(pack.requireVerification).toBe(false);
    const [role] = Object.values(pack.roles);
    expect(Object.keys(pack.roles)).toHaveLength(1);
    expect(role!.canEdit).toBe(false);
    expect(role!.tools).toEqual(["item_plan"]);
    expect(role!.instructions).toContain("Humans must approve");
    const { state } = createTeamState({
      pack,
      title: pack.title,
      objective: "Analyze project evidence",
      cwd: "/repo",
      bossAgentId: "boss",
      roleProfiles: {},
    });
    const events: TeamEventDraft[] = [];
    schedule(state, pack, events);
    const root = state.items[state.team.rootItemId]!;
    const planner = seat(state, root, role!.id);
    const [item] = planItems(
      state,
      pack,
      planner,
      [
        {
          key: "report",
          title: "Report",
          objective: "Read the runtime sample",
          acceptanceCriteria: ["Proposals cite evidence"],
        },
      ],
      events,
    );
    applyReport(state, pack, planner, { outcome: "planned", summary: "One report" }, events);
    expect(root.phase).toBe("execute");
    expect(item!.phase).toBe("analyze");
    const analyst = seat(state, item!, role!.id);
    expect(() =>
      applyReport(state, pack, analyst, { outcome: "pass", summary: "Product works" }, events),
    ).toThrow(/Unknown outcome/);
    applyReport(
      state,
      pack,
      analyst,
      {
        outcome: "proposed",
        summary:
          "Observations: repeated returns. Proposals: review the check. Human approval: required.",
      },
      events,
    );
    expect(item!.phase).toBe("done");
    expect(root.phase).toBe("done");
    expect(item!.pack.verifiedCommit).toBeUndefined();
    expect(item!.acceptanceCriteria[0]!.met).toBeUndefined();
    expect(
      events.some(
        (event) => event.type === "report.accepted" && event.data?.outcome === "proposed",
      ),
    ).toBe(true);
  });
});
