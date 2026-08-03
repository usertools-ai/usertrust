# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**Loopback/local endpoints now settle at nominal local rates instead of silently
billing frontier fallback.** Before, a free `llama3.3:70b` call against
`http://localhost:11434/v1` was priced like an unknown cloud model at
sonnet-class `FALLBACK_RATE` — and a streamed call settled on the pre-call
estimate (~615 usertokens of fake dollars per $0 stream). Local endpoints are
now classified as their own settlement scope and meter at `local.defaultRate`
(default `{0,0}` + the per-call `>=1` floor = exactly 1 nominal usertoken per
call), so free inference stays **inside** budget, anomaly, and audit governance
instead of being exempted from it.

### Added

- **First-class local-model governance (M2).** `classifyEndpoint()` labels every
  governed call `local` or `cloud` from the client's `baseURL` (explicit
  `endpoints[]` matchers, loopback autodetect, per-call override), and the
  scoped `resolveRates()` resolver prices every costing site accordingly. Local
  scope structurally cannot reach `FALLBACK_RATE`.
- New config surface (all keys zod-defaulted — existing configs parse
  unchanged): `endpoints[]` matchers (origin URL, `*.host` suffix, or bare
  hostname), `local` block (`autoDetectLoopback`, `defaultRate`, `rateClass`
  `"nominal" | "amortized-usd"` for GPU-amortized showback, per-model `models`
  with trailing-`*` globs, `injectUsageOptions`), and `unknownModelPolicy`
  (`"fallback" | "warn" | "deny"`, default `"warn"`) for cloud-scope models
  missing from the pricing table — `"warn"` is cost-identical to the old silent
  behavior but logs once per model and stamps the receipt.
- Receipts carry `endpoint` (`class`/`runtime`) and `meter` (`costBasis`
  `"usd-proxy" | "nominal"`, `rateSource`, optional `computeMs`) so the
  settlement regime and rate provenance of every call are auditable.
- Server-truth streaming usage for local endpoints:
  `stream_options: { include_usage: true }` is auto-injected into local
  OpenAI-compatible streams (gated by `local.injectUsageOptions`; the usage
  chunk is forwarded to the consumer unmodified; one retry without the
  injection if a server rejects it).
- Local-calibrated anomaly governance: `tokenRate.localThresholdTokPerSec`
  (default 5000), `tokenRate.perModel` glob overrides,
  `spendVelocity.localThresholdUsertokensPerMin` (default 10000) — local
  velocity verdicts are denominated in usertokens, never fake dollars; the
  detector now prices events with the same scoped resolver as settlement.
- Headless governor endpoint scope: `TrustOpts.endpoint` (governor default),
  `AuthorizeParams.endpoint` (per-call override, captured at authorize),
  `SettleParams.computeMs` → `receipt.meter.computeMs`.
- OpenClaw: Ollama-native chunk extraction (`prompt_eval_count`/`eval_count`,
  `eval_duration` → `computeMs`) alongside the OpenAI-compatible family.
- OpenClaw: `UsertrustPluginConfig.endpoint` (`class`, optional `runtime`/
  `baseURL`) declares the runtime's settlement scope — the headless path has no
  client baseURL to classify, so operators set `{ class: "local" }` to meter
  local models at local rates instead of cloud frontier fallback.
- `usertrust init` "Local inference" wizard step: Ollama/LM Studio/vLLM
  presets, optional `GET /v1/models` probe, writes `endpoints[]` +
  `local.models` entries.
- `examples/ollama-local-governance`: runnable before/after demo (`npx tsx
  run.ts`), falls back to an inline mock OpenAI-compatible server when Ollama
  is absent.
- **Governed surfaces expanded — previously-ungoverned SDK entry points now run
  inside the two-phase spend lifecycle (authorize → PENDING hold → settle/void),
  audit, and budget enforcement.** All wraps are feature-detected: a client on an
  older peer-range SDK that lacks a surface falls through to a raw pass-through
  and nothing throws at wrap time.
  - Anthropic `client.messages.stream()` is now governed. The original
    `MessageStream` is returned unchanged (all of `.on()` / `.finalMessage()` /
    `.abort()` / async iteration preserved) with a `.receipt` promise attached;
    settlement is driven by non-consuming emitter listeners so it never competes
    with the caller's own consumption. The governed `stream()` authorizes before
    forwarding, so callers `await` the returned handle. A clean stream close with no
    `finalMessage` settles at estimate (the hold never dangles), and a consumer
    `abort()` settles the partial usage as an early exit rather than voiding or
    tripping the circuit breaker. Governance never silently swallows a stream
    failure: a genuine stream error rejects `.receipt`, so any consumer that
    `await`s `.receipt` (or the stream's own `done()`/`finalMessage()`) observes it.
    The one exception is a pure fire-and-forget consumer that never awaits
    `.receipt`, registers no `error` handler, and never awaits the stream — for that
    caller the error is not surfaced; await `.receipt` or attach an error handler.
  - Anthropic `client.messages.parse()` and `client.beta.messages.parse()` are
    governed: the underlying create runs through the two-phase lifecycle exactly
    once, then the SDK's parse transform is applied and the parsed message is
    returned with a `.receipt` attached.
  - Anthropic `client.beta.messages.create()` and `client.beta.messages.stream()`
    are governed identically to the stable surface. `beta.models`, `beta.files`,
    and `beta.messages.batches` remain documented pass-throughs.
  - OpenAI `client.responses.create()` (Responses API) is governed, non-stream
    and streaming, when present (feature-detected against the `openai >=4.70.0`
    peer floor, which predates the Responses API). Prompt/PII/injection/estimation
    coverage reads Responses `input`/`instructions`; streaming usage is read from
    the terminal event — `response.completed`, and equally the terminal
    `response.incomplete` / `response.failed` events, at
    `event.response.usage.{input_tokens,output_tokens}`. The chat-completions-only
    `stream_options.include_usage` opt-in is never injected into Responses params.
    The `client.responses.stream()` and `client.responses.parse()` convenience
    helpers are **not** governed — they drive the SDK's raw client internally and so
    bypass the governed `create`; use `responses.create({ stream: true })` for a
    governed stream.
- **Real-TigerBeetle CI validation.** A new non-gating `tb-integration` CI job
  stands up a real single-node TigerBeetle cluster (pinned to the
  `tigerbeetle-node` version) and runs the two-phase hard-budget invariant
  end-to-end against the live ledger. The integration test self-skips
  (`describe.skipIf(!process.env.USERTRUST_TB_ADDRESS)`) so the normal test job
  stays green with no cluster.

### Changed

- **BREAKING: cost-center account ids now derive from the `(parentUserId,
  costCenter)` tuple** — a domain-separated, length-prefixed SHA-256 — instead
  of hashing the joined `parent::costCenter` string. This removes the reserved
  `::` separator and lets parent wallet ids contain `:` (#64), but it changes
  where cost-center money lives: a cost center funded on v2.x sits in an
  account this version no longer derives, so `getBudgetStatus` reports it as
  balance 0 (reading as fully spent) and `reclaimBudget` moves nothing —
  silently, on both paths. **Reclaim every live cost center with
  `reclaimBudget` on v2.x before upgrading.** If you have already upgraded with
  balances stranded: downgrade to 2.x, reclaim, then upgrade again. There is
  deliberately no read-time fallback to the legacy account: reading it would
  collide with an ordinary wallet literally named `parent::costCenter`, which
  is the exact ambiguity this change removes. For the same reason v3 continues
  to refuse `::` in wallet ids, escrow labels, and parent ids — a quarantine of
  the legacy namespace, so that a stranded pre-v3 cost-center account (including
  one re-funded by a pending hold voided after the upgrade) cannot be silently
  adopted by a new wallet name that hashes onto it; a single `:` remains legal
  (#64).
- OpenAI and Google streaming usage accumulation is now replace-with-latest
  (usage-bearing chunks carry cumulative snapshots — e.g. vLLM
  `continuous_usage_stats` — which summing would multiply-count). Anthropic
  stays additive (`message_start` + `message_delta` are genuinely incremental).

### Security

- Endpoint classification (config matchers, overrides, loopback autodetect) is
  a **trusted-operator decision** — never wire it to end-user or request input.
  In server/multi-tenant deployments set `local.autoDetectLoopback: false` and
  classify via explicit `endpoints[]` config: loopback inside a container can
  be a forwarding sidecar to a paid API. This is the same trust boundary as
  `budget`/`customRates` — the config author already controls billing entirely.
  Note that a compromised local server can under-report usage; receipts expose
  `usageSource` and `meter.rateSource` precisely so that this is auditable.
- `endpoints[]` matching never uses raw string prefixing: scheme entries match
  by URL origin equality, killing `http://gpu-box:8000.evil.com` /
  `...@evil.com` bypass shapes; malformed `baseURL`s classify as cloud
  (fail-expensive).

### Dependencies

- Adopted major upgrades across the toolchain and runtime deps. **Governance
  behavior is unchanged** — verified by the full suite (1957 passing, 4
  TigerBeetle-integration tests self-skipping without a live server) plus
  `tsc -b`, type-tests, and `biome check` all clean:
  - `tigerbeetle-node` 0.16 → **0.17.9**. Ledger client migrated to the 0.17
    API: `CreateAccountError`/`CreateTransferError` enums → `CreateAccountStatus`/
    `CreateTransferStatus`, and the per-event result shape is now
    `{ timestamp, status }` (success is `status === created`). Two-phase
    pending/post/void and `debits_must_not_exceed_credits` hard-budget
    enforcement are byte-for-byte unchanged. CI TigerBeetle server pinned to
    0.17.9 (sha256 recomputed).
  - `zod` 3 → **4.4.3**. Config object schemas migrated from `.default({})` to
    `.prefault({})` to preserve zod 3's re-parse-inner-defaults behavior (zod 4's
    `.default({})` skips inner defaults); parsed config output is identical.
  - `@anthropic-ai/sdk` → **0.115** and `openai` → **6.49**. SDK majors verified
    safe against the governance surface (streaming usage accumulation, tool-call
    and responses paths); no adapter changes required.
  - `@biomejs/biome` 1.9 → **2.5.5**. `biome.json` migrated to the v2 schema
    (`linter.rules.preset: "recommended"` — the migrator's silent
    `preset: "none"` downgrade was caught and corrected; `files.includes` with
    negated globs; CSS/SVG excluded, since Biome 2 cannot parse Tailwind v4
    `@theme`). Formatting reflow is purely mechanical (import sorting, JSON).
  - `@types/node` → **26**. One types-only regression fixed in money-path Ed25519
    signing (`createPublicKey` dropped `KeyObject` from its input union in v26,
    though Node still derives a public key from a private `KeyObject` at runtime);
    resolved with a types-only assertion — the runtime call is unchanged.

## [1.0.0] - 2026-03-29

First stable release.

## [0.2.6] - 2026-03-29

### Added
- Shell completions for bash, zsh, and fish (`usertrust completions`)

## [0.2.5] - 2026-03-29

### Added
- `--json` output flag for all CLI commands for machine-readable output
- Semantic colors in CLI output for improved readability
- Did-you-mean suggestions for misspelled CLI commands
- `--before` and `--after` date filters for `usertrust inspect`

## [0.2.4] - 2026-03-29

### Added
- Actionable error messages with fix suggestions across all error classes
- Site badges (npm version, CI status, license)
- Call-to-action section on marketing site
- Governance receipt display on site with real examples
- 1-hour soak test (`gate1-soak`) for sustained SDK validation
- DX research synthesis and pipeline plan documentation

### Fixed
- JetBrains Mono Bold rendering, typewriter animation, and hero layout cleanup on site

## [0.2.3] - 2026-03-28

### Added
- `/ship`, `/deploy`, `/promote` autonomous delivery pipeline and CI/CD scripts
- Gate 1 test harness for SDK validation
- Marketing site ported to Next.js 15 with Framer Motion
- Agent workflow documentation in CLAUDE.md

### Fixed
- 24 audit findings addressed: budget race condition, crypto integrity, governance hardening
- Site typography: keep `trust()` headline in `font-mono` (parentheses too round in sans)
- Site typography: entire site switched to Usertools Sans with `font-mono` removed

## [0.2.1] - 2026-03-28

### Added
- Single-transaction receipt verification in `usertrust-verify` with dotted leaders and USD conversion

### Changed
- Renamed governance types to `trust`/`receipt` in public API (breaking rename from internal `governance` naming)
- Publish workflow updated for version bump PR flow (replaces direct push)

### Fixed
- NPM publish token restored after OIDC trusted publishing migration
- Version bump PR merge uses `--auto` instead of `--admin`

## [0.1.1] - 2026-03-28

### Added
- Rebranded from `@usertools/govern` to `usertrust`
- npm publish metadata for both packages
- SPDX license headers and legal files (Apache 2.0)

### Changed
- IP audit remediation: stripped provenance metadata, added SPDX headers

### Fixed
- `usertrust-verify` CLI bin path corrected
- Publish workflow references renamed from `govern` to `usertrust`

## [0.1.0] - 2026-03-16

Initial release of the usertrust SDK.

### Added
- **Core SDK (`usertrust`)**
  - `trust()` async factory wrapping any LLM client (Anthropic, OpenAI, Google) via JS Proxy
  - Two-phase spend lifecycle: PENDING hold -> LLM call -> POST (success) or VOID (failure)
  - Duck-typed LLM client detection for Anthropic, OpenAI, and Google SDKs
  - Streaming support with per-provider token accumulation (`GovernedStream`)
  - `client.destroy()` cleanup lifecycle (idempotent)
  - Dry-run mode (`dryRun: true` or `USERTRUST_DRY_RUN`) for audit-only operation without TigerBeetle
  - Proxy mode stub for remote governance connection
  - Failure mode handling for all 5 scenarios per spec Section 15
- **Ledger**
  - TigerBeetle client wrapper with reconnect logic
  - Two-phase spend engine (PENDING -> POST/VOID) with dead-letter queue fallback
  - 20-model pricing table with cost estimation in usertokens
- **Audit**
  - SHA-256 hash-chained JSONL audit trail with advisory lock and async mutex
  - Deterministic canonicalization for hash computation
  - RFC 6962 Merkle tree with inclusion and consistency proofs
  - Daily-rotated audit receipts with bounded index
  - Audit chain verifier
  - 6 entropy signals for governance health diagnostics
- **Policy**
  - Policy gate with 12 field operators, soft/hard enforcement, dot-notation field resolution
  - YAML and JSON rule loading with glob-based scope matching via minimatch
  - Time-window constraints
  - PII detector (email, phone, SSN, credit card with Luhn validation, IPv4)
  - Exponential decay rate calculator for time-weighted budgets
- **Board of Directors**
  - Two directors (Alpha and Beta) with complementary focus areas
  - 6 heuristic concern detectors (hallucination, bias, safety, scope creep, resource abuse, policy violation)
  - Democratic decision matrix: unanimous veto, escalation, approval
- **Resilience**
  - Circuit breaker with per-provider failure isolation and registry
  - Scope locking with minimatch-based overlap detection for parallel workers
- **Memory**
  - Pattern memory: prompt hash -> model -> cost -> success routing (SHA-256 hashes only, no raw prompts)
- **Snapshot**
  - Checkpoint/restore for vault state
- **CLI**
  - `usertrust init` -- create `.usertrust/` vault with default config
  - `usertrust inspect` -- vault bank statement
  - `usertrust health` -- entropy diagnostics (6 signals, 0-100 score)
  - `usertrust verify` -- audit chain integrity check
  - `usertrust snapshot` -- checkpoint/restore vault state
  - `usertrust tb` -- TigerBeetle process management
  - Barrel exports, config loader, and `defineConfig()` type-checking helper
- **Standalone verifier (`usertrust-verify`)**
  - Zero-dependency vault verification (Node built-ins only)
  - CLI entry point for standalone verification
- **Infrastructure**
  - Monorepo scaffold with npm workspaces (`usertrust` + `usertrust-verify`)
  - Shared primitives: types, IDs (`tbId`, `trustId`, `fnv1a32`), 7 domain errors, constants
  - GitHub Actions CI: lint, test with coverage, publish workflows
  - Blacksmith runners with parallel job matrix
  - Codex review workflow
  - Branch protection, dependabot, CODEOWNERS
  - Apache 2.0 license
  - 979 tests across 38 files with coverage thresholds (92%+ lines, 85%+ branches)

### Fixed
- 9 Codex findings addressed: production wiring, security, receipts
- TigerBeetle connection when `dryRun` is false
- CLI entry moved to `src/cli/main.ts` for tsconfig inclusion
- `loadConfig()` accepts optional `vaultBase` parameter
- Pattern cache made instance-scoped by vault path
- Codex CI input name corrected with fallback to ubuntu-latest
- Biome lint errors resolved
- `tbId` test flake fixed by separating uniqueness from time-ordering assertions

[1.0.0]: https://github.com/usertools-ai/usertrust/compare/v0.2.6...v1.0.0
[0.2.5]: https://github.com/usertools-ai/usertrust/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/usertools-ai/usertrust/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/usertools-ai/usertrust/compare/v0.2.1...v0.2.3
[0.2.1]: https://github.com/usertools-ai/usertrust/compare/v0.1.1...v0.2.1
[0.1.1]: https://github.com/usertools-ai/usertrust/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/usertools-ai/usertrust/commits/v0.1.0
