import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { TeamState } from "../shared/factory-contracts.js";
import {
  officeAgentIds,
  officeToneColor,
  projectOffice,
  type OfficeAgentSnapshot,
  type OfficeDesk,
} from "./office-model.js";
import { mountOffice, type OfficePalette, type OfficeRenderer } from "./web.js";
import { Action, useFactoryStyles } from "./ui.js";

export type OfficeProps = PluginSurfaceProps & {
  teams: TeamState[];
  onOpenTeam(teamId: string): void;
  onConfigureAgent?(agentId: string): void;
  onNewMission?(): void;
};

export function Office(props: OfficeProps) {
  const { teams, theme, layout, navigation, host } = props;
  const styles = useFactoryStyles(props);
  const paseo = usePaseo();
  const [agents, setAgents] = useState<Record<string, OfficeAgentSnapshot>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rendererStatus, setRendererStatus] = useState("Preparing Kitchen…");
  const container = useRef<View | null>(null);
  const renderer = useRef<OfficeRenderer | null>(null);
  const idsKey = JSON.stringify(officeAgentIds(teams));
  const palette = useMemo<OfficePalette>(
    () => ({
      background: theme.colors.surface0,
      surface: theme.colors.surface1,
      foreground: theme.colors.foreground,
      muted: theme.colors.foregroundMuted,
      accent: theme.colors.accent,
      danger: theme.colors.statusDanger,
      border: theme.colors.border,
    }),
    [theme],
  );
  const canvasStyle = useMemo(
    () => ({
      height: layout.compact ? 320 : 460,
      borderRadius: 12,
      overflow: "hidden" as const,
      backgroundColor: theme.colors.surface1,
    }),
    [layout.compact, theme],
  );
  const desks = useMemo(() => projectOffice(teams, agents), [teams, agents]);
  const selected = desks.find((desk) => desk.id === selectedId);
  useEffect(() => {
    let active = true;
    const ids = JSON.parse(idsKey) as string[];
    setAgents({});
    setErrors({});
    const unsubscribes: (() => void)[] = [];
    for (const id of ids) {
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
      const unsubscribe = agent.subscribe(observe);
      observe();
      void agent
        .refresh()
        .then(observe)
        .catch((error: unknown) => {
          if (active) setErrors((old) => ({ ...old, [id]: String(error) }));
        });
      unsubscribes.push(unsubscribe);
    }
    return () => {
      active = false;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [paseo, host.id, idsKey]);
  useEffect(() => {
    if (Platform.OS !== "web") {
      setRendererStatus("Role view · native client");
      return;
    }
    const mounted = mountOffice(container.current, palette, setSelectedId, setRendererStatus);
    if (mounted.status === "unavailable") {
      setRendererStatus(mounted.reason);
      return;
    }
    renderer.current = mounted.renderer;
    setRendererStatus("Live Kitchen · select a station or agent");
    return () => {
      mounted.renderer.dispose();
      renderer.current = null;
    };
  }, [palette]);
  useEffect(() => {
    renderer.current?.update(desks, selectedId, palette);
  }, [desks, selectedId, palette]);
  const openAgent = useCallback(
    (id: string) => {
      navigation?.openAgent({ agentId: id, serverId: host.id });
    },
    [navigation, host.id],
  );
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <Text style={styles.title}>Kitchen</Text>
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {rendererStatus}
        </Text>
      </View>
      <Text style={styles.muted}>
        {desks.length} agents · {teams.length} missions ·{" "}
        {desks.filter((desk) => desk.tone === "active").length} active ·{" "}
        {desks.filter((desk) => desk.tone === "attention").length} need attention
      </Text>
      <Text style={styles.muted}>
        Select a chef to see its assignment, status and role instructions.
      </Text>
      {!desks.length && props.onNewMission ? (
        <View style={styles.row}>
          <Text style={styles.muted}>
            No agents assigned yet. The stations below are an empty Kitchen.
          </Text>
          <Action
            theme={theme}
            title="Create a mission"
            variant="primary"
            value="new"
            onAction={props.onNewMission}
          />
        </View>
      ) : null}
      {Platform.OS === "web" ? <View ref={container} style={canvasStyle} /> : null}
      {selected ? (
        <View style={styles.card}>
          <Text style={styles.heading}>{selected.title}</Text>
          <Text style={styles.muted}>
            {selected.role} · {selected.teamTitle}
          </Text>
          <Text style={styles.text}>
            {selected.workItem} · {selected.phase}
          </Text>
          <Text style={styles.text}>
            {selected.activity} · {selected.provider} · {selected.model || "Model not reported"}
          </Text>
          <Text style={styles.muted}>
            Agent {selected.agentId}
            {selected.bindingId ? ` · Binding ${selected.bindingId}` : ""}
          </Text>
          {errors[selected.agentId] ? (
            <Text style={styles.danger}>{errors[selected.agentId]}</Text>
          ) : null}
          <View style={styles.row}>
            <Action
              theme={theme}
              title="Open agent"
              value={selected.agentId}
              onAction={openAgent}
              disabled={!navigation}
            />
            <Action
              theme={theme}
              title="Open mission"
              value={selected.teamId}
              onAction={props.onOpenTeam}
            />
            {props.onConfigureAgent ? (
              <Action
                theme={theme}
                title="Configure agent"
                value={selected.agentId}
                onAction={props.onConfigureAgent}
              />
            ) : null}
          </View>
        </View>
      ) : null}
      {desks.length ? (
        <View style={styles.stack}>
          {[...new Set(desks.map((desk) => desk.role))].map((role) => (
            <View key={role} style={styles.stack}>
              <Text style={styles.heading}>{role}</Text>
              <View style={styles.row}>
                {desks
                  .filter((desk) => desk.role === role)
                  .map((desk) => (
                    <Desk
                      key={desk.id}
                      desk={desk}
                      selected={desk.id === selectedId}
                      palette={palette}
                      onSelect={setSelectedId}
                    />
                  ))}
              </View>
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.heading}>Your Kitchen is ready</Text>
          <Text style={styles.muted}>
            The empty stations show the layout. Agents appear here after you start a mission.
          </Text>
        </View>
      )}
    </View>
  );
}

function Desk({
  desk,
  selected,
  palette,
  onSelect,
}: {
  desk: OfficeDesk;
  selected: boolean;
  palette: OfficePalette;
  onSelect(id: string): void;
}) {
  const choose = useCallback(() => onSelect(desk.id), [onSelect, desk.id]);
  const color = officeToneColor(desk.tone, palette);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const style = useMemo(
    () => ({
      card: {
        padding: 14,
        gap: 6,
        minWidth: 190,
        maxWidth: 300,
        flexGrow: 1,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? palette.accent : palette.border,
        borderRadius: 10,
        backgroundColor: palette.surface,
      },
      title: { color: palette.foreground, fontWeight: "600" as const },
      activity: { color },
      muted: { color: palette.muted },
    }),
    [palette, color, selected],
  );
  return (
    <Pressable
      onPress={choose}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={`${desk.role}: ${desk.title}, ${desk.activity}, ${desk.teamTitle}`}
      style={style.card}
    >
      <Text style={style.title}>{desk.role}</Text>
      <Text numberOfLines={2} style={style.title}>
        {desk.title}
      </Text>
      <Text style={style.activity}>
        {desk.activity}
        {desk.observed ? "" : " · awaiting host snapshot"}
      </Text>
      <Text numberOfLines={2} style={style.muted}>
        {desk.teamTitle} · {desk.phase}
      </Text>
      <Text numberOfLines={1} style={style.muted}>
        {desk.provider} · {desk.model || "Model not reported"}
      </Text>
    </Pressable>
  );
}
