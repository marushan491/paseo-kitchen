import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativeStartSchema,
  factoryNativePresets,
  factoryNativeStart,
} from "../shared/native-contracts.js";
import type { NativeStart } from "../shared/native-contracts.js";
import type { FactoryAgent, FactoryController } from "./controller.js";
import { startNativeMission, registerNativeEntry, promptReferences } from "./native-entry.js";
import { PackRegistry, kitchenPack } from "./pack.js";
import { TeamService } from "./service.js";
import { definitionFromPack } from "./workflow-definitions.js";

const git = promisify(execFile);
const services = new Set<TeamService>();
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kitchen-native-adapter-"));
});
afterEach(async () => {
  await Promise.all([...services].map((service) => service.shutdown()));
  services.clear();
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const source = join(root, "source"),
    cwd = join(root, "checkout");
  await mkdir(source);
  await mkdir(cwd);
  const agents = new Map<string, FactoryAgent>();
  const creates = new Map<string, { id: string; config: unknown }>();
  const deliveries: Array<{ text: string; options: unknown }> = [];
  const cards: unknown[] = [];
  const sentIds = new Set<string>();
  let loseAcknowledgement = false;
  const create = vi.fn(
    async (input: {
      idempotencyKey: string;
      config: { provider: string };
      labels?: Record<string, string>;
    }) => {
      let existing = creates.get(input.idempotencyKey);
      if (!existing) {
        existing = { id: `head-chef-${creates.size}`, config: input.config };
        creates.set(input.idempotencyKey, existing);
        agents.set(existing.id, {
          id: existing.id,
          provider: input.config.provider.split("/")[0]!,
          cwd,
          workspaceId: "workspace",
          labels: input.labels ?? {},
        });
      }
      return {
        id: existing.id,
        send: async (text: string, options: { messageId: string }) => {
          if (!sentIds.has(options.messageId)) {
            sentIds.add(options.messageId);
            deliveries.push({ text, options });
          }
          if (loseAcknowledgement) {
            loseAcknowledgement = false;
            throw new Error("Acknowledgement lost after accepted send");
          }
        },
        timeline: {
          refetch: async () => ({ entries: cards.map((item) => ({ item })), hasOlder: false }),
          append: async (item: unknown) => {
            cards.push(item);
            return { seq: cards.length, epoch: "epoch" };
          },
        },
      };
    },
  );
  const controller: FactoryController = {
    get: async (id) => agents.get(id) ?? null,
    list: async () => [...agents.values()],
    isRunning: async () => false,
    create: async (input) => {
      const id = `worker-${agents.size}`;
      agents.set(id, {
        id,
        provider: input.provider.split("/")[0]!,
        cwd: input.cwd,
        workspaceId: input.workspaceId,
        labels: input.labels,
      });
      return { id };
    },
    send: async () => {},
    cancel: async () => {},
    detach: async () => {},
    update: async (id, changes) => {
      Object.assign(agents.get(id)!, changes);
    },
    moveToWorkspace: async () => {},
    resolveWorkspace: async () => ({ id: "workspace", cwd }),
    findWorkspaceForCwd: async () => ({ id: "workspace", cwd }),
    validateProvider: async () => {},
  };
  const service = new TeamService({
    storageRoot: join(root, "storage"),
    controller,
    packs: new PackRegistry(),
    logger: pino({ level: "silent" }),
    timers: false,
  });
  services.add(service);
  const paseo = {
    workspaces: {
      ref: () => ({
        refresh: async () => ({
          id: "workspace",
          projectId: "project",
          projectRootPath: source,
          workspaceDirectory: cwd,
        }),
        agents: { create },
      }),
    },
  } as unknown as PaseoApi;
  const input: NativeStart = {
    workspaceId: "workspace",
    projectId: "project",
    cwd,
    presetId: "kitchen",
    text: "Implement the feature",
    images: [],
    attachments: [],
    idempotencyKey: "native-draft",
    defaultAgentConfig: {
      provider: "codex/model",
      modeId: "full-access",
      thinkingOptionId: "medium",
      options: { fixture: true },
      systemPrompt: "Existing system instruction",
      toolPolicy: { preapproved: [] },
      mcpServers: {},
    },
  };
  return {
    source,
    cwd,
    service,
    paseo,
    input,
    create,
    creates,
    deliveries,
    cards,
    loseNextAcknowledgement: () => {
      loseAcknowledgement = true;
    },
  };
}

describe("native Kitchen adapter", () => {
  it("keeps attachment-only rich messages intact in the ordinary chat and replays one mission", async () => {
    const f = await fixture();
    const input = NativeStartSchema.parse({
      ...f.input,
      text: "",
      images: [{ data: "synthetic-image", mimeType: "image/png" }],
      attachments: [{ type: "text", mimeType: "text/plain", text: "The actual attached brief" }],
    });
    const [first, replay] = await Promise.all([
      startNativeMission(f.paseo, f.service, input),
      startNativeMission(f.paseo, f.service, input),
    ]);
    expect(replay).toEqual(first);
    expect(f.creates.size).toBe(1);
    expect(f.deliveries).toEqual([
      {
        text: "",
        options: {
          messageId: "native:native-draft",
          images: input.images,
          attachments: input.attachments,
        },
      },
    ]);
    expect(f.cards).toHaveLength(1);
    expect(f.create.mock.calls[0]![0].config).toMatchObject({
      ...input.defaultAgentConfig!,
      systemPrompt: expect.stringContaining(input.defaultAgentConfig!.systemPrompt!),
    });
    expect(f.create.mock.calls[0]![0].config).not.toHaveProperty("title");
    expect((await f.service.status(first.teamId)).state.team.bossAgentId).toBe(first.agentId);
    expect(
      promptReferences([{ type: "image", data: "synthetic-image", mimeType: "image/png" }]),
    ).not.toHaveProperty("data");
    expect(
      JSON.stringify(
        promptReferences([{ type: "image", data: "synthetic-image", mimeType: "image/png" }]),
      ),
    ).not.toContain("synthetic-image");
  });

  it("retains the same boss and mission after lost acknowledgement without sending a second initial turn", async () => {
    const f = await fixture();
    f.loseNextAcknowledgement();
    await expect(startNativeMission(f.paseo, f.service, f.input)).rejects.toThrow(
      /Acknowledgement lost/,
    );
    const replay = await startNativeMission(f.paseo, f.service, f.input);
    expect(f.creates.size).toBe(1);
    expect(f.deliveries).toHaveLength(1);
    expect(f.cards).toHaveLength(1);
    const state = (await f.service.status(replay.teamId)).state;
    expect(state.items[state.team.rootItemId].pack.nativeInitialMessageId).toBe(
      "native:native-draft",
    );
  });

  it("uses untracked source-project preferences when the isolated Git worktree has no project config", async () => {
    const f = await fixture();
    await git("git", ["-C", f.source, "init", "-b", "main"]);
    await git("git", ["-C", f.source, "config", "core.hooksPath", "/dev/null"]);
    await git("git", ["-C", f.source, "config", "user.email", "fixture@example.invalid"]);
    await git("git", ["-C", f.source, "config", "user.name", "Fixture"]);
    await writeFile(join(f.source, "source.txt"), "Source");
    await git("git", ["-C", f.source, "add", "source.txt"]);
    await git("git", ["-C", f.source, "commit", "-m", "Fixture"]);
    await rm(f.cwd, { recursive: true });
    await git("git", ["-C", f.source, "worktree", "add", "-b", "native-fixture", f.cwd]);
    await mkdir(join(f.source, ".agent-factory"));
    await writeFile(
      join(f.source, ".agent-factory", "project.json"),
      JSON.stringify({
        workflowPack: "kitchen",
        headChef: { model: "project-model", instructions: "Respect source defaults" },
        roles: { developer: { provider: "opencode", model: "project-developer" } },
      }),
    );
    const variant = await f.service.workflows.save(
      {
        ...definitionFromPack(kitchenPack, "project-variant"),
        roleProfiles: { developer: { thinking: "high" } },
      },
      0,
    );
    const result = await startNativeMission(f.paseo, f.service, {
      ...f.input,
      presetId: variant.id,
    });
    expect(f.create.mock.calls[0]![0].config).toMatchObject({
      provider: "codex/project-model",
      systemPrompt: expect.stringContaining("Respect source defaults"),
    });
    expect((await f.service.status(result.teamId)).state.team.roleProfiles.developer).toMatchObject(
      { provider: "opencode", model: "project-developer", thinking: "high" },
    );
  });

  it("rejects missing and version-invalid presets before creating a chat", async () => {
    const f = await fixture();
    await expect(
      startNativeMission(f.paseo, f.service, { ...f.input, presetId: "missing" }),
    ).rejects.toThrow(/available/);
    const invalid = {
      ...definitionFromPack(kitchenPack, "outdated"),
      basePackVersion: kitchenPack.version + 1,
      revision: 1,
    };
    await f.service.workflows.save(
      { ...invalid, basePackVersion: kitchenPack.version, revision: 0 },
      0,
    );
    await writeFile(join(root, "storage", "workflow-definitions.json"), JSON.stringify([invalid]));
    await expect(
      startNativeMission(f.paseo, f.service, { ...f.input, presetId: "outdated" }),
    ).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("keeps old hosts explicitly unavailable without registering an unsupported hook", async () => {
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
    const on = vi.fn();
    const server = {
      handle: (
        rpc: { name: string },
        handler: (input: unknown, context: unknown) => Promise<unknown>,
      ) => handlers.set(rpc.name, handler),
      on,
    } as unknown as PluginServerContext;
    const ready = vi.fn();
    registerNativeEntry(server, ready);
    expect(await handlers.get(factoryNativePresets.name)!({ cwd: root }, {})).toMatchObject({
      presets: [],
      unavailableReason: expect.stringContaining("Update"),
    });
    await expect(handlers.get(factoryNativeStart.name)!({}, {})).rejects.toThrow(/Update/);
    expect(on).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });
});
