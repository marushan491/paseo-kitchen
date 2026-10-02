import { expect, it } from "vitest";
import { mergeTimelineEntries, type Entry } from "./timeline-history.js";

function entry(start: number, end: number, text: string): Entry {
  return {
    seqStart: start,
    seqEnd: end,
    provider: "codex",
    timestamp: "now",
    item: { type: "assistant_message", text },
    sourceSeqRanges: [{ startSeq: start, endSeq: end }],
    collapsed: [],
  };
}

it("replaces overlapping projections without dropping older paginated history", () => {
  const old = [entry(1, 1, "Earlier"), entry(20, 21, "Old partial"), entry(30, 30, "Later")];
  const next = mergeTimelineEntries(old, [entry(20, 25, "Completed")]);
  expect(next.map((row) => row.item)).toEqual([
    { type: "assistant_message", text: "Earlier" },
    { type: "assistant_message", text: "Completed" },
    { type: "assistant_message", text: "Later" },
  ]);
  expect(old[1].seqEnd).toBe(21);
});

it("adds earlier pages in sequence order", () => {
  expect(
    mergeTimelineEntries([entry(100, 100, "New")], [entry(10, 10, "Old")]).map(
      (row) => row.seqStart,
    ),
  ).toEqual([10, 100]);
});

it("catches up a burst spanning more than the tail page", async () => {
  const { fetchTimelineWindow } = await import("./timeline-history.js");
  const pages = [
    {
      epoch: "epoch",
      error: null,
      reset: false,
      hasOlder: true,
      startCursor: { epoch: "epoch", seq: 201 },
      entries: [entry(201, 201, "Latest")],
    },
    {
      epoch: "epoch",
      error: null,
      reset: false,
      hasOlder: true,
      startCursor: { epoch: "epoch", seq: 101 },
      entries: [entry(101, 101, "Middle")],
    },
    {
      epoch: "epoch",
      error: null,
      reset: false,
      hasOlder: false,
      startCursor: { epoch: "epoch", seq: 1 },
      entries: [entry(1, 1, "Earlier")],
    },
  ];
  const calls: string[] = [];
  const refetch = async (options?: { direction?: string }) => {
    calls.push(options?.direction || "tail");
    return pages.shift() as Awaited<ReturnType<Parameters<typeof fetchTimelineWindow>[0]>>;
  };
  const page = await fetchTimelineWindow(refetch, { epoch: "epoch", seq: 50 });
  expect(calls).toEqual(["tail", "before", "before"]);
  expect(page.entries.map((row) => row.seqStart)).toEqual([1, 101, 201]);
});
