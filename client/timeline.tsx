import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Action, Field, useFactoryStyles } from "./ui.js";

import {
  fetchTimelineWindow,
  mergeTimelineEntries,
  type Entry,
  type Page,
} from "./timeline-history.js";

function entryText(item: Entry["item"]): string {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "tool_call":
      return `${item.name} · ${item.status}\n${JSON.stringify(item.detail, null, 2)}${item.error ? `\n${String(item.error)}` : ""}`;
    case "todo":
      return item.items.map((task) => `${task.completed ? "✓" : "○"} ${task.text}`).join("\n");
    case "error":
    case "notification":
      return item.message;
    case "compaction":
      return `Context compaction · ${item.status}`;
    case "plugin":
      return `${item.kind}\n${JSON.stringify(item.data, null, 2)}`;
  }
}

export function AgentTimeline(
  props: PluginSurfaceProps & {
    agentId: string;
    canSend?: boolean;
    sendMessage?(text: string): Promise<void>;
  },
) {
  const { agentId, canSend = false, theme, sendMessage } = props;
  const styles = useFactoryStyles(props);
  const paseo = usePaseo();
  const [history, setHistory] = useState<{ page: Page; entries: Entry[] } | null>(null);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    let version = 0;
    let fetching = false;
    let queued = false;
    let resetQueued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const agent = paseo.agents.ref(agentId);
    setHistory(null);
    historyRef.current = null;
    setLoading(true);
    setError("");
    const refresh = async (reset: boolean) => {
      if (fetching) {
        queued = true;
        resetQueued ||= reset;
        if (reset) version += 1;
        return;
      }
      fetching = true;
      const request = ++version;
      try {
        const page = await fetchTimelineWindow(
          (options) => agent.timeline.refetch(options),
          reset ? undefined : historyRef.current?.page.endCursor,
        );
        if (!active || request !== version) return;
        if (page.error) throw new Error(page.error);
        setHistory((old) => {
          if (reset || !old || old.page.epoch !== page.epoch || page.reset || page.staleCursor)
            return { page, entries: page.entries };
          return {
            page: { ...page, startCursor: old.page.startCursor, hasOlder: old.page.hasOlder },
            entries: mergeTimelineEntries(old.entries, page.entries),
          };
        });
        setError("");
      } catch (cause) {
        if (active && request === version) setError(String(cause));
      } finally {
        if (active && request === version) setLoading(false);
        fetching = false;
        if (active && queued) {
          const nextReset = resetQueued;
          queued = false;
          resetQueued = false;
          void refresh(nextReset);
        }
      }
    };
    const unsubscribe = agent.timeline.subscribe(({ event }) => {
      if (!active) return;
      if (event.type === "error") {
        setError(event.error);
        return;
      }
      if (event.type === "replacement" || event.type === "subscription_restored") {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        void refresh(true);
      } else if (timer === undefined)
        timer = setTimeout(() => {
          timer = undefined;
          void refresh(false);
        }, 200);
    });
    void unsubscribe.ready
      .then(() => {
        if (active) return refresh(true);
        return undefined;
      })
      .catch((cause) => {
        if (active) {
          setError(String(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
      version += 1;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [paseo, agentId, generation]);
  const older = useCallback(async () => {
    if (!history?.page.startCursor || loading) return;
    const previous = history;
    setLoading(true);
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({
        direction: "before",
        cursor: previous.page.startCursor ?? undefined,
        limit: 100,
      });
      if (page.error) throw new Error(page.error);
      if (
        page.hasOlder &&
        page.startCursor &&
        page.startCursor.seq >= previous.page.startCursor!.seq
      )
        throw new Error("Timeline history cursor did not advance. Reload the conversation.");
      if (page.epoch !== previous.page.epoch || page.reset || page.staleCursor) {
        reload();
        return;
      }
      setHistory((current) =>
        current && current.page.epoch === page.epoch
          ? {
              page: { ...current.page, startCursor: page.startCursor, hasOlder: page.hasOlder },
              entries: mergeTimelineEntries(current.entries, page.entries),
            }
          : current,
      );
      setError("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, [history, loading, paseo, agentId, reload]);
  const send = useCallback(async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      if (sendMessage) await sendMessage(text.trim());
      else await paseo.agents.ref(agentId).send(text.trim(), { activeTurnBehavior: "steer" });
      setText("");
      setError("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSending(false);
    }
  }, [paseo, agentId, text, sending, sendMessage]);
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <Action theme={theme} title="Reload conversation" value="reload" onAction={reload} />
        {history?.page.hasOlder ? (
          <Action
            theme={theme}
            title="Load earlier messages"
            value="older"
            onAction={older}
            disabled={loading}
          />
        ) : null}
      </View>
      {loading ? <Text style={styles.muted}>Loading conversation…</Text> : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {error}
        </Text>
      ) : null}
      {history?.entries.map((entry) => (
        <View key={`${history.page.epoch}:${entry.seqStart}`} style={styles.card}>
          <Text style={styles.muted}>
            {entry.item.type.replaceAll("_", " ")} · {entry.timestamp}
          </Text>
          <Text selectable style={styles.text}>
            {entryText(entry.item)}
          </Text>
        </View>
      ))}
      {history && !loading && history.entries.length === 0 ? (
        <Text style={styles.muted}>No conversation yet.</Text>
      ) : null}
      {!canSend ? (
        <Text style={styles.muted}>
          Read-only conversation. Steer Cooks through the Team Agent.
        </Text>
      ) : (
        <View style={styles.stack}>
          <Field
            theme={theme}
            label="Message the Team Agent"
            value={text}
            onChange={setText}
            multiline
          />
          <Action
            theme={theme}
            title={sending ? "Sending…" : "Send to Team Agent"}
            value="send"
            onAction={send}
            disabled={sending || !text.trim()}
          />
        </View>
      )}
    </View>
  );
}
