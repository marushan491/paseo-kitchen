import { StoredScheduleSchema, ScheduleRunSchema } from "@getpaseo/protocol/schedule/types";
import { z } from "zod";

export const ScheduleSummarySchema = StoredScheduleSchema.omit({ runs: true }).extend({
  lastRun: ScheduleRunSchema.omit({ output: true }).nullable().optional(),
  automationBlockedReason: z.string().nullable().optional(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;
