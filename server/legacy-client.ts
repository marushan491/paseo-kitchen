import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import {
  buildDaemonWebSocketUrl,
  parseConnectionUri,
  parseHostPort,
} from "@getpaseo/protocol/daemon-endpoints";
import type { HostControlOptions } from "./host-control.js";

const execute = promisify(execFile);

function webSocketEndpoint(raw: string): string {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/ws", ""].includes(url.pathname)
  )
    throw new Error("Kitchen legacy endpoint must be a plain daemon WebSocket address");
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  return buildDaemonWebSocketUrl(`${url.hostname}:${port}`, { useTls: url.protocol === "wss:" });
}

function endpointUrl(raw: string, local: boolean): string {
  if (!raw || raw.trim() !== raw || /\s/.test(raw))
    throw new Error("Kitchen legacy bootstrap requires a valid explicit daemon endpoint");
  if (raw.startsWith("ws://") || raw.startsWith("wss://")) return webSocketEndpoint(raw);
  const parts = raw.startsWith("tcp://")
    ? parseConnectionUri(raw)
    : { ...parseHostPort(raw), useTls: false };
  if ("password" in parts && parts.password)
    throw new Error("Kitchen legacy credentials must not be stored in the endpoint");
  let host = parts.host;
  if (local && host === "0.0.0.0") host = "127.0.0.1";
  if (local && host === "::") host = "::1";
  const address = parts.isIpv6 ? `[${host}]:${parts.port}` : `${host}:${parts.port}`;
  return buildDaemonWebSocketUrl(address, { useTls: parts.useTls });
}

async function endpointFromHome(options: HostControlOptions, home: string): Promise<string> {
  let status: unknown;
  try {
    const result = await execute(
      options.executable || "paseo",
      [...(options.argv || []), "daemon", "status", "--home", home, "--json"],
      {
        env: { ...process.env, PASEO_HOME: home },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    status = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      "Kitchen legacy bootstrap could not inspect the explicitly configured daemon home through its public CLI",
    );
  }
  if (
    !status ||
    typeof status !== "object" ||
    !("listen" in status) ||
    typeof status.listen !== "string" ||
    !("home" in status) ||
    typeof status.home !== "string"
  )
    throw new Error(
      "Kitchen legacy daemon status did not advertise its home and listening endpoint",
    );
  if ((await realpath(status.home)) !== (await realpath(home)))
    throw new Error("Kitchen legacy CLI status belongs to another daemon home");
  return endpointUrl(status.listen, true);
}

function localPassword(home: string | undefined, url: string): string | undefined {
  if (!home || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname))
    return undefined;
  const password = process.env.PASEO_PASSWORD?.trim();
  if (!password) return undefined;
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(password))
    throw new Error("Kitchen legacy PASEO_PASSWORD must support the public SDK bearer transport");
  return password;
}

export async function connectLegacyClient(options: HostControlOptions): Promise<PaseoClient> {
  const home = options.daemonHome?.trim();
  const host = options.daemonHost?.trim();
  if ((!home && !host) || (home && host))
    throw new Error(
      "Kitchen legacy bootstrap requires exactly one explicit daemon home or daemon endpoint",
    );
  if (home && !isAbsolute(home)) throw new Error("Kitchen legacy daemon home must be absolute");
  const url = home ? await endpointFromHome(options, home) : endpointUrl(host!, false);
  const password = localPassword(home, url);
  const client = createPaseoClient({
    url,
    password,
    clientId: `agent-factory-${randomUUID()}`,
    appVersion: "0.9.1",
    connectTimeoutMs: 15_000,
  });
  try {
    await client.connect();
    return client;
  } catch {
    await client.close().catch(() => {});
    throw new Error(
      "Kitchen legacy SDK connection failed for the explicitly selected daemon; verify its endpoint and provide PASEO_PASSWORD in the daemon environment if this legacy home requires authentication",
    );
  }
}
