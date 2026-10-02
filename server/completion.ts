import { ZodError } from "zod";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { FactoryCompletionSchema } from "../shared/factory-contracts.js";

export function parseFactoryCompletion(timeline: readonly AgentTimelineItem[]) {
  const parts: string[] = [];
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]!;
    if (item.type === "user_message") break;
    if (item.type === "assistant_message") parts.unshift(item.text);
  }
  const blocks = [...parts.join("").matchAll(/```factory-report\s*\n([\s\S]*?)\n```/g)];
  if (!blocks.length) return null;
  if (blocks.length !== 1) throw new Error("Return exactly one factory-report block");
  return FactoryCompletionSchema.parse(JSON.parse(blocks[0]![1]!));
}

export function factoryValidationFeedback(error: unknown): string {
  if (error instanceof ZodError)
    return error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
      .join("\n")
      .slice(0, 800);
  if (error instanceof SyntaxError) return "The factory-report block must contain valid JSON.";
  return (error instanceof Error ? error.message : "Invalid factory report").slice(0, 800);
}
