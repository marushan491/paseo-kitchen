import type { PluginClientContext } from "@getpaseo/plugin/client";
import { expect, it, vi } from "vitest";
import { registerFactoryClient } from "./registration.js";

it("registers only supported contributions on a PandaOS 0.9 shaped client", () => {
  const cleanup = vi.fn();
  const old = {
    addSettingsScreen: vi.fn(() => cleanup),
    addWorkspacePanel: vi.fn(() => cleanup),
    addCommandCenterItem: vi.fn(() => cleanup),
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
  expect(old.addCommandCenterItem).toHaveBeenCalledTimes(2);
  stop();
  expect(cleanup).toHaveBeenCalledTimes(5);
});
