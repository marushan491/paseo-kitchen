import { z } from "zod";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export const KITCHEN_SUGGESTION_ID = "agent-factory.kitchen-suggestion";
export const KITCHEN_SUGGESTION_KIND = "kitchen-suggestion";
export const KitchenSuggestionSchema = z.object({
  source: z.literal("paseo-kitchen"),
  sourceAgentId: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(4000),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type KitchenSuggestion = z.infer<typeof KitchenSuggestionSchema>;

export function readKitchenSuggestion(
  items: readonly AgentTimelineItem[],
  sourceAgentId: string,
): KitchenSuggestion | null {
  for (const item of items.toReversed()) {
    if (
      item.type !== "plugin" ||
      item.id !== KITCHEN_SUGGESTION_ID ||
      item.kind !== KITCHEN_SUGGESTION_KIND ||
      item.version !== 1
    )
      continue;
    const parsed = KitchenSuggestionSchema.safeParse(item.data);
    if (parsed.success && parsed.data.sourceAgentId === sourceAgentId) return parsed.data;
  }
  return null;
}
