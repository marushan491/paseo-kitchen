import { kitchenStations, stageForRole } from "./kitchen-stations.js";
import type { RoleWorkflow } from "../shared/role-builder.js";
import type { WorkflowDefinition } from "../shared/workflow-contracts.js";

export function clampGraphZoom(value: number): number {
  return Math.max(1, Math.min(200, Math.round(value)));
}
export function fitGraphZoom(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  return clampGraphZoom(Math.min(1, viewportWidth / width, viewportHeight / height) * 92);
}

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
export const graphPortSize = 64;
export const graphNodeSize = { width: 220, height: 150 };
export interface GraphBounds extends GraphPoint {
  width: number;
  height: number;
}
export interface GraphNode extends GraphPoint {
  id: string;
  primary: boolean;
  phase: GraphPhase;
  height: number;
  outputs: GraphConnection[];
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
export function graphZoomTranslation(
  translation: GraphPoint,
  pointer: GraphPoint,
  viewport: { width: number; height: number },
  fromZoom: number,
  toZoom: number,
): GraphPoint {
  const ratio = toZoom / fromZoom;
  const x = pointer.x - viewport.width / 2;
  const y = pointer.y - viewport.height / 2;
  return { x: x - (x - translation.x) * ratio, y: y - (y - translation.y) * ratio };
}
export function graphPanOrigin(position: GraphPoint, gestureDelta: GraphPoint): GraphPoint {
  return { x: position.x - gestureDelta.x, y: position.y - gestureDelta.y };
}
export function graphInputPoint(node: GraphNode): GraphPoint {
  return { x: node.x, y: node.y + 48 };
}
export function graphOutputPoint(node: GraphNode, edge: GraphConnection): GraphPoint {
  return {
    x: node.x + graphNodeSize.width,
    y:
      node.y +
      (graphNodeSize.height - graphPortSize / 2) +
      Math.max(
        0,
        node.outputs.findIndex((value) => value.id === edge.id),
      ) *
        graphPortSize,
  };
}
export function graphDropTarget(
  nodes: readonly GraphNode[],
  point: GraphPoint,
): GraphNode | undefined {
  return nodes.toReversed().find((node) => {
    const input = graphInputPoint(node);
    const onInput =
      Math.abs(point.x - input.x) <= graphPortSize / 2 &&
      Math.abs(point.y - input.y) <= graphPortSize / 2;
    const onCard =
      point.x >= node.x &&
      point.x <= node.x + graphNodeSize.width &&
      point.y >= node.y &&
      point.y <= node.y + node.height;
    return onInput || onCard;
  });
}
export function graphOutcomeTitle(edge: GraphConnection): string {
  if (edge.kind === "children") return "Tasks verified";
  if (edge.kind === "skip") return "No matching changes";
  const labels: Record<string, string> = {
    done: "Done",
    complete: "Done",
    changes: "Changes requested",
    approve: "Approved",
    approved: "Approved",
    pass: "Pass",
    fail: "Fail",
    planned: "Planned",
  };
  return labels[edge.label] || edge.label;
}
export function layoutRoleGraph(
  workflow: RoleWorkflow,
  boardId: string,
  positions: Readonly<Record<string, GraphPoint>> = {},
) {
  const board = workflow.boards[boardId];
  const empty = {
    nodes: [] as GraphNode[],
    routes: [] as GraphRoute[],
    width: 640,
    height: 320,
    focus: { x: 0, y: 0, width: 640, height: 320 },
    statesY: 0,
  };
  if (!board) return empty;
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
  const ordered = [...queue, ...Object.keys(board.phases).filter((id) => !depths.has(id))];
  const roles = ordered.filter((id) => board.phases[id].role);
  const primary = roles.length ? roles : [board.initialPhase];
  const remaining = Object.keys(board.phases).filter((id) => !primary.includes(id));
  const heightFor = (id: string) =>
    graphNodeSize.height +
    Math.max(0, edges.filter((edge) => edge.from === id).length - 1) * graphPortSize;
  const rowStep = Math.max(230, ...primary.map((id) => heightFor(id) + 90));
  const primaryRows = Math.ceil(primary.length / 3);
  const primaryBottom =
    80 +
    Math.max(0, primaryRows - 1) * rowStep +
    Math.max(graphNodeSize.height, ...primary.map(heightFor));
  const returns = edges.filter(
    (edge) =>
      depths.has(edge.from) &&
      depths.has(edge.to) &&
      depths.get(edge.to)! <= depths.get(edge.from)!,
  );
  const statesY = primaryBottom + returns.length * 56 + 110;
  const nodes = Object.entries(board.phases).map(([id, phase]): GraphNode => {
    const active = primary.includes(id);
    const index = active ? primary.indexOf(id) : remaining.indexOf(id);
    const row = Math.floor(index / 3);
    const column = active && row % 2 ? 2 - (index % 3) : index % 3;
    return {
      id,
      phase,
      height: heightFor(id),
      outputs: edges.filter((edge) => edge.from === id),
      primary: active,
      x: positions[id]?.x ?? 40 + column * 300,
      y: positions[id]?.y ?? (active ? 80 : statesY + 36) + row * rowStep,
    };
  });
  const primaryNodes = nodes.filter((node) => node.primary);
  const routeBottom = Math.max(primaryBottom, ...primaryNodes.map((node) => node.y + node.height));
  let returnIndex = 0;
  const routes = edges.flatMap((edge): GraphRoute[] => {
    const from = nodes.find((node) => node.id === edge.from),
      to = nodes.find((node) => node.id === edge.to);
    if (!from || !to) return [];
    const returning = returns.some((value) => value.id === edge.id);
    let points: GraphPoint[];
    let label: GraphPoint;
    const start = graphOutputPoint(from, edge);
    const end = graphInputPoint(to);
    if (returning || to.x <= from.x) {
      let lane = Math.max(from.y + from.height, to.y + to.height) + 40;
      let gap = 18;
      if (returning) {
        lane = routeBottom + 56 + returnIndex * 56;
        gap += (returnIndex++ % 3) * 6;
      }
      const startX = start.x + gap;
      const endX = Math.max(8, end.x - gap);
      points = [
        start,
        { x: startX, y: start.y },
        { x: startX, y: lane },
        { x: endX, y: lane },
        { x: endX, y: end.y },
        end,
      ];
      label = { x: (startX + endX) / 2, y: lane };
    } else {
      const elbow = (start.x + end.x) / 2;
      points = [start, { x: elbow, y: start.y }, { x: elbow, y: end.y }, end];
      label = { x: elbow, y: Math.min(from.y, to.y) - 24 };
    }
    return [{ edge, points, label, returning }];
  });
  const primaryIds = new Set(primaryNodes.map((node) => node.id));
  const primaryRoutes = routes.filter(
    (route) => primaryIds.has(route.edge.from) && primaryIds.has(route.edge.to),
  );
  const primaryRoutePoints = primaryRoutes.flatMap((route) => route.points);
  const left = Math.min(
    20,
    ...primaryNodes.map((node) => node.x - 20),
    ...primaryRoutePoints.map((point) => point.x - 20),
    ...primaryRoutes.map((route) => route.label.x - 80),
  );
  const top = Math.min(
    20,
    ...primaryNodes.map((node) => node.y - 50),
    ...primaryRoutePoints.map((point) => point.y - 20),
    ...primaryRoutes.map((route) => route.label.y - 30),
  );
  return {
    nodes,
    routes,
    statesY: remaining.length ? statesY : 0,
    width: Math.max(
      640,
      ...nodes.map((node) => node.x + graphNodeSize.width + 40),
      ...routes.map((route) => route.label.x + 100),
      ...routes.flatMap((route) => route.points.map((point) => point.x + 40)),
    ),
    height: Math.max(
      320,
      ...nodes.map((node) => node.y + node.height + 50),
      ...routes.flatMap((route) => route.points.map((point) => point.y + 50)),
    ),
    focus: {
      x: left,
      y: top,
      width:
        Math.max(
          440,
          ...primaryNodes.map((node) => node.x + graphNodeSize.width + 30),
          ...primaryRoutePoints.map((point) => point.x + 20),
          ...primaryRoutes.map((route) => route.label.x + 120),
        ) - left,
      height:
        Math.max(
          240,
          ...primaryNodes.map((node) => node.y + node.height + 40),
          ...primaryRoutePoints.map((point) => point.y + 20),
          ...primaryRoutes.map((route) => route.label.y + 40),
        ) - top,
    },
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
  else delete phase.maxReturns;
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

export function editableItemConnections(definition: WorkflowDefinition): GraphConnection[] {
  return graphConnections({ ...definition, maxParallel: 4 }).filter((edge) => {
    const phase = definition.boards[edge.board].phases[edge.from];
    return (
      edge.board === "item" &&
      phase.kind === "working" &&
      edge.from !== "verify" &&
      phase.role !== "verifier" &&
      (edge.kind === "outcome" || edge.kind === "next")
    );
  });
}

export function insertWorkflowRole(
  definition: WorkflowDefinition,
  edge: GraphConnection,
  input: {
    title: string;
    instructions: string;
    canEdit: boolean;
    clarification: "human" | "head-chef";
    investigation: "human" | "request-work";
  },
): WorkflowDefinition {
  const connection = editableItemConnections(definition).find((value) => value.id === edge.id);
  if (!connection || connection.to !== edge.to)
    throw new Error("Choose a current editable connection in Each feature.");
  const title = input.title.trim();
  const instructions = input.instructions.trim();
  if (!title || title.length > 160) throw new Error("Role name needs 1 to 160 characters.");
  if (!instructions || instructions.length > 16000)
    throw new Error("Responsibility needs 1 to 16000 characters.");
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "role";
  const base = `custom-${slug}`.slice(0, 58).replace(/-$/g, "");
  let id = base;
  let suffix = 2;
  while (definition.roles[id] || definition.boards.item.phases[id]) id = `${base}-${suffix++}`;
  const value: WorkflowDefinition = {
    ...definition,
    roles: {
      ...definition.roles,
      [id]: {
        id,
        title,
        instructions,
        skills: [],
        canEdit: input.canEdit,
        workspace: input.canEdit ? "own-worktree" : "item-worktree",
        tools: input.investigation === "request-work" ? ["item_request_work"] : [],
        communication: {
          clarification: input.clarification,
          investigation: input.investigation,
        },
      },
    },
    boards: {
      ...definition.boards,
      item: {
        ...definition.boards.item,
        phases: {
          ...definition.boards.item.phases,
          [id]: { title, kind: "working", role: id, outcomes: { done: edge.to } },
        },
      },
    },
  };
  const changed = updateGraphConnection(
    { ...value, maxParallel: 4 },
    edge,
    id,
    definition.boards.item.phases[edge.from].maxReturns,
  );
  return { ...value, boards: changed.boards };
}

export function graphPhaseTitle(workflow: RoleWorkflow, board: string, id: string): string {
  const phase = workflow.boards[board].phases[id];
  if (!phase.role) return phase.title;
  const stage = stageForRole(phase.role, id, board === "root");
  return stage === "head"
    ? phase.title
    : kitchenStations.find((entry) => entry.id === stage)!.title;
}
