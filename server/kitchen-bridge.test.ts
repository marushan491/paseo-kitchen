import { expect, it, vi } from "vitest";
import { createKitchenBridge } from "./kitchen.mjs";

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
