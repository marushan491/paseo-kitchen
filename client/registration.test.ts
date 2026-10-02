import type { PluginClientContext } from "@getpaseo/plugin/client";
import { expect, it, vi } from "vitest";
import { registerFactoryClient } from "./registration.js";

it("registers a global Kitchen surface on the actual PandaOS 0.9 client API", () => {
  const cleanup = vi.fn();
  const old = {
    addSettingsScreen: vi.fn(() => cleanup),
    addWorkspacePanel: vi.fn(() => cleanup),
    addCommandCenterItem: vi.fn(() => cleanup),
    addSurface: vi.fn(() => cleanup),
    addSidebarItem: vi.fn(() => cleanup),
  };
  const Component = () => null;
  const stop = registerFactoryClient(old as unknown as PluginClientContext, {
    Factory: Component,
    Settings: Component,
    Sidebar: Component,
  });
  expect(old.addWorkspacePanel.mock.calls[0][0]).toMatchObject({
    id: "factory",
    context: "workspace",
    locations: ["workspace", "explorer"],
  });
  expect(old.addCommandCenterItem.mock.calls[0][0].context).toBe("agent");
  expect(old.addCommandCenterItem.mock.calls[1][0].context).toBe("workspace");
  expect(old.addSurface).toHaveBeenCalledWith("factory", Component);
  expect(old.addSidebarItem).toHaveBeenCalledWith({
    id: "factory",
    title: "Kitchen",
    icon: "Workflow",
    surface: "factory",
  });
  expect(old.addCommandCenterItem).toHaveBeenCalledTimes(3);
  const global = old.addCommandCenterItem.mock.calls[2][0];
  expect(global).toMatchObject({ id: "open-factory", context: "global" });
  const openSurface = vi.fn();
  global.onSelect({ openSurface });
  expect(openSurface).toHaveBeenCalledWith("factory");
  stop();
  expect(cleanup).toHaveBeenCalledTimes(8);
});

it("prefers modern global registration when aliases are also available", () => {
  const cleanup = vi.fn();
  const modern = {
    addSettingsScreen: vi.fn(() => cleanup),
    addWorkspacePanel: vi.fn(() => cleanup),
    addCommandCenterItem: vi.fn(() => cleanup),
    addScreen: vi.fn(() => cleanup),
    addSidebarHeaderItem: vi.fn(() => cleanup),
    addSurface: vi.fn(() => cleanup),
    addSidebarItem: vi.fn(() => cleanup),
  };
  const Component = () => null;
  const stop = registerFactoryClient(modern as unknown as PluginClientContext, {
    Factory: Component,
    Settings: Component,
    Sidebar: Component,
  });
  expect(modern.addScreen).toHaveBeenCalledWith({
    id: "factory",
    title: "Kitchen",
    Component,
  });
  expect(modern.addSidebarHeaderItem).toHaveBeenCalledWith({
    id: "factory",
    title: "Kitchen",
    Component,
  });
  expect(modern.addSurface).not.toHaveBeenCalled();
  expect(modern.addSidebarItem).not.toHaveBeenCalled();
  const openScreen = vi.fn();
  modern.addCommandCenterItem.mock.calls[2][0].onSelect({ openScreen });
  expect(openScreen).toHaveBeenCalledWith({ screenId: "factory" });
  stop();
  expect(cleanup).toHaveBeenCalledTimes(8);
});

it("keeps workspace and agent panels when the host has no global contribution API", () => {
  const cleanup = vi.fn();
  const panelOnly = {
    addSettingsScreen: vi.fn(() => cleanup),
    addWorkspacePanel: vi.fn(() => cleanup),
    addCommandCenterItem: vi.fn(() => cleanup),
  };
  const Component = () => null;
  const stop = registerFactoryClient(panelOnly as unknown as PluginClientContext, {
    Factory: Component,
    Settings: Component,
    Sidebar: Component,
  });
  expect(panelOnly.addWorkspacePanel).toHaveBeenCalledTimes(2);
  expect(panelOnly.addCommandCenterItem).toHaveBeenCalledTimes(2);
  stop();
  expect(cleanup).toHaveBeenCalledTimes(5);
});
