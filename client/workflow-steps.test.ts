import { expect, test } from "vitest";
import { resolveWorkflowSteps } from "./workflow-steps.js";
import { skillOptions, skillProviderStatus } from "./skill-options.js";
import { parseWorkflowSource } from "./workflow-source.js";
import { kitchenPack } from "../server/pack.js";
import { definitionFromPack, validateDefinition } from "../server/workflow-definitions.js";

const original = [
  {
    id: "verify-release",
    title: "Verify release",
    instructions: "Inspect release metadata.\nCompare signatures.",
  },
  { id: "document", title: "Record evidence", instructions: "Save verified evidence." },
];

test("saving another workflow field keeps structured step identities, titles and multiline instructions unchanged", () => {
  const text = original.map((step) => step.instructions).join("\n");
  expect(resolveWorkflowSteps(original, text, false)).toBe(original);
  expect(resolveWorkflowSteps(undefined, "", false)).toBeUndefined();
});

test("an intentional step-field edit replaces steps by the declared line format and permits clearing", () => {
  expect(
    resolveWorkflowSteps(original, " Inspect the result. \n\n Record evidence. ", true),
  ).toEqual([
    { id: "step-1", title: "Inspect the result.", instructions: "Inspect the result." },
    { id: "step-2", title: "Record evidence.", instructions: "Record evidence." },
  ]);
  expect(resolveWorkflowSteps(original, "", true)).toEqual([]);
  expect(original[0].id).toBe("verify-release");
});

test("skill search uses actual descriptions, suggests contextual skills and avoids selected duplicates", () => {
  const review = {
    name: "codex-review",
    description: "Review a pull request against requirements",
    providers: ["codex"],
    scope: "host" as const,
  };
  const taste = {
    name: "design-taste-frontend",
    description: "Interface redesign and usability",
    providers: ["opencode"],
    scope: "project" as const,
  };
  const skills = [review, taste, review];
  expect(skillOptions(skills, "taste", { role: "reviewer" }, []).available).toEqual([taste]);
  expect(
    skillOptions(skills, "", { role: "reviewer" }, []).suggested.map((skill) => skill.name),
  ).toEqual([review.name]);
  expect(skillOptions(skills, "", { role: "reviewer" }, [review.name]).suggested).toEqual([]);
  expect(skillOptions(skills, "no-such-skill", {}, []).available).toEqual([]);
});

test("workflow JSON roundtrips and rejects malformed, oversized and silently discarded fields", () => {
  const definition = definitionFromPack(kitchenPack, "json-roundtrip");
  expect(parseWorkflowSource(JSON.stringify(definition))).toEqual(definition);
  expect(() => parseWorkflowSource("{missing quotes}")).toThrow("Invalid JSON");
  expect(() => parseWorkflowSource(" ".repeat(256_001))).toThrow("256 KB");
  const unknown = {
    ...definition,
    roles: { ...definition.roles, reviewer: { ...definition.roles.reviewer, surprise: true } },
  };
  expect(() => parseWorkflowSource(JSON.stringify(unknown))).toThrow("roles.reviewer.surprise");
  const unsafe = structuredClone(definition);
  unsafe.boards.item.phases.review.outcomes!.approve = "ready-for-human";
  expect(() =>
    validateDefinition(parseWorkflowSource(JSON.stringify(unsafe)), kitchenPack),
  ).toThrow("Every completion path");
});

test("separates discovered provider folders from providers actually advertised by the host", () => {
  expect(skillProviderStatus(["codex", "claude", "codex-plus"], ["codex-plus", "claude"])).toBe(
    "Available: claude, codex-plus / Not advertised: codex",
  );
  expect(skillProviderStatus(["shared"], [])).toBe("Shared folder");
});
