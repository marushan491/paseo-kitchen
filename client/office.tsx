import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import type { TeamState } from "../shared/factory-contracts.js";
import {
  officeAgentIds,
  projectOffice,
  type OfficeAgentSnapshot,
  type OfficeDesk,
} from "./office-model.js";
import { mountOffice, type OfficePalette, type OfficeRenderer } from "./web.js";
import { Action, SurfaceSheet, useFactoryStyles } from "./ui.js";
import { kitchenStations, clampZoom } from "./kitchen-stations.js";
import { KitchenInspector } from "./kitchen-inspector.js";
import { NativeKitchenMap } from "./kitchen-native-map.js";
import {
  missionStages,
  missionWorkflowFor,
  type MissionPack,
  type MissionStageStatus,
} from "../shared/mission-stage.js";
import { stageForRole } from "./kitchen-stations.js";

export type OfficeProps = PluginSurfaceProps & {
  teams: TeamState[];
  onOpenTeam(teamId: string): void;
  onConfigureAgent?(agentId: string): void;
  onNewMission?(): void;
  packs?: readonly MissionPack[];
};
export function Office(props: OfficeProps) {
  const styles = useFactoryStyles(props);
  const viewport = useWindowDimensions();
  const observed = useOfficeAgents(props);
  const desks = useMemo(
    () => projectOffice(props.teams, observed.agents),
    [props.teams, observed.agents],
  );
  const stages = useMemo(
    () =>
      props.teams.flatMap((state) =>
        missionStages(state, missionWorkflowFor(state, props.packs || []), observed.agents),
      ),
    [props.teams, props.packs, observed.agents],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"map" | "list">(props.layout.compact ? "list" : "map");
  const chooseMode = useCallback((value: string) => setMode(value === "map" ? "map" : "list"), []);
  useEffect(() => setMode(props.layout.compact ? "list" : "map"), [props.layout.compact]);
  const [zoom, setZoom] = useState(100);
  const [fitKey, setFitKey] = useState(0);
  const [fallback, setFallback] = useState(Platform.OS !== "web");
  const [reason, setReason] = useState("");
  const container = useRef<View | null>(null);
  const renderer = useRef<OfficeRenderer | null>(null);
  const palette = useMemo<OfficePalette>(
    () => ({
      background: props.theme.colors.surface0,
      surface: props.theme.colors.surface1,
      foreground: props.theme.colors.foreground,
      muted: props.theme.colors.foregroundMuted,
      accent: props.theme.colors.accent,
      danger: props.theme.colors.statusDanger,
      border: props.theme.colors.border,
    }),
    [props.theme],
  );
  const unavailable = useCallback((value: string) => {
    setFallback(true);
    setReason(value);
  }, []);
  useEffect(() => {
    if (mode !== "map" || Platform.OS !== "web") return;
    const mounted = mountOffice(container.current, palette, setSelected, unavailable, setZoom);
    if (mounted.status === "unavailable") {
      unavailable(mounted.reason);
      return;
    }
    setFallback(false);
    setReason("");
    renderer.current = mounted.renderer;
    return () => {
      mounted.renderer.dispose();
      renderer.current = null;
    };
  }, [mode, palette, unavailable]);
  useEffect(
    () => renderer.current?.update(desks, selected, palette),
    [desks, selected, palette, mode],
  );
  const zoomBy = useCallback(
    (amount: number) => {
      const next = clampZoom(zoom + amount);
      setZoom(next);
      renderer.current?.zoomTo(next);
    },
    [zoom],
  );
  const fit = useCallback(() => {
    setZoom(100);
    setFitKey((value) => value + 1);
    renderer.current?.fit();
  }, []);
  const dismiss = useCallback(() => setSelected(null), []);
  useEffect(() => {
    if (
      selected?.startsWith("agent:") &&
      !desks.some((desk) => `agent:${desk.agentId}` === selected)
    )
      setSelected(null);
  }, [selected, desks]);
  const canvasStyle = useMemo(
    () => ({
      height: fallback ? 0 : canvasHeight(props.layout.compact, viewport.height),
      borderRadius: 14,
      overflow: "hidden" as const,
      backgroundColor: props.theme.colors.surface1,
    }),
    [props.layout.compact, props.theme, fallback, viewport.height],
  );
  const columns = useMemo(
    () => ({
      flexDirection: props.layout.compact ? ("column" as const) : ("row" as const),
      gap: 20,
      alignItems: "stretch" as const,
    }),
    [props.layout.compact],
  );
  const mapColumn = useMemo(() => ({ flex: 1, minWidth: 0, gap: 12 }), []);
  return (
    <View style={styles.stack}>
      <KitchenStory {...props} desks={desks} />
      <View style={styles.header}>
        <View style={styles.row}>
          <Action
            theme={props.theme}
            title={props.layout.compact ? "Stages" : "List"}
            value="list"
            onAction={chooseMode}
            selected={mode === "list"}
            compact={props.layout.compact}
          />
          <Action
            theme={props.theme}
            title="Map"
            value="map"
            onAction={chooseMode}
            selected={mode === "map"}
            compact={props.layout.compact}
          />
          {mode === "map" ? (
            <StationPicker {...props} desks={desks} selected={selected} onSelect={setSelected} />
          ) : null}
        </View>
        {mode === "map" ? (
          <View style={styles.row}>
            <Action
              theme={props.theme}
              title="−"
              accessibilityLabel="Zoom out"
              value={-10}
              onAction={zoomBy}
              disabled={zoom <= 60}
              compact={props.layout.compact}
            />
            <Text style={styles.text}>{zoom}%</Text>
            <Action
              theme={props.theme}
              title="+"
              accessibilityLabel="Zoom in"
              value={10}
              onAction={zoomBy}
              disabled={zoom >= 180}
              compact={props.layout.compact}
            />
            <Action
              theme={props.theme}
              title="Fit"
              value="fit"
              onAction={fit}
              compact={props.layout.compact}
            />
          </View>
        ) : null}
      </View>
      <View style={columns}>
        <View style={mapColumn}>
          {mode === "map" ? (
            <>
              {reason ? <Text style={styles.muted}>{reason}</Text> : null}
              {Platform.OS === "web" ? <View ref={container} style={canvasStyle} /> : null}
              {fallback ? (
                <NativeKitchenMap
                  {...props}
                  desks={desks}
                  selected={selected}
                  onSelect={setSelected}
                  zoom={zoom}
                  onZoom={setZoom}
                  fitKey={fitKey}
                  palette={palette}
                />
              ) : null}
            </>
          ) : (
            <StageList
              {...props}
              desks={desks}
              stages={stages}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </View>
        <KitchenInspector
          {...props}
          selected={selected}
          desks={desks}
          onSelect={setSelected}
          onDismiss={dismiss}
          errors={observed.errors}
        />
      </View>
    </View>
  );
}
function KitchenStory(props: OfficeProps & { desks: OfficeDesk[] }) {
  const styles = useFactoryStyles(props);
  const missions = props.teams.filter(
    (state) => state.team.status !== "done" && state.team.status !== "canceled",
  );
  const attention = props.desks.filter((desk) => desk.tone === "attention").length;
  let title = "Ready to cook";
  let description =
    "Start with a goal. Kitchen plans, builds and verifies the work with your team.";
  if (missions.length) {
    title = "In the Kitchen";
    description =
      "Follow your agents from planning to a verified result. Select a station to inspect the work.";
  }
  if (attention) {
    title = "Your team needs you";
    description = "Open an agent to answer its question and keep the mission moving.";
  }
  return (
    <View style={styles.header}>
      <View style={styles.roleInfo}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.muted}>{description}</Text>
      </View>
      {missions.length || props.desks.length ? (
        <View style={styles.row}>
          <Metric {...props} value={missions.length} label="Missions" />
          <Metric {...props} value={props.desks.length} label="Agents" />
          {attention ? <Metric {...props} value={attention} label="Needs you" /> : null}
        </View>
      ) : null}
    </View>
  );
}
function Metric(props: PluginSurfaceProps & { value: number; label: string }) {
  const styles = useFactoryStyles(props);
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>{props.value}</Text>
      <Text style={styles.muted}>{props.label}</Text>
    </View>
  );
}
function StageList(
  props: PluginSurfaceProps & {
    desks: OfficeDesk[];
    selected: string | null;
    onSelect(value: string): void;
    stages?: ReturnType<typeof missionStages>;
  },
) {
  return (
    <View>
      {kitchenStations.map((station) => (
        <StageRow key={station.id} {...props} station={station} />
      ))}
    </View>
  );
}
function StationPicker(props: Parameters<typeof StageList>[0]) {
  const styles = useFactoryStyles(props);
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<View>(null);
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => {
    setExpanded(false);
    (trigger.current as unknown as { focus?(): void } | null)?.focus?.();
  }, []);
  const { onSelect } = props;
  const select = useCallback(
    (value: string) => {
      onSelect(value);
      close();
    },
    [onSelect, close],
  );
  const station = kitchenStations.find((value) => `station:${value.id}` === props.selected);
  return (
    <>
      <Action
        theme={props.theme}
        title={station?.title || "Stations"}
        accessibilityLabel="Choose Kitchen station"
        value={null}
        onAction={open}
        compact={props.layout.compact}
        trailing="⌄"
        buttonRef={trigger}
      />
      {expanded ? (
        <SurfaceSheet {...props} title="Kitchen stations" onClose={close} narrow>
          <View style={styles.stack}>
            {kitchenStations.map((value) => (
              <Action
                key={value.id}
                theme={props.theme}
                title={value.title}
                accessibilityLabel={`Select station ${value.title}`}
                value={`station:${value.id}`}
                onAction={select}
                selected={props.selected === `station:${value.id}`}
                compact={props.layout.compact}
              />
            ))}
          </View>
        </SurfaceSheet>
      ) : null}
    </>
  );
}
function StageRow(
  props: Parameters<typeof StageList>[0] & { station: (typeof kitchenStations)[number] },
) {
  const { station, onSelect } = props;
  const styles = useFactoryStyles(props);
  const workers = props.desks.filter((desk) => desk.stationId === station.id);
  const saved =
    props.stages
      ?.filter(
        (stage) => stageForRole(stage.role, stage.phase, stage.board === "root") === station.id,
      )
      .map((stage) => stage.status) || [];
  const status = stageStatus(workers, saved);
  const select = useCallback(() => onSelect(`station:${station.id}`), [onSelect, station.id]);
  const rowStyle = useMemo(
    () => ({
      minHeight: 68,
      paddingVertical: 14,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderColor:
        props.selected === `station:${station.id}`
          ? props.theme.colors.accent
          : props.theme.colors.border,
      backgroundColor:
        props.selected === `station:${station.id}` ? props.theme.colors.surface1 : "transparent",
    }),
    [props.theme, props.selected, station.id],
  );
  return (
    <Pressable
      onPress={select}
      accessibilityRole="button"
      accessibilityLabel={`Stage ${station.title}, ${status}`}
      style={rowStyle}
    >
      <View style={styles.header}>
        <View style={styles.roleInfo}>
          <Text style={styles.heading}>{station.title}</Text>
          <Text style={styles.muted}>{station.purpose}</Text>
        </View>
        <Text style={styles.muted}>{status}</Text>
      </View>
      {workers.map((desk) => (
        <Text key={desk.id} style={styles.muted}>
          {desk.title} · {desk.provider}
        </Text>
      ))}
    </Pressable>
  );
}
function stageStatus(workers: OfficeDesk[], saved: MissionStageStatus[]) {
  if (workers.some((desk) => desk.tone === "attention")) return "Needs you";
  if (workers.some((desk) => desk.tone === "active")) return "Working";
  if (saved.includes("needs-you")) return "Needs you";
  if (saved.includes("problem")) return "Blocked";
  if (saved.includes("unobserved")) return "Activity unavailable";
  if (saved.length && saved.every((value) => ["completed", "skipped"].includes(value)))
    return saved.every((value) => value === "skipped") ? "Skipped" : "Completed";
  if (saved.includes("queued")) return "Queued";
  if (saved.length) return "Waiting";
  return workers.length ? "Waiting" : "No agent assigned";
}
function useOfficeAgents(props: OfficeProps) {
  const paseo = usePaseo();
  const [agents, setAgents] = useState<Record<string, OfficeAgentSnapshot>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const idsKey = JSON.stringify(officeAgentIds(props.teams));
  useEffect(() => {
    let active = true;
    const ids = JSON.parse(idsKey) as string[];
    setAgents({});
    setErrors({});
    const recordError = (id: string, error: unknown) => {
      if (active) setErrors((old) => ({ ...old, [id]: String(error) }));
    };
    const releases = ids.map((id) => {
      const agent = paseo.agents.ref(id);
      const observe = () => {
        if (!active) return;
        const value = agent.current();
        if (value) {
          setAgents((old) => ({ ...old, [id]: value }));
          setErrors((old) => {
            if (!old[id]) return old;
            const next = { ...old };
            delete next[id];
            return next;
          });
        }
      };
      const release = agent.subscribe(observe);
      observe();
      void agent
        .refresh()
        .then(observe)
        .catch((error: unknown) => {
          recordError(id, error);
        });
      return release;
    });
    return () => {
      active = false;
      for (const release of releases) release();
    };
  }, [paseo, props.host.id, idsKey]);
  return { agents, errors };
}

function canvasHeight(compact: boolean, viewportHeight: number) {
  return compact ? 420 : Math.max(320, Math.min(600, viewportHeight - 340));
}
