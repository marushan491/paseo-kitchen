import { expect, it } from "vitest";
import type { RoleWorkflow } from "../shared/role-builder.js";
import { graphConnections, layoutRoleGraph, updateGraphConnection } from "./role-graph-model.js";
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
  expect(moved.routes.find((route) => route.edge.id === skip.id)?.points[0]).toEqual({
    x: 1000,
    y: 394,
  });
  const reset = layoutRoleGraph(conditional, "item");
  expect(reset.nodes.find((node) => node.id === "review")?.y).toBe(80);
  expect(updateGraphConnection(conditional, skip, "build").boards.item.phases.review).toMatchObject(
    { condition: { any: [{ prefix: "auth/" }] }, skipTo: "build" },
  );
});
