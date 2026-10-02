import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { StartKitchenSchema } from "./factory-contracts.js";

export const ImprovementRuleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1),
  enabled: z.boolean().default(false),
  sourcePackIds: z.array(z.string().min(1)).min(1),
  eventTypes: z.array(z.string().min(1)).min(1),
  minOccurrences: z.number().int().min(1).max(100),
  cooldownMs: z.number().int().min(60_000),
  maxRuns: z.number().int().min(1).max(10),
  target: StartKitchenSchema.omit({ idempotencyKey: true, scheduleId: true }),
});
export const ImprovementRunSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  sourceRefs: z.array(z.string()),
  at: z.string(),
  status: z.enum(["pending", "started", "failed"]),
  teamId: z.string().optional(),
  error: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  lastAttemptAt: z.string().optional(),
  target: StartKitchenSchema.omit({ idempotencyKey: true, scheduleId: true }).optional(),
});
export const factoryImprovementsList = defineRpc({
  name: "factory.improvements.list",
  input: z.object({}),
  output: z.object({ rules: z.array(ImprovementRuleSchema), runs: z.array(ImprovementRunSchema) }),
});
export const factoryImprovementsSave = defineRpc({
  name: "factory.improvements.save",
  input: z.object({ rule: ImprovementRuleSchema, actorId: z.string().min(1) }),
  output: ImprovementRuleSchema,
});
export const factoryImprovementsScan = defineRpc({
  name: "factory.improvements.scan",
  input: z.object({ actorId: z.string().min(1) }),
  output: z.object({ started: z.array(z.string()), errors: z.array(z.string()) }),
});
export type ImprovementRule = z.infer<typeof ImprovementRuleSchema>;
export type ImprovementRun = z.infer<typeof ImprovementRunSchema>;
