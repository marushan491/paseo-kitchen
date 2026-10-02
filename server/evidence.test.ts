import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  captureTrackedFiles,
  assertProtectedUnchanged,
  runIndependentChecks,
  assertCriterionEvidence,
} from "./evidence.js";

const runFile = promisify(execFile);
describe("Independent evidence", () => {
  let root: string;
  let commit: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kitchen-independent-evidence-"));
    await runFile("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "answer.txt"), "original\n");
    await runFile("git", ["add", "answer.txt"], { cwd: root });
    await runFile(
      "git",
      [
        "-c",
        "user.name=Kitchen fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
    commit = (await runFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("requires a passed current-commit command or artifact receipt for every criterion", () => {
    const receipt = {
      id: "test-a",
      criterionId: "a",
      kind: "command" as const,
      passed: true,
      summary: "Actual check",
      checkedAt: new Date().toISOString(),
      candidateCommit: commit,
    };
    expect(() => assertCriterionEvidence([receipt], ["a", "b"], commit)).toThrow("b");
    expect(() =>
      assertCriterionEvidence([{ ...receipt, candidateCommit: "b".repeat(40) }], ["a"], commit),
    ).toThrow("a");
    expect(() => assertCriterionEvidence([{ ...receipt, kind: "judge" }], ["a"], commit)).toThrow(
      "a",
    );
    expect(() => assertCriterionEvidence([{ ...receipt, passed: false }], ["a"], commit)).toThrow(
      "a",
    );
    expect(() =>
      assertCriterionEvidence(
        [receipt, { ...receipt, id: "browser-b", criterionId: "b", kind: "browser-artifact" }],
        ["a", "b"],
        commit,
      ),
    ).not.toThrow();
  });

  it("runs a configured actual check without inheriting the operator credential", async () => {
    vi.stubEnv("KITCHEN_OPERATOR_CREDENTIAL", "fixture-only-secret-not-for-child-env");
    const checks = await runIndependentChecks(root, commit, {
      commands: {
        test: {
          executable: process.execPath,
          argv: ["-e", "if(process.env.KITCHEN_OPERATOR_CREDENTIAL)process.exit(3)"],
        },
      },
      checks: [{ id: "tests", kind: "command", commandId: "test", criterionId: "criterion" }],
    });
    expect(checks.map((check) => check.passed)).toEqual([true, true]);
    expect(checks[0]).toMatchObject({
      kind: "command",
      exitCode: 0,
      candidateCommit: commit,
      criterionId: "criterion",
    });
  });

  it("detects a successful verifier command that edits protected tracked files", async () => {
    const checks = await runIndependentChecks(root, commit, {
      commands: {
        edit: {
          executable: process.execPath,
          argv: ["-e", "require('node:fs').writeFileSync('answer.txt','changed')"],
        },
      },
      checks: [{ id: "tests", kind: "command", commandId: "edit" }],
    });
    expect(checks[0].passed).toBe(true);
    expect(checks.at(-1)).toMatchObject({ kind: "protected-files", passed: false });
  });

  it("rejects unconfigured commands and an unrelated candidate HEAD", async () => {
    await expect(
      runIndependentChecks(root, commit, {
        commands: {},
        checks: [{ id: "check", kind: "command", commandId: "unconfigured" }],
      }),
    ).rejects.toThrow("not configured");
    await expect(
      runIndependentChecks(root, "b".repeat(40), { commands: {}, checks: [] }),
    ).rejects.toThrow("actual candidate");
  });

  it("checks screenshot file signature and hash without claiming workflow behavior", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const artifactPath = join(root, "fixture.png");
    await writeFile(artifactPath, png);
    const artifactSha256 = createHash("sha256").update(png).digest("hex");
    const checks = await runIndependentChecks(root, commit, {
      commands: {},
      artifactRoot: root,
      checks: [{ id: "screenshot", kind: "browser-artifact", artifactPath, artifactSha256 }],
    });
    expect(checks[0]).toMatchObject({ passed: true, artifactSha256 });
    expect(checks[0].summary).toContain("does not attest workflow behavior");
  });

  it("requires an actual configured external judge with a valid structured verdict", async () => {
    const script =
      "const input=JSON.parse(process.argv[1]);console.log(JSON.stringify({verdict:input.candidateCommit?'pass':'fail',reason:'Fixture judge evaluated actual payload',evidence:'candidateCommit inspected'}))";
    const checks = await runIndependentChecks(root, commit, {
      commands: { judge: { executable: process.execPath, argv: ["-e", script] } },
      checks: [],
      judge: { id: "judge", commandId: "judge" },
    });
    expect(checks[0]).toMatchObject({ kind: "judge", passed: true });
    await expect(
      runIndependentChecks(root, commit, {
        commands: {},
        checks: [],
        judge: { id: "judge", commandId: "missing" },
      }),
    ).rejects.toThrow("unavailable");
    const malformed = await runIndependentChecks(root, commit, {
      commands: {
        judge: { executable: process.execPath, argv: ["-e", "console.log('not-a-verdict')"] },
      },
      checks: [],
      judge: { id: "judge", commandId: "judge" },
    });
    expect(malformed[0]).toMatchObject({ kind: "judge", passed: false });
  });

  it("compares HEAD and working-tree status as well as content hashes", async () => {
    const before = await captureTrackedFiles(root);
    await writeFile(join(root, "new.txt"), "unexpected");
    expect(() => assertProtectedUnchanged(before, { ...before, head: "b".repeat(40) })).toThrow(
      "Git HEAD",
    );
    const after = await captureTrackedFiles(root);
    expect(() => assertProtectedUnchanged(before, after)).toThrow("working-tree status");
  });
});
