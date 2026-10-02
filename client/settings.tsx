import { useQuery } from "@tanstack/react-query";
import { factoryList } from "../shared/factory-contracts.js";
import {
  type PluginSurfaceProps,
  type SettingsState,
  useSettings,
  useRpc,
} from "@getpaseo/plugin/client";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  AgentCapacitySchema,
  DEFAULT_AGENT_CAPACITY,
  factorySettings,
} from "../shared/preferences.js";
import { Action, Field, Disclosure, useFactoryStyles } from "./ui.js";

function CapacityStatus(props: PluginSurfaceProps) {
  const styles = useFactoryStyles(props);
  const list = useRpc(factoryList);
  const query = useQuery({
    queryKey: ["factory", "capacity", props.host.id],
    queryFn: () => list({}),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  if (!query.data || query.isError)
    return (
      <Text style={styles.muted}>
        {query.isError ? "Runtime status unavailable" : "Loading runtime status…"}
      </Text>
    );
  const teams = query.data.teams.filter(
    (state) => state.team.status !== "done" && state.team.status !== "canceled",
  );
  const agents = new Set(
    teams.flatMap((state) =>
      Object.values(state.bindings)
        .filter((binding) => binding.status === "active" && binding.activeStartedAt)
        .map((binding) => binding.agentId || binding.decisionId),
    ),
  );
  const queued = teams
    .filter((state) => state.team.status === "active")
    .reduce(
      (total, state) =>
        total +
        Object.values(state.decisions).filter(
          (decision) =>
            (decision.kind === "start-role" || decision.kind === "message-role") &&
            (decision.status === "pending" || decision.status === "retry"),
        ).length,
      0,
    );
  return (
    <Text style={styles.muted}>
      Current runtime: {agents.size} occupied worker slots · {queued} queued starts or resumptions
    </Text>
  );
}

export function FactorySettings(props: PluginSurfaceProps) {
  const state = useSettings(factorySettings);
  const styles = useFactoryStyles(props);
  if (state.status !== "ready")
    return (
      <Text style={styles.muted}>
        {state.status === "loading" ? "Loading factory settings…" : state.error}
      </Text>
    );
  return <ReadySettings {...props} state={state} key={state.revision} />;
}

function ReadySettings(
  props: PluginSurfaceProps & {
    state: Extract<SettingsState<typeof factorySettings.schema>, { status: "ready" }>;
  },
) {
  const { state, theme } = props;
  const styles = useFactoryStyles(props);
  const [directory, setDirectory] = useState(state.values.dataDirectory);
  const [concurrency, setConcurrency] = useState(String(state.values.maxConcurrentAgents));
  const [daemonHost, setDaemonHost] = useState(state.values.daemonHost);
  const [daemonHome, setDaemonHome] = useState(state.values.daemonHome);
  const [cliExecutable, setCliExecutable] = useState(state.values.cliExecutable);
  const [cliArguments, setCliArguments] = useState(state.values.cliArguments.join("\n"));
  const [packDirectory, setPackDirectory] = useState(state.values.packDirectory);
  const count = Number(concurrency);
  const exclusiveTarget = !daemonHome.trim() || !daemonHost.trim();
  const valid = AgentCapacitySchema.safeParse(count).success && exclusiveTarget;
  const save = useCallback(() => {
    void state.save(
      {
        ...state.values,
        dataDirectory: directory.trim(),
        daemonHost: daemonHost.trim(),
        daemonHome: daemonHome.trim(),
        cliExecutable: cliExecutable.trim(),
        cliArguments: cliArguments.split("\n").filter(Boolean),
        packDirectory: packDirectory.trim(),
        maxConcurrentAgents: count,
      },
      state.revision,
    );
  }, [state, directory, count, daemonHost, daemonHome, cliExecutable, cliArguments, packDirectory]);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Kitchen settings</Text>
      <Text style={styles.muted}>
        Capacity controls simultaneous agents on this host. It does not limit how much work a
        mission can finish.
      </Text>
      <View style={styles.card}>
        <Text style={styles.heading}>Capacity</Text>
        <Text style={styles.muted}>Saved maximum: {state.values.maxConcurrentAgents} agents</Text>
        <CapacityStatus {...props} />
        <Field
          theme={theme}
          label="Maximum concurrent agents"
          value={concurrency}
          onChange={setConcurrency}
          {...{ keyboardType: "numeric" as const }}
        />
        <Text style={styles.muted}>
          Additional work stays in the queue when every configured slot is occupied.
        </Text>
      </View>
      {count > DEFAULT_AGENT_CAPACITY ? (
        <Text style={styles.muted}>
          Higher concurrency can consume provider quota and host resources quickly.
        </Text>
      ) : null}
      <Disclosure
        theme={theme}
        title="Advanced"
        summary="Host connection, storage and external workflow packs"
      >
        <Disclosure
          theme={theme}
          title="Host connection"
          summary={
            daemonHome || daemonHost || "Set up the public host CLI before starting a mission"
          }
        >
          <Text style={styles.muted}>
            Use the host daemon home or WebSocket address. Reload the plugin after changing
            connection settings.
          </Text>
          <Field theme={theme} label="Daemon home" value={daemonHome} onChange={setDaemonHome} />
          <Field
            theme={theme}
            label="Daemon WebSocket address · alternative"
            value={daemonHost}
            onChange={setDaemonHost}
          />
          <Field
            theme={theme}
            label="CLI executable"
            value={cliExecutable}
            onChange={setCliExecutable}
          />
          <Disclosure theme={theme} title="CLI launcher arguments" summary="Usually empty">
            <Field
              theme={theme}
              label="CLI arguments · one argument per line"
              value={cliArguments}
              onChange={setCliArguments}
              multiline
            />
          </Disclosure>
        </Disclosure>
        <Disclosure
          theme={theme}
          title="Storage & external workflow packs"
          summary="Use the host's plugin storage and built-in packs by default"
        >
          <Field theme={theme} label="Data directory" value={directory} onChange={setDirectory} />
          <Text style={styles.muted}>
            Leave empty if the host supplies isolated plugin storage. Otherwise use an absolute
            directory outside your project. Reload after changing it.
          </Text>
          <Field
            theme={theme}
            label="Additional workflow pack directory"
            value={packDirectory}
            onChange={setPackDirectory}
          />
        </Disclosure>
      </Disclosure>
      {!valid ? (
        <Text style={styles.danger}>
          Use a positive safe integer and only one CLI target: daemon home or WebSocket address.
        </Text>
      ) : null}
      {state.saveError ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {state.saveError}
        </Text>
      ) : null}
      <Action
        theme={theme}
        title={state.saving ? "Saving…" : "Save Kitchen settings"}
        value="save"
        onAction={save}
        disabled={state.saving || !valid || !cliExecutable.trim()}
      />
    </ScrollView>
  );
}
