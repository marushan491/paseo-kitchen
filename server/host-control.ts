import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";

const runFile = promisify(execFile);

export interface HostControl {
  preflight(): Promise<void>;
  cancel(id: string): Promise<void>;
  update(id: string, changes: { title?: string; labels?: Record<string, string> }): Promise<void>;
  moveToWorkspace(id: string, workspaceId: string): Promise<void>;
}

export interface HostControlOptions {
  daemonHome?: string;
  daemonHost?: string;
  executable?: string;
  argv?: string[];
}

function normalizeHost(raw: string): string {
  if (!raw || raw.trim() !== raw || /\s/.test(raw) || raw.startsWith("-"))
    throw new Error("Factory host control requires a valid explicit daemonHost endpoint");
  let endpoint: URL;
  try {
    endpoint = new URL(raw.includes("://") ? raw : `ws://${raw}`);
  } catch {
    throw new Error("Factory host control requires a valid explicit daemonHost endpoint");
  }
  if (
    !["ws:", "wss:", "tcp:"].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    (endpoint.protocol !== "tcp:" && endpoint.search) ||
    !["", "/", "/ws"].includes(endpoint.pathname)
  )
    throw new Error("Factory host control requires a valid explicit daemonHost endpoint");
  const address =
    endpoint.protocol === "tcp:"
      ? raw
      : `tcp://${endpoint.hostname}:${endpoint.port || (endpoint.protocol === "wss:" ? "443" : "80")}${endpoint.protocol === "wss:" ? "?ssl=true" : ""}`;
  return address;
}

export function createHostControl(paseo: PaseoApi, options: HostControlOptions = {}): HostControl {
  const home = options.daemonHome ?? process.env.PASEO_HOME;
  const executable = options.executable ?? "paseo";
  const prefix = [...(options.argv ?? [])];
  function targetArguments(): string[] {
    if (options.daemonHost !== undefined && options.daemonHome !== undefined)
      throw new Error("Factory host control requires either daemonHost or daemonHome, not both");
    let target: string[];
    if (options.daemonHost !== undefined) {
      target = ["--host", normalizeHost(options.daemonHost)];
    } else if (home && isAbsolute(home)) {
      target = ["--home", home];
    } else {
      throw new Error(
        "Factory host control requires an explicit absolute daemonHome or PASEO_HOME, or an explicit daemonHost",
      );
    }
    return target;
  }
  async function run(args: string[]): Promise<string> {
    const target = targetArguments();
    try {
      const result = await runFile(executable, [...prefix, ...args, ...target, "--json"], {
        env: options.daemonHost !== undefined ? process.env : { ...process.env, PASEO_HOME: home },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return result.stdout;
    } catch {
      throw new Error(`Factory host CLI ${args[1]} failed for the explicitly selected daemon`);
    }
  }
  async function assertAgent(id: string): Promise<PaseoAgent> {
    if (!id || id.startsWith("-")) throw new Error("Factory host control requires an agent ID");
    const sdk = await paseo.agents.ref(id).refresh();
    if (!sdk || sdk.agent.id !== id)
      throw new Error("Factory host agent is unavailable in the SDK");
    const cli: unknown = JSON.parse(await run(["agent", "inspect", id]));
    if (
      !cli ||
      typeof cli !== "object" ||
      !("Id" in cli) ||
      cli.Id !== sdk.agent.id ||
      !("Provider" in cli) ||
      cli.Provider !== sdk.agent.provider ||
      !("Cwd" in cli) ||
      cli.Cwd !== sdk.agent.cwd
    )
      throw new Error("Factory host CLI and SDK agent identity do not match; mutation refused");
    return sdk.agent;
  }
  return {
    async preflight() {
      targetArguments();
      try {
        await runFile(executable, [...prefix, "--version"], {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        });
      } catch {
        throw new Error(
          "Factory host CLI is unavailable; configure its executable and arguments before starting Kitchen",
        );
      }
    },
    async cancel(id) {
      const before = await assertAgent(id);
      const stdout = await run(["agent", "stop", id]);
      let output: unknown;
      try {
        output = JSON.parse(stdout);
      } catch {
        output = null;
      }
      const acknowledged = Boolean(
        output &&
        typeof output === "object" &&
        "stoppedCount" in output &&
        typeof output.stoppedCount === "number" &&
        output.stoppedCount > 0 &&
        "agentIds" in output &&
        Array.isArray(output.agentIds) &&
        output.agentIds.includes(id),
      );
      let stopped = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await setTimeout(100);
        const current = await paseo.agents.ref(id).refresh();
        if (!current)
          throw new Error("Factory host agent disappeared while confirming interruption");
        if (current.agent.status !== "running" && !current.agent.activeTurn) {
          stopped = true;
          break;
        }
      }
      if (!stopped || ((before.status === "running" || before.activeTurn) && !acknowledged))
        throw new Error("Factory host did not confirm interruption; the Cook may still be running");
    },
    async update(id, changes) {
      const args = ["agent", "update", id];
      if (changes.title !== undefined) {
        if (!changes.title.trim()) throw new Error("Factory host title must not be empty");
        args.push("--name", changes.title);
      }
      for (const [key, value] of Object.entries(changes.labels ?? {})) {
        if (
          !key ||
          /[,=]/.test(key) ||
          key.trim() !== key ||
          value.includes(",") ||
          value.trim() !== value
        )
          throw new Error("Factory host label cannot be represented by the CLI");
        args.push("--label", `${key}=${value}`);
      }
      if (args.length === 3) return;
      await assertAgent(id);
      await run(args);
    },
    async moveToWorkspace() {
      throw new Error(
        "Moving an existing agent to another workspace is not supported by the public Paseo SDK or CLI",
      );
    },
  };
}
