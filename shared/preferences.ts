import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_AGENT_CAPACITY = 4;
export const AgentCapacitySchema = z.number().int().positive();

export const factorySettings = defineSettings({
  id: "factory",
  scope: "host",
  version: 1,
  schema: z.object({
    dataDirectory: z.string().default(""),
    daemonHost: z.string().default(""),
    daemonHome: z.string().default(""),
    cliExecutable: z.string().default("paseo"),
    cliArguments: z.array(z.string()).default([]),
    packDirectory: z.string().default(""),
    maxConcurrentAgents: AgentCapacitySchema.default(DEFAULT_AGENT_CAPACITY),
  }),
});
