import { expect, it } from "vitest";
import type { RoleWorkflow } from "../shared/role-builder.js";
import { kitchenPack } from "../server/pack.js";
import { definitionFromPack, validateDefinition } from "../server/workflow-definitions.js";
import {
  clampGraphZoom,
  fitGraphZoom,
  graphConnections,
  graphNodeSize,
  graphPortSize,
  graphZoomTranslation,
  graphPanOrigin,
  graphInputPoint,
  graphOutputPoint,
  graphDropTarget,
  graphOutcomeTitle,
  layoutRoleGraph,
  updateGraphConnection,
  editableItemConnections,
  insertWorkflowRole,
} from "./role-graph-model.js";
const workflow: RoleWorkflow = {
  maxParallel: 4,
  roles: {
    dev: { title: "Developer" },
    review: { title: "Reviewer" },
    verify: { title: "Verifier" },
  },
  boards: {
    item: {
      initialPhase: "ready",
      phases: {
        ready: { title: "Ready", kind: "resting", next: "build" },
        build: { title: "Build", kind: "working", role: "dev", outcomes: { complete: "review" } },
        review: {
          title: "Review",
          kind: "working",
          role: "review",
          outcomes: { approved: "verify", changes: "build" },
        },
        verify: {
          title: "Verify",
          kind: "working",
          role: "verify",
          outcomes: { pass: "done", fail: "build" },
        },
        done: { title: "Human acceptance", kind: "terminal" },
      },
    },
  },
};
it("draws every actual phase, forward outcome and distinct return route without inventing a role", () => {
  const graph = layoutRoleGraph(workflow, "item");
  expect(graph.nodes.map((node) => node.id)).toEqual(Object.keys(workflow.boards.item.phases));
  expect(graph.routes.filter((route) => route.returning).map((route) => route.edge.label)).toEqual([
    "changes",
    "fail",
  ]);
  expect(
    graph.routes.every((route) =>
      route.points.every(
        (point) =>
          point.x >= 0 && point.y >= 0 && point.x <= graph.width && point.y <= graph.height,
      ),
    ),
  ).toBe(true);
});
it("updates only the selected outcome in an immutable draft and rejects stale or missing targets", () => {
  const edge = graphConnections(workflow).find((value) => value.label === "changes")!;
  const next = updateGraphConnection(workflow, edge, "ready", 3);
  expect(next.boards.item.phases.review.outcomes).toEqual({ approved: "verify", changes: "ready" });
  expect(
    updateGraphConnection(next, { ...edge, to: "ready" }, "build").boards.item.phases.review,
  ).not.toHaveProperty("maxReturns");
  expect(workflow.boards.item.phases.review.outcomes).toEqual({
    approved: "verify",
    changes: "build",
  });
  expect(() => updateGraphConnection(next, edge, "build")).toThrow("changed");
  expect(() => updateGraphConnection(workflow, edge, "missing")).toThrow("existing");
  expect(() => updateGraphConnection(workflow, edge, "build", 1.5)).toThrow("whole number");
});

it("preserves conditional skip paths and reroutes the visual edges after arranging a phase", () => {
  const conditional = {
    ...workflow,
    boards: {
      ...workflow.boards,
      item: {
        ...workflow.boards.item,
        phases: {
          ...workflow.boards.item.phases,
          review: {
            ...workflow.boards.item.phases.review,
            condition: { kind: "changed-files" as const, any: [{ prefix: "auth/" }] },
            skipTo: "verify",
          },
        },
      },
    },
  };
  const skip = graphConnections(conditional).find((edge) => edge.kind === "skip")!;
  expect(skip).toMatchObject({ from: "review", to: "verify", label: "No matching file changes" });
  const moved = layoutRoleGraph(conditional, "item", { review: { x: 900, y: 300 } });
  expect(moved.nodes.find((node) => node.id === "review")).toMatchObject({ x: 900, y: 300 });
  const movedRoute = moved.routes.find((route) => route.edge.id === skip.id)!;
  const start = movedRoute.points[0];
  expect(start.x).toBeGreaterThanOrEqual(900);
  expect(start.x).toBeLessThanOrEqual(900 + graphNodeSize.width);
  expect(start.y).toBeGreaterThanOrEqual(300);
  expect(start.y).toBeLessThanOrEqual(
    300 + moved.nodes.find((node) => node.id === "review")!.height,
  );
  const reset = layoutRoleGraph(conditional, "item");
  expect(reset.nodes.find((node) => node.id === "review")?.y).toBe(80);
  expect(updateGraphConnection(conditional, skip, "build").boards.item.phases.review).toMatchObject(
    { condition: { any: [{ prefix: "auth/" }] }, skipTo: "build" },
  );
});

it("fits long boards while allowing actual-size inspection independently of the kitchen map", () => {
  for (const board of ["root", "item"]) {
    const graph = layoutRoleGraph(
      { ...workflow, boards: { [board]: workflow.boards.item } },
      board,
    );
    const fit = fitGraphZoom(graph.width, graph.height, 640, 420);
    expect(fit).toBeLessThan(100);
    expect((graph.width * fit) / 100).toBeLessThanOrEqual(640);
    expect((graph.height * fit) / 100).toBeLessThanOrEqual(420);
    expect(clampGraphZoom(100) / 100).toBe(1);
    expect(clampGraphZoom(200) / 100).toBe(2);
    expect(clampGraphZoom(500)).toBe(200);
    expect(clampGraphZoom(0)).toBe(1);
  }
});

it("keeps unreachable protected states apart without losing a real node or connection", () => {
  const extended: RoleWorkflow = {
    ...workflow,
    boards: {
      item: {
        ...workflow.boards.item,
        phases: {
          ...workflow.boards.item.phases,
          blocked: { title: "Needs you", kind: "resting" },
          canceled: { title: "Canceled", kind: "terminal" },
        },
      },
    },
  };
  const graph = layoutRoleGraph(extended, "item");
  expect(graph.nodes.map((node) => node.id)).toEqual(Object.keys(extended.boards.item.phases));
  expect(graph.routes.map((route) => route.edge)).toEqual(graphConnections(extended));
  const primary = graph.nodes.filter((node) => node.primary);
  const protectedStates = graph.nodes.filter((node) => !node.primary);
  expect(primary.map((node) => node.id)).toEqual(["build", "review", "verify"]);
  expect(protectedStates.map((node) => node.id)).toEqual(["ready", "done", "blocked", "canceled"]);
  expect(
    protectedStates.every((node) => node.y > Math.max(...primary.map((mainNode) => mainNode.y))),
  ).toBe(true);
  expect(graph.focus.height).toBeLessThan(graph.height);
  expect(graph.width).toBeLessThan(1100);
  const primaryIds = new Set(primary.map((node) => node.id));
  for (const route of graph.routes.filter(
    (value) => primaryIds.has(value.edge.from) && primaryIds.has(value.edge.to),
  )) {
    for (const point of route.points) {
      expect(point.x).toBeGreaterThanOrEqual(graph.focus.x);
      expect(point.x).toBeLessThanOrEqual(graph.focus.x + graph.focus.width);
      expect(point.y).toBeGreaterThanOrEqual(graph.focus.y);
      expect(point.y).toBeLessThanOrEqual(graph.focus.y + graph.focus.height);
    }
    expect(route.label.x - 65).toBeGreaterThanOrEqual(graph.focus.x);
    expect(route.label.x + 115).toBeLessThanOrEqual(graph.focus.x + graph.focus.width);
    expect(route.label.y - 18).toBeGreaterThanOrEqual(graph.focus.y);
    expect(route.label.y + 30).toBeLessThanOrEqual(graph.focus.y + graph.focus.height);
  }
  expect(protectedStates.every((node) => node.y > graph.focus.y + graph.focus.height)).toBe(true);
});

it("keeps a reversed second-row handoff forward and only report retries returning", () => {
  const graph = layoutRoleGraph(workflow, "item");
  const completion = graph.routes.find(
    (route) => route.edge.from === "verify" && route.edge.to === "done",
  )!;
  expect(graph.nodes.find((node) => node.id === "done")!.x).toBeLessThan(
    graph.nodes.find((node) => node.id === "verify")!.x,
  );
  expect(completion.returning).toBe(false);
  expect(graph.routes.filter((route) => route.returning).map((route) => route.edge.label)).toEqual([
    "changes",
    "fail",
  ]);
});

it("preserves the world point under an off-center pointer while zooming both directions", () => {
  const viewport = { width: 900, height: 480 };
  const pointer = { x: 180, y: 350 };
  const before = { x: 85, y: -34 };
  const after = graphZoomTranslation(before, pointer, viewport, 80, 160);
  const world = {
    x: (pointer.x - viewport.width / 2 - before.x) / 0.8,
    y: (pointer.y - viewport.height / 2 - before.y) / 0.8,
  };
  expect(viewport.width / 2 + after.x + world.x * 1.6).toBeCloseTo(pointer.x);
  expect(viewport.height / 2 + after.y + world.y * 1.6).toBeCloseTo(pointer.y);
  expect(graphZoomTranslation(after, pointer, viewport, 160, 80)).toEqual(before);
});

it("routes correction paths through the gaps without crossing folded production cards", () => {
  const graph = layoutRoleGraph(workflow, "item");
  for (const route of graph.routes.filter((value) => value.returning)) {
    for (let index = 1; index < route.points.length; index++) {
      const from = route.points[index - 1];
      const to = route.points[index];
      for (const node of graph.nodes) {
        const crossesHorizontal =
          from.y === to.y &&
          from.y > node.y &&
          from.y < node.y + node.height &&
          Math.max(from.x, to.x) > node.x &&
          Math.min(from.x, to.x) < node.x + graphNodeSize.width;
        const crossesVertical =
          from.x === to.x &&
          from.x > node.x &&
          from.x < node.x + graphNodeSize.width &&
          Math.max(from.y, to.y) > node.y &&
          Math.min(from.y, to.y) < node.y + node.height;
        expect(crossesHorizontal || crossesVertical).toBe(false);
      }
    }
  }
});

it("preserves an off-center pinch transform when one finger lifts and continues panning", () => {
  const pinched = graphZoomTranslation(
    { x: 0, y: 0 },
    { x: 100, y: 140 },
    { width: 640, height: 480 },
    100,
    200,
  );
  expect(pinched).toEqual({ x: 220, y: 100 });
  for (const gestureDelta of [
    { x: 0, y: 0 },
    { x: 47, y: -12 },
  ]) {
    const origin = graphPanOrigin(pinched, gestureDelta);
    expect({ x: origin.x + gestureDelta.x, y: origin.y + gestureDelta.y }).toEqual(pinched);
    const nextDelta = { x: gestureDelta.x + 12, y: gestureDelta.y + 16 };
    expect({ x: origin.x + nextDelta.x, y: origin.y + nextDelta.y }).toEqual({ x: 232, y: 116 });
  }
});

it("uses visible ports for each real declared outcome and route endpoint", () => {
  expect(graphPortSize * 0.92).toBeGreaterThanOrEqual(44);
  expect(graphPortSize * 0.75).toBeGreaterThanOrEqual(48);
  const graph = layoutRoleGraph(workflow, "item");
  for (const node of graph.nodes) {
    expect(node.outputs).toEqual(
      graphConnections(workflow).filter((edge) => edge.from === node.id),
    );
    expect(new Set(node.outputs.map((edge) => graphOutputPoint(node, edge).y)).size).toBe(
      node.outputs.length,
    );
    for (const [index, edge] of node.outputs.entries()) {
      const point = graphOutputPoint(node, edge);
      expect(point.y - graphPortSize / 2).toBeGreaterThanOrEqual(node.y);
      expect(point.y + graphPortSize / 2).toBeLessThanOrEqual(node.y + node.height);
      if (index)
        expect(point.y - graphOutputPoint(node, node.outputs[index - 1]).y).toBeGreaterThanOrEqual(
          graphPortSize,
        );
    }
  }
  for (const route of graph.routes) {
    expect(route.points[0]).toEqual(
      graphOutputPoint(graph.nodes.find((node) => node.id === route.edge.from)!, route.edge),
    );
    expect(route.points.at(-1)).toEqual(
      graphInputPoint(graph.nodes.find((node) => node.id === route.edge.to)!),
    );
  }
  const review = graph.nodes.find((node) => node.id === "review")!;
  expect(graphDropTarget(graph.nodes, graphInputPoint(review))?.id).toBe("review");
  expect(
    graphDropTarget(graph.nodes, {
      x: review.x - graphPortSize / 2,
      y: graphInputPoint(review).y,
    })?.id,
  ).toBe("review");
  expect(
    graphDropTarget(graph.nodes, {
      x: review.x - graphPortSize / 2,
      y: review.y + review.height,
    }),
  ).toBeUndefined();
  expect(graphDropTarget(graph.nodes, { x: review.x + 90, y: review.y + 80 })?.id).toBe("review");
  expect(graphDropTarget(graph.nodes, { x: 2000, y: 2000 })).toBeUndefined();
  expect(graphOutcomeTitle(review.outputs.find((edge) => edge.label === "changes")!)).toBe(
    "Changes requested",
  );
});

it("inserts a real read-only role into every editable feature handoff while preserving verification", () => {
  const definition = definitionFromPack(kitchenPack, "manual-team");
  definition.boards.item.phases.review.maxReturns = 3;
  const before = structuredClone(definition);
  const edges = editableItemConnections(definition);
  expect(edges[0].from).toBe("implement");
  expect(edges.some((edge) => edge.from === "ready" || edge.from === "requested-work")).toBe(false);
  expect(edges.length).toBeGreaterThan(0);
  expect(edges.every((edge) => edge.board === "item" && edge.from !== "verify")).toBe(true);
  for (const edge of edges) {
    const candidate = insertWorkflowRole(definition, edge, {
      title: "Accessibility",
      instructions: "Inspect the feature and report evidence.",
      canEdit: false,
      clarification: "human",
      investigation: "human",
    });
    expect(validateDefinition(candidate, kitchenPack)).toEqual(candidate);
    expect(candidate.roles["custom-accessibility"]).toMatchObject({
      canEdit: false,
      workspace: "item-worktree",
      tools: [],
    });
    expect(candidate.boards.item.phases["custom-accessibility"]).toMatchObject({
      kind: "working",
      role: "custom-accessibility",
      outcomes: { done: edge.to },
    });
    expect(
      graphConnections({ ...candidate, maxParallel: 4 }).find((value) => value.id === edge.id)?.to,
    ).toBe("custom-accessibility");
    expect(candidate.boards.root).toEqual(definition.boards.root);
    expect(candidate.boards.item.phases.verify).toEqual(definition.boards.item.phases.verify);
    expect(candidate.roles.verifier).toEqual(definition.roles.verifier);
    expect(candidate.boards.item.phases.review.maxReturns).toBe(3);
  }
  expect(definition).toEqual(before);
});

it("isolates editable new roles, enables actual work-request tools and rejects protected or stale insertion", () => {
  const definition = definitionFromPack(kitchenPack, "manual-team");
  const edge = editableItemConnections(definition).find(
    (value) => value.from === "review" && value.label === "approve",
  )!;
  const input = {
    title: "Feature polish",
    instructions: "Make scoped accessibility fixes.",
    canEdit: true,
    clarification: "head-chef" as const,
    investigation: "request-work" as const,
  };
  const candidate = insertWorkflowRole(definition, edge, input);
  expect(validateDefinition(candidate, kitchenPack)).toEqual(candidate);
  expect(candidate.roles["custom-feature-polish"]).toMatchObject({
    canEdit: true,
    workspace: "own-worktree",
    tools: ["item_request_work"],
    communication: { clarification: "head-chef", investigation: "request-work" },
  });
  const current = editableItemConnections(candidate).find((value) => value.id === edge.id)!;
  const repeated = insertWorkflowRole(candidate, current, input);
  expect(repeated.roles["custom-feature-polish-2"]).toBeDefined();
  expect(validateDefinition(repeated, kitchenPack)).toEqual(repeated);
  expect(() => insertWorkflowRole(candidate, edge, input)).toThrow("current editable");
  const protectedEdge = graphConnections({ ...definition, maxParallel: 4 }).find(
    (value) => value.from === "verify",
  )!;
  expect(() => insertWorkflowRole(definition, protectedEdge, input)).toThrow("current editable");
  const rootEdge = graphConnections({ ...definition, maxParallel: 4 }).find(
    (value) => value.board === "root",
  )!;
  expect(() => insertWorkflowRole(definition, rootEdge, input)).toThrow("current editable");
  expect(() => insertWorkflowRole(definition, edge, { ...input, title: "" })).toThrow("Role name");
});
