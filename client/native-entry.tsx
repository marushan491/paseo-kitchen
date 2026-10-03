import type {
  PluginClientContext,
  PluginSurfaceProps,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { Text, View } from "react-native";
import {
  factoryNativePresets,
  factoryNativeStart,
  NativeMissionSchema,
  KITCHEN_MISSION_KIND,
  type NativeStart,
  type NativeMission,
  type NativePresets,
} from "../shared/native-contracts.js";
import { factoryStatus } from "../shared/factory-contracts.js";
import { missionSummary } from "../shared/mission-stage.js";
import { Action, useFactoryStyles } from "./ui.js";
import { useMissionAgents } from "./mission-agents.js";
import { openFactorySurface } from "./registration.js";
import { startNativeWithReceiptRetry } from "./native-start.js";

interface NativeContribution {
  id: string;
  title: string;
  icon: string;
  placeholder: string;
  loadPresets(input: { cwd: string; projectId?: string }): Promise<NativePresets>;
  start(input: NativeStart): Promise<{ agentId: string }>;
  onManage(): void;
}
export type NativeNavigation = NonNullable<PluginSurfaceProps["navigation"]> & {
  openNewWorkspace?(input: {
    initialText?: string;
    executionId: string;
    cwd?: string;
    projectId?: string;
    presetId?: string;
    serverId?: string;
  }): void;
};
export function registerNativeExecution(client: PluginClientContext) {
  let removeExecution: (() => void) | undefined;
  if ("addExecutionMode" in client && typeof client.addExecutionMode === "function") {
    const add = client.addExecutionMode as (input: NativeContribution) => () => void;
    removeExecution = add({
      id: "kitchen",
      title: "Kitchen",
      icon: "ChefHat",
      placeholder: "Message Kitchen…",
      loadPresets: (input) => client.rpc(factoryNativePresets, input),
      start: (input) =>
        startNativeWithReceiptRetry((request) => client.rpc(factoryNativeStart, request), input),
      onManage: () => openFactorySurface(client, { section: "Team" }),
    });
  }
  function Mission(props: PluginTimelineItemProps<NativeMission>) {
    const open = useCallback(
      () => openFactorySurface(client, { teamId: props.item.data.teamId, section: "Missions" }),
      [props.item.data.teamId],
    );
    return <KitchenMissionCard {...props} onOpen={open} />;
  }
  const removeRenderer =
    typeof client.addTimelineRenderer === "function"
      ? client.addTimelineRenderer({
          kind: KITCHEN_MISSION_KIND,
          version: 1,
          schema: NativeMissionSchema,
          Component: Mission,
        })
      : undefined;
  return () => {
    removeRenderer?.();
    removeExecution?.();
  };
}
function KitchenMissionCard(props: PluginTimelineItemProps<NativeMission> & { onOpen(): void }) {
  const styles = useFactoryStyles(props);
  const read = useRpc(factoryStatus);
  const query = useQuery({
    queryKey: ["factory", "team", props.item.data.teamId],
    queryFn: () => read({ teamId: props.item.data.teamId }),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  const live = useMissionAgents(query.data?.state, props.host.id);
  const state = query.data?.state;
  const summary = state ? missionSummary(state, query.data?.workflow, live.agents) : null;
  const { onOpen } = props;
  const open = useCallback(() => onOpen(), [onOpen]);
  return (
    <View style={styles.card}>
      <Text style={styles.muted}>Kitchen mission · {props.item.data.presetTitle}</Text>
      {state ? <Text style={styles.heading}>{state.team.title}</Text> : null}
      {summary ? (
        <Text style={styles.text}>
          {summary.currentStage} — {summary.statusLabel}
        </Text>
      ) : null}
      {summary?.workingCount ? (
        <Text style={styles.muted}>{summary.workingCount} agents working</Text>
      ) : null}
      {query.error ? (
        <Text style={styles.danger}>Mission unavailable: {String(query.error)}</Text>
      ) : null}
      <View style={styles.row}>
        <Action
          theme={props.theme}
          title={
            state?.items[state.team.rootItemId]?.phase === "ready-for-human"
              ? "Review result"
              : "Open Kitchen"
          }
          value="open"
          onAction={open}
          variant="secondary"
        />
      </View>
    </View>
  );
}
