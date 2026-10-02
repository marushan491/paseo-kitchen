import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { TeamState } from "../shared/factory-contracts.js";
import type { IndependentCheckOptions, TrustedCheckCommand } from "./evidence.js";
import type { PolicyObservation } from "./policy.js";

const runFile = promisify(execFile);
const absolutePath = z.string().min(1).refine(isAbsolute, "An absolute path is required");
const CommandSchema = z
  .object({
    executable: absolutePath,
    argv: z.array(z.string()).max(128),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const IdentitySchema = z.object({
  id: z.string().min(1),
  criterionId: z.string().min(1).optional(),
});
export const RuntimeChecksSchema = z
  .object({
    commands: z.record(z.string(), CommandSchema),
    checks: z
      .array(
        z.discriminatedUnion("kind", [
          IdentitySchema.extend({
            kind: z.literal("command"),
            commandId: z.string().min(1),
          }).strict(),
          IdentitySchema.extend({
            kind: z.literal("browser-artifact"),
            artifactPath: absolutePath,
            artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
          }).strict(),
        ]),
      )
      .max(128),
    artifactRoot: absolutePath.optional(),
    requireBrowserEvidence: z.boolean().optional(),
    requireCriterionEvidence: z.boolean().optional(),
    judge: z
      .object({ id: z.string().min(1), commandId: z.string().min(1) })
      .strict()
      .optional(),
    usageCommandId: z.string().min(1).optional(),
    publicationCli: z
      .object({ executable: absolutePath, argv: z.array(z.string()).max(128).optional() })
      .strict()
      .optional(),
  })
  .strict();
const UsageSchema = z
  .object({
    teamId: z.string().min(1),
    scope: z.literal("team"),
    cumulative: z.boolean(),
    complete: z.boolean(),
    tokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();
export interface KitchenRuntimeConfig {
  publicationCli?: { executable: string; argv?: string[] };
  independentChecks?: IndependentCheckOptions;
  policyUsage?: (state: TeamState) => Promise<PolicyObservation["usage"]>;
}

export async function loadKitchenRuntimeConfig(
  storageRoot: string,
  file = process.env.KITCHEN_CHECKS_FILE ?? join(storageRoot, "runtime-checks.json"),
): Promise<KitchenRuntimeConfig> {
  const contents = await readConfiguredFile(file, false, 256 * 1024);
  if (contents === undefined) return {};
  const parsed = RuntimeChecksSchema.parse(parseConfiguredJson(contents));
  const required = parsed.checks.flatMap((receipt) =>
    receipt.kind === "command" ? [receipt.commandId] : [],
  );
  if (parsed.judge) required.push(parsed.judge.commandId);
  if (parsed.usageCommandId) required.push(parsed.usageCommandId);
  for (const id of required)
    if (!Object.hasOwn(parsed.commands, id))
      throw new Error(`Runtime command ${id} is not configured`);
  if (parsed.checks.some((receipt) => receipt.kind === "browser-artifact") && !parsed.artifactRoot)
    throw new Error("Browser checks require a configured artifact root");
  if (
    parsed.requireBrowserEvidence &&
    !parsed.checks.some((receipt) => receipt.kind === "browser-artifact")
  )
    throw new Error("Required browser evidence has no configured artifact check");
  const { usageCommandId, publicationCli, ...independentChecks } = parsed;
  const command = usageCommandId ? parsed.commands[usageCommandId] : undefined;
  return {
    independentChecks,
    ...(publicationCli ? { publicationCli } : {}),
    ...(command ? { policyUsage: (state: TeamState) => observeUsage(state, command) } : {}),
  };
}

export async function loadIndependentChecks(
  storageRoot: string,
  file?: string,
): Promise<IndependentCheckOptions | undefined> {
  return (await loadKitchenRuntimeConfig(storageRoot, file)).independentChecks;
}

export async function readOperatorCredential(
  storageRoot: string,
  file = process.env.KITCHEN_OPERATOR_CREDENTIAL_FILE ?? join(storageRoot, "operator-credential"),
): Promise<string | undefined> {
  const contents = await readConfiguredFile(file, true, 4096);
  if (contents === undefined) return undefined;
  const credential = contents.trim();
  if (credential.length < 32 || credential.length > 4096)
    throw new Error(
      "Operator credential file must contain a provisioned value of at least 32 characters",
    );
  return credential;
}

async function readConfiguredFile(
  file: string,
  privateFile: boolean,
  maxBytes: number,
): Promise<string | undefined> {
  if (!isAbsolute(file)) throw new Error("Runtime configuration requires an absolute path");
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Runtime configuration file could not be opened", { cause: error });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("Runtime configuration must be a bounded regular file");
    if (
      process.platform !== "win32" &&
      ((info.mode & (privateFile ? 0o077 : 0o022)) !== 0 ||
        (process.getuid && info.uid !== process.getuid()))
    )
      throw new Error(
        privateFile
          ? "Operator credential file must be owned by the daemon user with private permissions"
          : "Runtime checks must be owned by the daemon user and not writable by other users",
      );
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function observeUsage(
  state: TeamState,
  command: TrustedCheckCommand,
): Promise<PolicyObservation["usage"]> {
  const agentIds = [
    ...new Set(
      [
        state.team.bossAgentId,
        ...Object.values(state.bindings).map((binding) => binding.agentId),
      ].filter(Boolean),
    ),
  ];
  const payload = JSON.stringify({ teamId: state.team.id, agentIds });
  if (Buffer.byteLength(payload) > 64 * 1024)
    throw new Error("Usage adapter input exceeds the bounded limit");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot", "WINDIR", "LANG"])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, command.env);
  let output: string;
  try {
    output = (
      await runFile(command.executable, [...command.argv, payload], {
        env,
        encoding: "utf8",
        timeout: command.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error("Configured usage adapter failed; trustworthy team usage unavailable");
  }
  const parsed = UsageSchema.safeParse(parseConfiguredJson(output));
  if (!parsed.success || parsed.data.teamId !== state.team.id)
    throw new Error("Usage adapter returned invalid or unrelated team coverage");
  const { teamId: _teamId, ...usage } = parsed.data;
  return usage;
}

function parseConfiguredJson(contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error("Configured runtime adapter or file returned invalid JSON");
  }
}
