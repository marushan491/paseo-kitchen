import { z } from "zod";

const routingNoticeSchema = z.object({
  status: z.enum(["waiting", "exhausted", "retrying", "selected", "unverified"]),
  reason: z.string(),
  resetsAt: z.string().nullable().optional(),
});
const snapshotSchema = z.object({ routingNotice: routingNoticeSchema.optional() });
export type AgentRoutingNotice = z.infer<typeof routingNoticeSchema>;

export function readAgentRoutingNotice(snapshot: unknown): AgentRoutingNotice | undefined {
  const parsed = snapshotSchema.safeParse(snapshot);
  return parsed.success ? parsed.data.routingNotice : undefined;
}
