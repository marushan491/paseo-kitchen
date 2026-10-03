import { Icon } from "@getpaseo/plugin/client/react-native";
import { kitchenStations, stageForRole } from "./kitchen-stations.js";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState, useEffect, useId } from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import type { RoleWorkflow } from "../shared/role-builder.js";
import { Action, Field, SurfaceSheet, useFactoryStyles } from "./ui.js";
import { Choice } from "./choice.js";
import { GraphViewport } from "./graph-viewport.js";
import {
  clampGraphZoom,
  graphNodeSize,
  graphConnections,
  layoutRoleGraph,
  updateGraphConnection,
  type GraphConnection,
  type GraphNode,
  type GraphPoint,
  type GraphRoute,
  type GraphPhase,
} from "./role-graph-model.js";
export interface RoleGraphProps extends PluginSurfaceProps {
  workflow: RoleWorkflow;
  onRole(role: string): void;
  onChange?(workflow: RoleWorkflow): void;
  onConnection?(edge: GraphConnection): void;
  selectedRole?: string;
  roleName?: string;
}
export function RoleGraph(props: RoleGraphProps) {
  const styles = useFactoryStyles(props);
  const toolbarStyles = useMemo(
    () => ({
      toolbar: {
        ...styles.row,
        alignItems: "flex-end" as const,
        justifyContent: "space-between" as const,
        gap: 12,
      },
      board: { width: props.layout.compact ? ("100%" as const) : 280 },
      controls: { ...styles.row, gap: 6 },
      zoom: {
        ...styles.text,
        minWidth: 42,
        textAlign: "center" as const,
      },
    }),
    [styles.row, styles.text, props.layout.compact],
  );
  const boards = useMemo(() => Object.keys(props.workflow.boards), [props.workflow.boards]);
  const [boardId, setBoard] = useState(boards[0] ?? "root");
  const [mode, setMode] = useState(props.layout.compact ? "list" : "graph");
  const [zoom, setZoom] = useState(100);
  const [graphScale, setGraphScale] = useState(1);
  const [fitKey, setFitKey] = useState(0);
  const [arrangeKey, setArrangeKey] = useState(0);
  const [selected, setSelected] = useState<GraphConnection | null>(null);
  const [phaseId, setPhase] = useState("");
  const [positions, setPositions] = useState<Record<string, GraphPoint>>({});
  const board = props.workflow.boards[boardId] ? boardId : boards[0];
  const graph = useMemo(
    () => layoutRoleGraph(props.workflow, board, positions),
    [props.workflow, board, positions],
  );
  const statesStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: 40,
      top: graph.statesY - 8,
      width: graph.width - 80,
      borderTopWidth: 1,
      borderColor: props.theme.colors.border,
      paddingTop: 12,
    }),
    [graph.statesY, graph.width, props.theme.colors.border],
  );
  useEffect(() => setMode(props.layout.compact ? "list" : "graph"), [props.layout.compact]);
  const chooseMode = useCallback((value: string) => setMode(value), []);
  const { onRole, onConnection } = props;
  const inspect = useCallback(
    (edge: GraphConnection) => {
      if (onConnection) onConnection(edge);
      else setSelected(edge);
    },
    [onConnection],
  );
  const inspectPhase = useCallback(
    (node: GraphNode) => {
      if (node.phase.role) onRole(node.phase.role);
      else setPhase(node.id);
    },
    [onRole],
  );
  const dismiss = useCallback(() => setSelected(null), []);
  const dismissPhase = useCallback(() => setPhase(""), []);
  const changeZoom = useCallback(
    (amount: number) => setZoom((value) => clampGraphZoom(value + amount)),
    [],
  );
  const naturalSize = useCallback(() => setZoom(100), []);
  const fit = useCallback(() => {
    setFitKey((value) => value + 1);
  }, []);
  const arrange = useCallback(() => {
    setPositions({});
    setArrangeKey((value) => value + 1);
  }, []);
  const moveNode = useCallback(
    (id: string, point: GraphPoint) => setPositions((old) => ({ ...old, [id]: point })),
    [],
  );
  const chooseBoard = useCallback((value: string) => {
    setBoard(value);
    setPositions({});
    setSelected(null);
    setPhase("");
  }, []);
  const options = useMemo(() => boards.map((id) => ({ id, title: boardTitle(id) })), [boards]);
  return (
    <View style={styles.stack}>
      <View style={toolbarStyles.toolbar}>
        <View style={toolbarStyles.board}>
          <Choice
            {...props}
            label="Work board"
            value={board}
            options={options}
            onChange={chooseBoard}
          />
        </View>
        <View style={toolbarStyles.controls}>
          <Action
            theme={props.theme}
            title="List"
            value="list"
            selected={mode === "list"}
            onAction={chooseMode}
            compact={props.layout.compact}
          />
          <Action
            theme={props.theme}
            title="Graph"
            value="graph"
            selected={mode === "graph"}
            onAction={chooseMode}
            compact={props.layout.compact}
          />
        </View>
        {mode === "graph" ? (
          <View style={toolbarStyles.controls}>
            <Action
              theme={props.theme}
              title="−"
              accessibilityLabel="Graph zoom out"
              value={-10}
              onAction={changeZoom}
              disabled={zoom <= 1}
              compact={props.layout.compact}
            />
            <Text style={toolbarStyles.zoom}>{zoom}%</Text>
            <Action
              theme={props.theme}
              title="+"
              accessibilityLabel="Graph zoom in"
              value={10}
              onAction={changeZoom}
              disabled={zoom >= 200}
              compact={props.layout.compact}
            />
            <Action
              theme={props.theme}
              title="1:1"
              accessibilityLabel="Workflow graph actual size"
              value="actual-size"
              onAction={naturalSize}
              selected={zoom === 100}
              compact={props.layout.compact}
            />
            <Action
              theme={props.theme}
              title="Fit"
              accessibilityLabel="Fit workflow graph"
              value="fit"
              onAction={fit}
              compact={props.layout.compact}
            />
            <Action
              theme={props.theme}
              title="Auto-arrange"
              value="arrange"
              onAction={arrange}
              compact={props.layout.compact}
            />
          </View>
        ) : null}
      </View>
      {mode === "graph" ? (
        <>
          <GraphViewport
            {...props}
            width={graph.width}
            height={graph.height}
            zoom={zoom}
            onZoom={setZoom}
            fitKey={fitKey}
            viewKey={`${board}:${arrangeKey}`}
            focus={graph.focus}
            onScale={setGraphScale}
          >
            {graph.statesY ? (
              <View style={statesStyle}>
                <Text style={styles.muted}>Other workflow states</Text>
              </View>
            ) : null}
            {graph.routes.map((route) => (
              <ConnectionPath key={route.edge.id} {...props} route={route} onInspect={inspect} />
            ))}
            {graph.nodes.map((node) => (
              <PhaseNode
                key={node.id}
                {...props}
                node={node}
                onInspect={inspectPhase}
                onMove={moveNode}
                scale={graphScale}
                initial={node.id === props.workflow.boards[board].initialPhase}
              />
            ))}
          </GraphViewport>
          <Text style={styles.muted}>
            Scroll or pinch to zoom. Drag the background to pan. Red routes return work for
            corrections. Fit includes every workflow state.
          </Text>
        </>
      ) : (
        <ConnectionList
          {...props}
          board={board}
          nodes={graph.nodes}
          onPhase={inspectPhase}
          onInspect={inspect}
        />
      )}
      <Text style={styles.muted}>
        Verification and human acceptance stay enforced by Kitchen. Editing a route does not grant
        tools or bypass those gates.
      </Text>
      {selected ? (
        <ConnectionInspector key={selected.id} {...props} edge={selected} onClose={dismiss} />
      ) : null}
      {phaseId && props.workflow.boards[board]?.phases[phaseId] ? (
        <PhaseInspector
          {...props}
          phase={props.workflow.boards[board].phases[phaseId]}
          initial={phaseId === props.workflow.boards[board].initialPhase}
          childBoard={props.workflow.boards.item ? "item" : undefined}
          onBoard={chooseBoard}
          onClose={dismissPhase}
        />
      ) : null}
    </View>
  );
}
function boardTitle(id: string) {
  if (id === "root") return "Mission plan and integration";
  if (id === "item") return "Task build and verification";
  return id;
}
function PhaseNode(
  props: RoleGraphProps & {
    node: GraphNode;
    initial: boolean;
    scale: number;
    onMove(id: string, point: GraphPoint): void;
    onInspect(node: GraphNode): void;
  },
) {
  const { node, onInspect, onMove, scale } = props;
  const nativeId = useId();
  const styles = useFactoryStyles(props);
  const select = useCallback(() => onInspect(node), [onInspect, node]);
  const drag = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, state) =>
          state.numberActiveTouches === 1 && Math.abs(state.dx) + Math.abs(state.dy) > 8,
        onPanResponderRelease: (_, state) => {
          const estimatedScale = scale;
          onMove(node.id, {
            x: Math.max(20, node.x + state.dx / estimatedScale),
            y: Math.max(40, node.y + state.dy / estimatedScale),
          });
        },
        onPanResponderTerminationRequest: () => true,
      }),
    [node, onMove, scale],
  );
  const role = node.phase.role ? props.workflow.roles[node.phase.role] : undefined;
  const name =
    node.phase.role === props.selectedRole && props.roleName ? props.roleName : role?.title;
  const presentation = phasePresentation(props, node);
  const nodeStyles = useMemo(() => {
    let borderColor = node.phase.role ? presentation.color : props.theme.colors.border;
    if (props.selectedRole === node.phase.role && props.selectedRole)
      borderColor = props.theme.colors.accent;
    return {
      card: {
        position: "absolute" as const,
        left: node.x,
        top: node.y,
        width: graphNodeSize.width,
        height: graphNodeSize.height,
        padding: 14,
        paddingTop: 16,
        gap: 6,
        overflow: "hidden" as const,
        borderRadius: 12,
        borderWidth: 1,
        borderColor,
        backgroundColor: node.phase.role
          ? props.theme.colors.surface1
          : props.theme.colors.surface0,
      },
      tint: {
        position: "absolute" as const,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: presentation.color,
        opacity: 0.12,
      },
      stripe: {
        position: "absolute" as const,
        left: 0,
        right: 0,
        top: 0,
        height: 5,
        backgroundColor: presentation.color,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      title: {
        color: props.theme.colors.foreground,
        fontSize: 16,
        lineHeight: 21,
        fontWeight: "700" as const,
        flex: 1,
      },
      purpose: { color: props.theme.colors.foreground, fontSize: 13, lineHeight: 17 },
      role: { color: props.theme.colors.foregroundMuted, fontSize: 11, lineHeight: 14 },
      initial: { color: props.theme.colors.foregroundMuted, fontSize: 11 },
    };
  }, [node, props.selectedRole, props.theme, presentation.color]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Workflow phase ${node.phase.title}${name ? `, ${name}` : ""}`}
      nativeID={nativeId}
      onPress={select}
      style={nodeStyles.card}
      {...drag.panHandlers}
    >
      {node.phase.role ? <View pointerEvents="none" style={nodeStyles.tint} /> : null}
      {node.phase.role ? <View pointerEvents="none" style={nodeStyles.stripe} /> : null}
      <View style={nodeStyles.row}>
        <Icon name={presentation.icon} size={20} color={presentation.color} />
        <Text style={nodeStyles.title} numberOfLines={2}>
          {presentation.title}
        </Text>
      </View>
      {presentation.purpose ? <Text style={nodeStyles.purpose}>{presentation.purpose}</Text> : null}
      <Text style={node.phase.role ? nodeStyles.role : styles.muted} numberOfLines={2}>
        {name || phasePurpose(node.phase)}
      </Text>
      {props.initial ? <Text style={nodeStyles.initial}>Start here</Text> : null}
    </Pressable>
  );
}
function phasePresentation(props: RoleGraphProps, node: GraphNode) {
  const colors = props.theme.colors;
  if (!node.phase.role)
    return {
      title: node.phase.title,
      icon: node.phase.kind === "terminal" ? "ShieldCheck" : "GitBranch",
      color: colors.foregroundMuted,
    };
  const stage = stageForRole(
    node.phase.role,
    node.id,
    props.workflow.boards.root?.phases[node.id] === node.phase,
  );
  const station = kitchenStations.find((value) => value.id === stage);
  const icons: Record<string, string> = {
    plan: "ClipboardList",
    build: "Code2",
    review: "SearchCheck",
    verify: "ShieldCheck",
    integrate: "GitMerge",
    final: "BadgeCheck",
  };
  let color = colors.accent;
  if (stage === "plan" || stage === "review") color = colors.statusWarning;
  if (stage === "verify" || stage === "final") color = colors.statusSuccess;
  return {
    title: stage === "head" ? node.phase.title : station!.title,
    purpose: stage === "head" ? undefined : station!.purpose,
    icon: icons[stage] || "Workflow",
    color,
  };
}
function phasePurpose(phase: GraphPhase) {
  if (phase.completeWithChildren) return "Wait for verified scoped work";
  if (phase.kind === "terminal") return "Protected gate / completed stage";
  if (phase.next) return "Kitchen advances automatically";
  return "Waiting stage";
}
function ConnectionPath(
  props: RoleGraphProps & { route: GraphRoute; onInspect(edge: GraphConnection): void },
) {
  const { route, onInspect } = props;
  const nativeId = useId();
  const select = useCallback(() => onInspect(route.edge), [onInspect, route.edge]);
  const styles = useFactoryStyles(props);
  const label = useMemo(
    () => ({
      position: "absolute" as const,
      left: route.label.x - 65,
      top: route.label.y - 18,
      minHeight: 44,
      maxWidth: 180,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: route.returning ? props.theme.colors.statusDanger : props.theme.colors.border,
      backgroundColor: props.theme.colors.surface0,
      justifyContent: "center" as const,
    }),
    [route.label, route.returning, props.theme],
  );
  const labelText = useMemo(
    () => ({
      ...styles.text,
      color: route.returning ? props.theme.colors.statusDanger : props.theme.colors.foreground,
      fontWeight: "600" as const,
      fontSize: 13,
    }),
    [styles.text, route.returning, props.theme],
  );
  const segments = route.points
    .slice(1)
    .map((point, index) => ({ from: route.points[index], to: point }));
  return (
    <>
      <View pointerEvents="none">
        {segments.map((segment, index) => (
          <RouteSegment
            key={`${segment.from.x}:${segment.from.y}:${segment.to.x}:${segment.to.y}`}
            {...props}
            from={segment.from}
            to={segment.to}
            terminal={index === segments.length - 1}
            returning={route.returning}
          />
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Connection ${props.workflow.boards[route.edge.board].phases[route.edge.from]?.title} to ${props.workflow.boards[route.edge.board].phases[route.edge.to]?.title}: ${route.edge.label}`}
        onPress={select}
        nativeID={nativeId}
        style={label}
      >
        <Text style={labelText}>
          {route.edge.label}
          {route.returning ? " ↩" : " →"}
        </Text>
      </Pressable>
    </>
  );
}
function RouteSegment(
  props: PluginSurfaceProps & {
    from: GraphPoint;
    to: GraphPoint;
    terminal: boolean;
    returning: boolean;
  },
) {
  const styles = useMemo(() => {
    const dx = props.to.x - props.from.x,
      dy = props.to.y - props.from.y,
      length = Math.hypot(dx, dy),
      angle = Math.atan2(dy, dx);
    return {
      line: {
        position: "absolute" as const,
        left: (props.from.x + props.to.x) / 2 - length / 2,
        top: (props.from.y + props.to.y) / 2 - 1,
        width: length,
        height: 2,
        backgroundColor: props.returning
          ? props.theme.colors.statusDanger
          : props.theme.colors.accent,
        transform: [{ rotate: `${angle}rad` }],
      },
      arrow: {
        position: "absolute" as const,
        left: props.to.x - 9,
        top: props.to.y - 13,
        color: props.returning ? props.theme.colors.statusDanger : props.theme.colors.accent,
        fontSize: 22,
        transform: [{ rotate: `${angle}rad` }],
      },
    };
  }, [props.from, props.to, props.theme, props.returning]);
  return (
    <>
      <View style={styles.line} />
      {props.terminal ? <Text style={styles.arrow}>›</Text> : null}
    </>
  );
}
function ConnectionList(
  props: RoleGraphProps & {
    board: string;
    nodes: GraphNode[];
    onPhase(node: GraphNode): void;
    onInspect(edge: GraphConnection): void;
  },
) {
  const styles = useFactoryStyles(props);
  const edges = useMemo(
    () => graphConnections(props.workflow).filter((edge) => edge.board === props.board),
    [props.workflow, props.board],
  );
  return (
    <View style={styles.stack}>
      {props.nodes.map((node) => (
        <PhaseRow key={node.id} {...props} node={node} edges={edges} />
      ))}
    </View>
  );
}
function PhaseRow(
  props: Parameters<typeof ConnectionList>[0] & { node: GraphNode; edges: GraphConnection[] },
) {
  const styles = useFactoryStyles(props);
  const { node, onPhase } = props;
  const outgoing = props.edges.filter((edge) => edge.from === node.id);
  const open = useCallback(() => onPhase(node), [onPhase, node]);
  return (
    <View style={styles.card}>
      <Action
        theme={props.theme}
        title={node.phase.title}
        accessibilityLabel={`Workflow phase ${node.phase.title}`}
        value="phase"
        onAction={open}
      />
      <Text style={styles.muted}>
        {node.phase.role ? props.workflow.roles[node.phase.role]?.title : phasePurpose(node.phase)}
      </Text>
      {outgoing.map((edge) => (
        <Action
          key={edge.id}
          theme={props.theme}
          title={`${edge.label} → ${props.workflow.boards[edge.board].phases[edge.to]?.title || edge.to}`}
          accessibilityLabel={`Connection ${node.phase.title}: ${edge.label}`}
          value={edge}
          onAction={props.onInspect}
        />
      ))}
    </View>
  );
}
function ConnectionInspector(props: RoleGraphProps & { edge: GraphConnection; onClose(): void }) {
  const styles = useFactoryStyles(props);
  const { edge, onChange, onClose, workflow } = props;
  const phase = workflow.boards[edge.board].phases[edge.from] as GraphPhase;
  const [target, setTarget] = useState(edge.to);
  const [limit, setLimit] = useState(phase.maxReturns?.toString() ?? "");
  const [error, setError] = useState("");
  const options = useMemo(
    () =>
      Object.entries(workflow.boards[edge.board].phases).map(([id, value]) => ({
        id,
        title: value.title,
      })),
    [workflow, edge.board],
  );
  const save = useCallback(() => {
    try {
      onChange?.(
        updateGraphConnection(workflow, edge, target, limit.trim() ? Number(limit) : undefined),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onChange, onClose, workflow, edge, target, limit]);
  const { theme } = props;
  const footer = useMemo(
    () => (
      <View style={styles.row}>
        <Action theme={theme} title="Cancel" value="cancel" onAction={onClose} />
        {onChange ? (
          <Action
            theme={theme}
            title="Apply route to draft"
            variant="primary"
            value="save"
            onAction={save}
          />
        ) : null}
      </View>
    ),
    [theme, styles.row, onClose, onChange, save],
  );
  const from = workflow.boards[edge.board].phases[edge.from],
    to = workflow.boards[edge.board].phases[edge.to];
  return (
    <SurfaceSheet {...props} title="Workflow connection" onClose={onClose} side footer={footer}>
      <Text style={styles.heading}>
        {from.title} → {to.title}
      </Text>
      <Text style={styles.muted}>When</Text>
      <Text style={styles.text}>{edge.label}</Text>
      <Text style={styles.muted}>{connectionPurpose(edge)}</Text>
      {onChange ? (
        <>
          <Choice
            {...props}
            label="Continue at"
            value={target}
            options={options}
            onChange={setTarget}
          />
          {edge.kind === "outcome" ? (
            <Field
              theme={props.theme}
              label="Return limit for this phase"
              value={limit}
              onChange={setLimit}
              keyboardType="numeric"
              placeholder="Use workflow default"
            />
          ) : null}
          <Text style={styles.muted}>
            This changes the draft. Save the workflow to validate and publish it; running missions
            keep their selected revision.
          </Text>
        </>
      ) : (
        <Text style={styles.muted}>
          This pack is read-only. Create an editable workflow to change its routing.
        </Text>
      )}
      <Text style={styles.muted}>Context</Text>
      <Text style={styles.text}>
        Kitchen records the report and dispatches the target phase’s configured role. Agent
        permissions and verification requirements are separate from this connection.
      </Text>
      {phase.condition ? (
        <>
          <Text style={styles.muted}>Runs when files change</Text>
          <Text style={styles.text}>
            {phase.condition.any
              .map((match) =>
                [
                  match.prefix ? `Starts with ${match.prefix}` : "",
                  match.suffix ? `Ends with ${match.suffix}` : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
              )
              .join(" or ")}
          </Text>
        </>
      ) : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </SurfaceSheet>
  );
}
function connectionPurpose(edge: GraphConnection) {
  if (edge.kind === "children") return "Advance only after scoped work is verified.";
  if (edge.kind === "skip") return "Skip only when the configured file condition does not match.";
  if (edge.kind === "next") return "Automatic advancement from a waiting phase.";
  return "An actual factory-report outcome determines the next phase.";
}
function PhaseInspector(
  props: PluginSurfaceProps & {
    phase: GraphPhase;
    initial: boolean;
    childBoard?: string;
    onBoard(id: string): void;
    onClose(): void;
  },
) {
  const styles = useFactoryStyles(props);
  const { onBoard, onClose } = props;
  const scoped = useCallback(
    (value: string) => {
      onClose();
      onBoard(value);
    },
    [onClose, onBoard],
  );
  return (
    <SurfaceSheet {...props} title={props.phase.title} onClose={props.onClose} side>
      <Text style={styles.text}>{phasePurpose(props.phase)}</Text>
      {props.initial ? (
        <Text style={styles.muted}>This is the initial phase of this work board.</Text>
      ) : null}
      {props.phase.completeWithChildren && props.childBoard ? (
        <Action
          theme={props.theme}
          title="Inspect scoped task flow"
          value={props.childBoard}
          onAction={scoped}
        />
      ) : null}
      <Text style={styles.muted}>
        Waiting and terminal stages belong to the execution workflow. Human acceptance and
        verification are checked by the runtime; they cannot be disabled in this inspector.
      </Text>
    </SurfaceSheet>
  );
}
