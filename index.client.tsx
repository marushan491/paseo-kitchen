import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { Studio, StudioSettings } from "./client/studio.js";
import { Action } from "./client/ui.js";
import { registerFactoryClient } from "./client/registration.js";

function FactoryItem({ theme, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "factory" }), [openScreen]);
  return <Action theme={theme} title="Kitchen Studio" value="open" onAction={open} />;
}

export default function contribute(client: PluginClientContext) {
  return registerFactoryClient(client, {
    Factory: Studio,
    Settings: StudioSettings,
    Sidebar: FactoryItem,
  });
}
