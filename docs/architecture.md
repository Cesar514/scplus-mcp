# Context+ Architecture

This document is the short authoritative description of the current Context+ runtime.

## Serving Model

Context+ serves prepared state from one sqlite-backed repo-local index at `.contextplus/state/index.sqlite`.

- Query surfaces read from one active generation only.
- Reindex and repair flows reserve a pending generation, write candidate artifacts there, validate that generation, and only then promote it to active.
- If a candidate generation fails validation, the previous active generation remains the serving source of truth.
- Freshness is explicit: the active generation can be `fresh`, `dirty`, or `blocked`, and write workflows are expected to move it back to `fresh` only after synchronous refresh succeeds.

## Generation Model

Generations are durable serving snapshots, not ad hoc caches.

- Global metadata tracks active, pending, and latest generation ids.
- Generation-scoped artifacts include exact-query state, full-index artifacts, text artifacts, and vector namespaces.
- Global artifacts remain outside generation scoping only when they are intentionally shared, such as restore-point metadata.
- Validation is a hard gate: missing artifacts, incompatible versions, or incomplete stage state block promotion.

## Query Escalation Model

Context+ uses a two-lane query model.

- Exact navigation questions should stay on the prepared exact-query substrate through `symbol`, `word`, `outline`, `deps`, `status`, and `changes`.
- Broader discovery questions route through `search` with `intent="related"` and the unified ranking stack over file, chunk, identifier, and structure evidence.
- `research` sits above related search and assembles a larger report from ranked candidates, cluster artifacts, and hub context.
- The product contract is that exact queries remain the cheapest deterministic path, and broader ranked paths only run when exact lookup is insufficient.

## CLI And MCP Transport Model

The MCP server and the human CLI share one backend core.

- The TypeScript backend core owns watcher state, scheduler state, generation-aware reads, and backend event streaming.
- MCP calls use that core directly for server-side operations.
- The human CLI talks to the same core over the persistent local `bridge-serve` JSON-line protocol.
- `bridge` commands expose the same high-value engine surfaces for local automation without requiring the full MCP transport.
- The Go operator console is a client of the persistent bridge, not a second indexing engine.

## Operator Implications

Operators should treat the serving generation and freshness state as the primary truth signals.

- `doctor`, validation, bridge payloads, and the CLI status surfaces should agree on the active generation, pending generation, and freshness state.
- A broken prepared index should result in explicit failure or repair guidance, not quiet fallback behavior.
- Large UI and benchmark orchestration modules still exist, but the serving contract, query contract, and transport contract above describe the current shipped behavior.
