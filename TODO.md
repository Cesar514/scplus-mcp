# TODO List

## instructions

ai agents may update this file to remove completed work, keep the backlog accurate, and add newly discovered remaining tasks for the current goal

## current goal

No incomplete current-goal tasks. The completed step 21-24 work was moved to `TODO_COMPLETED.md`.

## full engine roadmap (ordered)

- [ ] 25. expose the full engine cleanly through the planned CLI and UX layers only after the underlying fast-path, indexing, retrieval, structure, and research primitives are stable

---

## v2

code update:

- [ ] list overengineered tools and parameters that could be removed for better context
- [ ] remove overengineered tools and parameters
- [ ] remove vibeslop code (if any)
- [ ] remove ollama bugs and spam for embeddings with a smarter embedding generation system that continuously watches for file changes and updates embeddings in the background, only init one time in the project and then its automatically watched

new features:

- [ ] ctx+ cli in cli/ folder
  - [ ] visualize undo commits, hubs in the cli
  - [ ] use charm's tui library - bubble or tea
  - [ ] features like `contextplus index`
  - [ ] visualize context tree, undo commits, hubs list, and more in the cli
  - [ ] create hubs option from the cli for humans
- [ ] faster and cleaner agent protocol access
- [ ] faster tool execution and cleaner outputs and better error handling and reporting with suggestions like "this tool failed, you can do this instead, it will work the same"
- [ ] better treesitter support and tools for using it to understand code structure and semantics better
- [ ] add these features to be visualized in the cli
- [ ] add researchplus tools and features
