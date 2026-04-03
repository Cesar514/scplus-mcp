# cross-process coordination

These files coordinate cross-process runtime locks and shared repository backend work to ensure safe concurrent access. They use RepoRuntimeLockOwner and AcquireRepoRuntimeLockOptions to manage ownership and acquisition of repo-level runtime locks. test/*

Suggested hub generated from persisted full-index artifacts.

- Rationale: These files coordinate cross-process runtime locks and shared repository backend work to ensure safe concurrent access. They use RepoRuntimeLockOwner and AcquireRepoRuntimeLockOptions to manage ownership and acquisition of repo-level runtime locks. test/* Touches modules test/demo, test/main. Tagged with Verifies watcher creation only occurs when explicitly needed. Backed by semantic clusters cluster-root, cluster-1-5, cluster-2-1.
- Modules: test/demo, test/main
- Feature tags: Verifies watcher creation only occurs when explicitly needed

@linked-to [[Hierarchical context management via feature hub graph.]]
@linked-to [[architecture documentation]]
@linked-to [[codebase indexing pipeline]]
@linked-to [[embedding and indexing]]

- [[test/demo/blast-radius.demo.mjs|Suggested because it anchors cross-process coordination]]
- [[test/demo/context-tree.demo.mjs|Suggested because it anchors cross-process coordination]]
- [[test/demo/propose-commit.demo.mjs|Suggested because it anchors cross-process coordination]]
- [[test/demo/shadow.demo.mjs|Suggested because it anchors cross-process coordination]]
- [[test/demo/walker.demo.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/blast-radius.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/context-tree.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/embedding-tracker.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/feature-hub.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/file-skeleton.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/hub.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/init-codex.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/init-opencode.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/propose-commit.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/shadow.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/static-analysis.test.mjs|Suggested because it anchors cross-process coordination]]
- [[test/main/walker.test.mjs|Suggested because it anchors cross-process coordination]]
