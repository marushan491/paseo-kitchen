import { beforeEach, expect, test, vi } from "vitest";
import { readSchedules, resolveScheduleTarget, scheduleControl } from "./schedules.js";

const fixture = vi.hoisted(() => ({
  calls: [] as { args: readonly string[]; env: NodeJS.ProcessEnv }[],
  heartbeat: false,
  completed: false,
}));

vi.mock("node:child_process", () => {
  const execFile = (
    _file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    fixture.calls.push({ args, env: options.env });
    const timestamp = "2026-10-02T10:00:00.000Z";
    const agentId = "12345678-1234-4234-8234-123456789012";
    const record = {
      id: "scheduled",
      name: "Nightly",
      prompt: "Check the project",
      cadence: { type: "every", everyMs: 60000 },
      target: fixture.heartbeat
        ? { type: "agent", agentId }
        : { type: "new-agent", config: { provider: "codex", cwd: "/fixture" } },
      status: fixture.completed ? "completed" : "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      nextRunAt: timestamp,
      lastRunAt: timestamp,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [
        {
          id: "run",
          scheduledFor: timestamp,
          startedAt: timestamp,
          endedAt: timestamp,
          status: "failed",
          agentId,
          workspaceId: "workspace",
          output: null,
          error: "Actual failed outcome",
        },
      ],
    };
    const operation = args[1];
    let output: unknown = record;
    if (operation === "ls") output = [{ id: record.id }];
    else if (operation === "pause") output = { id: record.id, status: "paused" };
    callback(null, JSON.stringify(output), "");
  };
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) =>
      new Promise((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
  });
  return { execFile };
});

const options = {
  daemonHome: "/fixture/home",
  cliExecutable: "paseo",
  cliArguments: [],
  scheduleHosts: [{ serverId: "remote", daemonHost: "ws://127.0.0.1:49123/ws" }],
};
beforeEach(() => {
  fixture.calls.length = 0;
  fixture.heartbeat = false;
  fixture.completed = false;
});

test("schedule outcomes and actions select exactly the configured host", async () => {
  const own = await readSchedules(resolveScheduleTarget(options, { kind: "local" }));
  const remote = await readSchedules(
    resolveScheduleTarget(options, { kind: "remote", serverId: "remote" }),
  );
  expect(own[0]?.lastRun?.error).toBe("Actual failed outcome");
  expect(remote[0]?.lastRun?.workspaceId).toBe("workspace");
  expect(fixture.calls[0]?.args).toContain("/fixture/home");
  expect(fixture.calls[2]?.args).toContain("tcp://127.0.0.1:49123");
  expect(fixture.calls[2]?.env.PASEO_PASSWORD).toBeUndefined();
  await scheduleControl(
    resolveScheduleTarget(options, { kind: "remote", serverId: "remote" }),
    "scheduled",
    "pause",
  );
  expect(fixture.calls.at(-1)?.args).toEqual([
    "schedule",
    "pause",
    "scheduled",
    "--host",
    "tcp://127.0.0.1:49123",
    "--json",
  ]);
});

test("unknown hosts are rejected before launching any CLI", () => {
  expect(() => resolveScheduleTarget(options, { kind: "remote", serverId: "unknown" })).toThrow(
    "no configured",
  );
  expect(() =>
    resolveScheduleTarget(options, { kind: "remote", serverId: "/fixture/home" }),
  ).toThrow("no configured");
  expect(fixture.calls).toHaveLength(0);
});

test("heartbeat failures remain visible but unsupported human controls never dispatch", async () => {
  fixture.heartbeat = true;
  expect((await readSchedules(options))[0]?.target.type).toBe("agent");
  await expect(scheduleControl(options, "scheduled", "pause")).rejects.toThrow("owning agent");
  expect(fixture.calls.map((call) => call.args[1])).toEqual(["ls", "inspect", "inspect"]);
});

test("completed schedules never dispatch a mutation", async () => {
  fixture.completed = true;
  await expect(scheduleControl(options, "scheduled", "run-once")).rejects.toThrow("completed");
  expect(fixture.calls.map((call) => call.args[1])).toEqual(["inspect"]);
});
