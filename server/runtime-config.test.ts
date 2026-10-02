import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamState } from "../shared/factory-contracts.js";
import { loadKitchenRuntimeConfig, readOperatorCredential } from "./runtime-config.js";

describe("Trusted Kitchen runtime configuration", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kitchen-runtime-config-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const configuration = (executable = process.execPath) => ({
    commands: { tests: { executable, argv: ["--version"] } },
    checks: [{ id: "node-tests", criterionId: "criterion-a", kind: "command", commandId: "tests" }],
  });
  async function writeConfig(value: unknown) {
    const file = join(root, "runtime-checks.json");
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    return file;
  }

  it("does not invent checks or credentials when no file is provisioned", async () => {
    expect(await loadKitchenRuntimeConfig(root)).toEqual({});
    expect(await readOperatorCredential(root)).toBeUndefined();
  });
  it("loads only explicit commands and rejects relative executables, unknown commands and missing required browser evidence", async () => {
    await writeConfig(configuration());
    expect((await loadKitchenRuntimeConfig(root)).independentChecks?.checks[0].criterionId).toBe(
      "criterion-a",
    );
    await writeConfig(configuration("node"));
    await expect(loadKitchenRuntimeConfig(root)).rejects.toThrow();
    await writeConfig({
      ...configuration(),
      publicationCli: { executable: process.execPath, argv: ["--version"] },
    });
    expect((await loadKitchenRuntimeConfig(root)).publicationCli).toEqual({
      executable: process.execPath,
      argv: ["--version"],
    });
    await writeConfig({ ...configuration(), publicationCli: { executable: "gh" } });
    await expect(loadKitchenRuntimeConfig(root)).rejects.toThrow();
    await writeConfig({
      ...configuration(),
      checks: [{ id: "bad", kind: "command", commandId: "unconfigured" }],
    });
    await expect(loadKitchenRuntimeConfig(root)).rejects.toThrow("not configured");
    await writeConfig({ ...configuration(), requireBrowserEvidence: true });
    await expect(loadKitchenRuntimeConfig(root)).rejects.toThrow("browser evidence");
    await writeConfig({ ...configuration(), injectedCommands: ["sh"] });
    await expect(loadKitchenRuntimeConfig(root)).rejects.toThrow();
  });
  it("reads a private credential without storing it in the runtime checks or accepting public permissions", async () => {
    const file = join(root, "operator-credential");
    const credential = "synthetic-fixture-operator-credential-value";
    await writeFile(file, credential + "\n", { mode: 0o600 });
    expect(await readOperatorCredential(root)).toBe(credential);
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await expect(readOperatorCredential(root)).rejects.toThrow("private permissions");
    }
  });
  it("rejects symlink configuration and writable shared configuration", async () => {
    const file = await writeConfig(configuration());
    if (process.platform !== "win32") {
      const linked = join(root, "link.json");
      await symlink(file, linked);
      await expect(loadKitchenRuntimeConfig(root, linked)).rejects.toThrow("could not be opened");
      await chmod(file, 0o666);
      await expect(loadKitchenRuntimeConfig(root)).rejects.toThrow("not writable");
    }
  });
  it("invokes the configured actual usage adapter with team identity and rejects unrelated or failed coverage", async () => {
    const state = {
      team: { id: "fixture-team", bossAgentId: "fixture-boss" },
      bindings: { worker: { agentId: "fixture-agent" } },
    } as unknown as TeamState;
    const config = {
      commands: {
        meter: {
          executable: process.execPath,
          argv: [
            "-e",
            "const input=JSON.parse(process.argv[1]);if(!input.agentIds.includes('fixture-boss'))process.exit(4);process.stdout.write(JSON.stringify({teamId:input.teamId,scope:'team',cumulative:true,complete:true,tokens:7,costUsd:0.01}))",
          ],
        },
      },
      checks: [],
      usageCommandId: "meter",
    };
    await writeConfig(config);
    const runtime = await loadKitchenRuntimeConfig(root);
    expect(await runtime.policyUsage!(state)).toEqual({
      scope: "team",
      cumulative: true,
      complete: true,
      tokens: 7,
      costUsd: 0.01,
    });
    await writeConfig({
      ...config,
      commands: {
        meter: {
          executable: process.execPath,
          argv: [
            "-e",
            "process.stdout.write(JSON.stringify({teamId:'other',scope:'team',cumulative:true,complete:true,tokens:7}))",
          ],
        },
      },
    });
    await expect((await loadKitchenRuntimeConfig(root)).policyUsage!(state)).rejects.toThrow(
      "unrelated",
    );
    await writeConfig({
      ...config,
      commands: {
        meter: {
          executable: process.execPath,
          argv: ["-e", "process.stdout.write('fixture-secret-invalid-json')"],
        },
      },
    });
    await expect((await loadKitchenRuntimeConfig(root)).policyUsage!(state)).rejects.toThrow(
      "invalid JSON",
    );
    await writeConfig({
      ...config,
      commands: { meter: { executable: process.execPath, argv: ["-e", "process.exit(1)"] } },
    });
    await expect((await loadKitchenRuntimeConfig(root)).policyUsage!(state)).rejects.toThrow(
      "unavailable",
    );
  });
});
