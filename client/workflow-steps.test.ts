import { expect, test } from "vitest";
import { resolveWorkflowSteps } from "./workflow-steps.js";

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
