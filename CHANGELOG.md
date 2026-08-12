# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`usertrust-verify receipt <file> --trust <snapshot.json>` — the offline
  half of the trust story.** A zero-dependency, zero-network CLI mode that
  reads a signed ut1 receipt plus a PINNED `receipt-spec` §8 trust snapshot
  and runs §7 steps 1–9 entirely offline: the strict byte reader (canonical
  base64, fatal UTF-8 with `ignoreBOM: true`, pre-parse duplicate-key
  rejection, frozen numeric rules — non-integer / `-0` / non-safe-integer /
  `Infinity`/`NaN` refused on the numeric LITERAL during that same pre-parse
  scan, never as a thrown `canonicalize`; checking the parsed VALUE instead
  would be too late, because `JSON.parse` rounds `1.00000000000000001` to
  exactly `1` and the receipt then verifies against a canonical preimage its
  own bytes do not spell),
  the nine event-hash equalities, the mint signature (including the retired
  MINT-key boundary evaluated through the mint event's own segment, not
  merely "state permitting"), Merkle inclusion topology derived from
  `(leafIndex, treeSize)`, the checkpoint signature and lineage pin, §2's
  semantic constraints, the `transferSetRoot`/`amountUsd` derivation, and —
  with `--envelope` — the full history walk back to the registered
  `genesisSegmentId` with every checkpoint's signature re-verified under the
  §8 lineage. `--trust` is required and never fetched: an implicit fetch
  would silently unpin the verifier, so absent key material reports
  UNVERIFIABLE rather than reaching out for it. `--envelope` reads the
  receipt from the resolver envelope's byte-authoritative `receiptBytes`
  member (never its `receipt` convenience copy) and runs the R4 agreement
  check between the two — a STRUCTURAL comparison (`Object.is` on numbers,
  key order ignored), not a canonical-string one, since a serializer erases
  exactly the distinctions the check exists to find (`-0` renders as `0`). `--expect-id` binds arrival context (a bare
  `ut1_…`, a resolution URL, or a `Usertrust-Receipt:` trailer line).
  `--json` puts the machine-readable report on stdout ONLY — every
  diagnostic goes to stderr, so `| jq` is safe — with every field nullable
  on the failure path that cannot produce it, `delegationPosture` labels
  travelling with `amountUsd` (an unlabelled or unrecognized posture fails
  the semantic check rather than rendering an ambiguous total), and every
  untrusted string (keyIds, snapshot version/predecessor, failure detail,
  receipt IDs) control-character sanitized before truncation. Exit codes are
  0 (`VERIFIED_CHECKPOINT` or higher — the rung itself is in the report, not
  the code), 1 (FAILED, step + code named), 2 (UNVERIFIABLE, required
  material missing), 3 (usage error, receipt mode's own handler — never the
  shared vault `usage()`, which exits 1 and would misreport a typo as
  FAILED). `--help`/`-h` is recognized at any argv position, same as vault
  mode's own loop, and also exits 3: no verdict was reached, so it must
  never share 0 with `VERIFIED_CHECKPOINT` — an unsanitized `<file>`
  argument of literally `--help` must not be able to read as verified to a
  scripted caller keying on exit status alone. This is what the
  `/r/<receiptId>` verify page's download affordance points at, closing the
  loop that entry above left open.

  **Deliberately incomplete, and says so out loud rather than guessing.**
  Anchor (Rekor) evidence is reported OUT OF BAND, never as a §7 value: if
  absent the check is `notApplicable`; if present it is omitted from
  `checks` and named in a top-level `unimplemented: ["anchorEvidence"]`,
  because none of §7's four verdict values means "the verifier declined to
  look" and claiming one would misstate why the check didn't run. The
  verdict ladder is capped below `VERIFIED_ANCHORED` accordingly — no input
  can upgrade past it — pending a normative artifact-hash rule binding
  Rekor evidence to a `SegmentCheckpoint`'s signed payload, which belongs to
  whoever mints anchors. Trust-snapshot signature verification is likewise
  deferred to when receipt-spec §8's signing scheme ships; until then the
  snapshot's structural rules (unique/resolvable keys, one-lineage-one-vault,
  role/kind consistency, acyclic rotation, `activationSequence` bound to
  `state`) are the only defense, and any violation is UNVERIFIABLE, never a
  pass. `registryBinding` and `predecessorLinkage` report `notApplicable` —
  offline has no registry to check against — though both stay in the
  `--json` vocabulary for resolver-side consumers replaying a report.

  **`packages/verify/src/canonical.ts` is left non-conformant with
  receipt-spec §13 on this ship, deliberately.** §13's 79-case differential
  found `core/src/audit/canonical.ts` and `verify/src/canonical.ts`
  code-identical and bug-compatible with each other (`undefined` → the JS
  value rather than `null`; `[1,undefined,2]` → `[1,,2]`; and two SILENT
  divergences that stay valid, parseable JSON at a different digest —
  `[undefined]` → `[]` and `{a:[undefined]}` → `{"a":[]}`) — and states
  plainly that **"Core and verify MUST be corrected together; fixing verify
  alone splits ut1's two implementations against each other, which is worse
  than the status quo."** Correcting only this package's copy would do
  exactly that split, so the fix is deferred to a follow-up that lands both
  sides at once. The divergence is unreachable from parsed wire data (every
  key in a ut1 document is a concrete JSON value, never `undefined`), so
  this is an honesty gap, not a soundness one — but it means this ship's
  verifier is bug-compatible with the SDK minter, not §13-conformant.

  **Every field the specs give a FORMAT is checked against it, and the check
  is a table rather than a list of fixes.** Two review rounds found nine
  soundness holes that were one hole nine times: the verifier checked
  STRUCTURE (present? a string?) and never FORMAT (the thing §2 declares) —
  a sibling hash of `<64 hex>zz` folded to the SAME root, because Node's hex
  decoder stops at the first non-hex pair and drops the tail, so the proof
  verified here and would FAIL under any decoder that refuses trailing junk;
  `startedAt: "not-a-date"` verified; `sourceReservationReceiptId:
  "not-an-id"` named no receipt and verified. The fix is not nine checks:
  the key set and the declared format are now ONE declaration per member of
  §5's document — RFC 3339 UTC "Z" with ms precision for every timestamp,
  64-lowercase-hex for every digest, the FULL git OID at the length its
  `oidAlg` selects, §12 canonical decode for every receipt ID, the keyed
  `r1_`/`c1_` forms as the 32-byte MACs the resolver defines — walked once
  for both purposes, with the owning §7 step recorded per field so step 1
  never pre-empts a condition a normative equality names. A member cannot
  enter the schema without saying what it is, which is what makes this a
  closed class rather than nine patches; the corpus drives a sweep off that
  table, so a member declared and then not enforced fails a test. The same
  formats bind a SERVED history member at step 6, which is the only place
  they can bind — those never pass through step 1's reader at all.

  **A rotated-away key can no longer sign forever (§8).** The snapshot
  loader refused an `activationSequence` on an `active` key and a `retired`
  key without one, but both rules read a single entry; read across the
  rotation LINK, a key that a successor names as its predecessor plainly
  HAS a successor, so `active` is a contradiction — and one that pays,
  because an active key has no upper bound, so the predecessor stayed in the
  pinned lineage and kept verifying new material in a snapshot that looked
  like a clean rotation. `retired` (boundary evaluable) and `revoked` (the
  compromise path) remain legal predecessors; `active` does not. Relatedly,
  `--expect-id` supplied on a run that failed before step 3 now reports
  `unavailable` rather than `notApplicable`: §7 reserves the latter for an
  input that could not exist in this context, and an arrival context the
  operator typed plainly exists.

  Built against a from-scratch mint harness (Ed25519 keygen/sign, sha256,
  canonical JSON — node builtins only) that reaches canonical bytes by a
  path independent of the verifier's own `canonicalize`, so a shared
  preimage bug can't hide from the corpus; pinned first against
  receipt-spec §13's byte-for-byte canonicalization golden vectors — modulo
  the non-conformant cases above, which the corpus does not exercise. Vault
  mode (`--tx`, `--bundle`, the differential anchor suites) is unchanged —
  same flags, same byte-for-byte behavior.

- **`/r/<receiptId>` — the public verify page a `Usertrust-Receipt` trailer
  resolves to (ships DARK, not yet live).** A read-only, unauthenticated
  page and two JSON siblings (`receipt.json`, `envelope.json`) that render
  the resolver's answer as an honest verdict: chain-committed claims,
  minter-asserted claims, and merely-displayed fields kept visually and
  textually distinct, every non-green outcome (202/404/409/410/503/429,
  plus a fail-closed protocol-error shell for anything the resolver's
  contract doesn't name) rendered loud rather than swallowed. The page never
  computes a verdict — every rung was already decided upstream by
  `api.usertools.ai/v1/receipts/*` — and does no cryptography beyond the R4
  byte-identity pipeline (canonical base64, fatal UTF-8, pre-parse
  duplicate-key rejection, frozen numeric rules) that checks the served
  receipt bytes against the signed envelope. Built fixture-first against a
  40-fixture conformance matrix (28 conforming shapes, 11 rejection vectors,
  2 vector modules) with every rendered claim string asserted verbatim
  against the frozen spec. **Merges dark**: unlinked, `noindex`, and pointed
  at the real (not-yet-serving) resolver endpoint — going DNS-visible still
  needs the resolver live in production and `usertrust-verify receipt`
  released from `packages/verify`, both tracked separately. See
  `site/app/r/README.md`.

- **Chain events for governance denials, and a correlation handle on the error.**
  A denied call previously wrote NOTHING to the audit chain: invisible to
  `usertrust verify`, to the ledger UI, to exports, and to the entropy signal
  behind `usertrust health`, with no handle a caller could quote back. Two new
  kinds close that gap. `policy_denied` records a decision the GOVERNOR made —
  `denialClass` is one of `policy`, `budget_gate`, `pii`, `injection`,
  `unknown_model` — and carries the hard rules that fired (id + name), PII
  TYPE names, injection PATTERN names, the two budget numbers the gate
  compared, a `promptHash` that joins to pattern memory, plus model /
  action / cost-center / endpoint / transferId. `ledger_rejected` records the
  ledger's own atomic refusal of a hold, where a `transferId` genuinely exists
  and `usertrust verify --tx` can join on it. Both carry `schemaVersion: 1` and
  `decision: "deny"`; every field is PII-safe, and the error text is redacted
  before it is truncated.

  `PolicyDeniedError` and `InsufficientBalanceError` now expose
  `auditEventHash` — the appended event's hash — and `auditDegraded`, which
  distinguishes "the append was attempted, failed, and was dead-lettered" from
  "no append was ever attempted" (an error built by hand, or thrown by an
  older version). Both errors gained an optional trailing metadata argument
  (third and **fifth** respectively, behind their existing `hint`), so every
  existing construction compiles unchanged.

  Appends happen at a FLOW BOUNDARY — a `catch` wrapped around the try/finally
  that releases the budget mutex, ending lexically before the provider call —
  so a denial storm never stalls allowed calls behind an fsync, and a provider
  that throws a same-typed error is never audited as a governor decision. A
  failed denial-append never changes the error the caller receives, `failClosed`
  included: the call is already refused and no money moved. The circuit breaker
  remains deliberately un-wired for denials; a refusal never contacted a
  provider, and counting it would let a policy storm suppress healthy traffic.

  Downstream: `usertrust health` counts both kinds, `verifyTransaction()`
  renders **DENIED** instead of a false PENDING receipt, and the visual ledger
  labels denials as denials rather than as zero-cost failed transactions.

  **Caveat for indirect callers:** `usertrust-server` and the ACS adapter do
  not yet forward `auditEventHash` on the wire, so an HTTP caller receives the
  denial without the handle. The event itself is written either way — the
  server converts the error only after `governor.authorize()` has returned its
  decision, so an `evaluate_only` (`would_deny`) deployment records the denial
  too. Richer UI rendering of `denialClass`/rules, export columns, and an
  `inspect` kind column are also follow-ups.

### Fixed

- **`usertrust-verify --tx` scrubs control characters out of every untrusted
  receipt field.** The receipt renders strings read from `events.jsonl` — a file
  the party under audit owns — onto the terminal of the auditor checking it, so
  an escape sequence could erase the line the verdict prints on and forge a
  passing verification. The unknown-model denial made this reachable with a
  caller-supplied `model`, which the governor also copies into the event's
  `error` text. `model`, `error`, `transferId`, the timestamp, both chain hashes
  and the `renderNotFound` txId now go through the stronger `forDisplay`
  sanitizer (C1 range included) before rendering. This also closes the same
  pre-existing exposure on the `llm_call_failed` error line.
- **A denial whose audit append fails only at the `.meta` sidecar now keeps its
  correlation handle.** `appendEvent` fsyncs `events.jsonl` before writing the
  sidecar, so a sidecar failure rejected for an event that was already durably
  on the chain — and the caller was told `auditDegraded` with no hash, losing
  the handle for a record an auditor could still read. The writer now reports
  that event's hash on the rejection and the denial boundary surfaces
  `auditEventHash` **and** `auditDegraded: true` together, meaning "on-chain at
  this hash, and the write reported failure".
- **`ledger_rejected` carries `actionName`,** mirroring `policy_denied`. Without
  it, every rejected action sharing a broad `kind` (`"tool"`) was
  indistinguishable in the chain — the question a rejected-hold investigation
  starts from.
- **Four-tier cache pricing: rates, receipts, and public schemas (correctness fix).**
  Cache traffic was billed at **zero**: `ModelRates` was two-tier, core's extraction read
  `usage.input_tokens ?? prompt_tokens` while providers report cache read/write as separate
  counters, and openclaw's accumulator dropped the cache fields it did extract. A
  1.14B-cache-read day was under-recorded roughly 7-8x — understatement is the dangerous
  direction, since it makes budgets deplete an order of magnitude slower than the real invoice
  and every scarcity number read falsely high. `ModelRates` gains optional `cacheReadPer1k` /
  `cacheWritePer1k`; every `PRICING_TABLE` entry was re-derived from providers' current published
  rates (`PRICING_TABLE_VERSION = "2026-08-08"`, recorded on receipts), correcting a stale
  `o4-mini` base rate along the way. **An absent cache rate now prices at `inputPer1k`, never
  zero** — overstatement is the fail-safe direction, and this resolution happens in exactly one
  place (`costFromRates`). Core's Anthropic/OpenAI-completions/Responses/Gemini extraction,
  openclaw's accumulator and settle paths, the server wire schema, and the ACS adapter's
  `token_count` all carry the four disjoint tiers end-to-end now, normalized per-source (pi-ai's
  pinned adapters are already disjoint and pass through; core-direct OpenAI/Gemini subtract the
  cache tiers back out of an inclusive prompt count, clamped at 0). The PENDING hold now reserves
  the input leg at `max(inputPer1k, effective cacheWritePer1k)` so a cache-write premium (Anthropic
  1.25x/2x) can't exceed an input-only hold — holds on cache-writing workloads run ~25% fatter;
  warm workloads settle well below and release the difference. `TrustReceipt.usage` (the four-tier
  split) and `TrustReceipt.pricing` (`appliedRates` + `tableVersion` — the resolved rates,
  published even when they came from the fallback) make a settled cost independently recomputable
  from the record alone: `ceil(sum(counts x rates / 1000))`, multiply-then-divide, floored at 1.
  Both are ROOT-level additions because v1 froze `meter` with `additionalProperties: false`, so v1
  validators accept v2 receipts unchanged. `appliedRates` is frozen and copied per record surface.
  `receipt.v2.schema.json` publishes both (v1 stays frozen). Anomaly velocity
  tracking now sees cached traffic instead of losing it once `inputTokens` stopped including it.
  Documented approximations (per-TTL write premium collapsed to the 5-minute rate; long-context,
  service-tier, regional, modality, and cache-storage charges not modeled) are in `AGENTS.md`'s
  Money invariants and `/docs/api/pricing`. See the design spec and the D1-D9 sections it links
  for the full boundary inventory.

- **Budget envelopes: spend routing, per-envelope caps, and scarcity visibility
  (#79, previously unlisted).** `withCostCenter(costCenter, fn, opts?)`
  (`budget/attribution.ts`) attributes a governed call's spend to a
  `(parentUserId, costCenter)` envelope by CODE STRUCTURE — an
  `AsyncLocalStorage` scope, never anything a request body can carry. An
  attributed hold debits the envelope's own ledger-derived account
  (`allocateBudget` / `reclaimBudget`), so TigerBeetle's atomic
  `debits_must_not_exceed_credits` enforces the per-envelope cap the same way
  it already enforced the session wallet's. `getBudgetStatus` and the batched
  `budgetContext()` read the envelope's live balance; the gate's
  `budgetFractionRemaining` / `budgetRunwayHours` turn that into pre-spend
  policy tiers, and settled receipts carry the same numbers under
  `receipt.budget` as a post-settle snapshot. Both surfaces are OBSERVATIONS,
  never authority — see the Money invariants in `AGENTS.md`.
- **Settle-shortfall hardening.** The PENDING hold's size is a heuristic
  estimate (chars/4 tokens × a 1.5x safety margin), so real usage can price
  above the reserve. TigerBeetle rejects — never caps — a settle POST above
  its pending transfer's amount, which previously left the call reporting
  `settled: false` with the hold stranded PENDING until `destroy()` or the
  300s TigerBeetle timeout, and the wallet ultimately charged nothing for a
  call that succeeded. Both `createTBEngine` factories (`govern.ts`,
  `headless.ts`) now cap the post at the reserved amount themselves and audit
  the truncation as a `settlement_shortfall` event; `ledger/engine.ts` reaches
  the same outcome reactively (catches `exceeds_pending_transfer_amount`,
  re-posts with the amount omitted so TigerBeetle posts the full hold).
  `TrustReceipt.postedCost` is now populated whenever the post was capped
  (`receipt.cost − receipt.postedCost` is the shortfall); `receipt.cost` stays
  the true metered cost, and `settled` stays `true`.
- **Class-aware denial hints.** A hard policy denial whose triggering rule
  conditions any budget-scoped field (`budget_remaining`,
  `budget_remaining_after`, `budgetFractionRemaining`, `budgetRunwayHours`,
  `estimated_cost`) now surfaces a budget-specific remedy pointing at
  `allocateBudget` and the fraction/runway tiers (`derivePolicyHint`), instead
  of the rule's generic description.
- **`usertrust-openclaw`: operator-declared tool→envelope attribution and
  per-turn scarcity injection.** A new `costCenters` plugin config
  (`parentUserId`, `tools`, `default`, `envelopes`, `scarcityContext`) routes
  each governed call's spend to a named, operator-capped budget envelope,
  selected STATELESSLY per call from the caller-supplied context's trailing,
  correlated, non-error tool-result run (`deriveAttribution`,
  `src/attribution.ts`) — structured-field matching only, never message text.
  Validated once at plugin construction through core's own
  `parentUserIdRefusal` and `withCostCenter` doors, normalized into a
  deep-frozen config every wrapper reads. When enabled, a
  `[usertrust scarcity] research: 34% left (~2.1h runway) · …` block is
  appended to each call's system prompt from a live batched read of the
  configured envelopes (`Governor.budgetContext`, core), on a copy of the
  caller's context — never gating, delaying, or throwing into the money path
  on a read failure. Fixes a pre-existing money bug in the same pass: the
  stream wrapper now guarantees exactly one settle/abort on every terminal
  mode (completion, thrown error, error event, consumer break/return,
  close-without-`done`), where it previously leaked the PENDING hold on an
  early consumer `break`. See `packages/openclaw/README.md` for the full
  attribution rule and the security-model carve-out.

### Fixed

- `TrustedClient` types: governed `messages.create` / `beta.messages.create` now
  type as `Promise<{ response, receipt }>`, matching the runtime envelope — the
  documented `const { response, receipt } = await client.messages.create(...)`
  pattern now compiles, per-overload. On the streaming overload
  (`stream: true`, and the streaming half of the base-overload union),
  `response` is the governed stream wrapper — `GovernedStream<T>`, an async
  iterable with a settled-`.receipt` promise — not the SDK's raw `Stream`
  (which the runtime never returns from governed `create`; the envelope's own
  `receipt` is the pre-settlement estimate). Types-only; no runtime change.
- `TrustedClient` types: the same envelope now covers the remaining governed
  surfaces — OpenAI `chat.completions.create` and `responses.create`, and Google
  `models.generateContent`. All three resolved to the provider SDK's raw return
  type while the runtime had been returning `{ response, receipt }` since the
  proxies were written, so an OpenAI or Google consumer had no typed path to
  `.receipt` at all and had to cast through `as unknown as`. Streaming calls on
  either OpenAI surface resolve `response` to `GovernedStream<T>`, matching the
  generic async-iterable branch of `interceptCall` that actually wraps them.
  `TrustedClient<T>` now mirrors `detectClientKind`'s ORDER and BOTH halves of
  its shape test, as exclusive branches — Anthropic, else OpenAI, else Google —
  so a hybrid client is typed as governed on exactly the one provider surface
  `trust()` proxies at runtime. Both halves means the governed method must be
  callable AND its namespace must be a non-callable object: every namespace walk
  in the runtime is gated on `typeof ns === "object"`, which a function object
  fails, so a client whose `chat`, `messages`, `models`, `responses` or `beta` is
  a callable carrying properties is skipped by the runtime and is now skipped by
  the type too (falling through to the next provider where one applies).
  Namespaces are re-added through homomorphic mapped types rather than plain
  intersections, so `readonly` — which real `@google/genai` declares on `models`
  — and `?` both survive, and a namespace the client never declared does not
  become a phantom property. The ungoverned inventory stays raw and
  is pinned by type tests: `chat.completions.parse` / `.stream` / `.runTools`,
  `responses.stream` / `.parse` / `.retrieve` / `.cancel` / `.delete` /
  `.compact`, the OpenAI `beta.*` namespace, legacy `completions.create`, and
  Google `models.generateContentStream`. The OpenAI assertions run against the
  real installed `openai@^7.3.0` types; the Google mapper is asserted against a
  structural mock only — no `@google/genai` devDependency exists yet, so real
  `@google/genai` compatibility is unverified. Types-only; no runtime change.
- A policy rule with no `description` no longer renders its identifier twice
  in the denial reason (`[scarcity-brake] scarcity-brake` is now
  `[scarcity-brake]`).

### Security

- **Merkle inclusion proofs now validate PATH TOPOLOGY against
  `(leafIndex, treeSize)`.** `verifyInclusionProof` previously folded whatever
  siblings it was handed and compared the result to the published root. It
  never derived what the path *should* look like for the claimed position, so
  a proof could assert any `leafIndex` it liked and still verify — a forged
  index rode an otherwise-valid fold, and where two sibling hashes are equal
  (identical leaves) flipping a sibling's side refolded to the very same root,
  which no amount of hashing can catch. The verifier now derives the expected
  per-level orientation from `(leafIndex, treeSize)` under the tree's
  odd-node-promotion semantics, requires the supplied sibling count and every
  `position` to match it exactly, and rejects non-safe-integer or
  out-of-range indices and sizes before hashing. `packages/core` and
  `usertrust-verify` changed in lockstep and are covered by a differential
  suite that drives both verifiers directly. Every field of the proof is read
  exactly once and the fold walks a materialized array plus the derived
  orientation, so a hand-built object with a re-reading `position` getter or an
  overridden array iterator cannot pass validation on one path and fold
  another.

  **Compatibility.** Every proof `generateInclusionProof` produces still
  verifies — exhaustively pinned for all leaves of every tree sized 1..33.
  `leafIndex` is ZERO-BASED and is now authenticated: a caller that treated
  it as informational, dropped it during (de)serialization, or stored a
  one-based sequence number will start failing verification. That is the fix
  working, not a regression.

## [3.0.0] - 2026-08-03

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
