# scplus-mcp

Prepared-index code intelligence for agents and operators.

`scplus-mcp` is the repository and npm package for **scplus**, a local code-intelligence engine that serves structural, exact-query, related-search, and research workflows from a validated repo-local index. It ships three connected surfaces: the `scplus-mcp` MCP server for coding agents, a persistent local bridge for automation, and the `scplus-cli` Bubble Tea operator console for humans.

The project is built around one operating contract: build a prepared local index, read from one validated active generation at a time, and fail loudly when freshness or validation is broken instead of quietly answering from stale state.

![scplus operator console](/home/cesar514/Documents/agent_programming/contextplus/docs/assets/contextpp-cli-console.svg)

![scplus serving contract](/home/cesar514/Documents/agent_programming/contextplus/docs/assets/contextpp-serving-flow.svg)

## Table of Contents

- [Key Features](#key-features)
- [Naming And Product Surfaces](#naming-and-product-surfaces)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [MCP Client Setup](#mcp-client-setup)
- [Models And Embedding Providers](#models-and-embedding-providers)
- [Architecture](#architecture)
- [Environment Variables](#environment-variables)
- [Available Scripts](#available-scripts)
- [MCP Resource And Tool Catalog](#mcp-resource-and-tool-catalog)
- [Bridge And Automation Surface](#bridge-and-automation-surface)
- [Human CLI Surface](#human-cli-surface)
- [Benchmarks](#benchmarks)
- [References](#references)
- [License](#license)

## Key Features

- Prepared exact-query tools for deterministic lookups such as `symbol`, `word`, `outline`, `deps`, `status`, and `changes`
- Ranked related search and broad research over persisted file, chunk, identifier, structure, cluster, and hub artifacts
- One shared backend core for MCP and the human CLI, with the CLI connected over the persistent `bridge-serve` JSON-line transport
- Repo-local SQLite machine state rooted at `.scplus/`, with active/pending generation promotion and explicit `fresh`, `dirty`, and `blocked` freshness states
- Loud failure semantics for invalid prepared state instead of silent fallback behavior
- Suggested hubs and semantic clusters generated from the prepared full index
- Shadow restore points for reversible AI-authored edits without mutating git history
- A separate Next.js landing/docs app under `landing/`, wired to the local package during development
- Committed real benchmark artifacts under `docs/benchmarks/`

## Naming And Product Surfaces

This repository uses a few names that matter in different contexts:

| Surface | Current name |
| --- | --- |
| Public npm package | `scplus-mcp` |
| Public MCP command | `scplus-mcp` |
| Public human CLI command | `scplus-cli` |
| Product/brand name | `scplus` |
| Repo-local state directory used by current source | `.scplus/` |
| Runtime env prefix used by current source | `SCPLUS_` |

Important context:

- The **current source code** uses `.scplus/` as the repo-local state root via `src/core/project-layout.ts`.
- The runtime environment prefix used by current code is `SCPLUS_`.

If code and docs disagree, treat the code as authoritative.

## Tech Stack

- **Primary language**: TypeScript (ESM)
- **MCP transport**: `@modelcontextprotocol/sdk` over stdio
- **Prepared state store**: SQLite at `.scplus/state/index.sqlite`
- **Parsing**: `web-tree-sitter` and `tree-sitter-wasms`
- **Retrieval**: lexical plus embedding-backed retrieval persisted into SQLite vector collections
- **Embedding backends**: Ollama by default, OpenAI-compatible embeddings optionally
- **Human CLI**: Go + Bubble Tea
- **Go toolchain management**: Pixi (`go = 1.24.*`)
- **Landing/docs app**: Next.js 16, React 19, Tailwind CSS 4, OpenNext/Cloudflare tooling
- **Primary package manager**: npm

## Prerequisites

Install these before working on the repository:

- **Node.js**
- **npm**
- **Pixi**
- **Git**

Usually also needed for semantic indexing:

- **Ollama**, unless you explicitly choose an OpenAI-compatible embedding backend

Optional:

- **Bun**, if you prefer `bunx` when generating MCP config instead of `npx`

Notes:

- The repository does not currently ship a checked-in `.env.example`.
- The canonical onboarding path for the core package is the install script, not manual npm and pixi commands typed from memory.

## Getting Started

### Canonical install path

For the main developer/operator workflow, start with the installer:

```bash
git clone https://github.com/Cesar514/scplus-mcp.git
cd scplus-mcp
./install-scplus.sh
```

Treat `./install-scplus.sh` as the primary local setup path for the package and CLI. Manual build steps are documented below so you understand what the installer is doing, but the intended bootstrap flow is through the script.

### What `./install-scplus.sh` does

The installer:

1. verifies `node`
2. verifies `npm`
3. verifies `pixi`
4. runs `npm install`
5. runs `npm run build`
6. runs `npm run build:cli`
7. runs `npm link`
8. verifies that `scplus-mcp` points at `build/index.js`
9. verifies that `scplus-cli` points at `build/cli-launcher.js`
10. runs a lightweight `scplus-mcp tree "$ROOT_DIR"` check
11. runs a lightweight `scplus-cli doctor --root "$ROOT_DIR"` check

If any prerequisite is missing, the script exits fatally instead of guessing.

### What you should have after install

After a successful run:

- `scplus-mcp` should be on your `PATH`
- `scplus-cli` should be on your `PATH`
- the TypeScript build output should exist under `build/`
- the Bubble Tea launcher should exist under `build/scplus-cli`

Quick verification:

```bash
scplus-mcp doctor .
scplus-cli doctor --root .
```

### Rebuilding after edits

After editing the TypeScript or Go sources, rebuild both shipped entrypoints with:

```bash
npm run build:all
```

This updates the already linked `scplus-mcp` and `scplus-cli` commands in place because `npm link` points them at this checkout’s build output.

### Bootstrapping prepared state for the repository

Once the commands are installed, create prepared repo-local state:

```bash
scplus-mcp index .
```

Then validate it:

```bash
scplus-mcp validate-index .
```

The strongest success signal is a valid prepared index with:

- one active generation
- no pending generation unless a rebuild is in progress
- serving freshness reported as `fresh`

### Verifying the user-facing surfaces

Run these from the repository root:

```bash
scplus-mcp tree .
scplus-mcp status .
scplus-cli snapshot --root .
scplus-cli doctor --root .
```

What these confirm:

- the MCP entrypoint is runnable
- the exact-query/git-aware surfaces are reachable
- the shared backend can serve the Go operator console
- the linked human CLI works against the same backend state

### Working on the landing app

The landing/docs application under `landing/` is a separate app with its own dependencies. Only do this if you are editing the site itself:

```bash
cd landing
npm install
npm run dev
```

The landing app serves on `http://localhost:6767`.

## MCP Client Setup

### Supported client targets

The `init` command can generate MCP config for:

- `claude`
- `cursor`
- `vscode`
- `windsurf`
- `opencode`
- `codex`

Generated config paths:

| Target | Output path |
| --- | --- |
| `claude` | `.mcp.json` |
| `cursor` | `.cursor/mcp.json` |
| `vscode` | `.vscode/mcp.json` |
| `windsurf` | `.windsurf/mcp.json` |
| `opencode` | `opencode.json` |
| `codex` | `.codex/config.toml` |

### Generate config files automatically

Examples:

```bash
scplus-mcp init claude
scplus-mcp init cursor
scplus-mcp init vscode
scplus-mcp init windsurf
scplus-mcp init opencode
scplus-mcp init codex
```

Runner selection:

- by default, the command prefers `bunx` when it detects Bun and otherwise falls back to `npx`
- you can force a runner with `--runner=npx` or `--runner=bunx`

Examples:

```bash
scplus-mcp init codex --runner=npx
scplus-mcp init claude --runner=bunx
```

### Manual Codex TOML configuration

If you want to configure Codex manually after using the local install script, add this to `~/.codex/config.toml`:

```toml
[mcp_servers."scplus-mcp"]
command = "scplus-mcp"
args = []

[mcp_servers."scplus-mcp".env]
OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b-32k"
OLLAMA_CHAT_MODEL = "nemotron-3-nano:4b-128k"
OLLAMA_API_KEY = "YOUR_OLLAMA_API_KEY"
SCPLUS_EMBED_BATCH_SIZE = "8"
SCPLUS_EMBED_TRACKER = "lazy"
```

If you prefer running through `npx` or `bunx` instead of the locally linked command, the generated Codex config follows the same structure but sets:

- `command = "npx"` with `args = ["-y", "scplus-mcp"]`, or
- `command = "bunx"` with `args = ["scplus-mcp"]`

### Example JSON-style MCP config

For clients that use JSON config files, the generated config follows this general shape:

```json
{
  "mcpServers": {
    "scplus-mcp": {
      "command": "bunx",
      "args": ["scplus-mcp"],
      "env": {
        "OLLAMA_EMBED_MODEL": "qwen3-embedding:0.6b-32k",
        "OLLAMA_CHAT_MODEL": "nemotron-3-nano:4b-128k",
        "OLLAMA_API_KEY": "YOUR_OLLAMA_API_KEY",
        "SCPLUS_EMBED_BATCH_SIZE": "8",
        "SCPLUS_EMBED_TRACKER": "lazy"
      }
    }
  }
}
```

The exact top-level key differs by client:

- `mcpServers` for Claude/Cursor/Windsurf-style configs
- `servers` for VS Code’s `.vscode/mcp.json`
- `mcp` for `opencode.json`
- TOML tables for Codex

## Models And Embedding Providers

### Important note on the Ollama model names in this repo

The model tags shown in this repository, especially:

- `qwen3-embedding:0.6b-32k`
- `nemotron-3-nano:4b-128k`

should be read as **local Ollama variants used in the maintainer environment**, not as a claim that these are wholly bespoke model families invented by the project.

Per the current maintainer workflow:

- the base models were downloaded from official Ollama sources
- the local setup then modified the context window configuration

So in practice, the README examples are documenting the project’s current local runtime tags and expectations, not asserting that the repository itself distributes new model architectures.

### Provider overview

The code supports two embedding-provider modes:

| Provider mode | Env value | Typical use |
| --- | --- | --- |
| Ollama | `ollama` | local/private embeddings |
| OpenAI-compatible | `openai` | API-backed embeddings through OpenAI-compatible endpoints |

### Ollama path

The default code path is Ollama. A typical local setup looks like:

```bash
ollama pull qwen3-embedding:0.6b
ollama pull nemotron-3-nano:4b
ollama serve
```

Then, if your local environment uses extended-context variants or custom local tags, configure the env values that `scplus-mcp` should actually use:

```bash
export OLLAMA_EMBED_MODEL=qwen3-embedding:0.6b-32k
export OLLAMA_CHAT_MODEL=nemotron-3-nano:4b-128k
```

### OpenAI-compatible path

For API-backed embeddings:

```bash
export SCPLUS_EMBED_PROVIDER=openai
export SCPLUS_OPENAI_API_KEY=YOUR_API_KEY
export SCPLUS_OPENAI_EMBED_MODEL=text-embedding-3-small
```

Optional custom base URL:

```bash
export SCPLUS_OPENAI_BASE_URL=https://your-proxy.example.com/v1
```

## Architecture

### Directory Structure

```text
.
├── src/                     # TypeScript MCP server, backend core, indexing, retrieval, and tool implementations
│   ├── cli/                 # Shared backend core, bridge commands, doctor/report formatting
│   ├── core/                # Project layout, embeddings, parser runtime, locks, lifecycle helpers
│   ├── git/                 # Shadow restore-point logic
│   └── tools/               # Public indexing, query, lint, research, hub, and recovery tools
├── cli/                     # Go Bubble Tea operator console
│   ├── cmd/scplus-cli/      # Go CLI entrypoint
│   └── internal/            # Backend client, hubs flow, watcher integration, UI rendering
├── landing/                 # Separate Next.js marketing/docs application
├── docs/                    # Architecture notes, benchmark artifacts, snapshots, and images
├── test/                    # TypeScript tests, demos, and fixtures
├── .scplus/                 # Generated repo-local prepared state
├── package.json             # Root package metadata and Node build/test scripts
├── pixi.toml                # Project-local Go toolchain and CLI tasks
└── install-scplus.sh        # Canonical local install script
```

### Runtime Surfaces

The repository exposes three distinct but connected runtime surfaces:

| Surface | Purpose | Backing implementation |
| --- | --- | --- |
| `scplus-mcp` | Agent-facing MCP server and CLI-style local commands | `src/index.ts` |
| `bridge` / `bridge-serve` | Structured local automation interface over the shared backend core | `src/cli/commands.ts` |
| `scplus-cli` | Human operator console and a few direct Go subcommands | `cli/cmd/scplus-cli/main.go` |

Important constraint:

- the Go CLI is **not** a second indexing engine
- it is a client of the same backend core used by the MCP server

### Request Lifecycle

For agent/MCP requests:

```text
Agent or MCP client
  -> scplus-mcp (src/index.ts)
  -> shared backend core / tool implementation
  -> prepared index in .scplus/state/index.sqlite
  -> formatted MCP response
```

For human operator requests:

```text
scplus-cli
  -> Go backend client
  -> persistent bridge-serve session
  -> shared backend core
  -> prepared index in .scplus/state/index.sqlite
  -> operator UI panes / plain-text output
```

### Serving And Generation Contract

The prepared-state contract documented by current code and architecture docs is:

- one active generation is the serving source of truth
- rebuilds and repairs can write a pending generation first
- pending generations are promoted only after validation succeeds
- serving freshness is explicit and can be `fresh`, `dirty`, or `blocked`
- invalid or blocked prepared state is supposed to fail loudly rather than degrade silently

The short authoritative architecture summary lives in [architecture.md](/home/cesar514/Documents/agent_programming/contextplus/docs/architecture.md).

### Query Model

The codebase implements a two-lane query model:

- **Exact lane**: `symbol`, `word`, `outline`, `deps`, `status`, `changes`
- **Ranked lane**: `search` with `intent="related"`
- **Broad report lane**: `research`

The product contract is that exact lookups remain the cheapest deterministic path and broader retrieval only runs when exact lookup is insufficient.

### Project State Layout

Current code uses this repo-local state root:

```text
.scplus/
├── state/
│   └── index.sqlite
├── hubs/
│   └── suggested/
└── locks/
```

Observed in the current checkout after indexing:

- `.scplus/state/index.sqlite`
- `.scplus/hubs/suggested/`
- `.scplus/locks/`

Current source code uses `.scplus/`.

### Core Component Map

#### `src/core/`

- `project-layout.ts` defines the `.scplus/` layout
- `embeddings.ts` manages provider-backed embeddings, SQLite vector namespaces, runtime options, and generation-aware cache invalidation
- `tree-sitter.ts` and `parser.ts` provide structural parsing
- `runtime-locks.ts` coordinates cross-process ownership
- `process-lifecycle.ts` manages idle shutdown, parent monitoring, and cleanup

#### `src/tools/`

- `index-codebase.ts`, `index-stages.ts`, and `index-reliability.ts` drive indexing, validation, and repair
- `exact-query.ts` implements the fast exact-query substrate
- `query-intent.ts`, `unified-ranking.ts`, `semantic-search.ts`, and `semantic-identifiers.ts` implement ranked search
- `research.ts` builds larger bounded subsystem reports
- `feature-hub.ts`, `hub-suggestions.ts`, and `cluster-artifacts.ts` implement hub and cluster views
- `static-analysis.ts` and `blast-radius.ts` provide diagnostics and usage tracing
- `propose-commit.ts` and `write-freshness.ts` implement guarded writes and synchronous freshness repair

#### `cli/`

- `cli/cmd/scplus-cli/main.go` is the Go entrypoint
- `cli/internal/backend/` is the bridge client layer
- `cli/internal/ui/` renders the operator console
- `cli/internal/hubs/` powers manual hub creation

### Operator Console Behavior

The shipped human CLI is more than a thin wrapper. The previous README’s high-value description is still accurate enough to preserve at a high level:

- it has a navigation pane, overview/content pane, detail pane, and jobs/logs area
- it exposes operator health, serving state, queue state, history, and observability
- it supports a command palette, filtering, export, and navigation history
- it streams backend events over the persistent `bridge-serve` transport

The committed plain snapshot is in [cli-snapshot.txt](/home/cesar514/Documents/agent_programming/contextplus/docs/artifacts/cli-snapshot.txt).

### Watcher And Scheduler Semantics

The backend, not the Go frontend, owns watcher behavior:

- bursty path changes are deduped
- the scheduler can queue or supersede stale pending work
- ordinary edits can become refresh jobs
- dependency/config changes can escalate to full index jobs
- job, watch, and log events are streamed over `bridge-serve`

## Environment Variables

The repository does not have a checked-in `.env.example`, so the source is the authority. The table below reflects variables verified in `src/core/embeddings.ts`, `src/index.ts`, and the generated config helpers.

### Provider selection and model configuration

| Variable | Required | Purpose | Default / source |
| --- | --- | --- | --- |
| `SCPLUS_EMBED_PROVIDER` | No | Select embedding provider mode | `ollama` |
| `OLLAMA_EMBED_MODEL` | No | Ollama embedding model tag | `qwen3-embedding:0.6b-32k` |
| `OLLAMA_CHAT_MODEL` | No | Chat model used in generated config examples | `nemotron-3-nano:4b-128k` |
| `OLLAMA_HOST` | No | Override Ollama host | unset |
| `OLLAMA_API_KEY` | Conditional | Required only if your Ollama setup needs auth | unset |
| `SCPLUS_OPENAI_API_KEY` | Conditional | Preferred OpenAI-compatible API key when provider is `openai` | unset |
| `OPENAI_API_KEY` | Conditional | Fallback alias for API key | unset |
| `SCPLUS_OPENAI_BASE_URL` | No | Preferred OpenAI-compatible base URL | `https://api.openai.com/v1` |
| `OPENAI_BASE_URL` | No | Fallback alias for base URL | `https://api.openai.com/v1` |
| `SCPLUS_OPENAI_EMBED_MODEL` | No | Preferred OpenAI-compatible embedding model | `text-embedding-3-small` |
| `OPENAI_EMBED_MODEL` | No | Fallback alias for embedding model | `text-embedding-3-small` |

### Indexing, chunking, and refresh behavior

| Variable | Required | Purpose | Default / source |
| --- | --- | --- | --- |
| `SCPLUS_EMBED_BATCH_SIZE` | No | Embedding batch size, clamped in code | `8` |
| `SCPLUS_EMBED_CHUNK_CHARS` | No | Chunk chars before vector merge, clamped in code | `2000` |
| `SCPLUS_MAX_EMBED_FILE_SIZE` | No | Max file size for embed-aware search paths | tool fallback in `semantic-search.ts` |
| `SCPLUS_EMBED_TRACKER` | No | Enable/shape tracker behavior | read directly from env |
| `SCPLUS_EMBED_TRACKER_MAX_FILES` | No | Max files processed per tracker tick | `8` |
| `SCPLUS_EMBED_TRACKER_DEBOUNCE_MS` | No | Debounce window for tracker work | `700` |
| `SCPLUS_IDLE_TIMEOUT_MS` | No | Idle shutdown timeout for MCP process | unset |
| `SCPLUS_PARENT_POLL_MS` | No | Parent-process polling interval | unset |

### Advanced Ollama runtime options

| Variable | Required | Purpose |
| --- | --- | --- |
| `SCPLUS_EMBED_NUM_GPU` | No | Pass `num_gpu` into Ollama embed options |
| `SCPLUS_EMBED_MAIN_GPU` | No | Pass `main_gpu` into Ollama embed options |
| `SCPLUS_EMBED_NUM_THREAD` | No | Pass `num_thread` into Ollama embed options |
| `SCPLUS_EMBED_NUM_BATCH` | No | Pass `num_batch` into Ollama embed options |
| `SCPLUS_EMBED_NUM_CTX` | No | Pass `num_ctx` into Ollama embed options |
| `SCPLUS_EMBED_LOW_VRAM` | No | Pass `low_vram` into Ollama embed options |

## Available Scripts

### Root package scripts

| Command | Description |
| --- | --- |
| `npm run build` | Compile the TypeScript MCP server into `build/` |
| `npm run build:cli` | Use Pixi to build the Go Bubble Tea CLI |
| `npm run build:all` | Build both the TypeScript server and the Go CLI |
| `npm run dev` | Run TypeScript in watch mode |
| `npm start` | Start the built Node entrypoint |
| `npm test` | Run the main TypeScript test suite |
| `npm run test:cli` | Run the Go CLI test suite through Pixi |
| `npm run test:demo` | Run the demo/test harness |
| `npm run test:all` | Run all Node and Go test suites |

### Landing app scripts

Run these from `landing/`:

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Next.js landing app on port `6767` |
| `npm run build` | Build the landing app |
| `npm run start` | Run the built landing app on port `6767` |
| `npm run lint` | Lint the landing app |
| `npm run cf:build` | Build the OpenNext/Cloudflare target |
| `npm run cf:preview` | Build and run a Cloudflare preview |
| `npm run cf:deploy` | Build and deploy the Cloudflare target |

### `scplus-mcp` local command surface

When you run `scplus-mcp` as a shell command after `./install-scplus.sh`, it supports both CLI-style local commands and the MCP stdio server mode.

| Command | Purpose | Important flags / forms |
| --- | --- | --- |
| `scplus-mcp init <target>` | Generate client config for `claude`, `cursor`, `vscode`, `windsurf`, `opencode`, or `codex` | `--runner=npx`, `--runner=bunx` |
| `scplus-mcp index [path]` | Build or refresh prepared repo-local state | `--mode=core`, `--mode=full` |
| `scplus-mcp tree [path]` | Render the structural tree | `--json`, `--headers-only`, `--max-tokens=<n>` |
| `scplus-mcp skeleton <file>` | Render a file skeleton | `--root=<repo>`, `--json` |
| `scplus-mcp validate-index [path]` | Validate prepared state | `--mode=core`, `--mode=full`, `--json` |
| `scplus-mcp validate_index [path]` | Alias for `validate-index` | same flags as above |
| `scplus-mcp repair-index [path] --target=<...>` | Repair prepared state | `--json` |
| `scplus-mcp repair_index [path] --target=<...>` | Alias for `repair-index` | `--json` |
| `scplus-mcp status [path]` | Render a git-aware status summary | `--limit=<n>`, `--json` |
| `scplus-mcp changes [path]` | Render a git-aware changes summary | `--path=<file>`, `--limit=<n>`, `--json` |
| `scplus-mcp cluster [path]` | Render persisted semantic cluster output | `--max-depth=<n>`, `--max-clusters=<n>`, `--json` |
| `scplus-mcp hubs [path]` | Render hub output | `--hub-path=<file>`, `--feature-name=<name>`, `--query=<text>`, `--ranking-mode=<keyword|semantic|both>`, `--show-orphans`, `--json` |
| `scplus-mcp find-hub [path]` | Alias-style hub discovery entrypoint | same flags as `hubs` |
| `scplus-mcp restore-points [path]` | Render restore-point history | `--json` |
| `scplus-mcp restore_points [path]` | Alias for `restore-points` | `--json` |
| `scplus-mcp doctor [path]` | Print a combined health/observability report | `--json` |
| `scplus-mcp bridge <subcommand>` | Run one-shot structured backend commands | see bridge table below |
| `scplus-mcp bridge-serve` | Start the persistent JSON-line bridge service | no flags |
| `scplus-mcp [path]` | Start the MCP stdio server rooted at the given path or current directory | path only |

The shell-entry aliases currently implemented in `src/cli/commands.ts` are:

- `validate-index` and `validate_index`
- `repair-index` and `repair_index`
- `restore-points` and `restore_points`
- `hubs` and `find-hub`

## MCP Resource And Tool Catalog

### Public MCP resource

The MCP server exposes one resource:

| Resource | URI | Purpose |
| --- | --- | --- |
| `scplus_mcp_instructions` | `scplus-mcp://instructions` | Fetch the current repo instruction markdown from the published instructions source URL |

### Full public MCP tool list

Current public MCP tools registered in `src/index.ts`:

#### Index and navigation tools

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `index` | Create or refresh `.scplus/` prepared state | `mode?: "core" | "full"` |
| `validate_index` | Validate the prepared index for consistency and version compatibility | `mode?: "core" | "full"` |
| `repair_index` | Repair a prepared index stage or full mode, then validate | `target: "core" | "full" | "bootstrap" | "file-search" | "identifier-search" | "full-artifacts"` |
| `tree` | Render the structural repository tree | `target_path?`, `depth_limit?`, `include_symbols?`, `max_tokens?` |
| `skeleton` | Show detailed signatures and type surfaces for one file | `file_path` |
| `cluster` | Render persisted semantic cluster and subsystem views | `max_depth?`, `max_clusters?` |
| `find_hub` | List, rank, inspect, or orphan-check manual/suggested hubs | `hub_path?`, `feature_name?`, `query?`, `ranking_mode?`, `show_orphans?` |

#### Exact-query tools

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `symbol` | Exact symbol lookup from the prepared fast-query substrate | `query`, `top_k?` |
| `word` | Tiny indexed word/phrase lookup | `query`, `top_k?` |
| `outline` | Compact imports/exports/symbol outline for a known file | `file_path` |
| `deps` | Direct and reverse dependency info for one indexed file | `target` |
| `status` | Tiny git worktree summary | `limit?` |
| `changes` | Git change summary, optionally scoped to one file | `path?`, `limit?` |

#### Search and research tools

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `search` | Intent-routed exact or related search over prepared artifacts | `intent`, `search_type`, `query`, `retrieval_mode?`, `top_k?`, `include_kinds?` |
| `research` | Broad bounded report combining retrieval, structure, clusters, and hubs | `query` |
| `evaluate` | Run the built-in real benchmark harness | no parameters |

#### Analysis, write, and recovery tools

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `blast_radius` | Trace symbol usage before modification or deletion | `symbol_name`, `file_context?` |
| `lint` | Run native linter/compiler-backed analysis | `target_path?` |
| `checkpoint` | Guarded write path with restore-point creation | `file_path`, `new_content` |
| `restore_points` | List shadow restore points | no parameters |
| `restore` | Restore files from a specific restore point | `point_id` |

## Bridge And Automation Surface

The repository has two non-MCP local automation surfaces:

- `bridge <subcommand>` for one-shot JSON output
- `bridge-serve` for a persistent JSON-line session used by `scplus-cli` and local tooling

### `bridge` subcommands

The one-shot `bridge` wrapper exposes these subcommands:

| Subcommand | Purpose | Key flags / args |
| --- | --- | --- |
| `doctor` | Return doctor output as JSON | `--root=<repo>` |
| `tree` | Return tree output as JSON | `--root=<repo>`, `--headers-only`, `--max-tokens=<n>` |
| `status` | Return worktree status as JSON | `--root=<repo>`, `--limit=<n>` |
| `changes` | Return change summaries as JSON | `--root=<repo>`, `--path=<file>`, `--limit=<n>` |
| `restore-points` | Return restore points as JSON | `--root=<repo>` |
| `validate-index` | Return validation report as JSON | `--root=<repo>`, `--mode=<core|full>` |
| `cluster` | Return cluster output as JSON | `--root=<repo>`, `--max-depth=<n>`, `--max-clusters=<n>` |
| `hubs` / `find-hub` | Return hub output as JSON | `--root=<repo>`, `--hub-path=<file>`, `--feature-name=<name>`, `--query=<text>`, `--ranking-mode=<keyword|semantic|both>`, `--show-orphans` |
| `symbol` | Return exact symbol results plus freshness header | `<query>` or `--query=<text>`, `--root=<repo>`, `--top-k=<n>` |
| `word` | Return word results plus freshness header | `<query>` or `--query=<text>`, `--root=<repo>`, `--top-k=<n>` |
| `outline` | Return outline payload plus freshness header | `<file>` or `--file-path=<file>`, `--root=<repo>` |
| `deps` | Return dependency payload plus freshness header | `<target>` or `--target=<file>`, `--root=<repo>` |
| `search` | Return search report plus freshness header | `<query>` or `--query=<text>`, `--root=<repo>`, `--intent=<exact|related>`, `--search-type=<file|symbol|mixed>`, `--retrieval-mode=<semantic|keyword|both>`, `--top-k=<n>`, `--include-kinds=a,b` |
| `research` | Return research report plus freshness header | `<query>` or `--query=<text>`, `--root=<repo>`, `--top-k=<n>`, `--include-kinds=a,b`, `--max-related=<n>`, `--max-subsystems=<n>`, `--max-hubs=<n>` |
| `lint` | Return lint/static-analysis report | `--root=<repo>`, `--target-path=<path>` |
| `blast-radius` | Return blast-radius report | `<symbol>` or `--symbol-name=<name>`, `--root=<repo>`, `--file-context=<file>` |
| `checkpoint` | Return checkpoint report | `<file>` or `--file-path=<file>`, `--root=<repo>`, `--new-content=<full file contents>` |
| `restore` | Return restore payload | `<point-id>` or `--point-id=<id>`, `--root=<repo>` |
| `repair-index` | Return repair payload | `--root=<repo>`, `--target=<core|full|bootstrap|file-search|identifier-search|full-artifacts>` |

### Persistent `bridge-serve` protocol

`bridge-serve` runs a long-lived JSON-line session with these frame shapes:

```json
{"type":"request","id":1,"command":"doctor","args":{"root":"."}}
{"type":"response","id":1,"ok":true,"result":{...}}
{"type":"event","kind":"log","message":"..."}
```

The persistent shared command executor supports everything listed above plus these backend-control commands:

| Persistent command | Purpose |
| --- | --- |
| `index` | Trigger index or refresh work through the shared backend |
| `job-control` | Control queued work with `cancel-pending`, `retry-last`, or `supersede-pending` |
| `watch-set` | Enable or disable watching, optionally with debounce override |
| `shutdown` | Ask the persistent bridge service to shut down |

Alias notes for the bridge layer:

- `find-hub` and `hubs` normalize onto the same implementation
- underscore forms are normalized to hyphen forms where applicable
- `validate-index` and `repair-index` are the canonical bridge names

### Persistent-only command arguments

| Command | Key arguments |
| --- | --- |
| `index` | `root`, `mode?: "auto" | "core" | "full"` |
| `job-control` | `root`, `action: "cancel-pending" | "retry-last" | "supersede-pending"` |
| `watch-set` | `root`, `enabled`, `debounceMs?` |
| `shutdown` | none |

## Human CLI Surface

The Go operator console is exposed as `scplus-cli`.

### Supported direct `scplus-cli` subcommands

| Command | Purpose | Important args |
| --- | --- | --- |
| `scplus-cli` | Launch the interactive operator console | optional `--root=<repo>` |
| `scplus-cli doctor --root .` | Print a plain-text health report | `--root=<repo>` |
| `scplus-cli snapshot --root .` | Render a one-shot UI snapshot and exit | `--root=<repo>` |
| `scplus-cli index --root . [auto|core|full]` | Trigger index work through the backend | `--root=<repo>` and optional positional mode |
| `scplus-cli tree --root .` | Print the prepared tree view | `--root=<repo>` |
| `scplus-cli hubs --root .` | Print hub output | `--root=<repo>` |
| `scplus-cli cluster --root .` | Print cluster output | `--root=<repo>` |
| `scplus-cli restore-points --root .` | Print restore-point history | `--root=<repo>` |
| `scplus-cli hub-create --root . --title \"...\" --summary \"...\" --files \"a,b,c\"` | Create a manual hub file | `--title`, `--summary`, `--files`, `--root=<repo>` |

`scplus-cli` only has the direct shell subcommands listed above. The much larger operator-facing command set lives inside the interactive UI and is routed over the persistent `bridge-serve` backend session.

### Human CLI capabilities

Based on the current UI implementation and the previous README’s still-useful context:

- animated/operator-branded top shell
- typed navigation across overview, tree, hubs, restore points, clusters, dependencies, search, research, lint, blast-radius, checkpoint, status, and changes
- detail views for selected items and export-ready content
- jobs and log panes fed by backend events
- command palette, filtering, history, and export actions
- shared backend session over `bridge-serve`
- backend-owned watcher/scheduler state surfaced in the operator experience

### Interactive operator commands exposed inside `scplus-cli`

The Bubble Tea UI exposes a broader action catalog than the direct shell subcommands. These commands are available from the command palette and, where applicable, from the sidebar action list.

| Operator command | What it does | Backing surface |
| --- | --- | --- |
| `exit` | Quit the operator console | local UI action |
| `activity` | Return to the main operator surface | local UI action |
| `back` | Move backward through navigation history | local UI action |
| `forward` | Move forward through navigation history | local UI action |
| `overview` | Open the health and observability overview | local UI view |
| `tree` | Open the prepared tree section | `bridge-serve` `tree` |
| `hubs` | Open manual and suggested hubs | `bridge-serve` `hubs` |
| `issue` | Open the current issue/detail view | local UI view |
| `log` | Open the backend log history pane | streamed `bridge-serve` events |
| `restore` | Open restore points and recovery state | `bridge-serve` `restore-points` |
| `cluster` | Open persisted semantic clusters | `bridge-serve` `cluster` |
| `status` | Open the git worktree status table | `bridge-serve` `status` |
| `changes` | Open changed-file stats and ranges | `bridge-serve` `changes` |
| `search` | Open ranked search output | `bridge-serve` `search` |
| `symbol` | Open exact symbol output | `bridge-serve` `symbol` |
| `index` | Trigger indexing through the shared backend | `bridge-serve` `index` |
| `retry-index` | Re-run the last sync strategy | `bridge-serve` `job-control` |
| `refresh` | Refresh visible backend-backed sections | repeated bridge refresh calls |
| `cancel-pending` | Drop queued watch work before it starts | `bridge-serve` `job-control` |
| `supersede-pending` | Replace stale queued work with the newest plan | `bridge-serve` `job-control` |
| `watch` | Enable or disable watcher-driven refreshes | `bridge-serve` `watch-set` |
| `new-hub` | Start the manual hub-creation flow | local UI wizard plus hub creation |
| `export` | Export the active pane or detail content to `.scplus/exports/` | local UI action |
| `help` | Open keybinding and behavior help | local UI overlay |
| `find-hub` | Rank hubs by natural-language query | `bridge-serve` `hubs` / `find-hub` |
| `exact` | Run exact mixed search | `bridge-serve` `search` |
| `search-related` | Run related ranked search | `bridge-serve` `search` |
| `research` | Build the broad explanation-backed report | `bridge-serve` `research` |
| `file` | Find an exact file/path hit and open it in Search | `bridge-serve` `search` |
| `go-symbol` | Find an exact symbol hit and open it in Search | `bridge-serve` `search` |
| `symbol-lookup` | Run exact symbol lookup directly | `bridge-serve` `symbol` |
| `word` | Run exact word lookup directly | `bridge-serve` `word` |
| `outline` | Load the prepared outline for one file | `bridge-serve` `outline` |
| `deps` | Load direct and reverse dependencies for one file | `bridge-serve` `deps` |
| `lint` | Run native lint diagnostics | `bridge-serve` `lint` |
| `blast-radius` | Trace symbol usage across the repo | `bridge-serve` `blast-radius` |
| `checkpoint-detail` | Save the current detail pane to a repo file via checkpoint flow | `bridge-serve` `checkpoint` |
| `restore-point` | Restore one shadow restore point by id | `bridge-serve` `restore` |

### Human CLI keybindings

The current UI wiring exposes these interaction patterns directly in the Go operator console:

- `:` or `Ctrl+P` opens the command palette.
- `/` starts in-section filtering.
- `b` and `f` move backward and forward through navigation history.
- `e` exports the current pane or detail content into `.scplus/exports/`.
- `?` opens the help overlay.
- `Tab` and `Shift+Tab` move focus across panes and overlays.
- Arrow keys plus `j` / `k` move through lists and tables.
- `Enter` opens the selected row or confirms the active prompt action.
- `Esc` exits overlays, prompts, or focus modes.
- Mouse wheel and pointer focus are supported across sidebar, content, detail, jobs, and logs panes.

## Benchmarks

The committed benchmark artifacts are produced by the real evaluation harness under `docs/benchmarks/`.

- Human-readable summary: [latest.md](/home/cesar514/Documents/agent_programming/contextplus/docs/benchmarks/latest.md)
- Machine-readable report: [latest.json](/home/cesar514/Documents/agent_programming/contextplus/docs/benchmarks/latest.json)

![scplus benchmark overview](/home/cesar514/Documents/agent_programming/contextplus/docs/assets/contextpp-benchmark-overview.svg)

Current committed numbers from the checked-in benchmark summary:

| Lane | Samples | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: |
| Exact | 5 | 3.14 | 4.07 | 4.07 |
| Related | 7 | 55.95 | 57.64 | 57.64 |
| Research | 3 | 63.52 | 64.23 | 64.23 |

| Quality category | Passed | Total |
| --- | ---: | ---: |
| Scenario coverage | 10 | 10 |
| Exact lookup accuracy | 5 | 5 |
| Related-search relevance | 4 | 4 |
| Symbol resolution accuracy | 3 | 3 |
| Dependency graph accuracy | 3 | 3 |
| Hub suggestion quality | 4 | 4 |
| Research quality | 3 | 3 |

The current committed run also records:

- `22` golden operator questions
- `0/4` stale-after-write failures
- `0/2` restore failures
- `251` Tree-sitter parses
- `247` parser reuses

This matters because the benchmark suite is exercising not just indexing latency, but also validation quality, rename/write freshness, and broken-state behavior.

## References

- [zilliztech/claude-context](https://github.com/zilliztech/claude-context): prior art for codebase-context workflows, repository navigation patterns, and agent-facing context tooling that influenced the product direction.

## License

This project is licensed under the MIT License. See [LICENSE](/home/cesar514/Documents/agent_programming/contextplus/LICENSE) for the full text.
