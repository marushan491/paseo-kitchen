import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { StoredScheduleSchema } from "@getpaseo/protocol/schedule/types";
import { z } from "zod";
import { normalizeDaemonHost } from "../../shared/dashboard/daemon-host.js";
import type { ScheduleSummary } from "../../shared/dashboard/schedules.js";

const execute = promisify(execFile);
export interface ScheduleOptions {
  daemonHome: string;
  daemonHost?: string;
  scheduleHosts?: { serverId: string; daemonHost: string }[];
  cliExecutable: string;
  cliArguments: string[];
}

async function command(options: ScheduleOptions, args: string[]): Promise<unknown> {
  let target: string[] | null = null;
  if (options.daemonHost) target = ["--host", normalizeDaemonHost(options.daemonHost)];
  else if (options.daemonHome && isAbsolute(options.daemonHome))
    target = ["--home", options.daemonHome];
  if (!target)
    throw new Error("Configure this host's absolute daemon home to include schedule outcomes");
  const environment = { ...process.env };
  if (options.daemonHost) delete environment.PASEO_PASSWORD;
  else {
    environment.PASEO_HOME = options.daemonHome;
    environment.PANDAOS_HOME = options.daemonHome;
  }
  const result = await execute(
    options.cliExecutable,
    [...options.cliArguments, "schedule", ...args, ...target, "--json"],
    {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env: environment,
    },
  );
  return JSON.parse(result.stdout);
}

export async function readSchedules(options: ScheduleOptions): Promise<ScheduleSummary[]> {
  const rows = z
    .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/) }))
    .max(500)
    .parse(await command(options, ["ls"]));
  let cursor = 0;
  const summaries: ScheduleSummary[] = [];
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const stored = StoredScheduleSchema.parse(await command(options, ["inspect", row!.id]));
      const { runs, ...summary } = stored;
      summaries.push({ ...summary, lastRun: runs.at(-1) ?? null });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
  return summaries.sort((left, right) => left.id.localeCompare(right.id));
}

export async function scheduleControl(
  options: ScheduleOptions,
  id: string,
  action: "pause" | "resume" | "run-once",
): Promise<void> {
  z.string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .parse(id);
  const record = StoredScheduleSchema.parse(await command(options, ["inspect", id]));
  if (record.status === "completed")
    throw new Error("This schedule has completed. Create a new schedule to run it again");
  if (record.target.type !== "new-agent")
    throw new Error("The public CLI permits heartbeat controls only from the owning agent");
  const result = z
    .object({ id: z.string(), status: z.string() })
    .parse(await command(options, [action, id]));
  if (
    result.id !== id ||
    (action === "pause" && result.status !== "paused") ||
    (action === "resume" && result.status !== "active" && result.status !== "blocked")
  )
    throw new Error("The selected schedule did not confirm the requested action");
}

export function resolveScheduleTarget(
  options: ScheduleOptions,
  target: { kind: "local" } | { kind: "remote"; serverId: string },
): ScheduleOptions {
  if (target.kind === "local") return { ...options, daemonHost: undefined };
  const configured = options.scheduleHosts?.find((host) => host.serverId === target.serverId);
  if (!configured) throw new Error("This schedule host has no configured public CLI target");
  return { ...options, daemonHome: "", daemonHost: normalizeDaemonHost(configured.daemonHost) };
}
