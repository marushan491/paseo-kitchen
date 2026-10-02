import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { KitchenSuggestion } from "../shared/kitchen-suggestion.js";
import { Action } from "./ui.js";

export function KitchenSuggestionCard({
  item,
  theme,
  layout,
  openKitchen,
  canOpen,
}: PluginTimelineItemProps<KitchenSuggestion> & {
  openKitchen(suggestion: KitchenSuggestion): void;
  canOpen: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const open = useCallback(() => openKitchen(item.data), [openKitchen, item.data]);
  const dismiss = useCallback(() => setDismissed(true), []);
  const styles = useMemo(
    () => ({
      card: {
        gap: 10,
        padding: layout.compact ? 12 : 16,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      description: { color: theme.colors.foregroundMuted },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    }),
    [theme, layout.compact],
  );
  if (dismissed) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Want Kitchen to coordinate this project?</Text>
      <Text style={styles.description}>{item.data.reason}</Text>
      <Text style={styles.description}>
        {canOpen
          ? "Review the brief in the chat composer. Work starts when you send it."
          : "Update the host to start a Kitchen mission from this conversation."}
      </Text>
      <View style={styles.actions}>
        <Action
          theme={theme}
          title="Review Kitchen mission"
          value="open"
          onAction={open}
          disabled={!canOpen}
          variant="primary"
        />
        <Action theme={theme} title="Keep chatting" value="dismiss" onAction={dismiss} />
      </View>
    </View>
  );
}
