# Context+

Semantic Intelligence for Large-Scale Engineering.

Context+ is an MCP server designed for developers who demand 99% accuracy. By combining Tree-sitter AST, Spectral Clustering, and Obsidian-style linking, Context+ turns a massive codebase into a searchable, hierarchical feature graph.

https://github.com/user-attachments/assets/a97a451f-c9b4-468d-b036-15b65fc13e79

## Local Install

For local development, install the linked `contextplus` CLI with:

```bash
./install-contextplus.sh
```

What it does:

- runs `npm install`
- runs `npm run build`
- runs `npm run build:cli`
- runs `npm link`
- verifies the linked `contextplus` command resolves to this checkout
- verifies the linked `contextplus-ui` command resolves to this checkout

After editing this repo, rebuild the linked CLI with:

```bash
npm run build:all
```

The human CLI is built with Bubble Tea in Go and uses a project-local Go toolchain through Pixi. `pixi` must be installed before running the install script.

Because `npm link` points `contextplus` at this checkout’s [build/index.js](/home/cesar514/Documents/agent_programming/contextplus/build/index.js) and `contextplus-ui` at [build/cli-launcher.js](/home/cesar514/Documents/agent_programming/contextplus/build/cli-launcher.js), future builds update both commands in place.

To add it to Codex, put this in `~/.codex/config.toml` as a separate manual step:

```toml
[mcp_servers.contextplus]
command = "contextplus"
args = []

[mcp_servers.contextplus.env]
OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b-32k"
OLLAMA_CHAT_MODEL = "nemotron-3-nano:4b-128k"
CONTEXTPLUS_EMBED_BATCH_SIZE = "8"
CONTEXTPLUS_EMBED_TRACKER = "lazy"
```

## Tools

### Discovery

| Tool                         | Description                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index`                     | Create or refresh `.contextplus/` project state. Defaults to `full` mode, which eagerly builds persisted file, identifier, chunk, code-structure, semantic-cluster, and hub-suggestion artifacts, writes indexing status, preserves restore-point state, refreshes incrementally using content hashes plus dependency-aware structure invalidation, and prepares the unified ranking substrate used by canonical search. |
| `validate_index`            | Check that the prepared sqlite-backed index is present, version-compatible, and internally consistent for `core` or `full` mode before query tools rely on it. |
| `repair_index`              | Repair a broken prepared index by rerunning either the full pipeline or a specific durable stage, then revalidate the repaired state loudly. |
| `tree`                      | Structural AST tree of a project with file headers and symbol ranges (line numbers for functions/classes/methods). Dynamic pruning shrinks output automatically. |
| `skeleton`                  | Function signatures, class methods, and type definitions with line ranges, without reading full bodies. Shows the API surface.                                   |
| `symbol`                    | Tiny exact symbol lookup over the prepared fast-query substrate. Use this when you already know the symbol name and want deterministic exact matches. |
| `word`                      | Tiny indexed word lookup over paths, headers, symbols, and content snippets. Use this for exact words or short phrases before escalating to broader search. |
| `outline`                   | Compact imports/exports/symbol outline for a known file from the prepared fast-query substrate. |
| `deps`                      | Compact direct and reverse dependency report for one indexed file. |
| `status`                    | Tiny git worktree status summary for the current repository. |
| `changes`                   | Tiny git change summary, optionally scoped to one file, including line-range hunks when available. |
| `search`                    | Query-intent router for repository search. Use `intent: "exact"` for deterministic fast-substrate answers when you already know the symbol or file target, and `intent: "related"` for ranked related-item and pattern discovery. `search_type` still selects `file`, `symbol`, or `mixed`, and related search now accepts explicit `retrieval_mode` values of `semantic`, `keyword`, or `both`. |
| `research`                  | Broad repository research report. Use this for subsystem understanding after exact lookup and related-item search are no longer enough. |
| `evaluate`                  | Run the built-in real benchmark harness across small, medium, monorepo, polyglot, ignored-tree, broken-state, and rename-freshness scenarios. Reports golden-query accuracy, validation rates, freshness reliability, and p50/p95/p99 query latency. |
| `cluster`                   | Browse persisted semantic clusters from the full index. Renders labeled subsystem groupings, related files, and cluster summaries from sqlite-backed artifacts. |

### Analysis

| Tool                  | Description                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `blast_radius`        | Trace every file and line where a symbol is imported or used. Prevents orphaned references.                                   |
| `lint`                | Run native linters and compilers to find unused variables, dead code, and type errors. Supports TypeScript, Python, Rust, Go, and now reports a repo score plus lowest-scoring files from Context+ repo-rule findings. |

### Code Ops

| Tool              | Description                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `checkpoint`   | The only way to write code. Validates against strict rules before saving. Creates a shadow restore point before writing. |
| `find_hub`     | Obsidian-style feature hub navigator. Lists handwritten hubs plus persisted suggested hubs and feature-group candidates generated from the full index, and can rank hub candidates for a natural-language query with `keyword`, `semantic`, or `both` modes. |

### Version Control

| Tool                  | Description                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `restore_points` | List all shadow restore points created by `checkpoint`. Each captures file state before AI changes.    |
| `restore`        | Restore files to their state before a specific AI change. Uses shadow restore points. Does not affect git. |

## Setup

### Quick Start (npx / bunx)

No installation needed. Add Context+ to your IDE MCP config.

For Claude Code, Cursor, and Windsurf, use `mcpServers`:

```json
{
  "mcpServers": {
    "contextplus": {
      "command": "bunx",
      "args": ["contextplus"],
      "env": {
        "OLLAMA_EMBED_MODEL": "qwen3-embedding:0.6b-32k",
        "OLLAMA_CHAT_MODEL": "nemotron-3-nano:4b-128k",
        "OLLAMA_API_KEY": "YOUR_OLLAMA_API_KEY"
      }
    }
  }
}
```

For VS Code (`.vscode/mcp.json`), use `servers` and `inputs`:

```json
{
  "servers": {
    "contextplus": {
      "type": "stdio",
      "command": "bunx",
      "args": ["contextplus"],
      "env": {
        "OLLAMA_EMBED_MODEL": "qwen3-embedding:0.6b-32k",
        "OLLAMA_CHAT_MODEL": "nemotron-3-nano:4b-128k",
        "OLLAMA_API_KEY": "YOUR_OLLAMA_API_KEY"
      }
    }
  },
  "inputs": []
}
```

If you prefer `npx`, use:

- `"command": "npx"`
- `"args": ["-y", "contextplus"]`

Or generate the MCP config file directly in your current directory:

```bash
npx -y contextplus init claude
bunx contextplus init cursor
npx -y contextplus init opencode
bunx contextplus init codex
```

Supported coding agent names: `claude`, `cursor`, `vscode`, `windsurf`, `opencode`, `codex`.

Config file locations:

| IDE         | Config File          |
| ----------- | -------------------- |
| Claude Code | `.mcp.json`          |
| Cursor      | `.cursor/mcp.json`   |
| VS Code     | `.vscode/mcp.json`   |
| Windsurf    | `.windsurf/mcp.json` |
| OpenCode    | `opencode.json`      |
| Codex       | `.codex/config.toml` |

### CLI Subcommands

- `init [target]` - Generate MCP configuration (targets: `claude`, `cursor`, `vscode`, `windsurf`, `opencode`, `codex`).
- `index [path] [--mode=core|full]` - Create or refresh `.contextplus/` for the target repo. Defaults to `full` mode. The authoritative durable machine state now lives only in `state/index.sqlite`. `core` persists the project config, context-tree export, file manifest, stage state, indexing status, and eager file/identifier search state in SQLite. `full` also persists first-class AST chunk artifacts, hybrid chunk and identifier retrieval indexes, richer code-structure artifacts, and the full-manifest plus vector collections in SQLite. Dense retrieval now writes into `vector_collections` and `vector_entries` instead of artifact-shaped embedding-cache blobs, while the hybrid layer keeps lexical term maps plus embedding keys so later search surfaces can combine lexical and dense evidence without rebuilding transient indexes. The structure layer now includes per-file imports, exports, calls, symbols, dependency paths, normalized symbol records, file-to-symbol maps, ownership edges, module summaries, and module import edges. Refresh uses file content hashes for file and identifier artifacts, file-plus-chunk content hashes for chunk reuse, dependency hashes for structure artifacts so local import changes invalidate affected downstream files, and embed-provider/model-aware cache hashes so vector reuse stops immediately when the embedding backend changes. Legacy JSON artifact files are deleted during bootstrap so the database remains the only source of truth. The persisted contract metadata covers supported modes, stage order, sqlite-only storage, invalidation rules, and crash-only failure semantics.
- `validate-index [path]` - Verify that a prepared `core` or `full` index is still version-compatible and internally consistent before query tools rely on it. `validate_index` remains supported as an alias.
- `repair-index [path] --target=<core|full|bootstrap|file-search|identifier-search|full-artifacts>` - Repair a broken prepared index and revalidate it. `repair_index` remains supported as an alias.
- `tree [path] [--json]` - Print the structural tree for a repo directly in the terminal.
- `skeleton <file> [--root=<repo>] [--json]` - Print the structural skeleton for a single indexed file.
- `status [path] [--json]` - Print the git-aware repo status summary from the fast exact-query substrate.
- `changes [path] [--path=<file>] [--limit=<n>] [--json]` - Print changed-file summaries and optional line-range detail.
- `cluster [path] [--json]` - Render the persisted semantic cluster view for the prepared full index.
- `hubs [path] [--query=<text>] [--feature-name=<name>] [--hub-path=<file>] [--show-orphans] [--json]` - Browse hub summaries, suggestions, and hub details from the terminal.
- `restore-points [path] [--json]` - Print restore-point history for the repository.
- `doctor [path] [--json]` - Print a combined repo, index, hub, restore-point, Ollama, and observability report, including stage timing, cache, integrity, and scheduler metrics.
- `bridge <subcommand>` - Machine-readable JSON output for the human CLI and automation. Shared high-value subcommands now include `doctor`, `tree`, `status`, `changes`, `restore-points`, `validate-index`, `cluster`, `hubs`, `symbol`, `word`, `outline`, `deps`, `search`, `research`, `lint`, `blast-radius`, `checkpoint`, `restore`, and `repair-index`.
- `bridge-serve` - Persistent JSON-line session used by `contextplus-ui`. Requests use `{"type":"request","id":<n>,"command":"...","args":{...}}`; responses mirror the same id, and async backend events stream as `{"type":"event", ...}` frames.
- `[path]` - Start the MCP server (stdio) for the specified path (defaults to current directory).

### Human CLI

The Bubble Tea terminal app is exposed as `contextplus-ui`.

- `contextplus-ui` - Launch the interactive dashboard.
- `contextplus-ui snapshot --root .` - Render the overview screen once and exit. Useful for tests and automation.
- `contextplus-ui doctor --root .` - Print a concise health summary from the human CLI.
- `contextplus-ui index --root .` - Trigger a full index run through the backend.
- `contextplus-ui tree --root .`
- `contextplus-ui hubs --root .`
- `contextplus-ui cluster --root .`
- `contextplus-ui restore-points --root .`
- `contextplus-ui hub-create --root . --title "Main Flow" --summary "Operator entrypoint" --files "src/index.ts,README.md"`

The dashboard includes:

- an animated magician header
- a left navigation-and-actions sidebar, a center content pane, a right detail pane, and a bottom jobs/logs pane on wide terminals
- a stacked vertical fallback layout for narrower terminals
- a real bottom status line showing watcher state, current index stage, backend connectivity, active repo, and active generation
- observability details for stage timing, vector coverage, refresh failures, lexical candidate counts, and watcher scheduler state
- typed section navigation for overview, tree, hubs, restore points, and clusters instead of a tab-only card wall, with overview rows that can be navigated and scrolled through the content pane
- Bubble `list` and `table` components for operator sections instead of raw text dumps, with typed status and changes tables and typed list renderers for tree, hubs, restore points, clusters, and search-result state
- a structured jobs table for index, refresh, restore, lint, and query task slots, with stage, percent, current file, elapsed time, queue depth, and pending-state context on the active index row
- a real scrollable log panel instead of a fixed 12-line activity buffer
- operator controls for retrying the last index and canceling or superseding queued watch work directly from the console sidebar and jobs pane hints
- a persistent backend session shared through `bridge-serve`
- a backend-owned watcher that streams change batches, explicit job progress, current-file progress, and index-job control effects to the UI
- a human hub-creation flow

### Codex

Codex uses project-scoped TOML configuration in `.codex/config.toml`:

```toml
[mcp_servers.contextplus]
command = "bunx"
args = ["contextplus"]

[mcp_servers.contextplus.env]
OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b-32k"
OLLAMA_CHAT_MODEL = "nemotron-3-nano:4b-128k"
OLLAMA_API_KEY = "YOUR_OLLAMA_API_KEY"
CONTEXTPLUS_EMBED_BATCH_SIZE = "8"
CONTEXTPLUS_EMBED_TRACKER = "lazy"
```

### From Source

```bash
npm install
npm run build
```

## Embedding Providers

Context+ supports two embedding backends controlled by `CONTEXTPLUS_EMBED_PROVIDER`:

| Provider | Value | Requires | Best For |
|----------|-------|----------|----------|
| **Ollama** (default) | `ollama` | Local Ollama server | Free, offline, private |
| **OpenAI-compatible** | `openai` | API key | Gemini (free tier), OpenAI, Groq, vLLM |

### Ollama (Default)

No extra configuration needed. Just run Ollama with an embedding model:

```bash
ollama pull qwen3-embedding:0.6b-32k
ollama pull nemotron-3-nano:4b-128k
ollama serve
```

### Google Gemini (Free Tier)

Full Claude Code `.mcp.json` example:

```json
{
  "mcpServers": {
    "contextplus": {
      "command": "npx",
      "args": ["-y", "contextplus"],
      "env": {
        "CONTEXTPLUS_EMBED_PROVIDER": "openai",
        "CONTEXTPLUS_OPENAI_API_KEY": "YOUR_GEMINI_API_KEY",
        "CONTEXTPLUS_OPENAI_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai",
        "CONTEXTPLUS_OPENAI_EMBED_MODEL": "text-embedding-004"
      }
    }
  }
}
```

Get a free API key at [Google AI Studio](https://aistudio.google.com/apikey).

### OpenAI

```json
{
  "mcpServers": {
    "contextplus": {
      "command": "npx",
      "args": ["-y", "contextplus"],
      "env": {
        "CONTEXTPLUS_EMBED_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_EMBED_MODEL": "text-embedding-3-small"
      }
    }
  }
}
```

### Other OpenAI-compatible APIs (Groq, vLLM, LiteLLM)

Any endpoint implementing the [OpenAI Embeddings API](https://platform.openai.com/docs/api-reference/embeddings) works:

```json
{
  "mcpServers": {
    "contextplus": {
      "command": "npx",
      "args": ["-y", "contextplus"],
      "env": {
        "CONTEXTPLUS_EMBED_PROVIDER": "openai",
        "CONTEXTPLUS_OPENAI_API_KEY": "YOUR_KEY",
        "CONTEXTPLUS_OPENAI_BASE_URL": "https://your-proxy.example.com/v1",
        "CONTEXTPLUS_OPENAI_EMBED_MODEL": "your-model-name"
      }
    }
  }
}
```

> **Note:** The `cluster` tool also uses a chat model for cluster labeling. When using the `openai` provider, set `CONTEXTPLUS_OPENAI_CHAT_MODEL` (default: `gpt-4o-mini`).
>
> For VS Code, Cursor, or OpenCode, use the same `env` block inside your IDE's MCP config format (see [Config file locations](#setup) table above).

## Architecture

Three layers built with TypeScript over stdio using the Model Context Protocol SDK:

**Core** (`src/core/`) - Multi-language AST parsing (tree-sitter, 43 extensions), gitignore-aware traversal, Ollama/OpenAI-compatible vector embeddings with sqlite vector collections, and wikilink hub graph.

**Tools** (`src/tools/`) - MCP tools exposing structural, semantic, and operational codebase capabilities.

**Git** (`src/git/`) - Shadow restore point system for undo without touching git history.

**Project State** (`.contextplus/`) - created by `index`; stores authoritative machine state in `.contextplus/state/index.sqlite` plus generated suggested hub markdown under `.contextplus/hubs/suggested/` when full-mode hub suggestions exist. Legacy sqlite-migration directories such as `.contextplus/config/`, `.contextplus/embeddings/`, `.contextplus/checkpoints/`, and `.contextplus/derived/` are removed instead of being recreated empty. Later searches refresh only changed files before querying the prepared state.

## Config

| Variable                                | Type                      | Default                                | Description                                                   |
| --------------------------------------- | ------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `CONTEXTPLUS_EMBED_PROVIDER`            | string                    | `ollama`                               | Embedding backend: `ollama` or `openai`                      |
| `OLLAMA_EMBED_MODEL`                    | string                    | `qwen3-embedding:0.6b-32k`             | Ollama embedding model                                        |
| `OLLAMA_API_KEY`                        | string                    | -                                      | Ollama Cloud API key                                          |
| `OLLAMA_CHAT_MODEL`                     | string                    | `nemotron-3-nano:4b-128k`              | Ollama chat model for cluster labeling                        |
| `CONTEXTPLUS_OPENAI_API_KEY`            | string                    | -                                      | API key for OpenAI-compatible provider (alias: `OPENAI_API_KEY`) |
| `CONTEXTPLUS_OPENAI_BASE_URL`           | string                    | `https://api.openai.com/v1`            | OpenAI-compatible endpoint URL (alias: `OPENAI_BASE_URL`)    |
| `CONTEXTPLUS_OPENAI_EMBED_MODEL`        | string                    | `text-embedding-3-small`               | OpenAI-compatible embedding model (alias: `OPENAI_EMBED_MODEL`) |
| `CONTEXTPLUS_OPENAI_CHAT_MODEL`         | string                    | `gpt-4o-mini`                          | OpenAI-compatible chat model for labeling (alias: `OPENAI_CHAT_MODEL`) |
| `CONTEXTPLUS_EMBED_BATCH_SIZE`          | string (parsed as number) | `8`                | Embedding batch size per GPU call, clamped to 5-10            |
| `CONTEXTPLUS_EMBED_CHUNK_CHARS`         | string (parsed as number) | `2000`             | Per-chunk chars before merge, clamped to 256-8000             |
| `CONTEXTPLUS_MAX_EMBED_FILE_SIZE`       | string (parsed as number) | `51200`            | Skip non-code text files larger than this many bytes          |
| `CONTEXTPLUS_EMBED_NUM_GPU`             | string (parsed as number) | -                  | Optional Ollama embed runtime `num_gpu` override              |
| `CONTEXTPLUS_EMBED_MAIN_GPU`            | string (parsed as number) | -                  | Optional Ollama embed runtime `main_gpu` override             |
| `CONTEXTPLUS_EMBED_NUM_THREAD`          | string (parsed as number) | -                  | Optional Ollama embed runtime `num_thread` override           |
| `CONTEXTPLUS_EMBED_NUM_BATCH`           | string (parsed as number) | -                  | Optional Ollama embed runtime `num_batch` override            |
| `CONTEXTPLUS_EMBED_NUM_CTX`             | string (parsed as number) | -                  | Optional Ollama embed runtime `num_ctx` override              |
| `CONTEXTPLUS_EMBED_LOW_VRAM`            | string (parsed as boolean)| -                  | Optional Ollama embed runtime `low_vram` override             |
| `CONTEXTPLUS_EMBED_TRACKER`             | string (parsed as boolean)| `true`             | Enable realtime embedding refresh on file changes             |
| `CONTEXTPLUS_EMBED_TRACKER_MAX_FILES`   | string (parsed as number) | `8`                | Max changed files processed per tracker tick, clamped to 5-10 |
| `CONTEXTPLUS_EMBED_TRACKER_DEBOUNCE_MS` | string (parsed as number) | `700`              | Debounce window before tracker refresh                        |

## Test

```bash
npm test
npm run test:demo
npm run test:all
```
