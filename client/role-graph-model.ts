import type { RoleWorkflow } from "../shared/role-builder.js";
import type { WorkflowDefinition } from "../shared/workflow-contracts.js";

export type GraphPhase = RoleWorkflow["boards"][string]["phases"][string] &
  Partial<
    Pick<
      WorkflowDefinition["boards"][string]["phases"][string],
      "condition" | "skipTo" | "maxReturns"
    >
  >;
export interface GraphConnection {
  id: string;
  board: string;
  from: string;
  to: string;
  label: string;
  kind: "outcome" | "next" | "children" | "skip";
}
export interface GraphPoint {
  x: number;
  y: number;
}
export interface GraphNode extends GraphPoint {
  id: string;
  phase: GraphPhase;
}
export interface GraphRoute {
  edge: GraphConnection;
  points: GraphPoint[];
  label: GraphPoint;
  returning: boolean;
}
export function graphConnections(workflow: RoleWorkflow): GraphConnection[] {
  return Object.entries(workflow.boards).flatMap(([board, value]) =>
    Object.entries(value.phases).flatMap(([from, original]) => {
      const phase: GraphPhase = original;
      const edges: GraphConnection[] = Object.entries(phase.outcomes ?? {}).map(([label, to]) => ({
        id: `${board}:${from}:outcome:${label}`,
        board,
        from,
        to,
        label,
        kind: "outcome",
      }));
      if (phase.next)
        edges.push({
          id: `${board}:${from}:next`,
          board,
          from,
          to: phase.next,
          label: "Continue",
          kind: "next",
        });
      if (phase.completeWithChildren)
        edges.push({
          id: `${board}:${from}:children`,
          board,
          from,
          to: phase.completeWithChildren,
          label: "All scoped results verified",
          kind: "children",
        });
      if (phase.condition && phase.skipTo)
        edges.push({
          id: `${board}:${from}:skip`,
          board,
          from,
          to: phase.skipTo,
          label: "No matching file changes",
          kind: "skip",
        });
      return edges;
    }),
  );
}
export function layoutRoleGraph(
  workflow: RoleWorkflow,
  boardId: string,
  positions: Readonly<Record<string, GraphPoint>> = {},
) {
  const board = workflow.boards[boardId];
  if (!board)
    return { nodes: [] as GraphNode[], routes: [] as GraphRoute[], width: 640, height: 320 };
  const edges = graphConnections(workflow).filter((edge) => edge.board === boardId);
  const depths = new Map<string, number>([[board.initialPhase, 0]]);
  const queue = [board.initialPhase];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index];
    for (const edge of edges.filter((value) => value.from === from)) {
      if (!board.phases[edge.to] || depths.has(edge.to)) continue;
      depths.set(edge.to, (depths.get(from) ?? 0) + 1);
      queue.push(edge.to);
    }
  }
  const rows = new Map<number, number>();
  const nodes = Object.entries(board.phases).map(([id, phase]): GraphNode => {
    const depth = depths.get(id) ?? Math.max(0, ...depths.values()) + 1;
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    return {
      id,
      phase,
      x: positions[id]?.x ?? 40 + depth * 270,
      y: positions[id]?.y ?? 80 + row * 160,
    };
  });
  const nodeHeight = 94;
  const baseHeight = Math.max(220, ...nodes.map((node) => node.y + nodeHeight + 60));
  let returnIndex = 0;
  const routes = edges.flatMap((edge): GraphRoute[] => {
    const from = nodes.find((node) => node.id === edge.from),
      to = nodes.find((node) => node.id === edge.to);
    if (!from || !to) return [];
    const returning = to.x <= from.x;
    let points: GraphPoint[];
    let label: GraphPoint;
    if (returning) {
      const lane = baseHeight + returnIndex++ * 60;
      const startX = from.x + (edge.from === edge.to ? 160 : 100);
      const endX = to.x + (edge.from === edge.to ? 40 : 100);
      points = [
        { x: startX, y: from.y + nodeHeight },
        { x: startX, y: lane },
        { x: endX, y: lane },
        { x: endX, y: to.y + nodeHeight },
      ];
      label = { x: (from.x + to.x) / 2 + 100, y: lane };
    } else {
      const start = { x: from.x + 200, y: from.y + nodeHeight / 2 },
        end = { x: to.x, y: to.y + nodeHeight / 2 };
      const elbow = start.x + 35;
      points = [start, { x: elbow, y: start.y }, { x: elbow, y: end.y }, end];
      label = { x: elbow + 5, y: Math.max(start.y, end.y) + 66 };
    }
    return [{ edge, points, label, returning }];
  });
  return {
    nodes,
    routes,
    width: Math.max(640, ...nodes.map((node) => node.x + 250)),
    height: baseHeight + returnIndex * 60 + 30,
  };
}
export function updateGraphConnection(
  workflow: RoleWorkflow,
  edge: GraphConnection,
  target: string,
  maxReturns?: number,
): RoleWorkflow {
  const original = workflow.boards[edge.board]?.phases[edge.from] as GraphPhase | undefined;
  if (!original || !workflow.boards[edge.board].phases[target])
    throw new Error("Choose an existing phase on this board.");
  const current = graphConnections(workflow).find((value) => value.id === edge.id);
  if (!current || current.to !== edge.to)
    throw new Error("This connection changed. Reopen it before editing.");
  if (maxReturns !== undefined && (!Number.isSafeInteger(maxReturns) || maxReturns < 0))
    throw new Error("Return limit must be a whole number of zero or more.");
  const phase: GraphPhase = { ...original };
  if (edge.kind === "outcome") phase.outcomes = { ...phase.outcomes, [edge.label]: target };
  if (edge.kind === "next") phase.next = target;
  if (edge.kind === "children") phase.completeWithChildren = target;
  if (edge.kind === "skip") phase.skipTo = target;
  if (maxReturns !== undefined) phase.maxReturns = maxReturns;
  return {
    ...workflow,
    boards: {
      ...workflow.boards,
      [edge.board]: {
        ...workflow.boards[edge.board],
        phases: { ...workflow.boards[edge.board].phases, [edge.from]: phase },
      },
    },
  };
}
