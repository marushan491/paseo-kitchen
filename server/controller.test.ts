import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi, PaseoAgentConfig, PaseoAgentCreateOptions } from "@getpaseo/client";
import { sdkController } from "./controller.js";
import { createHostControl } from "./host-control.js";
import { kitchenPermissionConfig } from "./permission-config.js";
import { TEAM_ITEM_LABEL, TEAM_LABEL } from "../shared/factory-contracts.js";
import type { FactoryCreate } from "./controller.js";

const placementDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    placementDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function placementFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "kitchen-placement-"));
  placementDirectories.push(cwd);
  const child = join(cwd, "feature");
  await mkdir(child);
  const workspaces = new Map([
    [
      "parent-workspace",
      {
        id: "parent-workspace",
        projectId: "project",
        workspaceDirectory: cwd,
        projectRootPath: cwd,
        archivingAt: null as string | null,
      },
    ],
    [
      "sibling-workspace",
      {
        id: "sibling-workspace",
        projectId: "project",
        workspaceDirectory: cwd,
        projectRootPath: cwd,
        archivingAt: null as string | null,
      },
    ],
  ]);
  const records = new Map<
    string,
    {
      id: string;
      provider: string;
      cwd: string;
      workspaceId: string | null;
      labels: Record<string, string>;
      archivedAt?: string | null;
    }
  >([
    [
      "boss",
      {
        id: "boss",
        provider: "opencode",
        cwd,
        workspaceId: "parent-workspace",
        labels: { [TEAM_LABEL]: "team-a" },
      },
    ],
  ]);
  const calls: Array<{ workspaceId: string; options: PaseoAgentCreateOptions }> = [];
  const ref = vi.fn((id: string) => ({
    id,
    refresh: async () => workspaces.get(id) ?? null,
    agents: {
      create: async (options: PaseoAgentCreateOptions) => {
        calls.push({ workspaceId: id, options });
        const agentId = `worker-${calls.length}`;
        records.set(agentId, {
          id: agentId,
          provider: "opencode",
          cwd: workspaces.get(id)!.workspaceDirectory,
          workspaceId: id,
          labels: options.labels ?? {},
        });
        return { id: agentId };
      },
    },
  }));
  const createWorkspace = vi.fn(
    async (_options: Parameters<PaseoApi["workspaces"]["create"]>[0]) => {
      const id = `item-workspace-${workspaces.size}`;
      workspaces.set(id, {
        id,
        projectId: "project",
        workspaceDirectory: child,
        projectRootPath: cwd,
        archivingAt: null,
      });
      return { id };
    },
  );
  const open = vi.fn(async () => {
    throw new Error("Directory-based workspace reuse is forbidden");
  });
  const createAgent = vi.fn();
  const list = vi.fn(async () => ({
    entries: [...records.values()].map((agent) => ({ agent })),
    pageInfo: { nextCursor: null },
  }));
  const listModels = vi.fn(async () => ({
    models: [{ id: "opencode/free-test-model", isDefault: true }],
  }));
  const api = {
    workspaces: { ref, open, create: createWorkspace },
    agents: {
      create: createAgent,
      ref: (id: string) => ({
        refresh: async () => (records.has(id) ? { agent: records.get(id)! } : null),
      }),
      list,
    },
    providers: { listModels },
  } as unknown as PaseoApi;
  const request: FactoryCreate = {
    provider: "opencode/opencode/free-test-model",
    title: "Reviewer · Inventory search",
    cwd,
    parentAgentId: "boss",
    decisionId: "decision-review",
    labels: { [TEAM_LABEL]: "team-a", [TEAM_ITEM_LABEL]: "item-a" },
  };
  return {
    api,
    cwd,
    child,
    records,
    workspaces,
    calls,
    ref,
    open,
    createWorkspace,
    createAgent,
    list,
    listModels,
    request,
  };
}

it("passes provider/model, creation identity and worktree through the public SDK", async () => {
  const calls: PaseoAgentCreateOptions[] = [];
  const api = {
    agents: {
      create: async (input: PaseoAgentCreateOptions) => {
        calls.push(input);
        return { id: "worker" };
      },
    },
  } as unknown as PaseoApi;
  const controller = sdkController(api);
  expect(
    await controller.create({
      provider: "codex/gpt-6.1-sol",
      title: "Developer",
      cwd: "/repo",
      initialPrompt: "Do the work",
      parentAgentId: "boss",
      decisionId: "decision",
      thinking: "high",
      labels: {},
      worktree: { worktreeName: "worker", branchName: "feature/worker", baseBranch: "main" },
    }),
  ).toEqual({ id: "worker" });
  expect(calls[0]).toMatchObject({
    config: { provider: "codex/gpt-6.1-sol", thinkingOptionId: "high" },
    idempotencyKey: "decision",
    parent: "boss",
    worktree: { mode: "branch-off", newBranch: "feature/worker", base: "main" },
  });
});

it("uses only an explicitly advertised provider default when no model was selected", async () => {
  const fixture = await placementFixture();
  fixture.listModels.mockResolvedValue({ models: [{ id: "raw/model-id", isDefault: true }] });
  await sdkController(fixture.api).create({ ...fixture.request, provider: "custom-profile" });
  expect(fixture.calls[0]!.options.config.provider).toBe("custom-profile/raw/model-id");
  expect(fixture.calls[0]!.workspaceId).toBe("parent-workspace");
  expect(fixture.open).not.toHaveBeenCalled();
});

it("keeps same-directory children in their Chef's verified workspace despite sibling workspaces", async () => {
  const fixture = await placementFixture();
  await sdkController(fixture.api).create(fixture.request);
  expect(fixture.calls[0]!.workspaceId).toBe("parent-workspace");
  expect(fixture.calls[0]!.options.parent).toBe("boss");
  expect(fixture.open).not.toHaveBeenCalled();
  expect(fixture.list).not.toHaveBeenCalled();
  expect(fixture.createWorkspace).not.toHaveBeenCalled();
  expect(fixture.createAgent).not.toHaveBeenCalled();
});

it.each([
  "archived-parent",
  "archiving-workspace",
  "wrong-directory",
  "other-team",
  "other-workspace",
])("rejects %s placement before creating a child", async (problem) => {
  const fixture = await placementFixture();
  const request = { ...fixture.request };
  if (problem === "archived-parent") fixture.records.get("boss")!.archivedAt = "2099-01-01";
  if (problem === "archiving-workspace")
    fixture.workspaces.get("parent-workspace")!.archivingAt = "2099-01-01";
  if (problem === "wrong-directory")
    fixture.workspaces.get("parent-workspace")!.workspaceDirectory = fixture.child;
  if (problem === "other-team") request.labels = { ...request.labels, [TEAM_LABEL]: "other-team" };
  if (problem === "other-workspace") request.workspaceId = "sibling-workspace";
  await expect(sdkController(fixture.api).create(request)).rejects.toThrow(/Kitchen/);
  expect(fixture.calls).toEqual([]);
  expect(fixture.open).not.toHaveBeenCalled();
  expect(fixture.createWorkspace).not.toHaveBeenCalled();
});

it("reuses an item's existing checkout mapping while excluding another mission in the same directory", async () => {
  const fixture = await placementFixture();
  fixture.workspaces.set("foreign-workspace", {
    id: "foreign-workspace",
    projectId: "project",
    workspaceDirectory: fixture.child,
    projectRootPath: fixture.cwd,
    archivingAt: null,
  });
  fixture.workspaces.set("developer-workspace", {
    id: "developer-workspace",
    projectId: "project",
    workspaceDirectory: fixture.child,
    projectRootPath: fixture.cwd,
    archivingAt: null,
  });
  fixture.records.set("foreign", {
    id: "foreign",
    provider: "opencode",
    cwd: fixture.child,
    workspaceId: "foreign-workspace",
    labels: { [TEAM_LABEL]: "team-b", [TEAM_ITEM_LABEL]: "item-a" },
  });
  fixture.records.set("developer", {
    id: "developer",
    provider: "opencode",
    cwd: fixture.child,
    workspaceId: "developer-workspace",
    labels: fixture.request.labels,
  });
  await sdkController(fixture.api).create({ ...fixture.request, cwd: fixture.child });
  expect(fixture.calls[0]!.workspaceId).toBe("developer-workspace");
  expect(fixture.list).toHaveBeenCalledWith({
    filter: { labels: fixture.request.labels, includeArchived: false },
    page: { limit: 200, cursor: undefined },
  });
  expect(fixture.createWorkspace).not.toHaveBeenCalled();
  expect(fixture.open).not.toHaveBeenCalled();
});

it("creates one named item workspace with a stable identity and reuses it across item roles", async () => {
  const fixture = await placementFixture();
  const controller = sdkController(fixture.api);
  await controller.create({ ...fixture.request, cwd: fixture.child });
  const firstWorkspace = fixture.calls[0]!.workspaceId;
  expect(fixture.createWorkspace).toHaveBeenCalledExactlyOnceWith({
    idempotencyKey: expect.stringMatching(/^kitchen-item:[a-f0-9]{64}$/),
    title: "Inventory search",
    source: { kind: "directory", path: fixture.child, projectId: "project" },
  });
  await controller.create({
    ...fixture.request,
    cwd: fixture.child,
    title: "Verifier · Inventory search",
    decisionId: "decision-verify",
  });
  expect(fixture.calls[1]!.workspaceId).toBe(firstWorkspace);
  expect(fixture.createWorkspace).toHaveBeenCalledTimes(1);
  fixture.records.delete("worker-1");
  fixture.records.delete("worker-2");
  await controller.create({ ...fixture.request, cwd: fixture.child });
  const firstKey = fixture.createWorkspace.mock.calls[0]![0].idempotencyKey;
  expect(fixture.createWorkspace.mock.calls[1]![0].idempotencyKey).toBe(firstKey);
  fixture.records.get("boss")!.labels = { [TEAM_LABEL]: "team-b" };
  await controller.create({
    ...fixture.request,
    cwd: fixture.child,
    labels: { [TEAM_LABEL]: "team-b", [TEAM_ITEM_LABEL]: "item-a" },
  });
  expect(fixture.calls[3]!.workspaceId).not.toBe(fixture.calls[2]!.workspaceId);
  expect(fixture.createWorkspace.mock.calls[2]![0].idempotencyKey).not.toBe(firstKey);
  expect(fixture.open).not.toHaveBeenCalled();
});

it("rejects a different checkout without team and item ownership", async () => {
  const fixture = await placementFixture();
  await expect(
    sdkController(fixture.api).create({
      ...fixture.request,
      cwd: fixture.child,
      labels: { [TEAM_LABEL]: "team-a" },
    }),
  ).rejects.toThrow("team and work item identity");
  expect(fixture.calls).toEqual([]);
  expect(fixture.list).not.toHaveBeenCalled();
});

it.each([
  { routingMode: undefined, expected: "manual" },
  { routingMode: "manual" as const, expected: "manual" },
  { routingMode: "auto" as const, expected: "auto" },
])(
  "binds Cook routing as $expected while preserving the selected provider/model",
  async ({ routingMode, expected }) => {
    const create = vi.fn(async () => ({ id: "worker" }));
    const listModels = vi.fn();
    await sdkController({
      agents: { create },
      providers: { listModels },
    } as unknown as PaseoApi).create({
      provider: "opencode/opencode/free-test-model",
      title: "Developer",
      cwd: "/repo",
      decisionId: "decision",
      routingMode,
      labels: {},
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { provider: "opencode/opencode/free-test-model" },
        labels: { "pandaos.routing.mode": expected },
      }),
    );
    expect(listModels).not.toHaveBeenCalled();
  },
);

it("leaves explicit permission settings intact when Kitchen auto-accept is disabled", async () => {
  const config: PaseoAgentConfig = {
    provider: "opencode/opencode/free-test-model",
    modeId: "plan",
    thinkingOptionId: "high",
    featureValues: { auto_accept: false, custom: true },
    options: { permission: { edit: "deny" } },
  };
  const api = { providers: {} } as unknown as PaseoApi;
  expect(await kitchenPermissionConfig(api, config, "/repo", false)).toBe(config);
});

it("starts an OpenCode Cook in Build with the advertised auto-accept toggle", async () => {
  const create = vi.fn(async () => ({ id: "worker" }));
  const listModes = vi.fn(async () => ({ modes: [{ id: "build", label: "Build" }] }));
  const listFeatures = vi.fn(async () => ({
    features: [{ id: "auto_accept", type: "toggle", label: "Auto-accept", value: false }],
  }));
  const api = {
    providers: { listModes, listFeatures },
    agents: { create },
  } as unknown as PaseoApi;
  await sdkController(api).create({
    provider: "opencode/opencode/free-test-model",
    title: "Developer",
    cwd: "/repo",
    initialPrompt: "Do the work",
    mode: "build",
    thinking: "high",
    autoAcceptPermissions: true,
    decisionId: "decision",
    labels: { role: "developer" },
  });
  expect(listModes).toHaveBeenCalledWith("opencode", { cwd: "/repo" });
  expect(listFeatures).toHaveBeenCalledWith({
    provider: "opencode/opencode/free-test-model",
    cwd: "/repo",
    modeId: "build",
    thinkingOptionId: "high",
    featureValues: undefined,
  });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: "decision",
      prompt: "Do the work",
      labels: { role: "developer", "pandaos.routing.mode": "manual" },
      config: {
        provider: "opencode/opencode/free-test-model",
        modeId: "build",
        thinkingOptionId: "high",
        featureValues: { auto_accept: true },
      },
    }),
  );
});

it.each(["opencode", "opencode-profile"])(
  "preserves a custom %s mode and existing features when enabling auto-accept",
  async (provider) => {
    const config: PaseoAgentConfig = {
      provider: `${provider}/opencode/free-test-model`,
      modeId: "security-audit",
      thinkingOptionId: "high",
      featureValues: { auto_accept: false, another: "selected" },
      systemPrompt: "Audit carefully",
      toolPolicy: { preapproved: [{ server: "factory", tool: "report" }] },
    };
    const api = {
      providers: {
        listModes: async () => ({ modes: [{ id: "security-audit", label: "Security audit" }] }),
        listFeatures: async () => ({ features: [{ id: "auto_accept", type: "toggle" }] }),
      },
    } as unknown as PaseoApi;
    expect(await kitchenPermissionConfig(api, config, "/repo", true)).toEqual({
      ...config,
      featureValues: { auto_accept: true, another: "selected" },
    });
    expect(config.featureValues?.auto_accept).toBe(false);
  },
);

it.each([
  ["codex", "full-access"],
  ["codex-plus", "full-access"],
  ["codex-business", "full-access"],
  ["claude", "bypassPermissions"],
  ["copilot", "allow-all"],
  ["omp", "full"],
])("selects only an advertised unattended mode for %s", async (provider, modeId) => {
  const config: PaseoAgentConfig = {
    provider: `${provider}/test-model`,
    modeId: "plan",
    thinkingOptionId: "high",
  };
  const api = {
    providers: {
      listModes: async () => ({ modes: [{ id: "plan" }, { id: modeId }] }),
      listFeatures: async () => ({ features: [] }),
    },
  } as unknown as PaseoApi;
  expect(await kitchenPermissionConfig(api, config, "/repo", true)).toEqual({ ...config, modeId });
});

it("accepts a custom provider's explicitly advertised unattended mode", async () => {
  const config: PaseoAgentConfig = { provider: "custom-profile/test-model", modeId: "ask" };
  const api = {
    providers: {
      listModes: async () => ({ modes: [{ id: "run-tools", isUnattended: true }] }),
      listFeatures: async () => ({ features: [] }),
    },
  } as unknown as PaseoApi;
  expect(await kitchenPermissionConfig(api, config, "/repo", true)).toEqual({
    ...config,
    modeId: "run-tools",
  });
});

it.each(["codex", "codex-plus"])(
  "honors an advertised override that makes %s full-access interactive",
  async (provider) => {
    const api = {
      providers: {
        listModes: async () => ({ modes: [{ id: "full-access", isUnattended: false }] }),
        listFeatures: async () => ({ features: [] }),
      },
    } as unknown as PaseoApi;
    await expect(
      kitchenPermissionConfig(api, { provider: `${provider}/test-model` }, "/repo", true),
    ).rejects.toThrow("no supported unattended mode or auto-accept toggle was advertised");
  },
);

it("does not infer a built-in provider's permission contract from another provider's mode IDs", async () => {
  const api = {
    providers: {
      listModes: async () => ({ modes: [{ id: "full-access" }] }),
      listFeatures: async () => ({ features: [] }),
    },
  } as unknown as PaseoApi;
  await expect(
    kitchenPermissionConfig(api, { provider: "opencode/opencode/free-test-model" }, "/repo", true),
  ).rejects.toThrow("no supported unattended mode or auto-accept toggle was advertised");
});

it.each([
  ["codex", "on-request"],
  ["codex-plus", { granular: { sandbox_approval: true } }],
])(
  "clears conflicting Codex permission overrides for %s while retaining other options",
  async (provider, approval) => {
    const config: PaseoAgentConfig = {
      provider: `${provider}/test-model`,
      modeId: "auto",
      thinkingOptionId: "high",
      options: {
        approval_policy: approval,
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: { writable_roots: ["/repo"], network_access: false },
        web_search: "cached",
        features: { multi_agent_v2: true },
      },
    };
    const api = {
      providers: {
        listModes: async () => ({ modes: [{ id: "full-access" }] }),
        listFeatures: async () => ({ features: [] }),
      },
    } as unknown as PaseoApi;
    expect(await kitchenPermissionConfig(api, config, "/repo", true)).toEqual({
      ...config,
      modeId: "full-access",
      options: {
        sandbox_workspace_write: { writable_roots: ["/repo"], network_access: false },
        web_search: "cached",
        features: { multi_agent_v2: true },
      },
    });
    expect(config.options?.approval_policy).toEqual(approval);
    expect(config.options?.sandbox_mode).toBe("workspace-write");
    expect(await kitchenPermissionConfig(api, config, "/repo", false)).toBe(config);
  },
);

it("retains tool restrictions when enabling a provider's unattended mode", async () => {
  const config: PaseoAgentConfig = {
    provider: "claude/test-model",
    modeId: "default",
    options: {
      disallowedTools: ["Write"],
      settings: { permissions: { deny: ["Bash(rm *)"] } },
      additionalDirectories: ["/docs"],
    },
    toolPolicy: { preapproved: [{ server: "factory", tool: "report" }] },
  };
  const api = {
    providers: {
      listModes: async () => ({ modes: [{ id: "bypassPermissions" }] }),
      listFeatures: async () => ({ features: [] }),
    },
  } as unknown as PaseoApi;
  expect(await kitchenPermissionConfig(api, config, "/repo", true)).toEqual({
    ...config,
    modeId: "bypassPermissions",
  });
});

it("refuses startup when the provider does not advertise a supported auto-accept choice", async () => {
  const create = vi.fn();
  const api = {
    providers: {
      listModes: async () => ({ modes: [{ id: "default" }] }),
      listFeatures: async () => ({ features: [{ id: "auto_accept", type: "select" }] }),
    },
    agents: { create },
  } as unknown as PaseoApi;
  await expect(
    sdkController(api).create({
      provider: "codex/test-model",
      title: "Developer",
      cwd: "/repo",
      autoAcceptPermissions: true,
      decisionId: "decision",
      labels: {},
    }),
  ).rejects.toThrow("no supported unattended mode or auto-accept toggle was advertised");
  expect(create).not.toHaveBeenCalled();
});

it.each(["modes", "features"])(
  "reports %s discovery failures instead of starting interactively",
  async (failure) => {
    const api = {
      providers: {
        listModes: async () => ({
          modes: [{ id: "full-access" }],
          ...(failure === "modes" ? { error: "catalog unavailable" } : {}),
        }),
        listFeatures: async () => ({
          features: [],
          ...(failure === "features" ? { error: "catalog unavailable" } : {}),
        }),
      },
    } as unknown as PaseoApi;
    await expect(
      kitchenPermissionConfig(api, { provider: "codex/test-model" }, "/repo", true),
    ).rejects.toThrow("Cannot configure Kitchen auto-accept for codex: catalog unavailable");
  },
);

it("requires explicit selection if the provider advertises no default", async () => {
  const api = {
    providers: { listModels: async () => ({ models: [{ id: "other" }] }) },
  } as unknown as PaseoApi;
  await expect(
    sdkController(api).create({
      provider: "codex",
      title: "PO",
      cwd: "/repo",
      initialPrompt: "Plan",
      parentAgentId: "boss",
      decisionId: "decision",
      labels: {},
    }),
  ).rejects.toThrow("no default was advertised");
});

it("targets an explicit home and compares the CLI agent before safe stop and metadata updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-host-control-"));
  const script = join(directory, "cli.mjs");
  const log = join(directory, "calls.jsonl");
  await writeFile(
    script,
    `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, home: process.env.PASEO_HOME}) + '\\n');
if (args[1] === 'inspect') console.log(JSON.stringify({Id:'worker', Provider:'codex', Cwd:'/repo'}));
if (args[1] === 'stop') console.log(JSON.stringify({stoppedCount:0,agentIds:[]}));
`,
  );
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { id: "worker", provider: "codex", cwd: "/repo" } }),
      }),
    },
  } as unknown as PaseoApi;
  try {
    const host = createHostControl(api, {
      daemonHome: directory,
      executable: process.execPath,
      argv: [script],
    });
    await host.cancel("worker");
    await host.update("worker", { title: "$(touch forbidden)", labels: { role: "developer" } });
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["agent", "inspect", "worker"],
      ["agent", "stop", "worker"],
      ["agent", "inspect", "worker"],
      ["agent", "update", "worker"],
    ]);
    expect(
      calls.every(
        (call) =>
          call.home === directory &&
          call.args.at(-3) === "--home" &&
          call.args.at(-2) === directory,
      ),
    ).toBe(true);
    expect(calls[3].args).toContain("$(touch forbidden)");
    expect(calls[3].args).toContain("role=developer");
    await expect(host.moveToWorkspace("worker", "workspace")).rejects.toThrow("not supported");
    await expect(
      host.update("worker", { labels: { role: "developer,admin=true" } }),
    ).rejects.toThrow("cannot be represented");
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(4);
    vi.stubEnv("PASEO_HOME", directory);
    await createHostControl(api, { executable: process.execPath, argv: [script] }).cancel("worker");
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(6);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses a different CLI agent without issuing a mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-host-mismatch-"));
  const script = join(directory, "cli.mjs");
  const log = join(directory, "calls.jsonl");
  await writeFile(
    script,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({Id:'different', Provider:'codex', Cwd:'/repo'}));
`,
  );
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { id: "worker", provider: "codex", cwd: "/repo" } }),
      }),
    },
  } as unknown as PaseoApi;
  try {
    const host = createHostControl(api, {
      daemonHome: directory,
      executable: process.execPath,
      argv: [script],
    });
    await expect(host.cancel("worker")).rejects.toThrow("mutation refused");
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses missing and relative daemon homes instead of falling back to production", async () => {
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { id: "worker", provider: "codex", cwd: "/repo" } }),
      }),
    },
  } as unknown as PaseoApi;
  vi.stubEnv("PASEO_HOME", undefined);
  try {
    await expect(createHostControl(api).cancel("worker")).rejects.toThrow("explicit absolute");
    vi.stubEnv("PASEO_HOME", "relative-home");
    await expect(createHostControl(api).cancel("worker")).rejects.toThrow("explicit absolute");
    await expect(
      createHostControl(api, { daemonHome: "relative-home" }).cancel("worker"),
    ).rejects.toThrow("explicit absolute");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("uses an explicit endpoint without home routing and rejects conflicting or invalid targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-host-endpoint-"));
  const script = join(directory, "cli.mjs");
  const log = join(directory, "calls.jsonl");
  await writeFile(
    script,
    `import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args[1]==='inspect') console.log(JSON.stringify({Id:'worker',Provider:'codex',Cwd:'/repo'}));
if(args[1]==='stop') console.log(JSON.stringify({stoppedCount:0,agentIds:[]}));
`,
  );
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { id: "worker", provider: "codex", cwd: "/repo" } }),
      }),
    },
  } as unknown as PaseoApi;
  const cli = { executable: process.execPath, argv: [script] };
  vi.stubEnv("PASEO_HOME", "/unused-home");
  try {
    await createHostControl(api, { ...cli, daemonHost: "ws://127.0.0.1:4129/ws" }).cancel("worker");
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (args) =>
          args.includes("tcp://127.0.0.1:4129") &&
          args.includes("--host") &&
          !args.includes("--home"),
      ),
    ).toBe(true);
    await expect(
      createHostControl(api, {
        ...cli,
        daemonHost: "127.0.0.1:4129",
        daemonHome: directory,
      }).cancel("worker"),
    ).rejects.toThrow("not both");
    for (const daemonHost of [
      "",
      "--home",
      "bad host",
      "file:///tmp/socket",
      "ws://localhost:4129/other",
    ])
      await expect(createHostControl(api, { ...cli, daemonHost }).cancel("worker")).rejects.toThrow(
        "valid explicit",
      );
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preflights target and CLI availability without SDK access or agent mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-host-preflight-"));
  const script = join(directory, "cli.mjs");
  const log = join(directory, "calls.jsonl");
  await writeFile(
    script,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
console.log('0.11.0');
`,
  );
  const api = {} as PaseoApi;
  try {
    await createHostControl(api, {
      daemonHost: "127.0.0.1:4129",
      executable: process.execPath,
      argv: [script],
    }).preflight();
    expect(JSON.parse((await readFile(log, "utf8")).trim())).toEqual(["--version"]);
    await expect(
      createHostControl(api, {
        daemonHome: directory,
        executable: join(directory, "missing-cli"),
      }).preflight(),
    ).rejects.toThrow("CLI is unavailable");
    await expect(
      createHostControl(api, {
        daemonHome: "relative",
        executable: process.execPath,
        argv: [script],
      }).preflight(),
    ).rejects.toThrow("explicit absolute");
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an exit-zero stop that leaves a Cook running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-stop-unacknowledged-"));
  const script = join(directory, "cli.mjs");
  await writeFile(
    script,
    `const args=process.argv.slice(2);
console.log(JSON.stringify(args[1]==='inspect'?{Id:'worker',Provider:'codex',Cwd:'/repo'}:{stoppedCount:0,agentIds:[]}));
`,
  );
  const refresh = vi.fn(async () => ({
    agent: {
      id: "worker",
      provider: "codex",
      cwd: "/repo",
      status: "running",
      activeTurn: { id: "turn" },
    },
  }));
  const api = { agents: { ref: () => ({ refresh }) } } as unknown as PaseoApi;
  try {
    await expect(
      createHostControl(api, {
        daemonHome: directory,
        executable: process.execPath,
        argv: [script],
      }).cancel("worker"),
    ).rejects.toThrow("did not confirm interruption");
    expect(refresh).toHaveBeenCalledTimes(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("accepts an acknowledged stop only after a fresh SDK snapshot confirms settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-stop-settled-"));
  const script = join(directory, "cli.mjs");
  await writeFile(
    script,
    `const args=process.argv.slice(2);
console.log(JSON.stringify(args[1]==='inspect'?{Id:'worker',Provider:'codex',Cwd:'/repo'}:{stoppedCount:1,agentIds:['worker']}));
`,
  );
  const refresh = vi
    .fn()
    .mockResolvedValueOnce({
      agent: { id: "worker", provider: "codex", cwd: "/repo", status: "running" },
    })
    .mockResolvedValue({
      agent: { id: "worker", provider: "codex", cwd: "/repo", status: "idle" },
    });
  const api = { agents: { ref: () => ({ refresh }) } } as unknown as PaseoApi;
  try {
    await expect(
      createHostControl(api, {
        daemonHome: directory,
        executable: process.execPath,
        argv: [script],
      }).cancel("worker"),
    ).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("forwards the exact native brief images from canonical host history after paging", async () => {
  const refetch = vi
    .fn()
    .mockResolvedValueOnce({
      entries: [],
      hasOlder: true,
      startCursor: { epoch: "history", seq: 20 },
    })
    .mockResolvedValueOnce({
      entries: [
        {
          item: {
            type: "user_message",
            clientMessageId: "native:brief",
            text: "Rendered reference",
            prompt: [
              { type: "text", text: "Actual attached brief text" },
              { type: "image", data: "synthetic-pixels", mimeType: "image/png" },
            ],
          },
        },
      ],
      hasOlder: false,
    });
  const send = vi.fn();
  const api = {
    agents: { ref: (id: string) => (id === "boss" ? { timeline: { refetch } } : { send }) },
  } as unknown as PaseoApi;
  await sdkController(api).send("po", "Plan this mission", undefined, {
    nativeBrief: { agentId: "boss", messageId: "native:brief", requireRich: true },
  });
  expect(refetch.mock.calls[1]![0]).toMatchObject({
    direction: "before",
    projection: "canonical",
    cursor: { epoch: "history", seq: 20 },
  });
  expect(send).toHaveBeenCalledWith(expect.stringContaining("Actual attached brief text"), {
    activeTurnBehavior: undefined,
    images: [{ data: "synthetic-pixels", mimeType: "image/png" }],
  });
});

it("fails closed when a selected rich brief was not persisted or its history is incomplete", async () => {
  const refetch = vi.fn().mockResolvedValue({
    entries: [{ item: { type: "user_message", clientMessageId: "native:brief", text: "[image]" } }],
    hasOlder: false,
  });
  const send = vi.fn();
  const api = {
    agents: { ref: (id: string) => (id === "boss" ? { timeline: { refetch } } : { send }) },
  } as unknown as PaseoApi;
  const controller = sdkController(api);
  await expect(
    controller.send("po", "Plan", undefined, {
      nativeBrief: { agentId: "boss", messageId: "native:brief", requireRich: true },
    }),
  ).rejects.toThrow(/preserve.*images/);
  refetch.mockResolvedValueOnce({
    entries: [
      { item: { type: "user_message", clientMessageId: "native:brief", text: "[image]" } },
      {
        item: {
          type: "user_message",
          clientMessageId: "latest",
          text: "Latest user context",
          prompt: "Latest user context",
        },
      },
    ],
    hasOlder: false,
  });
  await expect(
    controller.send("verifier", "Verify", undefined, {
      nativeInitialBrief: { agentId: "boss", messageId: "native:brief", requireRich: true },
      nativeBrief: { agentId: "boss", messageId: "latest" },
    }),
  ).rejects.toThrow(/preserve.*images/);
  refetch.mockResolvedValueOnce({ entries: [], hasOlder: false, gap: true });
  await expect(
    controller.send("po", "Plan", undefined, {
      nativeBrief: { agentId: "boss", messageId: "native:brief" },
    }),
  ).rejects.toThrow(/incomplete/);
  expect(send).not.toHaveBeenCalled();
});

it("retains the initial native PNG alongside actual follow-ups and deduplicates rich blocks", async () => {
  const initialImage = { type: "image" as const, data: "initial-png", mimeType: "image/png" };
  const prompts: Record<string, unknown> = {
    initial: [{ type: "text", text: "Original attached task" }, initialImage],
    revised: [
      { type: "text", text: "Revised attached task" },
      initialImage,
      { type: "image", data: "revised-png", mimeType: "image/png" },
    ],
    textual: "Preserve original layout",
  };
  const refetch = vi.fn(async () => ({
    entries: Object.entries(prompts).map(([id, prompt]) => ({
      item: {
        type: "user_message",
        clientMessageId: id,
        text: "Rendered text",
        prompt,
      },
    })),
    hasOlder: false,
  }));
  const send = vi.fn();
  const api = {
    agents: { ref: (id: string) => (id === "boss" ? { timeline: { refetch } } : { send }) },
  } as unknown as PaseoApi;
  const controller = sdkController(api);
  await controller.send("reviewer", "Original attached task already in packet", undefined, {
    nativeInitialBrief: { agentId: "boss", messageId: "initial", requireRich: true },
    nativeBrief: { agentId: "boss", messageId: "revised", requireRich: true },
  });
  expect(send).toHaveBeenLastCalledWith(expect.stringContaining("Revised attached task"), {
    activeTurnBehavior: undefined,
    images: [
      { data: "initial-png", mimeType: "image/png" },
      { data: "revised-png", mimeType: "image/png" },
    ],
  });
  expect(send.mock.calls[0]![0].split("Original attached task")).toHaveLength(2);
  await controller.send("verifier", "Verify actual candidate", undefined, {
    nativeInitialBrief: { agentId: "boss", messageId: "initial", requireRich: true },
    nativeBrief: { agentId: "boss", messageId: "textual" },
  });
  expect(send).toHaveBeenLastCalledWith(expect.stringContaining("Preserve original layout"), {
    activeTurnBehavior: undefined,
    images: [{ data: "initial-png", mimeType: "image/png" }],
  });
});

it("does not replace an explicit native client message identity with a conflicting provider ID", async () => {
  const refetch = vi.fn(async () => ({
    entries: [
      {
        item: {
          type: "user_message",
          clientMessageId: "different-client",
          messageId: "selected-client",
          text: "Wrong brief",
          prompt: [{ type: "image", data: "wrong-pixels", mimeType: "image/png" }],
        },
      },
    ],
    hasOlder: false,
  }));
  const send = vi.fn();
  const api = {
    agents: { ref: (id: string) => (id === "boss" ? { timeline: { refetch } } : { send }) },
  } as unknown as PaseoApi;
  await expect(
    sdkController(api).send("verifier", "Verify", undefined, {
      nativeBrief: { agentId: "boss", messageId: "selected-client", requireRich: true },
    }),
  ).rejects.toThrow(/not found/);
  expect(send).not.toHaveBeenCalled();
});
