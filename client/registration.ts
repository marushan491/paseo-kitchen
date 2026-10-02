import type {
  PluginClientContext,
  PluginSidebarItemProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import type { FunctionComponent } from "react";

export function registerFactoryClient(
  client: PluginClientContext,
  components: {
    Factory: FunctionComponent<PluginSurfaceProps>;
    Settings: FunctionComponent<PluginSurfaceProps>;
    Sidebar: FunctionComponent<PluginSidebarItemProps>;
  },
) {
  const cleanup = [
    client.addSettingsScreen({
      id: "factory",
      title: "Kitchen Studio",
      icon: "Workflow",
      Component: components.Settings,
    }),
    client.addWorkspacePanel({
      id: "factory",
      title: "Kitchen Studio",
      icon: "Workflow",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: components.Factory,
    }),
    client.addWorkspacePanel({
      id: "factory-agent",
      title: "Kitchen Studio",
      icon: "Workflow",
      context: "agent",
      locations: ["workspace", "explorer"],
      Component: components.Factory,
    }),
    client.addCommandCenterItem({
      id: "handoff-kitchen",
      title: "Hand off to Kitchen",
      icon: "Workflow",
      context: "agent",
      onSelect: ({ openPanel }) => openPanel("factory-agent"),
    }),
    client.addCommandCenterItem({
      id: "workspace-factory",
      title: "Open Kitchen",
      icon: "Workflow",
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel("factory"),
    }),
  ];
  if (typeof client.addScreen === "function" && typeof client.addSidebarHeaderItem === "function") {
    cleanup.push(
      client.addScreen({ id: "factory", title: "Kitchen Studio", Component: components.Factory }),
    );
    cleanup.push(
      client.addSidebarHeaderItem({
        id: "factory",
        title: "Kitchen Studio",
        Component: components.Sidebar,
      }),
    );
    cleanup.push(
      client.addCommandCenterItem({
        id: "open-factory",
        title: "Open Kitchen overview",
        icon: "Workflow",
        context: "global",
        onSelect: ({ openScreen }) => openScreen({ screenId: "factory" }),
      }),
    );
  } else if (
    typeof client.addSurface === "function" &&
    typeof client.addSidebarItem === "function"
  ) {
    cleanup.push(client.addSurface("factory", components.Factory));
    cleanup.push(
      client.addSidebarItem({
        id: "factory",
        title: "Kitchen Studio",
        icon: "Workflow",
        surface: "factory",
      }),
    );
    cleanup.push(
      client.addCommandCenterItem({
        id: "open-factory",
        title: "Open Kitchen overview",
        icon: "Workflow",
        context: "global",
        onSelect: ({ openSurface }) => openSurface("factory"),
      }),
    );
  }
  return () => {
    for (const remove of cleanup.toReversed()) remove();
  };
}
