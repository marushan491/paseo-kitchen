import { parseConnectionUri } from "@getpaseo/protocol/daemon-endpoints";

export function normalizeDaemonHost(raw: string): string {
  if (!raw || raw.trim() !== raw || /\s/.test(raw) || raw.startsWith("-"))
    throw new Error("Use an explicit daemon endpoint");
  const url = new URL(raw.includes("://") ? raw : `ws://${raw}`);
  if (
    !["ws:", "wss:", "tcp:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    !["", "/", "/ws"].includes(url.pathname)
  )
    throw new Error("Use a plain TCP or WebSocket daemon endpoint without credentials");
  if (url.protocol !== "tcp:" && url.search)
    throw new Error("Daemon WebSocket endpoints cannot include query credentials");
  const normalized =
    url.protocol === "tcp:"
      ? raw
      : `tcp://${url.hostname}:${url.port || (url.protocol === "wss:" ? "443" : "80")}${url.protocol === "wss:" ? "?ssl=true" : ""}`;
  const parsed = parseConnectionUri(normalized);
  if (parsed.password) throw new Error("Do not store daemon credentials in Dashboard settings");
  return normalized;
}
