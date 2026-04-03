# process lifecycle management

These files provide utilities for managing process lifecycle, detecting broken pipes, and handling idle timeouts across the application runtime. They implement runtime process lifecycle and broken-pipe detection utilities using symbols like BROKEN_PIPE_CODES and DEFAULT_IDLE_TIMEOUT_MS. 6 files around src/core/process-lifecycle.ts

Suggested hub generated from persisted full-index artifacts.

- Rationale: These files provide utilities for managing process lifecycle, detecting broken pipes, and handling idle timeouts across the application runtime. They implement runtime process lifecycle and broken-pipe detection utilities using symbols like BROKEN_PIPE_CODES and DEFAULT_IDLE_TIMEOUT_MS. 6 files around src/core/process-lifecycle.ts Touches modules src/core, test/main. Tagged with Loud cross-process watcher and mutation ownership for scplus runtimes., Prevent cross-process watcher and mutation races between CLI bridge and MCP runtimes., Runtime process lifecycle and broken-pipe detection utilities.. Backed by semantic clusters cluster-root, cluster-1-5, cluster-2-0.
- Modules: src/core, test/main
- Feature tags: Loud cross-process watcher and mutation ownership for scplus runtimes., Prevent cross-process watcher and mutation races between CLI bridge and MCP runtimes., Runtime process lifecycle and broken-pipe detection utilities.

@linked-to [[Hierarchical context management via feature hub graph.]]
@linked-to [[codebase indexing pipeline]]
@linked-to [[operator console launcher]]

- [[src/core/process-lifecycle.ts|Suggested because it anchors process lifecycle management]]
- [[src/core/runtime-locks.ts|Suggested because it anchors process lifecycle management]]
- [[test/main/bridge-serve.test.mjs|Suggested because it anchors process lifecycle management]]
- [[test/main/idle-timeout-spawn.test.mjs|Suggested because it anchors process lifecycle management]]
- [[test/main/process-lifecycle.test.mjs|Suggested because it anchors process lifecycle management]]
- [[test/main/runtime-concurrency.test.mjs|Suggested because it anchors process lifecycle management]]
