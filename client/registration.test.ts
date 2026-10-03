import { startNativeWithReceiptRetry } from "./native-start.js";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { expect, it, vi } from "vitest";
import { openFactorySurface, registerFactoryClient } from "./registration.js";

it("opens the same native mission on both supported navigation APIs", () => {
  const params = { teamId: "team_native", section: "Missions" };
  const openSurface = vi.fn();
  const openScreen = vi.fn();
  openFactorySurface({ openSurface, openScreen } as unknown as PluginClientContext, params);
  expect(openSurface).toHaveBeenCalledWith("factory", { params });
  expect(openScreen).not.toHaveBeenCalled();
  openFactorySurface({ openScreen } as unknown as PluginClientContext, params);
  expect(openScreen).toHaveBeenCalledWith({ screenId: "factory", params });
});

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
    title: "Kitchen Studio",
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
    title: "Kitchen Studio",
    Component,
  });
  expect(modern.addSidebarHeaderItem).toHaveBeenCalledWith({
    id: "factory",
    title: "Kitchen Studio",
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

it("recovers a slow native start receipt once without replacing the rich draft or idempotency key", async () => {
  const input = {
    workspaceId: "workspace",
    cwd: "/project",
    presetId: "kitchen",
    text: "Reviewed brief",
    images: [{ data: "image-bytes", mimeType: "image/png" }],
    attachments: [],
    idempotencyKey: "draft-key",
  };
  const receipt = { agentId: "existing-boss" };
  const start = vi
    .fn()
    .mockRejectedValueOnce(
      new Error(
        "Plugin RPC timed out: agent-factory.invoke requestType=plugin.rpc.invoke.request code=handler_error",
      ),
    )
    .mockResolvedValueOnce(receipt);
  await expect(startNativeWithReceiptRetry(start, input)).resolves.toBe(receipt);
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[0][0]).toBe(input);
  expect(start.mock.calls[1][0]).toBe(input);
});

it("does not repeat native starts for validation errors or repeat a second timeout", async () => {
  const input = {
    workspaceId: "workspace",
    cwd: "/project",
    presetId: "kitchen",
    text: "Brief",
    idempotencyKey: "draft-key",
  };
  const validation = new Error("Choose an available Kitchen team");
  const invalid = vi.fn().mockRejectedValue(validation);
  await expect(startNativeWithReceiptRetry(invalid, input)).rejects.toBe(validation);
  expect(invalid).toHaveBeenCalledTimes(1);
  const timeout = new Error("Plugin RPC timed out: agent-factory.invoke");
  const slow = vi.fn().mockRejectedValue(timeout);
  await expect(startNativeWithReceiptRetry(slow, input)).rejects.toBe(timeout);
  expect(slow).toHaveBeenCalledTimes(2);
});

it("does not replay a native start for another plugin timeout or a transport timeout", async () => {
  const input = {
    workspaceId: "workspace",
    cwd: "/project",
    presetId: "kitchen",
    text: "Brief",
    idempotencyKey: "draft-key",
  };
  for (const message of [
    "Plugin RPC timed out: other-plugin.invoke",
    "Request timed out: plugin.rpc.invoke.request",
  ]) {
    const error = new Error(message);
    const start = vi.fn().mockRejectedValue(error);
    await expect(startNativeWithReceiptRetry(start, input)).rejects.toBe(error);
    expect(start).toHaveBeenCalledTimes(1);
  }
});
