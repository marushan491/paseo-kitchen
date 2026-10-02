import { expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { readDirectory } from "./directory.js";

it("fetches only Kitchen members and their workspaces, skips removed historical Cooks and retains real host failures", async () => {
  const agents = vi.fn(async (id: string) => {
    if (id === "removed") throw new Error("Agent not found: removed");
    if (id === "unreachable") throw new Error("Host unavailable");
    return { agent: { id, workspaceId: "kitchen-workspace" } };
  });
  const workspaces = vi.fn(async (id: string) => ({ id }));
  const list = vi.fn(() => {
    throw new Error("Must not enumerate ordinary sessions");
  });
  const api = {
    agents: { list, ref: (id: string) => ({ refresh: () => agents(id) }) },
    workspaces: { list, ref: (id: string) => ({ refresh: () => workspaces(id) }) },
  } as unknown as PaseoApi;
  const result = await readDirectory(api, ["head-chef", "cook", "removed"]);
  expect(result.agents.map((agent) => agent.id)).toEqual(["head-chef", "cook"]);
  expect(workspaces.mock.calls).toEqual([["kitchen-workspace"]]);
  expect(list).not.toHaveBeenCalled();
  await expect(readDirectory(api, ["unreachable"])).rejects.toThrow("Host unavailable");
  await expect(readDirectory(api, [])).resolves.toEqual({
    agents: [],
    workspaces: [],
    complete: true,
  });
});
