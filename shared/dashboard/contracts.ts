import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { ScheduleSummarySchema } from "./schedules.js";
import { z } from "zod";

export const scheduleHostSchema = z.object({
  serverId: z.string().min(1),
  daemonHost: z.string().min(1),
});

export const dashboardSettings = defineSettings({
  id: "dashboard",
  scope: "host",
  version: 1,
  schema: z.object({
    dataDirectory: z.string().default(""),
    daemonHome: z.string().default(""),
    cliExecutable: z.string().default("paseo"),
    cliArguments: z.array(z.string()).default([]),
    jiraSite: z.string().default(""),
    scheduleHosts: z.array(scheduleHostSchema).default([]),
  }),
});

export const preferencesSchema = z.object({
  snoozedUntil: z.record(z.string(), z.number()),
  doneAt: z.record(z.string(), z.string().nullable()),
});

export type Preferences = z.infer<typeof preferencesSchema>;

export const scheduleTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({ kind: z.literal("remote"), serverId: z.string().min(1) }),
]);

export const dashboardSnapshot = defineRpc({
  name: "dashboard.snapshot",
  input: z.object({}),
  output: z.object({
    preferences: preferencesSchema,
    schedules: z.array(z.object({ target: scheduleTargetSchema, schedule: ScheduleSummarySchema })),
    scheduleErrors: z.array(z.object({ target: scheduleTargetSchema, message: z.string() })),
    scheduleTargets: z.array(scheduleTargetSchema),
  }),
});

export const dashboardPreference = defineRpc({
  name: "dashboard.preference",
  input: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("snooze"),
      itemId: z.string().min(1),
      untilMs: z.number().finite(),
    }),
    z.object({ action: z.literal("done"), workspaceKey: z.string().min(1), done: z.boolean() }),
    z.object({ action: z.literal("import"), preferences: preferencesSchema }),
  ]),
  output: preferencesSchema,
});

export const dashboardSchedule = defineRpc({
  name: "dashboard.schedule",
  input: z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    target: scheduleTargetSchema,
    action: z.enum(["pause", "resume", "run-once"]),
  }),
  output: z.object({ accepted: z.literal(true) }),
});
