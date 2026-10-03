import { Icon } from "@getpaseo/plugin/client/react-native";
import { kitchenStations, stageForRole } from "./kitchen-stations.js";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState, useEffect, useId, useRef, type RefObject } from "react";
import { PanResponder, Platform, Pressable, Text, View } from "react-native";
import type { RoleWorkflow } from "../shared/role-builder.js";
import { Action, Field, SurfaceSheet, useFactoryStyles } from "./ui.js";
import { Choice } from "./choice.js";
import { GraphViewport, type GraphViewportHandle } from "./graph-viewport.js";
import {
  clampGraphZoom,
  graphNodeSize,
  graphPortSize,
  graphConnections,
  graphInputPoint,
  graphOutputPoint,
  graphDropTarget,
  graphOutcomeTitle,
  graphPhaseTitle,
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
  const [showStates, setShowStates] = useState(false);
  const [connecting, setConnecting] = useState<GraphConnection | null>(null);
  const [dragPoint, setDragPoint] = useState<GraphPoint | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const viewportRef = useRef<GraphViewportHandle>(null);
  const board = props.workflow.boards[boardId] ? boardId : boards[0];
  const graph = useMemo(
    () => layoutRoleGraph(props.workflow, board, positions),
    [props.workflow, board, positions],
  );
  const visibleNodes = useMemo(
    () => graph.nodes.filter((node) => showStates || node.primary),
    [graph.nodes, showStates],
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleRoutes = useMemo(
    () =>
      graph.routes.filter(
        (route) => visibleIds.has(route.edge.from) && visibleIds.has(route.edge.to),
      ),
    [graph.routes, visibleIds],
  );
  const secondaryCount = graph.nodes.filter((node) => !node.primary).length;
  const hovered = dragPoint ? graphDropTarget(visibleNodes, dragPoint)?.id : undefined;
  const previewStart = connecting
    ? graph.nodes.find((node) => node.id === connecting.from)
    : undefined;
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
  const { onRole, onConnection, onChange } = props;
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
  const cancelConnection = useCallback(() => {
    setConnecting(null);
    setDragPoint(null);
    setConnectionError("");
  }, []);
  const startConnection = useCallback(
    (edge: GraphConnection) => {
      if (!props.onChange) {
        inspect(edge);
        return;
      }
      setConnectionError("");
      setConnecting(edge);
      setDragPoint(null);
    },
    [props.onChange, inspect],
  );
  const connect = useCallback(
    (edge: GraphConnection, target: string) => {
      try {
        const phase = props.workflow.boards[edge.board].phases[edge.from] as GraphPhase;
        const changed = updateGraphConnection(props.workflow, edge, target, phase.maxReturns);
        onChange?.(changed);
        setConnecting(null);
        setDragPoint(null);
        setConnectionError("");
        inspect({ ...edge, to: target });
      } catch (cause) {
        setConnectionError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [props.workflow, onChange, inspect],
  );
  const receiveConnection = useCallback(
    (id: string) => {
      if (connecting) connect(connecting, id);
    },
    [connecting, connect],
  );
  const dragConnection = useCallback(
    (edge: GraphConnection, point: GraphPoint) => {
      if (!props.onChange) return;
      setConnecting(edge);
      setDragPoint(viewportRef.current?.toGraphPoint(point) ?? null);
    },
    [props.onChange],
  );
  const dropConnection = useCallback(
    (edge: GraphConnection, point: GraphPoint) => {
      const world = viewportRef.current?.toGraphPoint(point);
      const target = world ? graphDropTarget(visibleNodes, world) : undefined;
      setDragPoint(null);
      if (target) connect(edge, target.id);
    },
    [visibleNodes, connect],
  );
  const toggleStates = useCallback(() => setShowStates((value) => !value), []);
  const dismissPhase = useCallback(() => setPhase(""), []);
  const changeZoom = useCallback(
    (amount: number) => setZoom((value) => clampGraphZoom(value + amount)),
    [],
  );
  const naturalSize = useCallback(() => setZoom(100), []);
  const fit = useCallback(() => {
    setShowStates(true);
    setFitKey((value) => value + 1);
  }, []);
  const arrange = useCallback(() => {
    setPositions({});
    setShowStates(false);
    setConnecting(null);
    setDragPoint(null);
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
    setShowStates(false);
    setConnecting(null);
    setDragPoint(null);
    setConnectionError("");
  }, []);
  const options = useMemo(() => boards.map((id) => ({ id, title: boardTitle(id) })), [boards]);
  return (
    <View style={styles.stack}>
      <View style={toolbarStyles.toolbar}>
        <View style={toolbarStyles.board}>
          <Choice
            {...props}
            label="Workflow level"
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
            {secondaryCount ? (
              <Action
                theme={props.theme}
                title={
                  showStates ? "Hide workflow states" : `Show workflow states (${secondaryCount})`
                }
                accessibilityLabel={showStates ? "Hide workflow states" : "Show workflow states"}
                value="states"
                selected={showStates}
                onAction={toggleStates}
                compact={props.layout.compact}
              />
            ) : null}
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
      <Text style={styles.muted}>{boardPurpose(board, props.workflow)}</Text>
      {mode === "graph" ? (
        <ConnectionHint
          {...props}
          connecting={connecting}
          board={board}
          onCancel={cancelConnection}
        />
      ) : null}
      {connectionError ? <Text style={styles.danger}>{connectionError}</Text> : null}
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
            controllerRef={viewportRef}
            onFit={fit}
          >
            {showStates && graph.statesY ? (
              <View style={statesStyle}>
                <Text style={styles.muted}>Other workflow states</Text>
              </View>
            ) : null}
            {visibleRoutes.map((route) => (
              <ConnectionPath key={route.edge.id} {...props} route={route} onInspect={inspect} />
            ))}
            {visibleNodes.map((node) => (
              <PhaseNode
                key={node.id}
                {...props}
                node={node}
                onInspect={inspectPhase}
                onMove={moveNode}
                scale={graphScale}
                initial={node.id === props.workflow.boards[board].initialPhase}
                connecting={connecting}
                targeted={hovered === node.id}
                onOutput={startConnection}
                onInput={receiveConnection}
                onDragOutput={dragConnection}
                onDropOutput={dropConnection}
              />
            ))}
            {connecting && previewStart && dragPoint ? (
              <View pointerEvents="none">
                <RouteSegment
                  {...props}
                  from={graphOutputPoint(previewStart, connecting)}
                  to={dragPoint}
                  terminal={false}
                  returning={false}
                />
              </View>
            ) : null}
          </GraphViewport>
          <Text style={styles.muted}>
            Drag a stage to move it. Drag an output to an input, or tap each in turn. Drag the
            background to pan; scroll to zoom. Red routes request corrections.
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
      <GraphInspectors
        {...props}
        selected={selected}
        phaseId={phaseId}
        board={board}
        onCloseConnection={dismiss}
        onClosePhase={dismissPhase}
        onBoard={chooseBoard}
      />
    </View>
  );
}
function ConnectionHint(
  props: RoleGraphProps & {
    connecting: GraphConnection | null;
    board: string;
    onCancel(): void;
  },
) {
  const styles = useFactoryStyles(props);
  const row = useMemo(() => ({ ...styles.row, height: 48, gap: 8 }), [styles.row]);
  const text = useMemo(() => ({ ...styles.text, flex: 1 }), [styles.text]);
  return (
    <View style={row}>
      <Text style={text} numberOfLines={2}>
        {props.connecting
          ? `Connecting ${props.workflow.boards[props.board].phases[props.connecting.from].title}: ${graphOutcomeTitle(props.connecting)}. Select an input or drag to a stage.`
          : "Select an output to inspect or connect a handoff."}
      </Text>
      {props.connecting ? (
        <Action
          theme={props.theme}
          title="Cancel connection"
          value="cancel"
          onAction={props.onCancel}
        />
      ) : null}
    </View>
  );
}
function GraphInspectors(
  props: RoleGraphProps & {
    selected: GraphConnection | null;
    phaseId: string;
    board: string;
    onCloseConnection(): void;
    onClosePhase(): void;
    onBoard(id: string): void;
  },
) {
  const phase = props.workflow.boards[props.board]?.phases[props.phaseId];
  return (
    <>
      {props.selected ? (
        <ConnectionInspector
          key={`${props.selected.id}:${props.selected.to}`}
          {...props}
          edge={props.selected}
          onClose={props.onCloseConnection}
        />
      ) : null}
      {phase ? (
        <PhaseInspector
          {...props}
          phase={phase}
          initial={props.phaseId === props.workflow.boards[props.board].initialPhase}
          childBoard={props.workflow.boards.item ? "item" : undefined}
          onClose={props.onClosePhase}
        />
      ) : null}
    </>
  );
}
function boardTitle(id: string) {
  if (id === "root") return "Mission delivery";
  if (id === "item") return "Each feature";
  return id;
}
function boardPurpose(id: string, workflow: RoleWorkflow) {
  if (id === "root") {
    const integrates = Object.values(workflow.boards.root.phases).some(
      (phase) => phase.role === "integrator",
    );
    return integrates
      ? "Plan the mission, run each feature, then combine and verify the complete result."
      : "Coordinate the complete mission and inspect its result.";
  }
  if (id === "item")
    return "Each feature runs its own build and checks before mission delivery continues.";
  return "Edit the stages and declared outcomes for this workflow level.";
}
interface GraphPointerEvent {
  button: number;
  pointerId: number;
  pointerType: string;
  pageX: number;
  pageY: number;
  preventDefault(): void;
  stopPropagation(): void;
}
interface GraphPointerElement {
  addEventListener(
    name: string,
    listener: (event: GraphPointerEvent) => void,
    capture?: boolean,
  ): void;
  removeEventListener(
    name: string,
    listener: (event: GraphPointerEvent) => void,
    capture?: boolean,
  ): void;
  setPointerCapture(id: number): void;
  releasePointerCapture(id: number): void;
}
function useGraphPointerDrag(
  target: RefObject<View | null>,
  enabled: boolean,
  callbacks: {
    start(): void;
    move(point: GraphPoint, delta: GraphPoint): void;
    end(point: GraphPoint): void;
  },
) {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  useEffect(() => {
    if (Platform.OS !== "web" || !enabled) return;
    const element = target.current as unknown as GraphPointerElement | null;
    if (!element?.addEventListener) return;
    let active: { id: number; x: number; y: number } | undefined;
    let moved = false;
    const down = (event: GraphPointerEvent) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      event.stopPropagation();
      active = { id: event.pointerId, x: event.pageX, y: event.pageY };
      moved = false;
      element.setPointerCapture(event.pointerId);
      latest.current.start();
    };
    const move = (event: GraphPointerEvent) => {
      if (active?.id !== event.pointerId) return;
      const delta = { x: event.pageX - active.x, y: event.pageY - active.y };
      if (!moved && Math.abs(delta.x) + Math.abs(delta.y) <= 3) return;
      moved = true;
      event.preventDefault();
      event.stopPropagation();
      latest.current.move({ x: event.pageX, y: event.pageY }, delta);
    };
    const up = (event: GraphPointerEvent) => {
      if (active?.id !== event.pointerId) return;
      event.stopPropagation();
      active = undefined;
      element.releasePointerCapture(event.pointerId);
      if (moved) latest.current.end({ x: event.pageX, y: event.pageY });
    };
    const cancel = () => {
      active = undefined;
    };
    const mouseDown = (event: GraphPointerEvent) => {
      if (active) event.stopPropagation();
    };
    const click = (event: GraphPointerEvent) => {
      if (!moved) return;
      moved = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const listeners = {
      pointerdown: down,
      pointermove: move,
      pointerup: up,
      pointercancel: cancel,
      mousedown: mouseDown,
      click,
    };
    for (const [name, listener] of Object.entries(listeners))
      element.addEventListener(name, listener, true);
    return () => {
      for (const [name, listener] of Object.entries(listeners))
        element.removeEventListener(name, listener, true);
    };
  }, [target, enabled]);
}
function PhaseNode(
  props: RoleGraphProps & {
    node: GraphNode;
    initial: boolean;
    scale: number;
    connecting: GraphConnection | null;
    targeted: boolean;
    onMove(id: string, point: GraphPoint): void;
    onInspect(node: GraphNode): void;
    onInput(id: string): void;
    onOutput(edge: GraphConnection): void;
    onDragOutput(edge: GraphConnection, point: GraphPoint): void;
    onDropOutput(edge: GraphConnection, point: GraphPoint): void;
  },
) {
  const { node, onInspect, onInput, connecting } = props;
  const nativeId = useId();
  const latest = useRef(props);
  latest.current = props;
  const origin = useRef<GraphPoint>({ x: node.x, y: node.y });
  const header = useRef<View>(null);
  useGraphPointerDrag(header, true, {
    start: () => {
      origin.current = { x: latest.current.node.x, y: latest.current.node.y };
    },
    move: (_, delta) =>
      latest.current.onMove(latest.current.node.id, {
        x: Math.max(20, origin.current.x + delta.x / latest.current.scale),
        y: Math.max(40, origin.current.y + delta.y / latest.current.scale),
      }),
    end: () => {},
  });
  const select = useCallback(() => onInspect(node), [onInspect, node]);
  const receive = useCallback(() => {
    if (connecting) onInput(node.id);
    else onInspect(node);
  }, [connecting, onInput, node, onInspect]);
  const drag = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, state) =>
          state.numberActiveTouches === 1 && Math.abs(state.dx) + Math.abs(state.dy) > 3,
        onPanResponderGrant: () => {
          origin.current = { x: latest.current.node.x, y: latest.current.node.y };
        },
        onPanResponderMove: (_, state) =>
          latest.current.onMove(latest.current.node.id, {
            x: Math.max(20, origin.current.x + state.dx / latest.current.scale),
            y: Math.max(40, origin.current.y + state.dy / latest.current.scale),
          }),
        onPanResponderTerminationRequest: () => true,
      }),
    [],
  );
  const role = node.phase.role ? props.workflow.roles[node.phase.role] : undefined;
  const name =
    node.phase.role === props.selectedRole && props.roleName ? props.roleName : role?.title;
  const presentation = phasePresentation(props, node);
  const styles = useMemo(() => {
    let borderColor = node.phase.role ? presentation.color : props.theme.colors.border;
    if (props.targeted || (props.selectedRole === node.phase.role && props.selectedRole))
      borderColor = props.theme.colors.accent;
    return {
      frame: {
        position: "absolute" as const,
        left: node.x,
        top: node.y,
        width: graphNodeSize.width,
        height: node.height,
      },
      card: {
        flex: 1,
        overflow: "hidden" as const,
        borderRadius: 12,
        borderWidth: props.targeted ? 2 : 1,
        borderColor,
        backgroundColor: node.phase.role
          ? props.theme.colors.surface1
          : props.theme.colors.surface0,
      },
      header: {
        height: graphNodeSize.height - graphPortSize,
        paddingHorizontal: 14,
        paddingTop: 12,
        paddingBottom: 8,
        gap: 4,
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
      input: {
        position: "absolute" as const,
        left: -graphPortSize / 2,
        top: graphInputPoint(node).y - node.y - graphPortSize / 2,
        width: graphPortSize,
        height: graphPortSize,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      dot: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 3,
        borderColor: presentation.color,
        backgroundColor: connecting ? props.theme.colors.accent : props.theme.colors.surface0,
      },
    };
  }, [node, props.targeted, props.selectedRole, props.theme, presentation.color, connecting]);
  return (
    <View style={styles.frame} {...drag.panHandlers}>
      <View style={styles.card}>
        {node.phase.role ? <View pointerEvents="none" style={styles.tint} /> : null}
        {node.phase.role ? <View pointerEvents="none" style={styles.stripe} /> : null}
        <Pressable
          ref={header}
          accessibilityRole="button"
          accessibilityLabel={`Workflow phase ${node.phase.title}${name ? `, ${name}` : ""}`}
          accessibilityHint="Drag to move this stage, or select to edit its role."
          nativeID={nativeId}
          onPress={select}
          style={styles.header}
        >
          <View style={styles.row}>
            <Icon name={presentation.icon} size={20} color={presentation.color} />
            <Text style={styles.title} numberOfLines={2}>
              {presentation.title}
            </Text>
          </View>
          {presentation.purpose ? <Text style={styles.purpose}>{presentation.purpose}</Text> : null}
          <Text style={styles.role} numberOfLines={1}>
            {name || phasePurpose(node.phase)}
          </Text>
        </Pressable>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Input ${node.phase.title}`}
        accessibilityHint={
          connecting
            ? "Connect the selected output to this stage."
            : "Select an output first to connect it here."
        }
        onPress={receive}
        style={styles.input}
      >
        <View pointerEvents="none" style={styles.dot} />
      </Pressable>
      {node.outputs.map((edge) => (
        <OutputPort key={edge.id} {...props} edge={edge} selected={connecting?.id === edge.id} />
      ))}
    </View>
  );
}
function OutputPort(
  props: Parameters<typeof PhaseNode>[0] & { edge: GraphConnection; selected: boolean },
) {
  const latest = useRef(props);
  latest.current = props;
  const port = useRef<View>(null);
  useGraphPointerDrag(port, Boolean(props.onChange), {
    start: () => latest.current.onOutput(latest.current.edge),
    move: (point) => latest.current.onDragOutput(latest.current.edge, point),
    end: (point) => latest.current.onDropOutput(latest.current.edge, point),
  });
  const { onOutput, edge } = props;
  const press = useCallback(() => onOutput(edge), [onOutput, edge]);
  const drag = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, state) =>
          Boolean(latest.current.onChange) &&
          state.numberActiveTouches === 1 &&
          Math.abs(state.dx) + Math.abs(state.dy) > 2,
        onPanResponderGrant: () => latest.current.onOutput(latest.current.edge),
        onPanResponderMove: (_, state) =>
          latest.current.onDragOutput(latest.current.edge, { x: state.moveX, y: state.moveY }),
        onPanResponderRelease: (event) =>
          latest.current.onDropOutput(latest.current.edge, {
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY,
          }),
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  const styles = useMemo(() => {
    const negative = ["changes", "fail"].includes(props.edge.label);
    const color = negative ? props.theme.colors.statusDanger : props.theme.colors.accent;
    return {
      port: {
        position: "absolute" as const,
        left: 14,
        right: -14,
        top: graphOutputPoint(props.node, props.edge).y - props.node.y - graphPortSize / 2,
        height: graphPortSize,
        paddingRight: 6,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      label: {
        color: props.selected ? color : props.theme.colors.foreground,
        fontSize: 12,
        lineHeight: 16,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      dot: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 3,
        borderColor: color,
        backgroundColor: props.selected ? color : props.theme.colors.surface0,
      },
    };
  }, [props.edge, props.node, props.selected, props.theme]);
  return (
    <Pressable
      ref={port}
      accessibilityRole="button"
      accessibilityLabel={`Output ${props.node.phase.title}: ${graphOutcomeTitle(props.edge)}`}
      accessibilityHint={`Connect this actual ${props.edge.label} outcome. Current target: ${props.workflow.boards[props.edge.board].phases[props.edge.to]?.title}.`}
      onPress={press}
      style={styles.port}
      {...drag.panHandlers}
    >
      <Text style={styles.label}>
        {graphOutcomeTitle(props.edge)}
        {props.workflow.boards[props.edge.board].phases[props.edge.to]?.role
          ? ""
          : ` → ${props.workflow.boards[props.edge.board].phases[props.edge.to]?.title}`}
      </Text>
      <View pointerEvents="none" style={styles.dot} />
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
    title: graphPhaseTitle(
      props.workflow,
      props.workflow.boards.root?.phases[node.id] === node.phase ? "root" : "item",
      node.id,
    ),
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
          {graphOutcomeTitle(route.edge)}
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
        title={phasePresentation(props, node).title}
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
          title={`${graphOutcomeTitle(edge)} → ${listDestination(props, edge.to)}`}
          accessibilityLabel={`Connection ${node.phase.title}: ${graphOutcomeTitle(edge)}`}
          value={edge}
          onAction={props.onInspect}
        />
      ))}
    </View>
  );
}
function listDestination(props: Parameters<typeof ConnectionList>[0], id: string) {
  const node = props.nodes.find((entry) => entry.id === id);
  return node ? phasePresentation(props, node).title : id;
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
      <Text style={styles.text}>{graphOutcomeTitle(edge)}</Text>
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
            Save changes to keep this handoff for new missions. Running missions keep their
            snapshot.
          </Text>
        </>
      ) : (
        <Text style={styles.muted}>
          This pack is read-only. Create an editable workflow to change its routing.
        </Text>
      )}
      <Text style={styles.muted}>Context</Text>
      <Text style={styles.text}>
        Kitchen sends work to the selected stage. Agent permissions and verification requirements
        stay enforced.
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
  return "When this stage reports this result, work moves to the selected stage.";
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
