import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi, PaseoAgentCreateOptions } from "@getpaseo/client";
import { sdkController } from "./controller.js";
import { createHostControl } from "./host-control.js";

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
  const calls: PaseoAgentCreateOptions[] = [];
  const api = {
    providers: { listModels: async () => ({ models: [{ id: "raw/model-id", isDefault: true }] }) },
    workspaces: {
      open: async () => ({
        agents: {
          create: async (input: PaseoAgentCreateOptions) => {
            calls.push(input);
            return { id: "worker" };
          },
        },
      }),
    },
    agents: {
      create: async (input: PaseoAgentCreateOptions) => {
        calls.push(input);
        return { id: "worker" };
      },
    },
  } as unknown as PaseoApi;
  await sdkController(api).create({
    provider: "custom-profile",
    title: "PO",
    cwd: "/repo",
    initialPrompt: "Plan",
    parentAgentId: "boss",
    decisionId: "decision",
    labels: {},
  });
  expect(calls[0]!.config.provider).toBe("custom-profile/raw/model-id");
});
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
