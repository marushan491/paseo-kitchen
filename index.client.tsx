import type {
  PluginClientContext,
  PluginSidebarItemProps,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { Studio, StudioSettings } from "./client/studio.js";
import { Action } from "./client/ui.js";
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
  const removeFactory = registerFactoryClient(client, {
    Factory: Studio,
    Settings: StudioSettings,
    Sidebar: FactoryItem,
  });
  function Suggestion(props: PluginTimelineItemProps<KitchenSuggestion>) {
    const openKitchen = useCallback(
      (suggestion: KitchenSuggestion) =>
        client.openPanel("factory-agent", {
          workspaceId: suggestion.workspaceId,
          agentId: suggestion.sourceAgentId,
        }),
      [],
    );
    return <KitchenSuggestionCard {...props} openKitchen={openKitchen} />;
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
    removeSuggestion?.();
    removeFactory();
  };
}
