import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { matchesChangedFiles } from "./workflow-definitions.js";
import type { FileCondition } from "../shared/workflow-contracts.js";

const execute = promisify(execFile);
export async function workflowHead(cwd: string): Promise<string> {
  const { stdout } = await execute("git", ["-C", cwd, "rev-parse", "HEAD"]);
  const head = stdout.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head))
    throw new Error("Workflow Git HEAD is unavailable");
  return head;
}
export async function observeChangedFiles(
  cwd: string,
  baseCommit: string,
  condition: FileCondition,
) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit))
    throw new Error(
      "Workflow change baseline is unavailable; conditional checks cannot be skipped",
    );
  const head = await workflowHead(cwd);
  const status = await execute("git", ["-C", cwd, "status", "--porcelain"]);
  if (status.stdout.trim())
    throw new Error("Conditional workflow check requires a clean committed checkout");
  const result = await execute(
    "git",
    ["-C", cwd, "diff", "--name-only", "-z", baseCommit, head, "--"],
    { maxBuffer: 1024 * 1024 },
  );
  const files = result.stdout.split("\0").filter(Boolean);
  return {
    baseCommit,
    candidateCommit: head,
    files,
    matches: matchesChangedFiles(condition, files),
    observedAt: new Date().toISOString(),
  };
}
