import type { PluginServerContext } from "@getpaseo/plugin/server";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  factorySkillsList,
  type InstalledSkill,
  type SkillCatalog,
} from "../shared/skill-contracts.js";

const knownProviders = ["claude", "codex", "opencode", "copilot", "pi"];
const providerId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const limits = { bytes: 16384, skills: 800, entries: 12000, directories: 2000, depth: 6 };
interface CatalogOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  providers?: string[];
  configuration?: unknown;
  warnings?: string[];
}
interface SkillRoot {
  path: string;
  providers: string[];
  scope: InstalledSkill["scope"];
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).filter((entry) => typeof entry[1] === "string"),
  ) as Record<string, string>;
}
function publicText(value: string) {
  return value
    .replace(/file:\/\/[^\s<>"']+/gi, "[local path]")
    .replace(/\b[A-Za-z]:[\\/][^\s<>"']+/g, "[local path]")
    .replace(/(^|[^\w:/])\/[^\s<>"'`,;)]+/g, "$1[local path]")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10;
    })
    .join("")
    .slice(0, 2048);
}
function scalar(value: string): string | null {
  if (value.startsWith('"')) {
    const quoted = value.match(/^"(?:\\.|[^"\\])*"/);
    if (!quoted || !/^\s*(?:#.*)?$/.test(value.slice(quoted[0].length))) return null;
    try {
      return JSON.parse(quoted[0]) as string;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) {
    const quoted = value.match(/^'((?:''|[^'])*)'/);
    if (!quoted || !/^\s*(?:#.*)?$/.test(value.slice(quoted[0].length))) return null;
    return quoted[1].replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, "").trim();
}
function metadata(content: string): Pick<InstalledSkill, "name" | "description"> | null {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  for (let index = 1; index < end; index++) {
    const match = lines[index].match(/^(name|description):\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    const block = /^[>|][+-]?$/.test(value);
    const continuation: string[] = [];
    while (index + 1 < end && (/^\s+\S/.test(lines[index + 1]) || !lines[index + 1].trim())) {
      continuation.push(lines[++index].trim());
    }
    if (block) value = continuation.join(value.startsWith("|") ? "\n" : " ");
    else if (continuation.length) value = [value, ...continuation].join(" ");
    const parsed = block ? value.trim() : scalar(value);
    if (parsed === null) return null;
    fields[match[1]] = parsed;
  }
  const name = fields.name?.trim();
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(name) || !fields.description?.trim())
    return null;
  return { name, description: publicText(fields.description.trim()) };
}
function profile(configuration: unknown, id: string, env: NodeJS.ProcessEnv) {
  const config = record(configuration);
  const providers = { ...record(config.providers), ...record(record(config.agents).providers) };
  const chain = new Set<string>();
  let base = id;
  const overrides: Record<string, string> = {};
  for (let count = 0; count < 12; count++) {
    if (chain.has(base)) return { base: "", env };
    chain.add(base);
    const settings = record(providers[base]);
    const current = {
      ...strings(settings.env),
      ...strings(record(settings.runtime).env),
    };
    for (const [key, value] of Object.entries(current))
      if (!(key in overrides)) overrides[key] = value;
    if (typeof settings.extends !== "string" || !providerId.test(settings.extends)) break;
    base = settings.extends;
  }
  return { base, env: { ...env, ...overrides } };
}
function configuredDirectory(value: string | undefined, fallback: string, home: string) {
  if (!value?.trim()) return fallback;
  const path = value.trim().replace(/^~(?=$|[\\/])/, home);
  return isAbsolute(path) ? path : fallback;
}
function hostRoots(base: string, home: string, env: NodeJS.ProcessEnv): string[] {
  const config = configuredDirectory(env.XDG_CONFIG_HOME, join(home, ".config"), home);
  if (base === "claude")
    return [
      join(configuredDirectory(env.CLAUDE_CONFIG_DIR, join(home, ".claude"), home), "skills"),
    ];
  if (base === "codex")
    return [join(configuredDirectory(env.CODEX_HOME, join(home, ".codex"), home), "skills")];
  if (base === "opencode")
    return [
      join(configuredDirectory(env.OPENCODE_CONFIG_DIR, join(config, "opencode"), home), "skills"),
    ];
  if (base === "copilot") return [join(home, ".copilot", "skills")];
  if (base === "pi")
    return [
      join(
        configuredDirectory(env.PI_CODING_AGENT_DIR, join(home, ".pi", "agent"), home),
        "skills",
      ),
    ];
  return [];
}
function projectRoot(base: string, cwd: string) {
  const folder = base === "copilot" ? ".github" : `.${base}`;
  return join(cwd, folder, "skills");
}
async function ancestors(cwd: string, home: string) {
  const result: string[] = [];
  let path = await realpath(cwd);
  if (!(await stat(path)).isDirectory()) throw new Error("Choose an existing project directory");
  for (let count = 0; count < 16 && path !== home; count++) {
    result.push(path);
    try {
      await stat(join(path, ".git"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  return result;
}

async function projectAncestors(cwd: string | undefined, home: string, warnings: Set<string>) {
  if (!cwd) return [];
  if (!isAbsolute(cwd)) throw new Error("Choose an absolute project directory");
  try {
    return await ancestors(cwd, home);
  } catch {
    warnings.add("Project skill directories could not be read; host skills are still listed.");
    return [];
  }
}

async function discoveryRoots(
  input: { cwd?: string; provider?: string },
  options: CatalogOptions,
  warnings: Set<string>,
) {
  const home = resolve(options.home ?? homedir());
  const env = options.env ?? process.env;
  const available = (options.providers ?? []).filter((id) => providerId.test(id));
  const selected = input.provider?.split("/")[0].trim();
  if (selected && !providerId.test(selected)) throw new Error("Choose a provider identifier");
  const ids = selected ? [selected] : [...new Set([...knownProviders, ...available])];
  const profiles = ids.map((id) => {
    const resolved = profile(options.configuration, id, env);
    return { id, base: resolved.base, env: resolved.env };
  });
  const sharedProviders = profiles
    .filter((entry) => knownProviders.includes(entry.base))
    .map((entry) => entry.id);
  if (selected && !sharedProviders.length)
    warnings.add(
      "This provider has no known skill directory; shared files do not confirm harness support.",
    );
  if (selected && !available.includes(selected))
    warnings.add("The selected provider is not advertised as available by this host.");
  const roots: SkillRoot[] = [];
  const project = await projectAncestors(input.cwd, home, warnings);
  for (const cwd of project) {
    roots.push({
      path: join(cwd, ".agents", "skills"),
      scope: "project",
      providers: sharedProviders.length ? sharedProviders : ["shared"],
    });
    for (const entry of profiles)
      if (knownProviders.includes(entry.base))
        roots.push({ path: projectRoot(entry.base, cwd), scope: "project", providers: [entry.id] });
  }
  roots.push({
    path: join(home, ".agents", "skills"),
    scope: "host",
    providers: sharedProviders.length ? sharedProviders : ["shared"],
  });
  for (const entry of profiles)
    for (const path of hostRoots(entry.base, home, entry.env))
      roots.push({ path, scope: "host", providers: [entry.id] });
  return { roots, available };
}

export async function discoverSkills(
  input: { cwd?: string; provider?: string },
  options: CatalogOptions = {},
): Promise<SkillCatalog> {
  const warnings = new Set(options.warnings ?? []);
  const { roots, available } = await discoveryRoots(input, options, warnings);
  const skills = new Map<string, InstalledSkill>();
  const files = new Map<string, Pick<InstalledSkill, "name" | "description"> | null>();
  let directories = 0,
    entries = 0;
  const capped = () =>
    files.size >= limits.skills || directories >= limits.directories || entries >= limits.entries;
  const merge = (data: Pick<InstalledSkill, "name" | "description">, root: SkillRoot) => {
    const key = data.name.toLowerCase();
    const existing = skills.get(key);
    if (existing)
      existing.providers = [...new Set([...existing.providers, ...root.providers])].sort();
    else skills.set(key, { ...data, scope: root.scope, providers: [...root.providers].sort() });
  };
  for (const root of roots) {
    if (capped()) break;
    const visited = new Set<string>();
    const visit = async (path: string, depth: number): Promise<void> => {
      if (capped()) return;
      let canonical: string;
      try {
        canonical = await realpath(path);
        if (visited.has(canonical)) return;
        visited.add(canonical);
        directories++;
        const skillPath = join(canonical, "SKILL.md");
        let found = false;
        try {
          const file = await realpath(skillPath);
          if (!files.has(file)) {
            const info = await stat(file);
            if (!info.isFile()) {
              warnings.add("Some skill metadata entries are not regular files and were skipped.");
              return;
            }
            const handle = await open(file, "r");
            try {
              const buffer = Buffer.alloc(limits.bytes);
              const read = await handle.read(buffer, 0, buffer.length, 0);
              files.set(file, metadata(buffer.toString("utf8", 0, read.bytesRead)));
            } finally {
              await handle.close();
            }
          }
          const data = files.get(file);
          if (data) merge(data, root);
          else
            warnings.add(
              "Some skills have missing, invalid or oversized frontmatter and were skipped.",
            );
          found = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            warnings.add("Some skill metadata could not be read and was skipped.");
        }
        if (found) return;
        if (depth >= limits.depth) {
          warnings.add(
            "Skill discovery reached its directory depth limit; the catalog may be incomplete.",
          );
          return;
        }
        const directory = await opendir(canonical);
        for await (const entry of directory) {
          entries++;
          if (capped()) break;
          if (entry.isDirectory() || entry.isSymbolicLink())
            await visit(join(canonical, entry.name), depth + 1);
        }
      } catch (error) {
        if (depth > 0 || (error as NodeJS.ErrnoException).code !== "ENOENT")
          warnings.add("Some skill directories could not be read and were skipped.");
      }
    };
    await visit(root.path, 0);
  }
  if (capped())
    warnings.add("Skill discovery reached its size limit; the catalog may be incomplete.");
  return {
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    providers: [...new Set(available)].sort(),
    warnings: [...warnings],
    source: "filesystem",
  };
}

export function registerSkills(server: PluginServerContext) {
  server.handle(factorySkillsList, async (input, { paseo }) => {
    const warnings: string[] = [];
    const [availability, config] = await Promise.allSettled([
      paseo.providers.listAvailable(),
      paseo.config.get(),
    ]);
    const providers =
      availability.status === "fulfilled"
        ? availability.value.providers
            .filter((entry) => entry.available)
            .map((entry) => entry.provider)
        : [];
    if (
      availability.status === "rejected" ||
      (availability.status === "fulfilled" && availability.value.error)
    )
      warnings.push(
        "Host provider availability could not be fully read; folder discovery does not confirm provider availability.",
      );
    if (config.status === "rejected")
      warnings.push(
        "Provider profile settings could not be read; only standard skill directories are included.",
      );
    return discoverSkills(input, {
      providers,
      configuration: config.status === "fulfilled" ? config.value.config : undefined,
      warnings,
    });
  });
}
