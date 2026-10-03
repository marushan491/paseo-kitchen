import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../shared/workflow-contracts.js";

function unknownField(input: unknown, parsed: unknown, path = ""): string | undefined {
  if (!input || typeof input !== "object" || !parsed || typeof parsed !== "object") return;
  const source = input as Record<string, unknown>;
  const target = parsed as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const next = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(target, key)) return next;
    const nested = unknownField(source[key], target[key], next);
    if (nested) return nested;
  }
}

export function parseWorkflowSource(text: string): WorkflowDefinition {
  if (text.length > 256_000) throw new Error("Workflow JSON must be under 256 KB.");
  let source: unknown;
  try {
    source = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON. Check quotes, commas and brackets.");
  }
  const parsed = WorkflowDefinitionSchema.safeParse(source);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue.path.join(".") || "Workflow"}: ${issue.message}`);
  }
  const unknown = unknownField(source, parsed.data);
  if (unknown) throw new Error(`Unknown field: ${unknown}. See the workflow format guide.`);
  return parsed.data;
}
