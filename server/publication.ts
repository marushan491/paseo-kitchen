import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Team } from "./types.js";

const execute = promisify(execFile);
export interface PublicationCli {
  executable: string;
  argv?: string[];
}
export type PublicationRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => Promise<string>;
export const publicationRunner: PublicationRunner = async (executable, args, cwd) => {
  const environment = { ...process.env };
  delete environment.KITCHEN_OPERATOR_CREDENTIAL;
  const result = await execute(executable, args, {
    cwd,
    env: environment,
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
};
export async function publishCandidate(
  cwd: string,
  commit: string,
  request: NonNullable<NonNullable<Team["kitchen"]>["publication"]>,
  cli: PublicationCli,
  run: PublicationRunner = publicationRunner,
): Promise<string> {
  if (!request.enabled)
    throw new Error("PR publication has not been explicitly enabled for this mission");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.remote))
    throw new Error("Publication remote must be a named Git remote");
  await run("git", ["check-ref-format", `refs/heads/${request.branch}`], cwd);
  await run("git", ["check-ref-format", `refs/heads/${request.baseBranch}`], cwd);
  const remote = await run("git", ["remote", "get-url", request.remote], cwd);
  const repo = publicationRepository(remote);
  const prefix = cli.argv ?? [];
  const rows: unknown = JSON.parse(
    await run(
      cli.executable,
      [
        ...prefix,
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        request.branch,
        "--state",
        "all",
        "--json",
        "url,headRefOid",
      ],
      cwd,
    ),
  );
  if (!Array.isArray(rows)) throw new Error("Publication CLI returned invalid PR listing");
  const existing = rows.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      entry.headRefOid === commit &&
      typeof entry.url === "string",
  );
  if (existing) return publicationUrl(existing.url, repo);
  await run("git", ["push", request.remote, `${commit}:refs/heads/${request.branch}`], cwd);
  const url = await run(
    cli.executable,
    [
      ...prefix,
      "pr",
      "create",
      "--repo",
      repo,
      "--head",
      request.branch,
      "--base",
      request.baseBranch,
      "--title",
      request.title ?? `Kitchen verified ${commit.slice(0, 12)}`,
      "--body",
      `Verified Kitchen candidate: ${commit}. Human approval recorded before publication.`,
    ],
    cwd,
  );
  return publicationUrl(url, repo);
}
function publicationRepository(remote: string): string {
  const ssh = /^(?:[^@]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
    remote.trim(),
  );
  if (ssh) return `${ssh[1]}/${ssh[2]}/${ssh[3]}`;
  const parsed = new URL(remote.trim());
  if (
    !["https:", "ssh:"].includes(parsed.protocol) ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Publication remote URL is unsupported");
  const path = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path))
    throw new Error("Publication remote must identify a repository");
  return `${parsed.hostname}/${path}`;
}
function publicationUrl(value: string, repo: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.host !== repo.split("/")[0] ||
    !url.pathname.startsWith(`/${repo.split("/").slice(1).join("/")}/pull/`)
  )
    throw new Error("Publication CLI returned a URL outside the selected repository");
  return url.toString();
}
