# Lints WIP

Working spec for a strict, scriptable lint pack for agent-generated code.

The target is not generic style polish. The target is to make generated code:

- easy for an agent to read back
- easy to patch safely
- hard to hide failure in
- safe for async, robotics, streaming, and ML-heavy systems
- enforceable by scripts across multiple languages

## Goals

- Keep the core rule set small enough that an agent can internalize it during generation.
- Prefer AST- or token-based rules over vague natural-language judgment.
- Fail loudly on structural problems instead of allowing silent degradation.
- Support Python, TypeScript/JavaScript, Go, Java, Rust, C++, and similar languages through a shared engine plus language adapters.

## Non-goals

- Replacing language-native formatters.
- Encoding every style preference.
- Building a perfect semantic verifier.

## Recommended Build Shape

Use a two-layer design:

1. `core/`
   Shared rule engine, config loader, result model, severity handling, suppression parsing, and reporters.
2. `adapters/`
   Language-specific parsers and symbol extraction.

Recommended parser strategy:

- Tree-sitter for symbol extraction, function boundaries, parameters, nesting depth, comments, and public/exported detection.
- Token streams for duplication detection and statement counting.
- Regex-only checks only for final-mile comment format rules such as `TODO` normalization.

Recommended result schema:

```json
{
  "rule_id": "max_function_loc",
  "severity": "error",
  "path": "apps/api/live/session.py",
  "line": 142,
  "message": "Function exceeds 40 non-comment LOC (52).",
  "evidence": {
    "actual": 52,
    "limit": 40,
    "symbol": "LiveSession.run_loop"
  }
}
```

Recommended suppression format:

```text
lint-disable: rule_id reason=ISSUE-123
```

Suppressions should be rare, line-scoped where possible, and require a reason token.

## Rule Set

`[S]` means source-backed rule or threshold.  
`[P]` means policy choice chosen for agent effectiveness and scriptability.

### 1. `max_file_loc` `[P]`

- Fail if a file exceeds `800` non-comment LOC.
- Why: large files hide responsibilities and make retrieval and patching less reliable.
- Detection:
  Parse comments and blank lines out, count logical lines of code.
- Suggested severity: `warning` at first, later `error`.

### 2. `max_function_loc` `[S]`

- Fail if a function/method body exceeds `40` non-comment LOC.
- Why: smaller units are easier for humans and agents to understand and modify.
- Detection:
  Use AST function boundaries, count non-comment LOC inside the body.
- Suggested severity: `error`.

### 3. `max_parameter_count` `[P]`

- Fail if a callable has more than `5` declared parameters.
- Ignore receiver/self parameters such as `self`, `this`, and optionally `ctx`.
- Why: long signatures are harder to call correctly and signal over-coupled design.
- Detection:
  Count formal parameters from the AST.
- Suggested severity: `error`.

### 4. `max_nesting_depth` `[S]`

- Fail if control-flow nesting depth exceeds `2`.
- Count `if`, `else if`, loops, `switch`/`match`, and `try`/`catch` nesting.
- Why: deep nesting is a direct readability and maintenance hazard.
- Detection:
  Traverse nested control-flow nodes and compute maximum depth.
- Suggested severity: `error`.

### 5. `max_cognitive_complexity` `[S]`

- Fail if a function exceeds cognitive complexity `15`.
- Why: this is a strong, widely used maintainability signal.
- Detection:
  Implement Sonar-style cognitive complexity counting over AST control-flow nodes.
- Suggested severity: `error`.

### 6. `no_duplicate_blocks` `[S]`

- Fail on duplicated code when either of these is true:
  - `10+` logical duplicated lines
  - `100+` successive duplicated tokens
- Why: duplicated code multiplies bug fixes and misleads generated patches.
- Detection:
  Tokenize normalized code, then hash sliding windows and verify duplicate regions.
- Suggested severity: `error`.

### 7. `one_statement_per_line` `[S]`

- Fail when a line contains more than one top-level executable statement.
- Exception: `for` headers and similar language-mandated constructs.
- Why: improves diffs, blame, patch precision, and review.
- Detection:
  Parse statements per line from AST/token stream.
- Suggested severity: `error`.

### 8. `no_commented_out_code` `[S]`

- Fail comments that lex like disabled code for more than `1` line.
- Why: commented-out code becomes stale fast and pollutes context for agents.
- Detection:
  Heuristic on comments containing assignment operators, braces, semicolons, function signatures, control keywords, or import syntax.
- Suggested severity: `error`.

### 9. `public_api_requires_doc` `[S]`

- Every public/exported function, class, and module must have a structured doc block.
- Minimum fields:
  - `Purpose`
  - `Inputs`
  - `Returns` or `Effects`
- Why: public API intent must be recoverable without reading implementation.
- Detection:
  Find exported/public symbols, verify adjacent doc comment shape.
- Suggested severity: `error`.

### 10. `tracked_todo_only` `[S]`

- Fail any `TODO` or `FIXME` lacking one of:
  - issue ID
  - URL
  - milestone/date token
- Accepted examples:
  - `TODO: ISSUE-123 - split worker supervision`
  - `FIXME: https://tracker/... - remove legacy polling`
- Why: untracked TODOs decay into noise.
- Detection:
  Regex over comments.
- Suggested severity: `error`.

### 11. `max_functions_per_file` `[P]`

- Fail if a file defines more than `12` callable bodies.
- Count top-level and nested callable definitions.
- Why: too many functions in one file usually means the module boundary is wrong.
- Detection:
  Count function-like AST nodes.
- Suggested severity: `warning` initially, later `error`.

### 12. `file_header_3_lines` `[P]`

- Every source file must start with a 3-line structured header comment:
  - `Purpose:`
  - `Dependencies:`
  - `Entry/Effects:`
- Example:

```text
Purpose: Supervises camera and intent workers for the live session.
Dependencies: asyncio, internal session store, SSE emitter.
Entry/Effects: Starts background tasks, emits status events, writes metrics.
```

- Why: this gives agents fast orientation before symbol-level parsing.
- Detection:
  Verify first non-blank, non-shebang lines form the required 3-line block.
- Suggested severity: `warning` first, then `error`.

### 13. `function_header_3_lines` `[P]`

- Every function longer than `5` LOC must have a 3-line structured comment directly above it:
  - `Purpose:`
  - `Inputs:`
  - `Returns/Effects:`
- Why: forces local intent next to the implementation.
- Detection:
  For each qualifying function, verify the previous contiguous comment block shape.
- Suggested severity: `warning` initially.

### 14. `line_length_max_100` `[S]`

- Fail code lines longer than `100` columns.
- Exceptions:
  - long URLs in comments/docs
  - generated code
  - import/package declarations where the language style guide explicitly exempts them
- Why: keeps code reviewable side by side and discourages dense, hard-to-edit lines.
- Detection:
  Raw line-length check with exclusion patterns.
- Suggested severity: `error`.

### 15. `no_global_mutable_state` `[S]`

- Fail mutable globals, mutable package-level variables, and implicit global registries unless explicitly whitelisted.
- Allow true constants.
- Why: mutable global state is brittle in async systems, robots, tests, and multi-worker runtimes.
- Detection:
  Language adapter marks top-level mutable declarations and known mutable singleton patterns.
- Suggested severity: `error`.

### 16. `no_wildcard_imports` `[S]`

- Ban wildcard/glob/on-demand imports such as:
  - `from x import *`
  - `import x.*`
  - equivalent broad namespace pulls
- Why: dependencies must remain explicit.
- Detection:
  Import AST inspection.
- Suggested severity: `error`.

### 17. `typed_public_interfaces` `[P]`

- Public/exported APIs must declare parameter and return types, or use an explicit schema/IDL boundary.
- Acceptable boundary forms:
  - language-native types
  - JSON Schema
  - protobuf/IDL
  - typed DTO models
- Why: agents misuse untyped boundaries more often than humans do.
- Detection:
  Adapter checks for type annotations or known schema wrappers on exported symbols.
- Suggested severity: `error`.

### 18. `no_generic_catch` `[S]`

- Ban broad catches such as:
  - bare `except:`
  - `catch (Exception)`
  - generic `catch (...)`
- Allowed only if the block:
  - logs/records the failure, and
  - rethrows, or
  - is a top-level isolation boundary explicitly marked as such
- Why: generic catches hide real faults and make agent debugging unreliable.
- Detection:
  Parse catch clauses and inspect body for rethrow/propagation markers.
- Suggested severity: `error`.

### 19. `resource_lifetime_scoped` `[S]`

- Resources must be acquired and released in the same function scope using a structured lifetime mechanism:
  - `with`
  - `async with`
  - `using`
  - `defer`
  - `finally`
- Target resources:
  - files
  - sockets
  - streams
  - DB transactions
  - locks
  - subprocesses
- Why: resource leaks and half-closed handles are common in async and robotics stacks.
- Detection:
  Known constructor/open-call patterns plus cleanup analysis for the same scope.
- Suggested severity: `error`.

### 20. `async_runtime_safety` `[S/P]`

- Fail async/callback/event-loop code when any of the following occur:
  - spawned task/promise/future is not awaited or registered in a supervisor collection
  - known blocking API is called directly on an event loop / async executor
  - outbound I/O lacks timeout/deadline/cancellation token
- Why: this is the highest-value rule for streaming, robotics, inference, and service orchestration.
- Detection:
  Adapter-specific patterns:
  - Python: `asyncio.create_task`, `TaskGroup`, `wait_for`, `timeout`, blocking calls inside `async def`
  - JS/TS: unhandled promises, missing `AbortSignal`, sync FS or CPU-heavy work in event-loop callbacks
  - Go: missing `context.Context`, missing `cancel()`, missing timeout propagation
- Suggested severity: `error`.

## Severity Recommendation

Start with this rollout:

- Errors:
  - `max_function_loc`
  - `max_nesting_depth`
  - `max_cognitive_complexity`
  - `no_duplicate_blocks`
  - `one_statement_per_line`
  - `no_commented_out_code`
  - `public_api_requires_doc`
  - `tracked_todo_only`
  - `no_global_mutable_state`
  - `no_wildcard_imports`
  - `typed_public_interfaces`
  - `no_generic_catch`
  - `resource_lifetime_scoped`
  - `async_runtime_safety`
- Warnings:
  - `max_file_loc`
  - `max_parameter_count`
  - `max_functions_per_file`
  - `file_header_3_lines`
  - `function_header_3_lines`
  - `line_length_max_100`

Once the codebase is adapted, move `max_parameter_count`, `max_functions_per_file`, and `line_length_max_100` to `error`.

## Build Plan

### Phase 1: Engine

- Create a CLI:
  - `lint-agents check <paths...>`
  - `lint-agents format-report <json-file>`
- Support:
  - JSON output
  - human-readable output
  - nonzero exit on any `error`

### Phase 2: Language Adapters

First adapters:

- Python
- TypeScript/JavaScript
- Go

These three cover most agent-heavy repos and async/service code.

### Phase 3: Rule Implementation Order

Implement in this order:

1. `one_statement_per_line`
2. `no_wildcard_imports`
3. `tracked_todo_only`
4. `max_function_loc`
5. `max_nesting_depth`
6. `max_cognitive_complexity`
7. `public_api_requires_doc`
8. `no_generic_catch`
9. `resource_lifetime_scoped`
10. `async_runtime_safety`
11. remaining structural policy rules

This order gets the highest signal first.

### Phase 4: Configuration

Suggested config file:

```yaml
version: 1
languages:
  - python
  - typescript
  - go
rules:
  max_file_loc:
    severity: warning
    max_loc: 800
  max_function_loc:
    severity: error
    max_loc: 40
  max_parameter_count:
    severity: warning
    max_params: 5
    ignore_names: ["self", "this", "ctx"]
  max_nesting_depth:
    severity: error
    max_depth: 2
  max_cognitive_complexity:
    severity: error
    max_score: 15
  no_duplicate_blocks:
    severity: error
    min_lines: 10
    min_tokens: 100
  one_statement_per_line:
    severity: error
  no_commented_out_code:
    severity: error
  public_api_requires_doc:
    severity: error
    require_fields: ["Purpose", "Inputs", "Returns|Effects"]
  tracked_todo_only:
    severity: error
    accepted_patterns:
      - "TODO: [A-Z]+-[0-9]+ - "
      - "TODO: https?://"
      - "FIXME: [A-Z]+-[0-9]+ - "
  max_functions_per_file:
    severity: warning
    max_functions: 12
  file_header_3_lines:
    severity: warning
  function_header_3_lines:
    severity: warning
    min_function_loc: 5
  line_length_max_100:
    severity: warning
    max_columns: 100
  no_global_mutable_state:
    severity: error
  no_wildcard_imports:
    severity: error
  typed_public_interfaces:
    severity: error
  no_generic_catch:
    severity: error
  resource_lifetime_scoped:
    severity: error
  async_runtime_safety:
    severity: error
```

## Language Adapter Notes

### Python

- Parser: Tree-sitter Python or `ast` plus `tokenize`.
- Public symbol heuristic:
  names without leading underscore, module exports, framework handlers.
- Async rule examples:
  - `asyncio.create_task()` result must be awaited, returned, or stored
  - prefer `TaskGroup` for sibling tasks
  - `asyncio.timeout()` / `wait_for()` for outbound waits
  - flag blocking calls in `async def`

### TypeScript / JavaScript

- Parser: Tree-sitter TS/JS or Babel parser.
- Public symbol heuristic:
  `export`, framework route handlers, object exports.
- Async rule examples:
  - no floating promises
  - no sync FS APIs in server request handlers
  - require `AbortSignal` or timeout wrapper for outbound fetch/HTTP
  - flag CPU-heavy loops in event-loop callbacks where possible

### Go

- Parser: Tree-sitter Go or `go/ast`.
- Public symbol heuristic:
  exported identifier capitalization.
- Async/concurrency rule examples:
  - require `context.Context` as first parameter for outbound or long-running work
  - require `cancel()` on all `WithTimeout` / `WithCancel` paths
  - flag blocking operations with no timeout/deadline

## Edge Cases

- Generated code should be excluded by path and/or header marker.
- Test code may relax:
  - `max_function_loc`
  - `function_header_3_lines`
  - `typed_public_interfaces`
- Migration mode can allow warnings-only output for selected legacy directories.

## Proposed Output Contract

Human output:

```text
ERROR max_function_loc apps/api/live/session.py:142 LiveSession.run_loop exceeds 40 LOC (52)
ERROR async_runtime_safety apps/api/live/session.py:201 created task is neither awaited nor supervised
WARNING file_header_3_lines apps/web/src/store/live.ts:1 missing required 3-line file header
```

Machine output:

- JSON array of result objects
- stable `rule_id`
- stable `severity`
- file path and line

## Source Notes

These rules are a mix of:

- directly source-backed thresholds or requirements
- explicit policy constraints selected for agent-written code

The strongest direct references are:

1. Google Python Style Guide
   - function length
   - public API docstrings
   - TODO formatting
   - mutable global state
   - imports
   - exceptions
   - resources
   - type-annotated code
   - https://google.github.io/styleguide/pyguide.html
2. Google Java Style Guide
   - no wildcard imports
   - one statement per line
   - 100-column limit
   - https://google.github.io/styleguide/javaguide.html
3. Google Testing Blog
   - refactor beyond 2 nesting levels
   - https://testing.googleblog.com/2017/06/code-health-reduce-nesting-reduce.html
4. SonarQube metric definitions
   - duplication thresholds
   - maintainability framing
   - https://docs.sonarsource.com/sonarqube-server/10.4/user-guide/metric-definitions
5. PEP 8
   - specific exception handling
   - resource cleanup via `with` / `try/finally`
   - line length
   - https://peps.python.org/pep-0008/
6. Python `asyncio` docs
   - keep task references
   - structured concurrency with `TaskGroup`
   - cancellation and `try/finally`
   - timeouts
   - https://docs.python.org/3/library/asyncio-task.html
7. Go `context` docs
   - propagate context
   - use deadlines/timeouts
   - call cancel functions
   - https://pkg.go.dev/context
8. Node.js async docs
   - do not block the event loop
   - `AbortSignal.timeout`
   - https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop
   - https://nodejs.org/api/globals.html#abortsignaltimeoutdelay

## Implementation Notes For This Repo

- Keep this file as the working specification until a stable `lint-agents` implementation exists.
- Once the tool is implemented, add:
  - installation instructions
  - config file location
  - CI invocation
  - suppression policy
  - per-language support matrix

## Open Questions

- Should `file_header_3_lines` and `function_header_3_lines` be mandatory everywhere, or only in agent-owned directories?
- Should `typed_public_interfaces` be relaxed for tests and migration scripts?
- Should `max_functions_per_file` count nested helper functions?
- Which directories should be exempt as generated or third-party code?
