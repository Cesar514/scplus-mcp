# CLI Overflow Fixes and scplus Rename ExecPlan

This ExecPlan must be maintained in accordance with `/home/cesar514/.codex/.agent/PLANS.md`. The goal is to make the human operator console readable in a normal terminal again and to finish the public naming migration so operators and agents invoke `scplus-mcp` and `scplus-cli` consistently. After this change, the activity pane will only show short issue and log previews, operators can open the full issue or log in dedicated views with `/issue` and `/log`, the slash-command list will stay bounded while typing `/`, and the published docs and configs will advertise the new `scplus-*` names instead of the older `contextplusplus*` names.

## Progress

- [x] (2026-04-03 11:40Z) Identified the goal, inspected `cli/internal/ui/model.go` and `cli/internal/ui/model_test.go`, and confirmed the current overflow behavior and command palette layout.
- [x] (2026-04-03 11:41Z) Added the current-goal entries to `TODO.md` so the active work is tracked separately from the longer v1.5 backlog.
- [ ] Implement the CLI preview truncation helpers, `/issue` and `/log` command actions, and bounded slash-command suggestion scrolling in `cli/internal/ui/model.go`.
- [ ] Add and update Go UI regression tests in `cli/internal/ui/model_test.go` so the new previews and commands are verified.
- [ ] Migrate the public executable, MCP, skill, docs, and config naming to `scplus-mcp` and `scplus-cli` without changing the `.contextplus/` state directory contract.
- [ ] Run focused tests, repo lint, and stale-name search checks; then update TODO bookkeeping and create the requested commit.

## Surprises & Discoveries

- Observation: The prepared full Context+ index is currently invalid for exact-query tools because `TODO_COMPLETED.md` is larger than the configured indexed text limit, so `outline`, `word`, and related exact-query surfaces fail loudly even though structural tools such as `tree` still work.
  Evidence: `contextplus outline` reported `index-status is failed` with `TODO_COMPLETED.md: refresh would remove an indexed file without replacement: text index candidate exceeds max embed file size (52718 > 51200)`.
- Observation: The activity shell already has a dedicated full logs pane, but the compact activity panel still renders the latest log and last error as unbounded or single-line truncations rather than a proper three-line preview contract.
  Evidence: `renderActivityShell` and `renderActivityPanel` in `cli/internal/ui/model.go` print `activeJob.Message`, `m.lastError`, and the latest log inline; only the logs pane uses a viewport.

## Decision Log

- Decision: Keep the stable `.contextplus/` repo-local state directory unchanged during this naming migration.
  Rationale: The user explicitly called out the public executable and MCP naming migration, while prior repo instructions still treat `.contextplus/` as the durable state contract. Changing both concerns at once would widen blast radius without being necessary for the requested CLI and naming fixes.
  Date/Author: 2026-04-03 / Codex
- Decision: Use targeted explicit edits instead of a single mass rename command.
  Rationale: The repository mixes product branding, stable storage names, temporary directory fixtures, external skill assets, and actual Go module import paths. A blind rename would likely break the build or the product contract.
  Date/Author: 2026-04-03 / Codex

## Outcomes & Retrospective

This section will be updated after implementation and verification so a fresh reader can compare the final behavior against the original goal.

## Context and Orientation

The human operator console lives in `/home/cesar514/Documents/agent_programming/contextplus/cli/internal/ui/model.go`. The `Model` type stores the last backend error in `lastError`, appends backend and operator lines to `logs`, and renders the activity pane through `renderActivityShell` and `renderActivityPanel`. Slash commands are defined in `paletteCommands()` and executed through `submitCommandBar()` and `executePaletteAction()`. The console uses “views”, which are named panes such as `viewOverview`, `viewLogs`, and `viewDoctor`, to switch between overview text, search results, and the logs viewport. The regression tests for this behavior are in `/home/cesar514/Documents/agent_programming/contextplus/cli/internal/ui/model_test.go`.

The public MCP server and npm package entrypoints live in `/home/cesar514/Documents/agent_programming/contextplus/src/index.ts`, `/home/cesar514/Documents/agent_programming/contextplus/src/cli-launcher.ts`, and `/home/cesar514/Documents/agent_programming/contextplus/package.json`. The Go human CLI binary entrypoint is `/home/cesar514/Documents/agent_programming/contextplus/cli/cmd/contextplusplus-cli/main.go`, and the Go module path is currently declared in `/home/cesar514/Documents/agent_programming/contextplus/cli/go.mod`. Codex init templates for MCP config output are built in `/home/cesar514/Documents/agent_programming/contextplus/src/cli/command-utils.ts`, while the user-facing installation and configuration docs are in `/home/cesar514/Documents/agent_programming/contextplus/README.md` and the landing app under `/home/cesar514/Documents/agent_programming/contextplus/landing/`.

The external skill surface to rename is outside the repository root at `/home/cesar514/.codex/skills/contextplus-mcp/`, and the local Codex MCP config to rename is `/home/cesar514/.codex/config.toml`. Those assets must be kept in sync with the new `scplus-mcp` public name so the local agent setup matches the repo docs.

## Plan of Work

Start with the operator console because it has the narrowest blast radius and the user listed those usability problems first. In `cli/internal/ui/model.go`, add a small helper that wraps text to the available pane width, clamps previews to three rendered lines, and appends an ellipsis marker when content exceeds the preview budget. Reuse that helper for the active issue preview, the activity panel issue preview, and the latest-log preview so both wide and narrow layouts follow the same contract. Extend `paletteCommands()` with `/issue` and `/log`, and wire them through `executePaletteAction()` so `/issue` opens a dedicated text section populated from the full current error while `/log` opens the existing logs pane or a dedicated full log view. Limit slash-command suggestion rendering to a fixed small window and keep using selection-based scrolling rather than resizing the whole activity pane around the list.

After the UI behavior is stable, update `/home/cesar514/Documents/agent_programming/contextplus/cli/internal/ui/model_test.go` with direct tests for three-line previews, ellipsis behavior, `/issue`, `/log`, and bounded command suggestion rendering. Then migrate the public naming. Rename package metadata, launcher names, Go CLI entrypoint folder and imports, MCP server `name`, init config templates, docs, landing copy, and the local Codex config from the older public names to `scplus-mcp` and `scplus-cli`. Preserve internal `.contextplus` paths and environment variable prefixes unless a specific public-facing string truly needs the new name.

Finish by running focused Go UI tests, the main TypeScript test and lint surfaces that cover init/config generation and package entrypoints, and repo-wide search checks for stale user-facing names. Once verification passes, update `TODO.md` and `TODO_COMPLETED.md` so only incomplete items remain in `TODO.md`, then create one commit covering the new CLI behavior and naming migration.

## Concrete Steps

Work from `/home/cesar514/Documents/agent_programming/contextplus`.

Run focused UI tests while iterating:

    pixi run test-cli

Or, when a faster focused loop is needed:

    cd cli && go test ./internal/ui -run 'Test(Activity|Palette|Logs)'

Run the TypeScript verification surfaces after the rename:

    npm test
    npm run build

Run repo lint after the code and doc changes:

    # via Context+ MCP
    lint target_path="."

Run stale-name checks:

    rg -n "contextplusplus|contextplusplus-cli|contextplus-mcp|\\[mcp_servers\\.contextplus\\]" README.md package.json cli src landing test /home/cesar514/.codex/config.toml /home/cesar514/.codex/skills -g '!**/node_modules/**' -g '!**/.next/**'

Expected outcome after the rename: public invocations and MCP config examples should use `scplus-mcp` and `scplus-cli`, while `.contextplus` storage paths may still remain where the storage contract is intentionally unchanged.

## Validation and Acceptance

Acceptance is behavior-based. In the operator console, long active errors and long recent log lines must no longer blow past the panel boundaries; instead, each preview must render at most three lines and end with an ellipsis marker when hidden content remains. Typing `/` in the activity pane must show a short scrollable suggestions list that does not consume the whole pane. Running `/issue` must open the full current error in a dedicated view, and `/log` must open the full log view. On the naming side, the package metadata, MCP server metadata, generated Codex config, README, landing instructions, and the external Codex skill/config must all advertise `scplus-mcp` and `scplus-cli`, with tests and lint still passing afterward.

## Idempotence and Recovery

The TODO and ExecPlan edits are safe to repeat. The CLI code changes are local source edits and can be re-run through the same tests until stable. The external skill and Codex config updates are also idempotent file edits, but because they live outside the repo root they should be reviewed carefully before the final commit note explains that those external surfaces were synchronized. If a rename breaks a test, prefer correcting the specific stale string rather than reverting broad chunks of the migration.

## Artifacts and Notes

The most important pre-change evidence is:

    renderActivityShell() computes the slash-command window size as:
      min(len(commands), max(4, height-len(lines)-4))

    This allows the command list to grow with the remaining pane height instead of staying bounded.

    paletteCommands() currently exposes /overview, /tree, /hubs, /cluster, /find-hub, /status, /changes, /research, /search, /symbol, /word, /outline, /deps, /blast, /lint, /restore, /validate, /repair, /refresh, /doctor, /toggle-watcher, /export, and /exit.

    No /issue or /log command exists yet.

## Interfaces and Dependencies

At the end of this work, `/home/cesar514/Documents/agent_programming/contextplus/cli/internal/ui/model.go` must contain a reusable helper for preview rendering that accepts raw text plus width and returns a max-three-line preview with ellipsis behavior. `paletteCommands()` must include commands whose titles are `/issue` and `/log`. `executePaletteAction()` and the command-bar path must route those actions into either existing text-section views or the full logs pane. The public MCP server metadata in `/home/cesar514/Documents/agent_programming/contextplus/src/index.ts` must advertise `scplus-mcp`, and the launcher and package metadata must expose `scplus-cli` as the human CLI binary name. The init config helpers in `/home/cesar514/Documents/agent_programming/contextplus/src/cli/command-utils.ts` and the local Codex config in `/home/cesar514/.codex/config.toml` must emit the new MCP server key and command name so downstream setup matches the docs.

Revision note: Created this ExecPlan on 2026-04-03 to drive the CLI overflow fixes and public `scplus-*` rename in one tracked change set.
