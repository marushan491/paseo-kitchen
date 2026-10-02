import { describe, expect, it } from "vitest";
import { parseFactoryCompletion } from "./completion.js";

describe("Factory completion transport", () => {
  it("reads a split final assistant report with a PO plan", () => {
    const result = parseFactoryCompletion([
      { type: "user_message", text: "Plan" },
      {
        type: "assistant_message",
        text: '```factory-report\n{"report":{"outcome":"planned","summary":"One item"},',
      },
      {
        type: "assistant_message",
        text: '"items":[{"key":"A","title":"A","objective":"Do A","acceptanceCriteria":["Works"]}]}\n```',
      },
    ]);
    expect(result?.report.outcome).toBe("planned");
    expect(result?.items).toHaveLength(1);
  });
  it("ignores old-turn reports, tool outputs, and user examples", () => {
    expect(
      parseFactoryCompletion([
        {
          type: "assistant_message",
          text: '```factory-report\n{"report":{"outcome":"done","summary":"Old"}}\n```',
        },
        { type: "user_message", text: "Try again" },
        { type: "assistant_message", text: "No report yet" },
      ]),
    ).toBeNull();
  });
  it("rejects invalid and ambiguous completion blocks", () => {
    expect(() =>
      parseFactoryCompletion([
        {
          type: "assistant_message",
          text: '```factory-report\n{"report":{"outcome":"done"}}\n```',
        },
      ]),
    ).toThrow();
    expect(() =>
      parseFactoryCompletion([
        {
          type: "assistant_message",
          text: "```factory-report\n{}\n```\n```factory-report\n{}\n```",
        },
      ]),
    ).toThrow(/exactly one/);
  });
});
