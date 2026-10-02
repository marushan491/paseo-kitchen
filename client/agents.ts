import type { PaseoApi } from "@getpaseo/client";

export async function listFactoryAgents(agents: Pick<PaseoApi["agents"], "list">) {
  const entries: Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await agents.list({ page: { limit: 200, cursor } });
    entries.push(...result.entries);
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error("Agent pagination did not advance");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { entries };
}
