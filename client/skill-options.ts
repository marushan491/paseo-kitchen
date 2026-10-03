import type { InstalledSkill } from "../shared/skill-contracts.js";

const roleWords: Record<string, string> = {
  reviewer: "review quality changes architecture",
  developer: "implement development code software",
  implementer: "implement development code software",
  verifier: "verify test validation testing qa",
  po: "planning requirements specification",
  integrator: "integration merge release",
  "head-chef": "coordination delegation agents factory workflow",
};
const ignored = new Set(
  "this that with from have will your their should must only into each then when role work agent code".split(
    " ",
  ),
);

export function skillOptions(
  skills: InstalledSkill[],
  search: string,
  context: { role?: string; title?: string; instructions?: string },
  selected: string[],
) {
  const query = search.trim().toLocaleLowerCase();
  const words = [
    ...new Set(
      `${roleWords[context.role || ""] || ""} ${context.title || ""} ${context.instructions?.slice(0, 2000) || ""}`
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 3 && !ignored.has(word)),
    ),
  ];
  const unique = [...new Map(skills.map((skill) => [skill.name, skill])).values()];
  const matches = unique.filter((skill) =>
    `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query),
  );
  const ranked = matches
    .filter((skill) => !selected.includes(skill.name))
    .map((skill) => {
      const name = skill.name.toLocaleLowerCase();
      const description = skill.description.toLocaleLowerCase();
      const terms = words.filter((word) => name.includes(word) || description.includes(word));
      return {
        skill,
        terms,
        score: terms.reduce((score, word) => score + (name.includes(word) ? 3 : 1), 0),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, 3);
  const recommended = new Set(ranked.map((entry) => entry.skill.name));
  return {
    suggested: ranked.map(({ skill, terms }) => ({
      name: skill.name,
      description: skill.description,
      providers: skill.providers,
      scope: skill.scope,
      reason: `Matches: ${terms.slice(0, 3).join(", ")}`,
    })),
    available: matches
      .filter((skill) => !recommended.has(skill.name))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function skillProviderStatus(providers: string[], available: string[]): string {
  const advertised = providers.filter((id) => available.includes(id));
  const other = providers.filter((id) => id !== "shared" && !available.includes(id));
  return [
    advertised.length ? `Available: ${advertised.join(", ")}` : "",
    other.length ? `Not advertised: ${other.join(", ")}` : "",
    providers.includes("shared") ? "Shared folder" : "",
  ]
    .filter(Boolean)
    .join(" / ");
}
