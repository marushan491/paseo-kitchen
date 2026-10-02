import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { TeamState } from "../shared/factory-contracts.js";
import {
  officeAgentIds,
  projectOffice,
  type OfficeAgentSnapshot,
  type OfficeDesk,
} from "./office-model.js";
import { mountOffice, type OfficePalette, type OfficeRenderer } from "./web.js";
import { Action, useFactoryStyles } from "./ui.js";
import { kitchenStations, clampZoom } from "./kitchen-stations.js";
import { KitchenInspector } from "./kitchen-inspector.js";
import { NativeKitchenMap } from "./kitchen-native-map.js";

export type OfficeProps = PluginSurfaceProps & {
  teams: TeamState[];
  onOpenTeam(teamId: string): void;
  onConfigureAgent?(agentId: string): void;
  onNewMission?(): void;
};
export function Office(props: OfficeProps) {
  const styles = useFactoryStyles(props);
  const observed = useOfficeAgents(props);
  const desks = useMemo(
    () => projectOffice(props.teams, observed.agents),
    [props.teams, observed.agents],
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
      height: fallback ? 0 : canvasHeight(props.layout.compact),
      borderRadius: 14,
      overflow: "hidden" as const,
      backgroundColor: props.theme.colors.surface1,
    }),
    [props.layout.compact, props.theme, fallback],
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
      <View style={styles.row}>
        <Action
          theme={props.theme}
          title={props.layout.compact ? "Stages" : "List"}
          value="list"
          onAction={chooseMode}
          selected={mode === "list"}
        />
        <Action
          theme={props.theme}
          title="Map"
          value="map"
          onAction={chooseMode}
          selected={mode === "map"}
        />
      </View>
      <View style={columns}>
        <View style={mapColumn}>
          {mode === "map" ? (
            <>
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
              <View style={styles.row}>
                <Action
                  theme={props.theme}
                  title="Zoom out"
                  accessibilityLabel="Zoom out"
                  value={-10}
                  onAction={zoomBy}
                  disabled={zoom <= 60}
                />
                <Text style={styles.text}>{zoom}%</Text>
                <Action
                  theme={props.theme}
                  title="Zoom in"
                  accessibilityLabel="Zoom in"
                  value={10}
                  onAction={zoomBy}
                  disabled={zoom >= 180}
                />
                <Action theme={props.theme} title="Fit" value="fit" onAction={fit} />
                <Action
                  theme={props.theme}
                  title={props.layout.compact ? "Stages" : "List"}
                  value="list"
                  onAction={chooseMode}
                />
              </View>
              {reason ? <Text style={styles.muted}>{reason}</Text> : null}
              <StationShortcuts
                {...props}
                desks={desks}
                selected={selected}
                onSelect={setSelected}
              />
            </>
          ) : (
            <StageList {...props} desks={desks} selected={selected} onSelect={setSelected} />
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
  return (
    <View style={styles.header}>
      <View style={styles.roleInfo}>
        <Text style={styles.title}>Ready to cook</Text>
        <Text style={styles.muted}>
          Give Kitchen an outcome. It plans the work, assigns the right agents and verifies the
          result—then brings decisions back to you.
        </Text>
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
function StationShortcuts(props: Parameters<typeof StageList>[0]) {
  const styles = useFactoryStyles(props);
  return (
    <View style={styles.row}>
      {kitchenStations.map((station) => (
        <Action
          key={station.id}
          theme={props.theme}
          title={station.title}
          accessibilityLabel={`Select station ${station.title}`}
          value={`station:${station.id}`}
          onAction={props.onSelect}
          selected={props.selected === `station:${station.id}`}
        />
      ))}
    </View>
  );
}
function StageRow(
  props: Parameters<typeof StageList>[0] & { station: (typeof kitchenStations)[number] },
) {
  const { station, onSelect } = props;
  const styles = useFactoryStyles(props);
  const workers = props.desks.filter((desk) => desk.stationId === station.id);
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
      accessibilityLabel={`Stage ${station.title}, ${stageStatus(workers)}`}
      style={rowStyle}
    >
      <View style={styles.header}>
        <View style={styles.roleInfo}>
          <Text style={styles.heading}>{station.title}</Text>
          <Text style={styles.muted}>{station.purpose}</Text>
        </View>
        <Text style={styles.muted}>{stageStatus(workers)}</Text>
      </View>
      {workers.map((desk) => (
        <Text key={desk.id} style={styles.muted}>
          {desk.title} · {desk.provider}
        </Text>
      ))}
    </Pressable>
  );
}
function stageStatus(workers: OfficeDesk[]) {
  if (workers.some((desk) => desk.tone === "attention")) return "Needs you";
  if (workers.some((desk) => desk.tone === "active")) return "Working";
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

function canvasHeight(compact: boolean) {
  return compact ? 420 : 580;
}
