import type { WorkflowDefinition } from "../shared/workflow-contracts.js";

export const workflowDesignChoices = {
  security:
    "Add a read-only Security Reviewer after Review only when authentication, authorization or permission files changed; pass to Verify, findings return to Build.",
  database:
    "Add a read-only Database Reviewer after Review only when database, schema, migration or SQL files changed; pass to Verify, findings return to Build.",
  "security-database":
    "Add both conditional Security and Database reviewers after Review and before Verify.",
  "editable-review":
    "Allow the existing Reviewer to edit small fixes directly; approve continues to Verify and changes returns to Build.",
  "read-only-review": "Make the existing Reviewer read-only; corrections return to Build.",
  "review-return":
    "Ensure Reviewer requests changes returns to the existing Developer in Build and approval continues to Verify.",
  "review-head-chef":
    "Route Reviewer clarification to the actual Head Chef session; unresolved human authorization remains with the human.",
  "review-human":
    "Route Reviewer clarification to the human operator through the persisted blocked-item question.",
  "request-work":
    "Allow the chosen role to request bounded work through the existing work-request route.",
  "head-chef-architecture":
    "Route architecture clarification to the actual Head Chef; requirements, irreversible actions and final acceptance remain human decisions.",
  human:
    "No supported structured edit matches the request, the request is ambiguous, or it asks to remove independent verification, human acceptance or host protections. Require clarification without applying anything.",
};

export function applyWorkflowDesign(
  definition: WorkflowDefinition,
  choice: string,
  request: string,
  selectedRole = "reviewer",
): WorkflowDefinition {
  const value = structuredClone(definition);
  const reviewer = value.roles.reviewer;
  const phases = value.boards.item.phases;
  if (choice === "human" || !(choice in workflowDesignChoices))
    throw new Error("Workflow design needs clarification; no supported structured change selected");
  if (["security", "database", "security-database"].includes(choice)) {
    addChecks(value, choice, request);
  } else if (choice === "editable-review" || choice === "read-only-review") {
    reviewer.canEdit = choice === "editable-review";
  } else if (choice === "review-return") {
    phases.review.outcomes!.changes = "implement";
  } else if (choice === "review-head-chef" || choice === "review-human") {
    reviewer.communication = {
      clarification: choice === "review-head-chef" ? "head-chef" : "human",
      investigation: reviewer.communication?.investigation ?? "human",
    };
  } else if (choice === "request-work") {
    const role = value.roles[selectedRole];
    if (!role) throw new Error("Select an existing workflow role before enabling work requests");
    role.tools = [...new Set([...role.tools, "item_request_work" as const])];
    role.communication = {
      clarification: role.communication?.clarification ?? "human",
      investigation: "request-work",
    };
  } else if (choice === "head-chef-architecture") {
    value.autonomy = {
      architecture: "head-chef",
      requirements: "human",
      irreversibleActions: "human",
      finalAcceptance: "human",
    };
  }
  return value;
}

function addChecks(value: WorkflowDefinition, choice: string, request: string) {
  const phases = value.boards.item.phases;
  const checks = choice === "security-database" ? ["security", "database"] : [choice];
  let next = phases.review.outcomes!.approve;
  for (const kind of checks.toReversed()) {
    const id = `${kind}-reviewer`,
      phase = `${kind}-review`;
    if (value.roles[id] || phases[phase])
      throw new Error(`Workflow already contains ${phase}; edit its existing role instead`);
    value.roles[id] = {
      id,
      title: kind === "security" ? "Security Reviewer" : "Database Reviewer",
      instructions: request,
      skills: [],
      canEdit: false,
      workspace: "item-worktree",
      tools: [],
      evidence: true,
      communication: { clarification: "head-chef", investigation: "human" },
    };
    phases[phase] = {
      title: value.roles[id].title,
      kind: "working",
      role: id,
      outcomes: { pass: next, findings: "implement" },
      condition: {
        kind: "changed-files",
        any:
          kind === "security"
            ? [
                { prefix: "auth/" },
                { prefix: "src/auth/" },
                { prefix: "permissions/" },
                { prefix: "src/permissions/" },
                { suffix: ".auth.ts" },
                { suffix: ".permissions.ts" },
              ]
            : [
                { prefix: "database/" },
                { prefix: "db/" },
                { prefix: "migrations/" },
                { prefix: "schema/" },
                { suffix: ".sql" },
                { suffix: ".prisma" },
              ],
      },
      skipTo: next,
    };
    next = phase;
  }
  phases.review.outcomes!.approve = next;
}
