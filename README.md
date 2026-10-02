# Kitchen

A portable Paseo plugin for the existing PandaOS Kitchen workflow. A Head Chef coordinates planned work, isolated developer worktrees, editable reviews, independent verification, combined integration and human acceptance. The plugin owns its persisted jobs, bindings, queue, evidence, runtime limits and schedules. It uses public Paseo APIs and the public host CLI.

The hierarchy is inspired by [Agent Crew](https://paseo.cafe/plugins/agent-crew/). No Agent Crew code is included. LICENSE and NOTICE identify the PandaOS, Paseo and Mastra adaptations.

## Install and configure

The plugin-only repository is [marushan491/paseo-kitchen](https://github.com/marushan491/paseo-kitchen). Clone it using an account with access to that private repository. The Paseo fork is a testbed; installing the plugin does not require that fork.

Install the cloned directory on the target host:

```sh
paseo plugin install /absolute/path/to/kitchen-plugin
```

For PandaOS, use `pandaos plugin install` with the same directory. Enable plugins on that host. Open Kitchen settings and configure:

| Setting                   | Value                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data directory            | Leave empty when the host provides plugin storage. Otherwise choose an absolute directory outside all project checkouts, dedicated to this installation. |
| Daemon home               | The absolute home of this host. An explicit inherited `PASEO_HOME` also works.                                                                           |
| Daemon endpoint           | Alternative to Daemon home, pointing to this same host. Do not set both.                                                                                 |
| CLI executable            | `paseo`, `pandaos`, or the absolute path to the installed CLI.                                                                                           |
| CLI arguments             | Optional argument prefix when the executable is a launcher.                                                                                              |
| Pack directory            | Optional absolute directory containing trusted `<pack>/pack.mjs` modules.                                                                                |
| Maximum concurrent agents | One through four across this plugin's managed teams.                                                                                                     |

Reload the plugin after changing storage, host, CLI or pack settings. Concurrency updates apply immediately. Kitchen preflight checks the configured CLI before creating agents. Every CLI mutation compares the selected agent with the public SDK snapshot to prevent operation against the wrong daemon. There is no implicit production-host fallback.

## Run a Kitchen

Open Kitchen from the workspace Explorer or Command Center. From an agent, choose **Hand off to Kitchen** to retain a source link and its provider/model/mode/thinking settings. You can also start from a project and explicitly select a provider and model.

Enter a goal and observable acceptance criteria. Choose the Kitchen pack, a fixed or self-organizing workflow, and an optional feature/bug/maintenance classification. Duplicate submissions keep the same request identity; a reused identity with different content is rejected.

The Kitchen pack runs:

- PO planning into bounded work items with dependencies and conflicts.
- Developer in an isolated worktree → editable Reviewer → independent Verifier.
- Verified dependency commits into dependent worktrees.
- An isolated Integrator combining the verified results → an independent final Verifier.
- **Ready for human**. Acceptance requires criterion evidence, no running Cooks, a clean checkout and the actual verified final Git HEAD.

Acceptance records the human and commit. Source checkouts are preserved; accepting a run does not deploy it or merge into the source branch.

Use Teamchat to answer requests for human input: the plugin records the answer, resumes blocked work and sends the actual Boss message. Agent Pool exposes read-only, paginated Cook histories. Auftrag contains the board, verification, insights and safety state. Job records remain reachable independently of native agent tabs.

Pause stops new dispatch while current turns finish. Stop interrupts managed turns and leaves the run resumable. Cancel closes the run. Failed decisions and malformed reports retain their evidence and use bounded retry or human escalation. Reload retains running workers and recovers validated reports before sending new work.

## Packs, delegation and schedules

Built-in packs are `kitchen`, `kitchen-insights`, `kitchen-gardener`, and the previous `software-basic` workflow. Insights/Gardener produce read-only proposals from recorded events and metrics; they do not execute their recommendations or claim product verification.

Self-organizing Kitchens accept bounded additional work requests from authorized active roles: at most two delegation levels and ten delegated items. Requests have stable identities, criteria and dependencies. Fixed Kitchens reject these requests.

Schedules use the same Kitchen service and durable start identities. The UI supports cron, explicit time zones, run limits, expiry, pause/resume, manual kickoff, edits and deletion. Missing time zones mean UTC. A pending kickoff survives reload; lost success responses retry the same identity. Missed historical slots do not create a burst of backfilled jobs. Run history reports kickoff success or failure; delivery status belongs to the linked Kitchen.

Repository role selection lives in `.agent-factory/project.json`:

```json
{
  "workflowPack": "kitchen",
  "roles": {
    "developer": {
      "provider": "codex",
      "model": "your-advertised-model-id",
      "thinking": "your-supported-thinking-id",
      "mode": "your-supported-mode-id"
    }
  }
}
```

Only use IDs advertised by the host. Unspecified roles inherit the chosen Head Chef profile. Worker instructions require no private company skills or PandaOS-specific MCP tools.

## Reports

A worker finishes with exactly one `factory-report` JSON fence containing `report.outcome` and `report.summary`. Optional artifacts are objects with `kind`, `ref` and optional `note`; criterion evidence uses `id`, `met` and `evidence`. PO reports also contain an `items` array with item keys, goals, acceptance criteria and dependency/conflict keys. Authorized self-organizing roles can include `workRequests` beside the report.

Reports are validated against the active binding and phase. Verification checks the actual checkout rather than accepting a claimed commit hash. Reports and plans are committed atomically; stale, duplicate or invalid reports cannot silently advance the run.

## Host boundaries

The manifest targets Paseo/PandaOS 0.9.1 through 0.11.x. Newer hosts provide eager plugin API and storage; older hosts need explicit storage and host configuration. Configured older hosts bootstrap their own public SDK connection so persisted schedules resume without opening the UI. For a password-protected older host, configure its local Daemon home and preserve its existing `PASEO_PASSWORD` environment source; passwords are never stored in plugin settings. The plugin remains optional and uses its own `agent-factory.*` labels and state. Existing built-in PandaOS jobs continue in their existing coordinator; this plugin does not migrate those jobs.

The public plugin API cannot veto native agent/workspace archiving, globally hide Cook tabs, replace the native Boss chat renderer, or move an existing agent into another workspace. This plugin keeps jobs in its own accessible UI and reports unsupported moves explicitly. It does not claim native enforcement of those features.

Time limits cover measured active role time: 60 minutes per role and four accumulated hours per run, with at most four active Cooks. Provider-wide quotas, model fallback and hard sandbox policies remain host responsibilities. The recorded token threshold applies only when trustworthy per-agent totals are available. Current public SDK snapshots do not expose universally cumulative totals, so the UI displays unavailable usage and does not claim an enforceable exact token budget. Read-only role instructions do not replace provider permissions.

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm run lint
npm run format:check
npm run test -- server/service.test.ts
```

The testbed's existing targeted suites cover persistence, claims, global capacity, delegation, recovery, interruption, Git verification, schedules, SDK adapters and client behavior. The installed-plugin test exercises two dependent items, a Reviewer code change, a failed verification and return, actual integration, reload and explicit human acceptance. Compatibility and live UI evidence are recorded separately from deterministic fixtures.
