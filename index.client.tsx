import type {
  PluginClientContext,
  PluginSidebarItemProps,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { Studio, StudioSettings } from "./client/studio.js";
import { Action } from "./client/ui.js";
import { registerNativeExecution, type NativeNavigation } from "./client/native-entry.js";
import { registerFactoryClient } from "./client/registration.js";
import { KitchenSuggestionCard } from "./client/kitchen-suggestion.js";
import {
  KitchenSuggestionSchema,
  KITCHEN_SUGGESTION_KIND,
  type KitchenSuggestion,
} from "./shared/kitchen-suggestion.js";

function FactoryItem({ theme, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "factory" }), [openScreen]);
  return <Action theme={theme} title="Kitchen Studio" value="open" onAction={open} />;
}

export default function contribute(client: PluginClientContext) {
  const nativeClient = client as PluginClientContext & Pick<NativeNavigation, "openNewWorkspace">;
  const removeNative = registerNativeExecution(client);
  const removeFactory = registerFactoryClient(client, {
    Factory: Studio,
    Settings: StudioSettings,
    Sidebar: FactoryItem,
  });
  function Suggestion(props: PluginTimelineItemProps<KitchenSuggestion>) {
    const openKitchen = useCallback(
      (suggestion: KitchenSuggestion) =>
        nativeClient.openNewWorkspace?.({
          executionId: "kitchen",
          cwd: suggestion.cwd,
          initialText: suggestion.objective,
        }),
      [],
    );
    return (
      <KitchenSuggestionCard
        {...props}
        openKitchen={openKitchen}
        canOpen={typeof nativeClient.openNewWorkspace === "function"}
      />
    );
  }
  const removeSuggestion =
    typeof client.addTimelineRenderer === "function"
      ? client.addTimelineRenderer({
          kind: KITCHEN_SUGGESTION_KIND,
          version: 1,
          schema: KitchenSuggestionSchema,
          Component: Suggestion,
        })
      : undefined;
  return () => {
    removeNative();
    removeSuggestion?.();
    removeFactory();
  };
}
