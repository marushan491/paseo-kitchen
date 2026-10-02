import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { kitchenStations } from "./kitchen-stations.js";
import type { OfficeDesk } from "./office-model.js";
import { Action, Disclosure, useFactoryStyles } from "./ui.js";

interface InspectorProps extends PluginSurfaceProps {
  selected: string | null;
  desks: readonly OfficeDesk[];
  onSelect(value: string): void;
  onDismiss(): void;
  onOpenTeam(id: string): void;
  onConfigureAgent?(id: string): void;
  errors: Record<string, string>;
}
export function KitchenInspector(props: InspectorProps) {
  const styles = useFactoryStyles(props);
  const desk = props.desks.find((value) => `agent:${value.agentId}` === props.selected);
  const station = kitchenStations.find(
    (value) => `station:${value.id}` === props.selected || value.id === desk?.stationId,
  );
  const assigned = props.desks.filter((value) => value.stationId === station?.id);
  const sheetStyle = useMemo(
    () => ({ flex: 1, justifyContent: "flex-end" as const, backgroundColor: "#00000066" }),
    [],
  );
  const panel = useMemo(
    () => ({
      maxHeight: "78%" as const,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 20,
      paddingBottom: 32,
      backgroundColor: props.theme.colors.surface1,
    }),
    [props.theme],
  );
  const inspectorStyle = useMemo(
    () => ({
      width: 300,
      padding: 18,
      gap: 12,
      borderWidth: 1,
      borderRadius: 14,
      borderColor: props.theme.colors.border,
      backgroundColor: props.theme.colors.surface1,
    }),
    [props.theme],
  );
  const body = (
    <View style={styles.stack}>
      <View style={styles.header}>
        <Text style={styles.heading}>{desk?.title || station?.title || "Kitchen inspector"}</Text>
        <Action
          theme={props.theme}
          title="Close inspector"
          value="close"
          onAction={props.onDismiss}
        />
      </View>
      {!station ? (
        <Text style={styles.muted}>Select a station or chef to inspect the work.</Text>
      ) : null}
      {station ? (
        <>
          <Text style={styles.text}>{station.description}</Text>
          {desk ? (
            <WorkerDetails {...props} desk={desk} />
          ) : (
            <>
              <Text style={styles.muted}>
                {assigned.length ? `${assigned.length} assigned` : "No agent assigned"}
              </Text>
              {!assigned.length ? <Text style={styles.muted}>{station.idle}</Text> : null}
              {assigned.map((worker) => (
                <WorkerSelect key={worker.agentId} {...props} desk={worker} />
              ))}
            </>
          )}
        </>
      ) : null}
    </View>
  );
  if (!props.layout.compact)
    return props.selected ? <View style={inspectorStyle}>{body}</View> : null;
  return (
    <Modal
      visible={Boolean(props.selected)}
      transparent
      animationType="slide"
      onRequestClose={props.onDismiss}
      accessibilityViewIsModal
    >
      <View style={sheetStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss inspector"
          onPress={props.onDismiss}
          style={backdrop}
        />
        <View style={panel}>
          <ScrollView>{body}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}
const backdrop = { flex: 1 };
function WorkerSelect(props: InspectorProps & { desk: OfficeDesk }) {
  const styles = useFactoryStyles(props);
  const { onSelect, desk } = props;
  const select = useCallback(() => onSelect(`agent:${desk.agentId}`), [onSelect, desk.agentId]);
  return (
    <View style={styles.stack}>
      <Action
        theme={props.theme}
        title={`${props.desk.title} · ${props.desk.activity}`}
        value="agent"
        onAction={select}
      />
      <Text style={styles.muted}>
        {props.desk.teamTitle} · {props.desk.workItem}
      </Text>
    </View>
  );
}
function WorkerDetails(props: InspectorProps & { desk: OfficeDesk }) {
  const styles = useFactoryStyles(props);
  const { desk, navigation, host, onOpenTeam, onConfigureAgent } = props;
  const open = useCallback(
    () => navigation?.openAgent({ agentId: desk.agentId, serverId: host.id }),
    [navigation, desk.agentId, host.id],
  );
  const mission = useCallback(() => onOpenTeam(desk.teamId), [onOpenTeam, desk.teamId]);
  const configure = useCallback(
    () => onConfigureAgent?.(desk.agentId),
    [onConfigureAgent, desk.agentId],
  );
  return (
    <View style={styles.stack}>
      <Text style={desk.tone === "attention" ? styles.danger : styles.text}>{desk.activity}</Text>
      <Text style={styles.muted}>Mission</Text>
      <Text style={styles.text}>{desk.teamTitle}</Text>
      <Text style={styles.muted}>Assignment</Text>
      <Text style={styles.text}>{desk.workItem}</Text>
      <Text style={styles.muted}>Agent</Text>
      <Text style={styles.text}>
        {desk.provider}
        {desk.model ? ` · ${desk.model}` : " · model not reported"}
      </Text>
      {typeof desk.elapsedMs === "number" ? (
        <Text style={styles.muted}>
          Active time: {Math.floor(desk.elapsedMs / 60000)}m{" "}
          {Math.floor(desk.elapsedMs / 1000) % 60}s
        </Text>
      ) : null}
      {desk.recentActivity ? (
        <Text style={styles.muted}>Recent activity: {desk.recentActivity}</Text>
      ) : null}
      {desk.instructions ? (
        <Text numberOfLines={4} style={styles.text}>
          {desk.instructions}
        </Text>
      ) : null}
      {props.errors[desk.agentId] ? (
        <Text style={styles.muted}>
          Live agent status unavailable; showing the saved assignment.
        </Text>
      ) : null}
      <View style={styles.row}>
        <Action
          theme={props.theme}
          title="Open agent"
          value="open"
          onAction={open}
          disabled={!navigation}
        />
        <Action theme={props.theme} title="Open mission" value="mission" onAction={mission} />
        {props.onConfigureAgent ? (
          <Action
            theme={props.theme}
            title="Configure role"
            value="configure"
            onAction={configure}
          />
        ) : null}
      </View>
      <Disclosure theme={props.theme} title="Technical details">
        <Text selectable style={styles.muted}>
          Agent: {desk.agentId}
        </Text>
        <Text style={styles.muted}>
          Role: {desk.role} · phase: {desk.phase}
        </Text>
        {desk.bindingId ? (
          <Text selectable style={styles.muted}>
            Assignment: {desk.bindingId}
          </Text>
        ) : null}
      </Disclosure>
    </View>
  );
}
