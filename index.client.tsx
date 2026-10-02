import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { FactorySettings } from "./client/settings.js";
import { Factory } from "./client/factory.js";
import { Action } from "./client/ui.js";
import { registerFactoryClient } from "./client/registration.js";

function FactoryItem({ theme, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "factory" }), [openScreen]);
  return <Action theme={theme} title="Kitchen" value="open" onAction={open} />;
}

export default function contribute(client: PluginClientContext) {
  return registerFactoryClient(client, {
    Factory,
    Settings: FactorySettings,
    Sidebar: FactoryItem,
  });
}
