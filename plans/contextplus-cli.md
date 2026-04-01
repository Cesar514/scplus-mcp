# Context+ CLI ExecPlan

This ExecPlan must be maintained in accordance with `/home/cesar514/.codex/.agent/PLANS.md`.

## Purpose / Big Picture

After this milestone, a human using this repository will have a real terminal application for Context+ rather than only the MCP server and a few utility subcommands. The user-visible outcome is that they can launch a Bubble Tea dashboard, inspect repo and index health, see whether Ollama is running, browse the context tree, hubs, and restore points, create a hub from the CLI, and keep a background watcher running that loudly reindexes when source files change.

The implementation is intentionally split between the existing TypeScript backend and a new Go terminal app. The TypeScript side remains the authoritative backend for Context+ operations and gains machine-readable bridge commands. The Go side in `cli/` becomes the human-facing shell built with Charm's Bubble Tea ecosystem.

## Progress

- [x] (2026-04-01 19:57Z) Scoped the CLI milestone, confirmed there is no existing `cli/` directory, and verified the current `contextplus` binary is still the Node MCP entrypoint with minimal helper subcommands.
- [x] (2026-04-01 19:57Z) Confirmed `go` is not installed globally in the environment and `pixi` is available, so the CLI build will use a project-local Go toolchain path via Pixi instead of assuming a system Go install.
- [x] (2026-04-01 20:18Z) Added TypeScript bridge commands plus human-readable JSON/plain output modes for the data the CLI needs, including doctor, status, changes, hubs, cluster, tree, and restore-point surfaces.
- [x] (2026-04-01 20:42Z) Implemented the Bubble Tea CLI in `cli/` with overview, tree, hubs, restore points, Ollama status, watcher state, snapshot mode, and guided hub creation.
- [x] (2026-04-01 21:03Z) Wired npm, Pixi, and the install script so the CLI builds reproducibly and exposes a global launcher command through `npm link`.
- [x] (2026-04-01 21:18Z) Verified the TypeScript backend, Go CLI, snapshot mode, and install flow directly, then updated `TODO.md` and `TODO_COMPLETED.md`.

## Surprises & Discoveries

- Observation: The repository already has most of the backend logic the CLI needs, but it only exists behind MCP tool handlers or a very small subcommand surface in `src/index.ts`.
  Evidence: `src/index.ts` already imports `getFeatureHub`, `semanticNavigate`, `validatePreparedIndex`, `repairPreparedIndex`, `listRestorePoints`, and the exact-query helpers, but only exposes `init`, `index`, and `tree`/`skeleton` on the human CLI boundary.

- Observation: A Go Bubble Tea implementation cannot be built in this environment with a system toolchain because `go` is absent.
  Evidence: `go version` returned `/bin/bash: go: command not found`, while `pixi --version` returned `pixi 0.63.1`.

- Observation: The npm-linked human CLI launcher must be a real Node executable script, not only transpiled JavaScript.
  Evidence: the first install-script verification linked `contextplus-ui` to `build/cli-launcher.js`, but invoking it failed under `/bin/sh` until `#!/usr/bin/env node` was added to `src/cli-launcher.ts`.

## Decision Log

- Decision: Keep the existing Node `contextplus` binary as the backend and add explicit human/bridge subcommands instead of moving backend logic into the Go app.
  Rationale: The TypeScript runtime already owns indexing, validation, hubs, restore points, and MCP serving. Reusing it avoids duplicating business logic or letting the TUI drift from the MCP behavior.
  Date/Author: 2026-04-01 / Codex

- Decision: Build the human terminal app in Go under `cli/` using Bubble Tea and expose it through a separate launcher command for now.
  Rationale: The user explicitly asked for Charm's TUI stack. A separate launcher keeps the MCP binary stable while the human CLI grows, and the later rename to `context++` can happen after the CLI milestone is complete.
  Date/Author: 2026-04-01 / Codex

- Decision: Use Pixi as the project-local Go toolchain path for this milestone.
  Rationale: The repo already uses npm for the TypeScript project, but Pixi is allowed for dev tooling and gives a reproducible way to build the Go CLI without requiring a global Go install.
  Date/Author: 2026-04-01 / Codex

## Outcomes & Retrospective

The shipped milestone now gives Context+ a real operator-facing terminal surface instead of only an MCP server and a few backend subcommands. The TypeScript runtime remains the source of truth for indexing, validation, restore points, hub discovery, and repo status; the Go app consumes those stable bridge payloads and renders them as a Bubble Tea dashboard with an animated magician companion, health cards, tree and hub views, restore-point visibility, snapshot mode, and a human hub-creation flow.

The watcher path also landed in the terminal UI rather than as a hidden background daemon. That matters because the goal was a CLI that helps a human see and assist the LLM. The dashboard now makes reindex activity, queued reruns, and failures visible instead of burying them in logs.

The only intentionally deferred work is the later product-wide rename from `Context+` / `contextplus` to `context++`, which remains in `TODO.md` because the user asked to leave that branding migration for after the CLI milestone was finished.

## Context and Orientation

The current backend entrypoint is `src/index.ts`. It starts the MCP server by default and already provides a few human-facing subcommands such as `init`, `index`, and `tree`. The indexing backend lives in `src/tools/index-codebase.ts`. Prepared-index validation and repair live in `src/tools/index-reliability.ts`. Exact repo inspection helpers such as git status and git changes live in `src/tools/exact-query.ts`. Hub browsing is implemented in `src/tools/feature-hub.ts`. Restore points are managed in `src/git/shadow.ts`. Cluster rendering is implemented in `src/tools/semantic-navigate.ts`.

The new human terminal application will live under `cli/`. In this plan, a “bridge command” means a `contextplus` subcommand that prints machine-readable data, usually JSON, so the Go terminal app can render stable views without parsing ad hoc text. A “dashboard snapshot” means a non-interactive command that renders the same high-level screen content the TUI shows on startup and exits immediately. That snapshot exists so the CLI can be validated directly in automation.

The project now includes a Go module in `cli/`, a Pixi manifest for the project-local Go toolchain, and a launcher wrapper exposed through npm as `contextplus-ui`. The install script `install-contextplus.sh` builds both the TypeScript backend and the Go CLI, runs `npm link`, and verifies both linked commands.

## Plan of Work

First, extend `src/index.ts` so the Node binary becomes a proper backend command surface for the human CLI. Add subcommands for `validate-index`, `repair-index`, `status`, `changes`, `cluster`, `find-hub`, `restore-points`, and a dedicated `bridge` mode that emits JSON for the views the TUI needs. Keep the backend as the source of truth for repo state and index data. The Go app should not inspect SQLite directly.

Second, add a small TypeScript launcher wrapper that will be exposed through npm as the global command for the human CLI. That wrapper will execute the built Go binary and pass through arguments. The launcher must fail loudly if the Go binary has not been built.

Third, create the Go module in `cli/` and implement the Bubble Tea terminal app. The initial screen should include an animated pixel-magician header, repository status, index health, Ollama runtime status, watcher state, and recent activity logs. Additional views must render the context tree, hubs, restore points, and hub suggestions. The app must expose a guided hub-creation flow that writes markdown hub files under `.contextplus/hubs/`.

Fourth, add a file watcher to the Go app using a normal filesystem watcher with debounce. The watcher must ignore generated directories such as `.contextplus/`, `build/`, `node_modules/`, and `landing/.next/`. When it observes source changes in the chosen root, it must run `contextplus index <root> --mode=full`, log the result, and surface failures loudly in the dashboard.

Fifth, add `pixi.toml` and root npm scripts so the Go CLI can be built and tested reproducibly. Update `install-contextplus.sh` to build both the TypeScript backend and the Go TUI, then expose both linked commands. Update `README.md` with the new CLI commands, watcher behavior, and install flow.

Finally, add direct verification. The TypeScript tests should cover the new bridge or subcommand surface. The Go side should have at least focused tests for backend parsing and snapshot rendering. The final verification must include a real build, the test suites, a direct snapshot render, direct non-interactive commands such as doctor or status, and the updated install script.

## Concrete Steps

From the repository root:

1. Extend `src/index.ts` with the new human and bridge subcommands, plus any small helper modules needed to serialize data.
2. Add the npm-exposed launcher wrapper in `src/` so `npm link` can publish the TUI command.
3. Create `cli/go.mod`, the Bubble Tea app, and any internal packages needed for backend calls, watcher orchestration, and snapshot rendering.
4. Add `pixi.toml`, update `package.json` scripts, and update `install-contextplus.sh`.
5. Add or update tests for the Node bridge commands and the Go CLI behavior.
6. Run the validation commands in the `Validation and Acceptance` section and record any deviations in this plan before finishing.

## Validation and Acceptance

Acceptance requires all of the following user-visible behavior:

- A global launcher command exists for the human CLI after running `./install-contextplus.sh`.
- The CLI can show repo status, prepared-index validation, Ollama runtime status, hubs, restore points, and context tree data without starting the MCP stdio server.
- The CLI can create a hub markdown file for a human.
- The CLI can watch the repo for source changes and trigger loud full reindex runs.
- The CLI includes the animated magician header on the dashboard.

The direct verification sequence from the repository root is:

    npm run build
    npm test
    pixi run build-cli
    pixi run test-cli
    node build/index.js bridge doctor --root . --json
    ./build/contextplus-ui snapshot --root .
    ./build/contextplus-ui doctor --root .
    ./install-contextplus.sh

The observed outcome was a passing TypeScript build and test suite, a passing Go CLI build and test suite, a machine-readable doctor report from the Node bridge, a visible dashboard snapshot that includes the magician and repo/index sections, a plain doctor report from the Go CLI that summarizes repo, index, and Ollama status, and a successful install flow that linked both `contextplus` and `contextplus-ui` to this checkout.

## Idempotence and Recovery

The build and install steps must be repeatable. Re-running the install script should rebuild the TypeScript backend and the Go CLI without leaving multiple conflicting launcher binaries behind. Re-running the watcher must reuse the same repo state and should not corrupt `.contextplus/`. If a new bridge command or Go view fails, the recovery path is to fix the specific module, rerun the targeted test, then rerun the full verification sequence.

## Artifacts and Notes

Important paths for this milestone:

    src/index.ts
    src/cli-launcher.ts
    cli/
    pixi.toml
    install-contextplus.sh
    README.md

Expected new commands after this milestone:

    contextplus index .
    contextplus validate-index .
    contextplus bridge doctor --root . --json
    contextplus-ui
    contextplus-ui snapshot --root .

## Interfaces and Dependencies

The Go terminal app must use Charm libraries from the Bubble Tea ecosystem. At minimum this means `github.com/charmbracelet/bubbletea` for the event loop and rendering, and `github.com/charmbracelet/lipgloss` for styling. A filesystem watcher library such as `github.com/fsnotify/fsnotify` should be used for the background reindex watcher.

In `src/index.ts`, define stable command handlers that can print either human-readable text or JSON. The JSON shapes must include enough data for the TUI to render:

    type BridgeDoctorReport = {
      root: string;
      repoStatus: RepoStatusSummary;
      indexValidation: IndexValidationReport;
      hubSummary: {
        suggestions: string[];
        featureGroups: string[];
      };
      ollama: {
        ok: boolean;
        runningModels: string[];
        error?: string;
      };
    };

    type BridgeRestorePointSummary = {
      id: string;
      timestamp: number;
      files: string[];
      message: string;
    };

The launcher wrapper must exec the built Go binary from `build/contextplus-ui` and pass stdin, stdout, stderr, and exit code through unchanged.

Revision note: created this dedicated CLI ExecPlan because roadmap Step 21 grew into a standalone milestone with cross-language build, install, and UX work that needs more detail than the existing roadmap file carries.
Revision note: the milestone is now implemented and verified; the remaining related backlog item is only the later rename to `context++`.
