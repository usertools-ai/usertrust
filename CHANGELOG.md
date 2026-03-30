# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
