import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  WorkflowDefinitions,
  definitionFromPack,
  validateDefinition,
  packFromSnapshot,
} from "./workflow-definitions.js";
import { kitchenPack, PackRegistry } from "./pack.js";
import { applyWorkflowDesign } from "./workflow-design.js";
import { observeChangedFiles, workflowHead } from "./workflow-runtime.js";

let root: string;
const execute = promisify(execFile);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kitchen-workflow-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("persists preview without applying; explicit apply pins a revision and rejects concurrent stale writers", async () => {
  const store = new WorkflowDefinitions(root, new PackRegistry());
  const definition = applyWorkflowDesign(
    definitionFromPack(kitchenPack, "secure-team"),
    "security",
    "Review authentication changes",
  );
  const preview = await store.preview(definition, {
    summary: ["Add Security"],
    confidence: 0.9,
    model: "test",
  });
  expect(await store.list()).toEqual([]);
  const reloaded = new WorkflowDefinitions(root, new PackRegistry());
  const saved = await reloaded.apply(preview.previewId, 0);
  expect(saved.revision).toBe(1);
  expect(saved.boards.item.phases.review.outcomes!.approve).toBe("security-review");
  await expect(reloaded.apply(preview.previewId, 0)).rejects.toThrow("revision conflict");
  const outcomes = await Promise.allSettled([store.save(saved, 1), reloaded.save(saved, 1)]);
  expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
  expect((await store.get("secure-team")).revision).toBe(2);
});
it("rejects removal or bypass of verification, source editing, malformed graph and baseline overwrite", () => {
  const template = definitionFromPack(kitchenPack, "safe-team");
  expect(() => validateDefinition({ ...template, id: "kitchen" }, kitchenPack)).toThrow("new ID");
  const unsafe = structuredClone(template);
  unsafe.boards.item.phases.review.outcomes!.approve = "ready-for-human";
  expect(() => validateDefinition(unsafe, kitchenPack)).toThrow("Every completion path");
  unsafe.boards = structuredClone(template.boards);
  unsafe.roles.verifier.canEdit = true;
  expect(() => validateDefinition(unsafe, kitchenPack)).toThrow("Verifier");
  const source = structuredClone(template);
  source.roles.developer.workspace = "team";
  expect(() => validateDefinition(source, kitchenPack)).toThrow("isolated worktree");
  const graph = structuredClone(template);
  graph.boards.item.phases.review.outcomes!.approve = "unknown";
  expect(() => validateDefinition(graph, kitchenPack)).toThrow("Unknown workflow phase");
  const rootEdit = structuredClone(template);
  rootEdit.boards.root.phases.verify.outcomes!.pass = "canceled";
  expect(() => validateDefinition(rootEdit, kitchenPack)).toThrow("human acceptance");
});
it("preserves active snapshot roles and structural limits after later definition and base updates", async () => {
  const store = new WorkflowDefinitions(root, new PackRegistry());
  const first = await store.save(definitionFromPack(kitchenPack, "custom-team"), 0);
  const pinned = structuredClone(first);
  const changed = applyWorkflowDesign(first, "database", "Check migrations");
  await store.save(changed, 1);
  const currentBase = { ...kitchenPack, version: 2 };
  new PackRegistry().register(currentBase);
  expect(packFromSnapshot(pinned).roles["database-reviewer"]).toBeUndefined();
  expect(packFromSnapshot(pinned).version).toBe(1);
  expect(packFromSnapshot(await store.get("custom-team")).roles["database-reviewer"]).toBeDefined();
});
it("uses actual clean committed changed files for conditions; missing baseline and dirty changes fail closed", async () => {
  await execute("git", ["init", root]);
  await execute("git", ["-C", root, "config", "user.name", "Workflow fixture"]);
  await execute("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(root, "README.md"), "Initial");
  await execute("git", ["-C", root, "add", "README.md"]);
  await execute("git", ["-C", root, "commit", "-m", "Initial"]);
  const base = await workflowHead(root);
  await mkdir(join(root, "auth"));
  await writeFile(join(root, "auth", "login.ts"), "export const auth=true;");
  await execute("git", ["-C", root, "add", "auth/login.ts"]);
  await execute("git", ["-C", root, "commit", "-m", "Auth"]);
  const condition = { kind: "changed-files" as const, any: [{ prefix: "auth/" }] };
  const observed = await observeChangedFiles(root, base, condition);
  expect(observed.files).toEqual(["auth/login.ts"]);
  expect(observed.matches).toBe(true);
  expect(
    (
      await observeChangedFiles(root, base, {
        kind: "changed-files",
        any: [{ prefix: "migrations/" }],
      })
    ).matches,
  ).toBe(false);
  await expect(observeChangedFiles(root, "missing", condition)).rejects.toThrow("baseline");
  await writeFile(join(root, "auth", "login.ts"), "dirty");
  await expect(observeChangedFiles(root, base, condition)).rejects.toThrow("clean committed");
});

it("persists configured delegation and return limits and rejects conditional skip cycles", async () => {
  const store = new WorkflowDefinitions(root, new PackRegistry());
  const definition = applyWorkflowDesign(
    definitionFromPack(kitchenPack, "configured-team"),
    "security-database",
    "Check auth and migrations",
  );
  definition.runtimePolicy = { maxReturns: 7, maxDelegationDepth: 2, maxDelegatedItems: 10 };
  const saved = await store.save(definition, 0),
    pack = packFromSnapshot(saved);
  expect(pack.maxReturns).toBe(7);
  expect(pack.maxDelegationDepth).toBe(2);
  expect(pack.maxDelegatedItems).toBe(10);
  expect(pack.dependencyPhase).toBe("ready-for-human");
  const unlimited = { ...saved, runtimePolicy: { maxReturns: 3 } };
  const next = await store.save(unlimited, 1);
  expect(packFromSnapshot(next).maxDelegationDepth).toBeUndefined();
  const cycle = structuredClone(definition);
  cycle.boards.item.phases["database-review"].skipTo = "security-review";
  expect(() => validateDefinition(cycle, kitchenPack)).toThrow("cycle");
  const unsafe = structuredClone(definition);
  unsafe.boards.item.phases["security-review"].skipTo = "implement";
  expect(() => validateDefinition(unsafe, kitchenPack)).toThrow("independent verification");
});

it("allows Verifier behavior and skill customization while preserving its independent workspace and result routes", () => {
  const value = definitionFromPack(kitchenPack, "custom-verifier");
  value.roles.verifier.instructions = "Inspect current evidence against the complete goal";
  value.roles.verifier.skills = ["code-review"];
  value.roles.verifier.communication = { clarification: "head-chef", investigation: "human" };
  value.boards.item.phases.verify.maxReturns = 5;
  expect(validateDefinition(value, kitchenPack).roles.verifier.skills).toEqual(["code-review"]);
  value.roles.verifier.workspace = "team";
  expect(() => validateDefinition(value, kitchenPack)).toThrow("read-only workspace");
});
