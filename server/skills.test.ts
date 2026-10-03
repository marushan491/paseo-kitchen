import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SkillCatalogSchema } from "../shared/skill-contracts.js";
import { discoverSkills } from "./skills.js";

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kitchen-skill-discovery-"));
  home = join(root, "home");
  await mkdir(home);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function skill(path: string, name: string, description = "Installed skill metadata") {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nPRIVATE BODY SECRET\n`,
  );
}
function options() {
  return { home, env: {}, providers: ["codex", "claude", "opencode"] };
}

it("lists inherited host skills with truthful provider tags and no body", async () => {
  await skill(join(home, ".agents", "skills", "shared"), "shared-skill");
  await skill(join(home, ".codex", "skills", "private"), "codex-skill");
  await skill(join(home, ".claude", "skills", "private"), "claude-skill");
  await skill(join(home, ".config", "opencode", "skills", "private"), "opencode-skill");
  const result = await discoverSkills({}, options());
  expect(result.skills.map((value) => value.name)).toEqual([
    "claude-skill",
    "codex-skill",
    "opencode-skill",
    "shared-skill",
  ]);
  expect(result.skills.find((value) => value.name === "codex-skill")).toMatchObject({
    providers: ["codex"],
    scope: "host",
  });
  expect(result.skills.find((value) => value.name === "shared-skill")?.providers).toContain(
    "opencode",
  );
  expect(result.providers).toEqual(["claude", "codex", "opencode"]);
  expect(result.source).toBe("filesystem");
  expect(result.warnings).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE BODY SECRET");
  expect(SkillCatalogSchema.safeParse(result).success).toBe(true);
});

it("filters discovery to the selected provider without guessing inherited configuration", async () => {
  await skill(join(home, ".agents", "skills", "shared"), "shared-skill");
  await skill(join(home, ".codex", "skills", "codex"), "codex-skill");
  await skill(join(home, ".claude", "skills", "claude"), "claude-skill");
  const result = await discoverSkills({ provider: "codex/model-id" }, options());
  expect(result.skills.map((value) => value.name)).toEqual(["codex-skill", "shared-skill"]);
  expect(result.skills.every((value) => value.providers.join() === "codex")).toBe(true);
});

it("merges canonical names and symlinked files across providers without following cycles forever", async () => {
  const shared = join(home, ".agents", "skills");
  await skill(join(shared, "common"), "same-skill");
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  await symlink(join(shared, "common"), join(home, ".codex", "skills", "alias"), "dir");
  await symlink(shared, join(shared, "cycle"), "dir");
  await skill(join(home, ".claude", "skills", "different"), "same-skill", "Alternate metadata");
  const result = await discoverSkills({}, options());
  expect(result.skills).toHaveLength(1);
  expect(result.skills[0].providers).toEqual(["claude", "codex", "copilot", "opencode", "pi"]);
  expect(result.skills[0].description).toBe("Installed skill metadata");
  expect(result.warnings).toEqual([]);
});

it("discovers current-project ancestors and prefers the nearest project description", async () => {
  const project = join(root, "projects", "selected");
  const cwd = join(project, "packages", "client");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await skill(join(project, ".agents", "skills", "one"), "project-skill", "Root description");
  await skill(
    join(project, "packages", ".agents", "skills", "one"),
    "project-skill",
    "Nearest description",
  );
  await skill(join(home, ".agents", "skills", "one"), "project-skill", "Host description");
  await skill(join(root, "projects", ".codex", "skills", "outside"), "outside-project");
  const result = await discoverSkills({ cwd, provider: "codex" }, options());
  expect(result.skills).toEqual([
    {
      name: "project-skill",
      description: "Nearest description",
      providers: ["codex"],
      scope: "project",
    },
  ]);
  expect(result.warnings).toEqual([]);
});

it("reads quoted, folded and literal metadata without treating body text as metadata", async () => {
  await skill(
    join(home, ".agents", "skills", "quoted"),
    '"quoted-skill"   ',
    "'It''s metadata: useful # words' # comment",
  );
  await skill(
    join(home, ".agents", "skills", "folded"),
    "folded-skill",
    ">-\n  First line\n  second line.",
  );
  await skill(
    join(home, ".agents", "skills", "literal"),
    "literal-skill",
    "|-\n  First line\n  second line.",
  );
  const result = await discoverSkills({}, options());
  expect(result.skills.map(({ description }) => description)).toEqual([
    "First line second line.",
    "First line\nsecond line.",
    "It's metadata: useful # words",
  ]);
  expect(result.warnings).toEqual([]);
});

it("bounds reads to frontmatter even when the body is large and rejects oversized metadata", async () => {
  const valid = join(home, ".agents", "skills", "large-body");
  await skill(valid, "large-body");
  await writeFile(
    join(valid, "SKILL.md"),
    `---\nname: large-body\ndescription: Brief metadata\n---\n${"BODY SECRET ".repeat(50000)}`,
  );
  await skill(join(home, ".agents", "skills", "large-header"), "large-header", "x".repeat(20000));
  const result = await discoverSkills({}, options());
  expect(result.skills).toEqual([
    {
      name: "large-body",
      description: "Brief metadata",
      scope: "host",
      providers: ["claude", "codex", "copilot", "opencode", "pi"],
    },
  ]);
  expect(result.warnings.join()).toContain("frontmatter");
  expect(JSON.stringify(result)).not.toContain("BODY SECRET");
});

it("redacts local paths from descriptions and never returns scan paths or raw read errors", async () => {
  await skill(
    join(home, ".agents", "skills", "paths"),
    "paths-skill",
    `Use ${home}/secret and path=${home}/private with /Users/private/file, C:\\private\\file and FILE:///home/private/file. Online https://example.test/docs is fine.`,
  );
  const result = await discoverSkills({ cwd: join(root, "missing-project") }, options());
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(home);
  expect(serialized).not.toContain("/Users/");
  expect(serialized).not.toContain("C:\\\\private");
  expect(serialized.toLowerCase()).not.toContain("file://");
  expect(serialized).toContain("https://example.test/docs");
  expect(result.warnings).toEqual([
    "Project skill directories could not be read; host skills are still listed.",
  ]);
});

it("resolves provider profile inheritance and runtime homes without reading the wrong account", async () => {
  const custom = join(root, "business-codex");
  await skill(join(custom, "skills", "business"), "business-skill");
  await skill(join(home, ".codex", "skills", "wrong"), "wrong-account-skill");
  const result = await discoverSkills(
    { provider: "business" },
    {
      ...options(),
      providers: ["business"],
      configuration: {
        providers: {
          business: { extends: "base", env: { CODEX_HOME: custom } },
          base: { extends: "codex" },
        },
      },
    },
  );
  expect(result.skills.map((value) => value.name)).toEqual(["business-skill"]);
  expect(result.skills[0].providers).toEqual(["business"]);
  expect(result.providers).toEqual(["business"]);
  expect(result.warnings).toEqual([]);
});

it("keeps shared discovery explicit for unknown providers rather than claiming harness availability", async () => {
  await skill(join(home, ".agents", "skills", "shared"), "shared-skill");
  const result = await discoverSkills(
    { provider: "custom-acp" },
    { ...options(), providers: ["custom-acp"] },
  );
  expect(result.skills[0].providers).toEqual(["shared"]);
  expect(result.warnings.join()).toContain("do not confirm harness support");
});

it("reports broken symlinks and nonregular metadata with safe warnings", async () => {
  const skills = join(home, ".agents", "skills");
  await mkdir(join(skills, "invalid", "SKILL.md"), { recursive: true });
  await symlink(join(root, "gone"), join(skills, "broken"), "dir");
  const result = await discoverSkills({}, options());
  expect(result.skills).toEqual([]);
  expect(result.warnings.join()).toContain("not regular files");
  expect(result.warnings.join()).toContain("could not be read");
  expect(JSON.stringify(result)).not.toContain(root);
});

it("bounds recursion depth and makes a partial catalog visible", async () => {
  await skill(join(home, ".agents", "skills", "a", "b", "c", "d", "e", "f", "g"), "too-deep");
  const result = await discoverSkills({}, options());
  expect(result.skills).toEqual([]);
  expect(result.warnings.join()).toContain("depth limit");
});

it("rejects relative project paths and invalid provider identifiers without returning them", async () => {
  await expect(discoverSkills({ cwd: dirname("relative/file") }, options())).rejects.toThrow(
    "absolute project directory",
  );
  await expect(discoverSkills({ provider: "../private" }, options())).rejects.toThrow(
    "provider identifier",
  );
});
