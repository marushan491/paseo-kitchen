import { expect, it } from "vitest";
import type { RoleWorkflow } from "../shared/role-builder.js";
import {
  clampGraphZoom,
  fitGraphZoom,
  graphConnections,
  graphNodeSize,
  graphZoomTranslation,
  graphPanOrigin,
  layoutRoleGraph,
  updateGraphConnection,
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
  expect(start.y).toBeLessThanOrEqual(300 + graphNodeSize.height);
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
  expect(protectedStates.map((node) => node.id)).toEqual(["blocked", "canceled"]);
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
          from.y < node.y + graphNodeSize.height &&
          Math.max(from.x, to.x) > node.x &&
          Math.min(from.x, to.x) < node.x + graphNodeSize.width;
        const crossesVertical =
          from.x === to.x &&
          from.x > node.x &&
          from.x < node.x + graphNodeSize.width &&
          Math.max(from.y, to.y) > node.y &&
          Math.min(from.y, to.y) < node.y + graphNodeSize.height;
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
