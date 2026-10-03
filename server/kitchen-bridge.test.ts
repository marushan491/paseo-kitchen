import { expect, it, vi } from "vitest";
import { createKitchenBridge } from "./kitchen.mjs";
import type { PaseoApi } from "@getpaseo/client";
import { resumeProviderQuestion } from "./question-hooks.js";

it("continues unanswered provider questions with guarded denial instead of choosing a human answer", async () => {
  const respondToPermission = vi.fn(async () => {});
  const agent = {
    refresh: async () => ({
      agent: { pendingPermissions: [{ id: "question-1", kind: "question" }] },
    }),
    respondToPermission,
  };
  const api = { agents: { ref: () => agent } } as unknown as PaseoApi;
  expect(await resumeProviderQuestion(api, "cook", "question-1", "Investigate further")).toBe(true);
  expect(respondToPermission).toHaveBeenCalledWith({
    requestId: "question-1",
    expectedNoInputStarted: true,
    response: { behavior: "deny", message: "Investigate further", interrupt: false },
  });
  respondToPermission.mockRejectedValueOnce(
    new Error("A user has started answering this question"),
  );
  expect(await resumeProviderQuestion(api, "cook", "question-1", "Investigate further")).toBe(
    false,
  );
  respondToPermission.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(
    resumeProviderQuestion(api, "cook", "question-1", "Investigate further"),
  ).rejects.toThrow("Disconnected");
});

it("leaves missing or already started provider questions untouched", async () => {
  const respondToPermission = vi.fn();
  const agent = {
    refresh: async () => ({
      agent: {
        pendingPermissions: [
          {
            id: "question-1",
            kind: "question",
            metadata: { responseStartedAt: "2026-10-03T12:00:00Z" },
          },
        ],
      },
    }),
    respondToPermission,
  };
  const api = { agents: { ref: () => agent } } as unknown as PaseoApi;
  expect(await resumeProviderQuestion(api, "cook", "question-1", "Investigate further")).toBe(
    false,
  );
  expect(await resumeProviderQuestion(api, "cook", "missing", "Investigate further")).toBe(false);
  expect(respondToPermission).not.toHaveBeenCalled();
});

it("filters role tools, binds mutations to the actual worker and rejects cross-mission impersonation", async () => {
  const invoke = vi.fn(async (method, input) =>
    method === "factory.list"
      ? {
          teams: [
            {
              team: { id: "team_current", status: "active" },
              bindings: { current: { agentId: "worker", status: "active", role: "verifier" } },
            },
          ],
        }
      : input,
  );
  const bridge = await createKitchenBridge(invoke, "worker");
  expect(await bridge.commands()).toEqual(["status", "report"]);
  await expect(bridge.call("start", {})).rejects.toThrow("unavailable");
  await expect(bridge.call("status", { teamId: "team_other" })).rejects.toThrow("another mission");
  await expect(bridge.call("report", { agentId: "other" })).rejects.toThrow("impersonate");
  expect(
    await bridge.call("report", { report: { outcome: "pass", summary: "Checked" } }),
  ).toMatchObject({ agentId: "worker" });
});
