# codebase indexing pipeline

The codebase indexing pipeline materializes durable scplus state through a codebase entrypoint for .scplus projects. The indexing pipeline uses IndexCodebaseProgressEvent to track progress, not other components. 23 files around src/core/process-lifecycle.ts

Suggested hub generated from persisted full-index artifacts.

- Rationale: The codebase indexing pipeline materializes durable scplus state through a codebase entrypoint for .scplus projects. The indexing pipeline uses IndexCodebaseProgressEvent to track progress, not other components. 23 files around src/core/process-lifecycle.ts Touches modules src/core, test/demo, test/main. Tagged with Loud cross-process watcher and mutation ownership for scplus runtimes., Prevent cross-process watcher and mutation races between CLI bridge and MCP runtimes., Runtime process lifecycle and broken-pipe detection utilities.. Backed by semantic clusters cluster-root, cluster-1-5, cluster-2-0.
- Modules: src/core, test/demo, test/main
- Feature tags: Loud cross-process watcher and mutation ownership for scplus runtimes., Prevent cross-process watcher and mutation races between CLI bridge and MCP runtimes., Runtime process lifecycle and broken-pipe detection utilities.

@linked-to [[Hierarchical context management via feature hub graph.]]
@linked-to [[architecture documentation]]
@linked-to [[cross-process coordination]]
@linked-to [[embedding and indexing]]

- [[src/core/process-lifecycle.ts|Suggested because it anchors codebase indexing pipeline]]
- [[src/core/runtime-locks.ts|Suggested because it anchors codebase indexing pipeline]]
- [[test/demo/blast-radius.demo.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/demo/context-tree.demo.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/demo/propose-commit.demo.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/demo/shadow.demo.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/demo/walker.demo.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/blast-radius.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/bridge-serve.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/context-tree.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/embedding-tracker.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/feature-hub.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/file-skeleton.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/hub.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/idle-timeout-spawn.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/init-codex.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/init-opencode.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/process-lifecycle.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/propose-commit.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/runtime-concurrency.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/shadow.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/static-analysis.test.mjs|Suggested because it anchors codebase indexing pipeline]]
- [[test/main/walker.test.mjs|Suggested because it anchors codebase indexing pipeline]]
