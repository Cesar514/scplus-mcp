# Context+

Semantic Intelligence for Large-Scale Engineering.

Context+ is an MCP server designed for developers who demand 99% accuracy. By combining RAG, Tree-sitter AST, Spectral Clustering, and Obsidian-style linking, Context+ turns a massive codebase into a searchable, hierarchical feature graph.

https://github.com/user-attachments/assets/a97a451f-c9b4-468d-b036-15b65fc13e79

## Local Install

For local development, install the linked `contextplus` CLI with:

```bash
./install-contextplus.sh
```

What it does:

- runs `npm install`
- runs `npm run build`
- runs `npm link`
- verifies the linked `contextplus` command resolves to this checkout

After editing this repo, rebuild the linked CLI with:

```bash
npm run build
```

Because `npm link` points `contextplus` at this checkout’s [build/index.js](/home/cesar514/Documents/agent_programming/contextplus/build/index.js), future builds update the command Codex launches.

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
| `index`                     | Create or refresh `.contextplus/` project state. Defaults to `full` mode, which eagerly builds persisted file, identifier, chunk, and code-structure indexes, writes indexing status, and preserves durable memories/checkpoints. |
| `tree`                      | Structural AST tree of a project with file headers and symbol ranges (line numbers for functions/classes/methods). Dynamic pruning shrinks output automatically. |
| `skeleton`                  | Function signatures, class methods, and type definitions with line ranges, without reading full bodies. Shows the API surface.                                   |
| `search`                    | Unified semantic search. Use `search_type: "file"` for file retrieval or `search_type: "identifier"` for symbol matches with ranked call sites.                 |
| `cluster`                   | Browse codebase by meaning using spectral clustering. Groups semantically related files into labeled clusters.                                                   |

### Analysis

| Tool                  | Description                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `blast_radius`        | Trace every file and line where a symbol is imported or used. Prevents orphaned references.                                   |
| `lint`                | Run native linters and compilers to find unused variables, dead code, and type errors. Supports TypeScript, Python, Rust, Go. |

### Code Ops

| Tool              | Description                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `checkpoint`   | The only way to write code. Validates against strict rules before saving. Creates a shadow restore point before writing. |
| `find_hub`     | Obsidian-style feature hub navigator. Hubs are `.md` files with `[[wikilinks]]` that map features to code files.        |

### Version Control

| Tool                  | Description                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `restore_points` | List all shadow restore points created by `checkpoint`. Each captures file state before AI changes.    |
| `restore`        | Restore files to their state before a specific AI change. Uses shadow restore points. Does not affect git. |

### Memory & RAG

| Tool                      | Description                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `create_memory`          | Create or update a memory node (concept, file, symbol, note) with auto-generated embeddings.             |
| `create_relation`         | Create typed edges between nodes (relates_to, depends_on, implements, references, similar_to, contains). |
| `search_memory`          | Semantic search with graph traversal — finds direct matches then walks 1st/2nd-degree neighbors.         |
| `prune_stale_links`       | Remove decayed edges (e^(-λt) below threshold) and orphan nodes with low access counts.                  |
| `bulk_memory`            | Bulk-add nodes with auto-similarity linking (cosine ≥ 0.72 creates edges automatically).                 |
| `explore_memory`         | Start from a node and walk outward — returns all reachable neighbors scored by decay and depth.          |

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
- `index [path] [--mode=core|full]` - Create or refresh `.contextplus/` for the target repo. Defaults to `full` mode. The authoritative durable machine state now lives only in `state/index.sqlite`. `core` persists the project config, context-tree export, file manifest, stage state, indexing status, and eager file/identifier search state in SQLite. `full` also persists first-class AST chunk artifacts, code-structure artifacts, and the full-manifest plus embedding caches in SQLite. Chunk artifacts carry explicit contract metadata and store symbol-scoped spans with a file-fallback path when no symbols are available. Legacy JSON artifact files are deleted during bootstrap so the database remains the only source of truth. The persisted contract metadata covers supported modes, stage order, sqlite-only storage, invalidation rules, and crash-only failure semantics.
- `skeleton [path]` or `tree [path]` - **(New)** View the structural tree of a project with file headers and symbol definitions directly in your terminal.
- `[path]` - Start the MCP server (stdio) for the specified path (defaults to current directory).

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

**Core** (`src/core/`) - Multi-language AST parsing (tree-sitter, 43 extensions), gitignore-aware traversal, Ollama vector embeddings with disk cache, wikilink hub graph, in-memory property graph with decay scoring.

**Tools** (`src/tools/`) - 17 MCP tools exposing structural, semantic, operational, and memory graph capabilities.

**Git** (`src/git/`) - Shadow restore point system for undo without touching git history.

**Project State** (`.contextplus/`) - created by `index`; stores repo-local config, context-tree snapshots, indexing status, persisted stage state for rerunnable indexing stages, persisted file and identifier search state, full-mode derived chunk and code-structure artifacts, memory graph data, restore-point manifests, and embedding caches. Later searches refresh only changed files before querying the prepared state.

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
