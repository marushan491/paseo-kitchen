import { expect, it, vi } from "vitest";
import { listFactoryAgents } from "./agents.js";

it("includes bosses beyond the first directory page and rejects repeated cursors", async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce({
      entries: [{ agent: { id: "first" } }],
      pageInfo: { nextCursor: "next" },
    })
    .mockResolvedValueOnce({
      entries: [{ agent: { id: "boss" } }],
      pageInfo: { nextCursor: null },
    });
  expect((await listFactoryAgents({ list })).entries.map((entry) => entry.agent.id)).toEqual([
    "first",
    "boss",
  ]);
  expect(list.mock.calls[1][0]).toEqual({ page: { limit: 200, cursor: "next" } });
  const stuck = vi.fn().mockResolvedValue({ entries: [], pageInfo: { nextCursor: "same" } });
  await expect(listFactoryAgents({ list: stuck })).rejects.toThrow("pagination did not advance");
});
