#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export const kitchenCommands = {
  list: "factory.list",
  status: "factory.status",
  start: "factory.kitchen.start",
  control: "factory.kitchen.control",
  report: "factory.report",
  plan: "factory.plan",
  "work-request": "factory.work.request",
  message: "factory.message",
  retry: "factory.retry",
  packs: "factory.packs",
  profiles: "factory.profiles.list",
  "save-profile": "factory.profiles.save",
  "configure-work": "factory.work.configure",
  schedules: "factory.schedule.list",
  "save-schedule": "factory.schedule.save",
  "control-schedule": "factory.schedule.control",
  "inspect-migration": "factory.migration.inspect",
  migrate: "factory.migration.import",
  improvements: "factory.improvements.list",
  "save-improvement": "factory.improvements.save",
  "scan-improvements": "factory.improvements.scan",
  publish: "factory.publish",
};
export function workerCommands(role) {
  return [
    "status",
    "report",
    ...(role === "po" ? ["plan"] : []),
    ...(["po", "developer", "reviewer", "integrator"].includes(role) ? ["work-request"] : []),
  ];
}
export async function createKitchenBridge(invoke, callerAgentId) {
  const resolve = async () => {
    if (!callerAgentId) return null;
    const result = await invoke("factory.list", {});
    for (const state of result.teams)
      for (const binding of Object.values(state.bindings))
        if (
          binding.agentId === callerAgentId &&
          binding.status === "active" &&
          !["done", "canceled"].includes(state.team.status)
        )
          return { teamId: state.team.id, role: binding.role };
    throw new Error("Kitchen MCP caller has no active managed binding");
  };
  return {
    async commands() {
      const caller = await resolve();
      return caller ? workerCommands(caller.role) : Object.keys(kitchenCommands);
    },
    async call(command, input) {
      if (!kitchenCommands[command]) throw new Error("Unknown Kitchen command");
      const caller = await resolve();
      if (caller) {
        if (!workerCommands(caller.role).includes(command))
          throw new Error("Command is unavailable to this Kitchen role");
        input = { ...input };
        if (command === "status") {
          if (input.teamId && input.teamId !== caller.teamId)
            throw new Error("Cannot inspect another mission through a role-bound bridge");
          input.teamId = caller.teamId;
        } else {
          if (input.agentId && input.agentId !== callerAgentId)
            throw new Error("Cannot impersonate another Kitchen binding");
          input.agentId = callerAgentId;
        }
      }
      return invoke(kitchenCommands[command], input);
    },
  };
}
async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      `Kitchen plugin CLI\nnode server/kitchen.mjs <${Object.keys(kitchenCommands).join("|")}> [--input JSON_FILE]\nSet KITCHEN_DAEMON_URL explicitly; PASEO_PASSWORD is read from the environment.\nWithout --input, request JSON is read from stdin. --mcp starts a stdio MCP server.\nKITCHEN_AGENT_ID selects a managed role scope; this is tool filtering, not an OS sandbox.\n`,
    );
    return;
  }
  const raw = process.env.KITCHEN_DAEMON_URL;
  if (!raw) throw new Error("Set KITCHEN_DAEMON_URL to the explicit daemon WebSocket endpoint");
  const endpoint = new URL(raw);
  if (
    !["ws:", "wss:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  )
    throw new Error("Kitchen requires a plain explicit ws/wss daemon endpoint");
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const client = new DaemonClient({
    url: endpoint.href,
    clientId: `kitchen-cli-${randomUUID()}`,
    clientType: "cli",
    appVersion: "0.11.0-beta.3",
    password: process.env.PASEO_PASSWORD,
    logger: silent,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    const bridge = await createKitchenBridge(
      (method, input) => client.invokePluginRpc("agent-factory", method, input),
      process.env.KITCHEN_AGENT_ID,
    );
    if (process.argv.includes("--mcp")) {
      const [
        { Server },
        { StdioServerTransport },
        { ListToolsRequestSchema, CallToolRequestSchema },
      ] = await Promise.all([
        import("@modelcontextprotocol/sdk/server/index.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js"),
        import("@modelcontextprotocol/sdk/types.js"),
      ]);
      const server = new Server(
        { name: "kitchen", version: "0.3.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (await bridge.commands()).map((command) => ({
          name: `kitchen_${command.replaceAll("-", "_")}`,
          description: `Kitchen ${command}. Input follows the installed plugin RPC contract.`,
          inputSchema: { type: "object", additionalProperties: true },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
          const command = request.params.name.replace(/^kitchen_/, "").replaceAll("_", "-");
          const result = await bridge.call(command, request.params.arguments ?? {});
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : "Kitchen request failed",
              },
            ],
          };
        }
      });
      await server.connect(new StdioServerTransport());
      await new Promise((resolve) => process.stdin.once("end", resolve));
      await server.close();
    } else {
      const index = process.argv.indexOf("--input");
      const rawInput =
        index >= 0
          ? await readFile(process.argv[index + 1], "utf8")
          : await new Promise((resolve, reject) => {
              let value = "";
              process.stdin.setEncoding("utf8");
              process.stdin.on("data", (chunk) => {
                value += chunk;
                if (value.length > 1024 * 1024) reject(new Error("Kitchen request exceeds 1MB"));
              });
              process.stdin.on("end", () => resolve(value));
              process.stdin.on("error", reject);
            });
      const result = await bridge.call(process.argv[2], JSON.parse(rawInput || "{}"));
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
  } finally {
    await client.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : "Kitchen failed") + "\n");
    process.exitCode = 1;
  });
