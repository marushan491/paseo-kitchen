# Workflows

A workflow defines the roles Kitchen runs and the handoffs between stages. Start with a built-in workflow under **Team**. You can edit a variant without replacing the built-in preset. New missions pin the saved revision; an existing mission keeps its snapshot.

## Edit the graph

Choose **Each feature** to edit how an individual task moves through Build, Review and Verify. **Mission delivery** shows how planning, all verified tasks, integration and final verification lead to your acceptance. Its protected gates remain fixed.

- Click a role card to edit its responsibility, skills, model preferences and communication.
- Drag a card to arrange it. Positions affect this editor view; they do not change execution or persist as workflow configuration.
- Drag an output handle onto a destination card or input handle. You can also click an output and then click its destination. This changes that outcome's real handoff.
- Click a connection to inspect its destination, return behavior and file condition. Red routes return work for corrections.
- Scroll or pinch to zoom. Drag the background to pan. **Auto-arrange** restores the readable role layout. **Fit** includes every workflow state. **1:1** restores full-size cards.
- **Show workflow states** reveals waiting and terminal states. **List** provides the same role and handoff controls without canvas gestures and is the default on compact screens.

A connection uses the outcome declared on its source stage: **Done**, **Approved**, **Changes requested**, **Pass** or **Fail**. Dragging moves that outcome's destination. It does not invent new tools or disable verification. Invalid routes are rejected when saved.

## Add a role manually

Click **+ Add role**. Name the role, describe its responsibility and choose the handoff where it belongs. Kitchen inserts a working stage there; its **Done** outcome continues to the handoff's former destination. The handoff starts after Build, so the task's checkout already exists. The new role defaults to read-only access in that worktree. Enable editing only when that responsibility needs it; editing uses an isolated worktree.

For example, insert **Security review** after Review and before Verify. Its instruction could be: “Inspect authentication and permission changes. Record findings with file references.” Refine its routes, communication and condition after adding it. Return findings to Build by editing the existing outcome, or describe the desired multi-outcome change to Kitchen.

**Describe a change to Kitchen** accepts a request such as “Add a security reviewer after Review when auth/ or permissions/ files change; send findings back to Build.” Select project context, preview the structured changes, then confirm. This uses your configured decision provider. It does not apply the request immediately.

Use **Save changes** to persist a variant. Save failures identify the invalid route or gate; your draft remains available to correct. Saving a team does not start a mission or publish code.

## Select skills

**+ Add skill** lists metadata discovered from supported provider and shared skill directories on this host, including project directories for the selected context. Search by name or purpose. Suggestions match the role's responsibility; they do not silently assign skills. Provider preferences filter the catalog. **Refresh skills** reloads it after installation changes.

Adding a skill does not install it. Discovery does not prove a particular harness loaded it; the role agent must confirm availability. Selected names absent from the current context remain visible so you can remove or correct them. Provider, model and thinking preferences are inherited unless you override them.

## Edit and export JSON

Expand **Workflow JSON** below the graph. The editor scrolls independently. **Copy JSON** exports the current text to the client clipboard. **Reload from graph** replaces the text with the current draft. Paste an exported definition or edit it, then click **Validate and apply to draft**. Validation uses Kitchen's runtime rules without starting an agent. Click **Save changes** to persist the validated draft.

JSON is the supported editable format. Unknown fields, malformed JSON, incompatible base versions, unsafe workspaces and routes that bypass review or independent verification are rejected. A new variant needs its own `id` and `revision: 0`; editing an existing variant keeps its ID and current revision. Conflicting saves are rejected instead of overwriting another edit.

The canonical schemas are [workflow-contracts.ts](../shared/workflow-contracts.ts) and [role-profile-contracts.ts](../shared/role-profile-contracts.ts). Use the exported definition from an installed preset as a complete starting point.

### Definition fields

| Field                             | Meaning                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`, `revision`                  | Stable variant ID and optimistic revision counter. IDs use lowercase letters, numbers and hyphens.                |
| `basePackId`, `basePackVersion`   | Installed Standard (`kitchen`) or Basic (`kitchen-single`) baseline and its version.                              |
| `title`                           | Name displayed in the workflow selector.                                                                          |
| `roles`                           | Role definitions keyed by their IDs.                                                                              |
| `boards.root`                     | Protected mission delivery flow.                                                                                  |
| `boards.item`                     | Individual feature flow and custom stages.                                                                        |
| `roleProfiles`, `headChefProfile` | Optional provider, model, thinking, mode, instructions, skills and ordered-step preferences.                      |
| `runtimePolicy`                   | Return bounds and optional delegation limits. Saving pins the baseline's dependency phase.                        |
| `autonomy`                        | Architecture decision preference; requirements, irreversible actions and final acceptance remain human decisions. |

### Stage types

| `kind`     | Behavior                                                                               | Common fields                  |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| `working`  | Runs its assigned role; the agent reports a declared outcome.                          | `role`, `outcomes`             |
| `resting`  | Runtime transition or waiting state; no role agent is started for this stage.          | `next`, `completeWithChildren` |
| `terminal` | Candidate, accepted or canceled state. Acceptance remains a separate runtime decision. | `title`                        |

Every stage has a title. `initialPhase` chooses a board's starting resting stage. Targets must refer to stages on that same board. A role key must match `role.id`.

### Handoffs and conditions

`outcomes` maps reported results to destinations. `next` advances a resting stage. `completeWithChildren` advances only after scoped children have verified results. `maxReturns` optionally bounds correction routes; it does not disable the mission's budgets or protected gates.

A conditional check uses `condition.kind: "changed-files"`, `condition.any` and `skipTo`. Each rule has a relative `prefix`, a file `suffix`, or both. Prefix and suffix within one rule must both match; separate rules are alternatives. Conditional roles are read-only. An unmatched condition must continue through a valid skip chain to independent verification.

This example is an excerpt for a custom item stage, not a complete import:

```json
{
  "security-review": {
    "title": "Security review",
    "kind": "working",
    "role": "security-review",
    "outcomes": { "approve": "verify", "changes": "implement" },
    "condition": {
      "kind": "changed-files",
      "any": [{ "prefix": "auth/" }, { "prefix": "permissions/" }]
    },
    "skipTo": "verify"
  }
}
```

Add a matching entry under `roles`, and redirect the preceding Review approval to this stage. A role includes `id`, `title`, `instructions`, `skills`, `canEdit`, `workspace` and `tools`. Workspaces are `team`, `own-worktree` or `item-worktree`. Editing roles require isolation. Build must create its own worktree; roles using `item-worktree` must follow Build on every reachable route. Only the planning role can use `item_plan`; investigation through `item_request_work` requires that tool to be declared. Verifier's read-only workspace and tools remain protected.

Adding new boards, changing the protected mission flow or skipping independent verification is unsupported. Previewing or saving a workflow grants no permission to publish, merge or deploy.

## Share a workflow on GitHub

Copy the full JSON into a file such as `my-team.json` in your own repository and commit and push it through your normal Git workflow. Another installation can paste it into **Workflow JSON**, validate it against its installed base pack and save its own variant. Check skill names and provider/model preferences on that host; the file does not install dependencies or carry credentials.
