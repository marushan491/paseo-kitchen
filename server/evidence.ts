import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { EvidenceResult } from "../shared/factory-contracts.js";

const runFile = promisify(execFile);
export interface TrustedCheckCommand {
  executable: string;
  argv: readonly string[];
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}
interface CheckIdentity {
  id: string;
  criterionId?: string;
}
export type IndependentCheck = CheckIdentity &
  (
    | { kind: "command"; commandId: string }
    | { kind: "browser-artifact"; artifactPath: string; artifactSha256: string }
  );
export interface IndependentCheckOptions {
  commands: Readonly<Record<string, TrustedCheckCommand>>;
  checks: readonly IndependentCheck[];
  artifactRoot?: string;
  requireBrowserEvidence?: boolean;
  requireCriterionEvidence?: boolean;
  judge?: { id: string; commandId: string };
}
export interface ProtectedSnapshot {
  head: string;
  status: string;
  files: Record<string, string | null>;
}

export async function captureTrackedFiles(cwd: string): Promise<ProtectedSnapshot> {
  const root = await realpath(cwd);
  const [head, tracked, status] = await Promise.all([
    git(root, ["rev-parse", "--verify", "HEAD"]),
    git(root, ["ls-files", "-z"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  const files: ProtectedSnapshot["files"] = {};
  for (const name of tracked.split("\0").filter(Boolean).sort()) {
    const file = resolve(root, name);
    assertInside(root, file);
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink()) {
        files[name] = digest(`link:${await readlink(file)}`);
      } else {
        assertInside(root, await realpath(file));
        if (!info.isFile()) throw new Error("Protected tracked path is not a file");
        files[name] = digest(
          Buffer.concat([Buffer.from(`mode:${info.mode & 0o111}:`), await readFile(file)]),
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files[name] = null;
    }
  }
  return { head: head.trim(), status, files };
}

export function assertProtectedUnchanged(
  before: ProtectedSnapshot,
  after: ProtectedSnapshot,
): void {
  if (
    before.head !== after.head ||
    before.status !== after.status ||
    JSON.stringify(before.files) !== JSON.stringify(after.files)
  )
    throw new Error(
      "Independent verification changed protected tracked files, Git HEAD, index or working-tree status",
    );
}

export async function runIndependentChecks(
  cwd: string,
  candidateCommit: string,
  options: IndependentCheckOptions,
): Promise<EvidenceResult[]> {
  if (
    options.requireBrowserEvidence &&
    !options.checks.some((receipt) => receipt.kind === "browser-artifact")
  ) {
    throw new Error("Required browser evidence has no configured artifact check");
  }
  for (const receipt of options.checks) {
    if (receipt.kind === "command" && !Object.hasOwn(options.commands, receipt.commandId))
      throw new Error("Trusted independent command is not configured");
  }
  if (options.judge && !Object.hasOwn(options.commands, options.judge.commandId))
    throw new Error("Configured external judge command is unavailable");
  const before = await captureTrackedFiles(cwd);
  if (before.head !== candidateCommit)
    throw new Error("Independent checks require the actual candidate Git HEAD");
  const checks: EvidenceResult[] = [];
  for (const check of options.checks) {
    if (check.kind === "command")
      checks.push(await commandCheck(cwd, candidateCommit, check, options));
    else checks.push(await artifactCheck(candidateCommit, check, options.artifactRoot));
  }
  if (options.judge) checks.push(await judgeCheck(cwd, candidateCommit, checks, options));
  try {
    assertProtectedUnchanged(before, await captureTrackedFiles(cwd));
    checks.push(
      result(
        "protected-files",
        "protected-files",
        true,
        "Tracked files, Git HEAD and working-tree status unchanged",
        candidateCommit,
      ),
    );
  } catch {
    checks.push(
      result(
        "protected-files",
        "protected-files",
        false,
        "Read-only verification boundary changed or became unreadable",
        candidateCommit,
      ),
    );
  }
  return checks;
}

export function assertCriterionEvidence(
  checks: readonly EvidenceResult[],
  criterionIds: readonly string[],
  candidateCommit: string,
): void {
  const missing = criterionIds.filter(
    (id) =>
      !checks.some(
        (receipt) =>
          receipt.criterionId === id &&
          receipt.passed &&
          receipt.candidateCommit === candidateCommit &&
          (receipt.kind === "command" || receipt.kind === "browser-artifact"),
      ),
  );
  if (missing.length)
    throw new Error(
      `Independent current-commit evidence missing for criteria: ${missing.join(", ")}`,
    );
}

async function commandCheck(
  cwd: string,
  commit: string,
  check: CheckIdentity & { commandId: string },
  options: IndependentCheckOptions,
): Promise<EvidenceResult> {
  const command = options.commands[check.commandId];
  if (!command) throw new Error(`Trusted independent command ${check.commandId} is not configured`);
  const execution = await execute(cwd, command);
  return {
    ...result(
      check.id,
      "command",
      execution.code === 0,
      `Independent command ${check.commandId} exited ${execution.code ?? "without a valid completion"}`,
      commit,
    ),
    criterionId: check.criterionId,
    exitCode: execution.code,
  };
}

async function artifactCheck(
  commit: string,
  check: CheckIdentity & { artifactPath: string; artifactSha256: string },
  root: string | undefined,
): Promise<EvidenceResult> {
  if (!root || !isAbsolute(root))
    throw new Error("Browser evidence requires a configured absolute artifact root");
  if (!/^[a-f0-9]{64}$/.test(check.artifactSha256))
    throw new Error("Browser evidence requires an expected SHA256");
  const file = await realpath(check.artifactPath);
  assertInside(await realpath(root), file);
  const info = await lstat(file);
  if (!info.isFile() || info.size > 20 * 1024 * 1024)
    throw new Error("Browser artifact must be a bounded regular file");
  const bytes = await readFile(file);
  const sha = digest(bytes);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return {
    ...result(
      check.id,
      "browser-artifact",
      png && sha === check.artifactSha256,
      "Screenshot file signature and expected hash checked; this does not attest workflow behavior",
      commit,
    ),
    criterionId: check.criterionId,
    artifactSha256: sha,
  };
}

const judgeVerdict = z
  .object({
    verdict: z.enum(["pass", "fail", "needs-human"]),
    reason: z.string().min(1),
    evidence: z.string().min(1),
  })
  .strict();

async function judgeCheck(
  cwd: string,
  commit: string,
  checks: EvidenceResult[],
  options: IndependentCheckOptions,
): Promise<EvidenceResult> {
  const judge = options.judge!;
  const command = options.commands[judge.commandId];
  if (!command) throw new Error("Configured external judge command is unavailable");
  const payload = JSON.stringify({ cwd, candidateCommit: commit, checks });
  if (Buffer.byteLength(payload) > 64 * 1024) throw new Error("External judge input exceeds limit");
  const execution = await execute(cwd, { ...command, argv: [...command.argv, payload] });
  if (execution.code !== 0)
    return result(judge.id, "judge", false, "External judge did not complete successfully", commit);
  let verdict: z.infer<typeof judgeVerdict>;
  try {
    verdict = judgeVerdict.parse(JSON.parse(execution.stdout));
  } catch {
    return result(
      judge.id,
      "judge",
      false,
      "External judge returned an invalid structured verdict",
      commit,
    );
  }
  return result(
    judge.id,
    "judge",
    verdict.verdict === "pass",
    `${verdict.verdict}: ${verdict.reason}\n${verdict.evidence}`,
    commit,
  );
}

async function execute(cwd: string, command: TrustedCheckCommand) {
  if (!isAbsolute(command.executable))
    throw new Error("Independent commands require an explicitly configured absolute executable");
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot", "WINDIR", "LANG"])
    if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, command.env);
  try {
    const output = await runFile(command.executable, [...command.argv], {
      cwd,
      env,
      encoding: "utf8",
      timeout: Math.min(120_000, Math.max(1, command.timeoutMs ?? 30_000)),
      maxBuffer: 128 * 1024,
    });
    return { code: 0 as number | null, stdout: output.stdout };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; killed?: boolean; signal?: string };
    const code =
      typeof failure.code === "number" && !failure.killed && !failure.signal ? failure.code : null;
    return { code, stdout: failure.stdout ?? "" };
  }
}

async function git(cwd: string, argv: string[]): Promise<string> {
  return (
    await runFile("git", argv, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout;
}
function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function assertInside(root: string, file: string): void {
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Evidence path escapes its configured root");
}
function result(
  id: string,
  kind: EvidenceResult["kind"],
  passed: boolean,
  summary: string,
  candidateCommit: string,
): EvidenceResult {
  return { id, kind, passed, summary, candidateCommit, checkedAt: new Date().toISOString() };
}
