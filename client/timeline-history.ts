import type { PaseoAgentHandle } from "@getpaseo/client";

export type Page = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>;
export type Entry = Page["entries"][number];

export function mergeTimelineEntries(previous: readonly Entry[], incoming: readonly Entry[]) {
  const ranges = incoming.map((entry) => [entry.seqStart, entry.seqEnd]);
  return previous
    .filter(
      (entry) => !ranges.some(([start, end]) => entry.seqStart <= end && entry.seqEnd >= start),
    )
    .concat(incoming)
    .toSorted((left, right) => left.seqStart - right.seqStart);
}

export async function fetchTimelineWindow(
  refetch: PaseoAgentHandle["timeline"]["refetch"],
  knownEnd?: Page["endCursor"],
) {
  const tail = await refetch({ direction: "tail", limit: 100 });
  if (tail.error) throw new Error(tail.error);
  let page = tail;
  let entries = tail.entries;
  if (!knownEnd || knownEnd.epoch !== tail.epoch || tail.reset) return tail;
  while (page.hasOlder && page.startCursor && page.startCursor.seq > knownEnd.seq) {
    const before = await refetch({ direction: "before", cursor: page.startCursor, limit: 100 });
    if (before.error) throw new Error(before.error);
    if (before.epoch !== tail.epoch || before.reset || before.staleCursor) return before;
    if (before.startCursor && before.startCursor.seq >= page.startCursor.seq)
      throw new Error("Timeline history cursor did not advance. Reload the conversation.");
    entries = mergeTimelineEntries(before.entries, entries);
    page = before;
  }
  return { ...tail, entries, startCursor: page.startCursor, hasOlder: page.hasOlder };
}
