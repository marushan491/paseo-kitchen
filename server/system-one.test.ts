import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { KitchenSystemOne, hostSystemOneConfig } from "./system-one.js";

it("supports standard Paseo hosts through explicit Jev environment configuration while honoring host exclusions and disablement", async () => {
  const home = await mkdtemp(join(tmpdir(), "kitchen-jev-config-"));
  vi.stubEnv("KITCHEN_SYSTEM_ONE_ENABLED", "true");
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ daemon: {} }));
    expect((await hostSystemOneConfig(home)).enabled).toBe(true);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ daemon: { systemOne: { enabled: false, excludedPaths: [home] } } }),
    );
    expect(await hostSystemOneConfig(home)).toMatchObject({
      enabled: false,
      excludedPaths: [home],
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it("uses actual typed choices and human escalation for uncertainty; excludes projects before sending context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kitchen-jev-"));
  try {
    await writeFile(join(cwd, "README.md"), "One small repository");
    const input = {
      cwd,
      title: "Small task",
      objective: "Change one file",
      provider: "codex",
      acceptanceCriteria: [{ id: "check", text: "Independent check" }],
      idempotencyKey: "id",
    };
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-test",
            answers: {
              decision: {
                choice: "single",
                confidence: 0.9,
                probabilities: { single: 0.9, team: 0.05, human: 0.05 },
              },
            },
            usage: { input_tokens: 100, output_tokens: 12 },
          }),
          { status: 200 },
        ),
    );
    const source = new KitchenSystemOne({
      config: async () => ({ enabled: true, minimumConfidence: 0.8 }),
      credentials: async () => ["private-test-key"],
      fetch: fetcher,
    });
    expect(await source.classify(input)).toMatchObject({
      executionMode: "single",
      source: "jev",
      usage: { inputTokens: 100, outputTokens: 12 },
    });
    expect(
      JSON.parse(fetcher.mock.calls[0]![1]!.body as string).state.repository["README.md"],
    ).toBe("One small repository");
    const uncertain = new KitchenSystemOne({
      config: async () => ({ enabled: true, minimumConfidence: 0.95 }),
      credentials: async () => ["private-test-key"],
      fetch: fetcher,
    });
    expect((await uncertain.classify(input)).executionMode).toBe("human");
    const excluded = new KitchenSystemOne({
      config: async () => ({ enabled: true, excludedPaths: [cwd] }),
      credentials: async () => ["private-test-key"],
      fetch: fetcher,
    });
    await expect(excluded.classify(input)).rejects.toThrow("excluded");
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it("does not let a semantic pass authorize missing independent checks", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            decision: {
              choice: "pass",
              confidence: 1,
              probabilities: { pass: 1, return: 0, human: 0 },
            },
          },
        }),
        { status: 200 },
      ),
  );
  const source = new KitchenSystemOne({
    config: async () => ({ enabled: true }),
    credentials: async () => ["test"],
    fetch: fetcher,
  });
  expect(
    (
      await source.judge({
        cwd: "/repo",
        objective: "Verify",
        criteria: [],
        candidateCommit: "a".repeat(40),
        checks: [],
      })
    ).verdict,
  ).toBe("human");
  const bad = new KitchenSystemOne({
    config: async () => ({ enabled: true }),
    credentials: async () => ["test"],
    fetch: async () => new Response("private server diagnostic", { status: 429 }),
  });
  await expect(
    bad.classify({
      cwd: tmpdir(),
      title: "Task",
      objective: "Verify",
      provider: "codex",
      idempotencyKey: "id",
      acceptanceCriteria: [{ id: "check", text: "checked" }],
    }),
  ).rejects.toThrow("HTTP 429");
});
it("never sends a repository symlink's private target to Jev", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kitchen-jev-scope-"));
  try {
    const cwd = join(directory, "repo");
    await (await import("node:fs/promises")).mkdir(cwd);
    const secret = join(directory, "operator-credential");
    await writeFile(secret, "private sentinel must never leave host");
    await symlink(secret, join(cwd, "README.md"));
    const fetcher = vi.fn();
    const source = new KitchenSystemOne({
      config: async () => ({ enabled: true }),
      credentials: async () => ["test"],
      fetch: fetcher,
    });
    await expect(
      source.classify({
        cwd,
        title: "Task",
        objective: "Check",
        provider: "codex",
        idempotencyKey: "id",
        acceptanceCriteria: [{ id: "check", text: "checked" }],
      }),
    ).rejects.toThrow("symlink");
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
