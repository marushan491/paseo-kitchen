import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { factorySettings } from "../shared/preferences.js";
import { Action, Field, Disclosure, useFactoryStyles } from "./ui.js";

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
  const [concurrency, setConcurrency] = useState(
    String(Math.min(4, state.values.maxConcurrentAgents)),
  );
  const [daemonHost, setDaemonHost] = useState(state.values.daemonHost);
  const [daemonHome, setDaemonHome] = useState(state.values.daemonHome);
  const [cliExecutable, setCliExecutable] = useState(state.values.cliExecutable);
  const [cliArguments, setCliArguments] = useState(state.values.cliArguments.join("\n"));
  const [packDirectory, setPackDirectory] = useState(state.values.packDirectory);
  const count = Number(concurrency);
  const exclusiveTarget = !daemonHome.trim() || !daemonHost.trim();
  const valid = Number.isInteger(count) && count >= 1 && count <= 4 && exclusiveTarget;
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
        <Text style={styles.heading}>Parallel capacity</Text>
        <Field
          theme={theme}
          label="Concurrent Cooks · 1 to 4"
          value={concurrency}
          onChange={setConcurrency}
        />
        <Text style={styles.muted}>
          Four is the host runtime maximum. Additional work stays in the queue.
        </Text>
      </View>
      <Disclosure
        theme={theme}
        title="Host connection"
        defaultOpen={!daemonHome && !daemonHost}
        summary={daemonHome || daemonHost || "Set up the public host CLI before starting a mission"}
      >
        <Text style={styles.muted}>
          Use the host daemon home or WebSocket address. Reload the plugin after changing connection
          settings.
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
      {!valid ? (
        <Text style={styles.danger}>
          Use a whole number from 1 to 4 and only one CLI target: daemon home or WebSocket address.
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
