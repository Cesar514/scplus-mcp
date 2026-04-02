Evaluation suite: real-benchmark
Generated at: 2026-04-02T14:20:47.846Z
Overall: PASS
Golden operator questions: 22
Validation rates: falsePositiveRate=0.0000 | falseNegativeRate=0.0000 | truePositives=9 | trueNegatives=1
Freshness rates: staleAfterWriteFailures=0/4 | restoreFailures=0/2
Exact latency: samples=5 | p50=3.14ms | p95=4.07ms | p99=4.07ms | max=4.07ms
Related latency: samples=7 | p50=55.95ms | p95=57.64ms | p99=57.64ms | max=57.64ms
Research latency: samples=3 | p50=63.52ms | p95=64.23ms | p99=64.23ms | max=64.23ms
Clustering benchmarks: medium=400 vectors in 1.13ms (12 clusters) | large=2400 vectors in 17.70ms (20 clusters)
Tree-sitter stats: parses=251 | parseFailures=0 | grammarLoadFailures=0 | parserReuses=247

Scenario summaries (7)
- small-smoke [small-smoke] files=5 languages=markdown, typescript indexMs=2087.27 validation=ok
  note: tiny synthetic repo kept only as smoke test
- medium [medium] files=8 languages=markdown, typescript indexMs=644.88 validation=ok
  note: multi-feature TypeScript service repo
- large-monorepo [large-monorepo] files=22 languages=markdown, typescript indexMs=1463.97 validation=ok
  note: multi-app monorepo with shared packages and suggested hubs
- polyglot [polyglot] files=5 languages=go, markdown, python, rust, typescript indexMs=644.53 validation=ok
  note: TypeScript, Python, Rust, Go, and Markdown indexed together
- ignored-generated [ignored-generated] files=2 languages=typescript indexMs=482.10 validation=ok
  note: generated/ is ignored through .gitignore
  note: generated/ excluded from file manifest
- broken-state [broken-state] files=2 languages=typescript indexMs=456.29 validation=failed
  note: delete query-explanation-index after indexing
- rename-freshness [rename-freshness] files=2 languages=typescript indexMs=455.16 validation=ok
  note: renamed billing/invoice.ts to billing/pricing.ts
  note: mutated pricing symbol through checkpoint
  note: restored latest checkpoint state

Scenario coverage: 10/10
  - PASS | scenario small-smoke is present | 5 files | validation=true
  - PASS | scenario medium is present | 8 files | validation=true
  - PASS | scenario large-monorepo is present | 22 files | validation=true
  - PASS | scenario polyglot is present | 5 files | validation=true
  - PASS | scenario ignored-generated is present | 2 files | validation=true
  - PASS | scenario broken-state is present | 2 files | validation=false
  - PASS | scenario rename-freshness is present | 2 files | validation=true
  - PASS | ignored-generated scenario excludes generated files from the prepared manifest | src/runtime/handler.ts, src/runtime/router.ts
  - PASS | broken-state validation reports invalid prepared state | issues=1
  - PASS | broken-state research fails loudly | research requires a valid prepared full index.

Smoke test: 3/3
  - PASS | small smoke repo validates | issues=0
  - PASS | small smoke repo indexes auth files | fileCount=5
  - PASS | small smoke repo stays small | fileCount=5

Exact lookup accuracy: 5/5
  - PASS | small smoke exact symbol resolves verifyToken | Exact symbol matches for "verifyToken" (1) | - src/auth/jwt.ts:4-6 | function | function verifyToken(token: string): string {
  - PASS | medium exact symbol resolves calculateInvoiceTotal | Exact symbol matches for "calculateInvoiceTotal" (1) | - src/billing/invoice.ts:4-6 | function | function calculateInvoiceTotal(subtotal: number, taxRate: number): number {
  - PASS | large monorepo exact symbol resolves buildSessionToken | Exact symbol matches for "buildSessionToken" (1) | - packages/session/src/token.ts:8-10 | function | function buildSessionToken(token: string): string {
  - PASS | polyglot exact symbol resolves sign_payload | Exact symbol matches for "sign_payload" (1) | - rust/crypto/src/lib.rs:4-6 | function | pub fn sign_payload(payload: &str) -> String {
  - PASS | ignored-generated exact symbol resolves runtime handler instead of generated noise | Exact symbol matches for "handleRuntimeEvent" (1) | - src/runtime/handler.ts:4-6 | function | function handleRuntimeEvent(eventName: string): string {

Related-search relevance: 4/4
  - PASS | medium related search finds checkout orchestration | src/orders/checkout.ts :: src/orders/checkout.ts
  - PASS | large monorepo related search finds session token helpers | packages/session/src/token.ts :: packages/session/src/token.ts
  - PASS | polyglot related search finds rust signing implementation | rust/crypto/src/lib.rs :: rust/crypto/src/lib.rs
  - PASS | ignored-generated related search stays on runtime router instead of ignored bundle | src/runtime/router.ts :: src/runtime/router.ts

Symbol resolution accuracy: 3/3
  - PASS | medium symbol resolution finds calculateInvoiceTotal from natural language | src/billing/invoice.ts :: calculateInvoiceTotal
  - PASS | large monorepo symbol resolution finds verifyAccessToken | services/auth/src/verify.ts :: verifyAccessToken
  - PASS | polyglot symbol resolution finds reconcile_invoices | python/jobs/reconcile.py :: reconcile_invoices

Dependency graph accuracy: 3/3
  - PASS | medium dependency graph keeps checkout imports accurate | direct=src/billing/invoice.ts, src/catalog/search.ts, src/orders/cart.ts | reverse=none
  - PASS | large monorepo dependency graph keeps web login imports accurate | direct=packages/session/src/token.ts, packages/ui/src/button.ts | reverse=none
  - PASS | small smoke reverse dependencies include session.ts for jwt.ts | direct=none | reverse=src/auth/session.ts

Hub suggestion quality: 4/4
  - PASS | small smoke manual auth hub resolves by feature name | Hub: Authentication | Path: docs/authentication.md | Links: 2 |  | ---
  - PASS | medium manual billing hub resolves by feature name | Hub: Billing | Path: docs/billing.md | Links: 2 |  | ---
  - PASS | large monorepo suggested analytics hub resolves by feature name | Hub: Analytics | Path: .contextplus/hubs/suggested/analytics.md | Links: 11 | Cross-links: Billing | 
  - PASS | polyglot crypto hub ranks correctly for query mode | Ranked hubs for: "crypto signing payload gateway" | Ranking mode: both | Candidates: 6 |  | 1. docs/crypto.md [manual] score=0.687

Research quality: 3/3
  - PASS | medium research joins checkout and billing context | src/orders/checkout.ts, src/billing/invoice.ts, src/orders/cart.ts, src/catalog/search.ts, docs/billing.md
  - PASS | large monorepo research joins login, verify, and session packages | apps/web/src/auth/login.ts, packages/session/src/token.ts, docs/auth-console.md, services/auth/src/verify.ts, packages/ui/src/button.ts, packages/session/src/audit.ts
  - PASS | polyglot research joins signing and gateway flow | go/gateway/main.go, rust/crypto/src/lib.rs, docs/crypto.md, python/jobs/reconcile.py, src/web/auth.ts

Validation quality: 10/10
  - PASS | small smoke validation stays valid | expected=valid actual=valid issues=0
  - PASS | medium validation stays valid | expected=valid actual=valid issues=0
  - PASS | large monorepo validation stays valid | expected=valid actual=valid issues=0
  - PASS | polyglot validation stays valid | expected=valid actual=valid issues=0
  - PASS | ignored-generated validation stays valid | expected=valid actual=valid issues=0
  - PASS | broken-state validation detects missing query explanation index | expected=invalid actual=invalid issues=1
  - PASS | rename-freshness initial validation stays valid | expected=valid actual=valid issues=0
  - PASS | rename-freshness validation stays valid after file rename | expected=valid actual=valid issues=0
  - PASS | rename-freshness validation stays valid after checkpoint write | expected=valid actual=valid issues=0
  - PASS | rename-freshness validation stays valid after restore | expected=valid actual=valid issues=0

Freshness reliability: 6/6
  - PASS | renamed symbol becomes searchable after reindex | Exact symbol matches for "calculatePricingPlan" (1) | - src/billing/pricing.ts:4-6 | function | function calculatePricingPlan(subtotal: number, taxRate: number): number {
  - PASS | old renamed symbol disappears after reindex | No exact symbol matches for "calculateInvoiceTotal". | Next step: rerun search with intent="related" for related items and patterns, or use research for broader subsystem understanding.
  - PASS | checkpoint mutation becomes searchable immediately | Exact symbol matches for "buildPricingPlan" (1) | - src/billing/pricing.ts:4-6 | function | function buildPricingPlan(subtotal: number, taxRate: number): number {
  - PASS | replaced pricing symbol disappears after checkpoint mutation | No exact symbol matches for "calculatePricingPlan". | Next step: rerun search with intent="related" for related items and patterns, or use research for broader subsystem understanding.
  - PASS | restore reintroduces the pre-checkpoint pricing symbol | Exact symbol matches for "calculatePricingPlan" (1) | - src/billing/pricing.ts:4-6 | function | function calculatePricingPlan(subtotal: number, taxRate: number): number {
  - PASS | restore resets file content to the last known good pricing implementation | // Pricing helpers for freshness benchmark after rename | // FEATURE: Billing |  | export function calculatePricingPlan(subtotal: number, taxRate: number): number {

