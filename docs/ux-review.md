# Kitchen Studio UI review — 2026-10-03

The Team editor supports moving stages, dragging or tapping real output/input ports, wheel zoom, pan, Fit and Auto-arrange. Roles can be inserted manually after Build. Skills come from discovered host/project metadata, with suggestions and explicit provider availability. Workflow JSON can be edited, validated, copied and saved.

## Verified walkthrough

The review used an owned window of the installed Mac Electron app connected to an isolated PandaOS dev host. Desktop was 1500 × 1050; compact was 430 × 950. It made zero inference calls and started zero agents. The user’s main window and daemon were left running.

| Task                                  | Evidence                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Move a stage and restore its position | Actual mouse drag changed coordinates; Auto-arrange restored them                                                   |
| Connect stages                        | Output drag and tap-to-connect opened the real outcome inspector; a saved route was read back from storage          |
| Add a role                            | A read-only Accessibility stage was saved between Build and Review with its declared Done destination               |
| Choose skills                         | Searching `taste` found `design-taste-frontend`; adding/removing it updated the draft                               |
| Use small choice menus                | Both communication dialogs offered their two choices without a search field                                         |
| Edit JSON                             | Malformed JSON and protected-policy changes were rejected; valid edits were applied and saved                       |
| Keep the JSON field usable            | Its own wheel scroll moved 300 pixels while the outer page stayed still; copied text matched the editor’s SHA-256   |
| Validate safely                       | The field became read-only while checking, then editable again; success feedback remained visible                   |
| Use a compact window                  | List, role/skill sheets and JSON remained usable without horizontal page overflow; optional graph wheel zoom worked |

The five Studio pages, all four Settings sections, expanded settings, team rules, role presets and the editor dialogs were also opened. The isolated Overview showed its real missing-dashboard-storage setup message. No schedule, migration, improvement rule or AI preview was executed. Live mission execution is covered by the earlier free OpenCode receipts in [the screenshot manifest](screenshots/captures.json).

## Automated accessibility result

[axe-core 4.13.0](https://github.com/dequelabs/axe-core) checked 31 UI states using WCAG 2 A/AA, WCAG 2.1 AA, WCAG 2.2 AA and best-practice rules. The final snapshots reported **zero violations and zero horizontal page overflows**. Counts and outstanding manual checks are in [the audit results](ux-audit.json).

The first pass found missing tab-list semantics, unnamed/nested dialogs and undersized graph ports. Those findings were corrected before the final pass.

axe could not determine some text backgrounds in Electron’s composited surface and marked contrast checks incomplete. It also marked non-text disclosure glyphs for review. These are not automated passes. Visual inspection found readable text in the captured screens; the configured foreground/surface contrast is 17.21:1, muted text 7.46–8.15:1, and primary-button text 6.09:1. Token ratios do not prove every rendered contrast or full WCAG compliance.

## UX assessment

**Manual heuristic rating: 4/5.** This is a Taste-informed design review, separate from axe’s accessibility result and not a user study.

| Area                       | Rating | Reason                                                                                                                |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| Understanding the workflow | 4/5    | Mission delivery and Each feature have separate explanations; stage and outcome labels are consistent                 |
| Direct control             | 4/5    | Visible ports support drag and tap; zoom, Fit and Auto-arrange work; protected mission gates remain explicit          |
| Feedback and recovery      | 4/5    | Draft status, validation errors, pending state, discard and revision-conflict protection are available                |
| Compact use                | 4/5    | List is the default, details open in sheets and the page has no horizontal overflow; the graph still needs more space |

Native Android/iOS gestures, screen-reader navigation and a moderated first-use study remain unverified. AI team design was not re-run because this check must not use paid models. [Workflow usage and format](workflows.md) explain the supported editing boundaries.
