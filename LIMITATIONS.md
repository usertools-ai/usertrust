# Limitations

usertrust is a trust layer. A trust layer that overstates itself is worse than none,
so this document is part of the product: what usertrust deliberately does not do,
where its boundaries sit, and why each boundary is where it is.

Every statement below is true of the code in this repository. When a limitation
moves, this document moves with it.

## 1. The governance surface is the wrapped SDK methods — nothing else

`trust()` intercepts exactly three entry points:

- Anthropic: `client.messages.create()`
- OpenAI: `client.chat.completions.create()`
- Google: `client.models.generateContent()`

Streaming through those methods (`stream: true`) is governed, including mid-stream
anomaly cutoff. Everything else on the client bypasses governance, audit, and
budget enforcement entirely: Anthropic's `client.messages.stream()` helper and
`client.beta.*`, OpenAI's Responses API and legacy `client.completions.create()`,
and any other alternative surface.

**Why:** usertrust detects clients by duck typing and wraps them with a JS Proxy.
That is what makes it a one-line integration with zero SDK dependencies across
SDK versions — and it means the governed surface is a specific set of methods,
not "the network." If your code relies on an ungoverned method, route it through
a governed entry point or bring your own controls. The exact boundary is
documented at the source in `packages/core/src/detect.ts`.

## 2. Endpoint classification is a trusted-operator decision

`classifyEndpoint()` decides whether a call settles at local or cloud rates from
`endpoints[]` matchers, per-call overrides, and loopback autodetect. All three
inputs belong to the operator. If any of them is plumbed from end-user or
request input, an attacker chooses their own settlement regime — the same trust
boundary as `budget` and `customRates`, where the config author already controls
billing entirely.

Two specifics worth knowing:

- **Loopback autodetect is workstation mode.** On servers and in containers, set
  `local.autoDetectLoopback: false` and classify via explicit `endpoints[]` —
  loopback inside a container can be a forwarding sidecar to a paid API.
- **Classification happens once, at wrap time,** from the client's `baseURL`.
  Per-request baseURL overrides are not re-classified. Absent or malformed
  baseURLs classify as cloud — fail-expensive, because over-charging at cloud
  rates is recoverable and under-charging a paid endpoint is not.

## 3. Local-server usage reports are trusted for settlement

For local endpoints, usertrust prefers server-reported usage (it auto-injects
`stream_options: { include_usage: true }` into local OpenAI-compatible streams).
A compromised or lying local server can under-report its own usage, and
usertrust does not independently re-count tokens for arbitrary local runtimes.

**Why receipts still hold up:** every receipt stamps `usageSource`
(`"provider"` or `"estimated"`) and `meter.rateSource`, so the provenance of
every settled number is explicit and auditable. usertrust does not pretend to
verify what it cannot; it makes the trust relationship visible in the ledger
instead.

## 4. Hard budget atomicity applies to full mode, not `dryRun`

`dryRun: true` (or `USERTRUST_DRY_RUN=true`) skips TigerBeetle entirely and runs
audit-chain-only. It exists as the explicit, honest way to bypass financial
enforcement — in tests, in evaluation. Every claim about atomic budget
enforcement (an over-budget PENDING hold rejected by the ledger before the
provider is called) applies to full mode with a live TigerBeetle instance.

One caveat from our own release history: CI validates live-ledger enforcement
against a stateful `tigerbeetle-node` fake that implements real double-entry
balance math and `debits_must_not_exceed_credits` (see
`packages/core/tests/harden/ledger-funded-wallet.test.ts`) — a behavioral test
against real ledger semantics, not a mock asserting a mock. It is still a fake.
Validate against a real TigerBeetle cluster before relying on enforcement in
production.

## 5. One audit writer per vault, one process at a time

The audit chain is a linear SHA-256 hash chain. Two concurrent writers would
fork it, which is precisely the tampering the chain exists to make evident — so
usertrust enforces single-writer semantics with an advisory file lock plus an
in-process mutex. A second process opening the same vault gets a hard error, not
a silent fork. Stale locks from crashed processes are reclaimed; live ones are
never stolen.

If you need multiple concurrent workers, give each its own vault. Merging or
centralizing chains is a control-plane concern, not something the core SDK
pretends to solve today.

## 6. Anomaly governance ships conservative defaults and expects calibration

Anomaly detection is opt-in (`anomaly.enabled: true`) and tuned to catch
sustained runaway behavior, not brief spikes: 500 tok/s over three consecutive
2-second windows, $1.00/min spend velocity over a 10-second rolling window,
3 injection signals in 60 seconds. Local endpoints get local-calibrated
thresholds (5,000 tok/s; 10,000 nominal usertokens/min) because fast local GPU
inference legitimately exceeds cloud rates.

One behavior is by design, not a gap: with the default local rate of `{0,0}`,
per-call nominal cost floors at 1 usertoken, so spend velocity cannot trip on
default local config — **token rate is the primary local signal**. Velocity
becomes meaningful on local endpoints when you set nonzero amortized rates.
Whatever your workload looks like, the defaults are a starting point; calibrate
them against your own traffic before trusting the trip wire.

## 7. The Board of Directors is heuristic, not an LLM

The board's two directors review decisions with six pattern-matching concern
detectors (hallucination, bias, safety, scope creep, resource abuse, policy
violation). No LLM calls are made.

**Why:** deterministic review is auditable, free, adds no latency, and cannot be
prompt-injected. The trade is real — heuristics will not catch what a model
reviewer might. Treat board verdicts as a cheap tripwire layered under your
policy rules, not as semantic judgment.

## 8. No third-party certification

usertrust has no SOC 2 report, no ISO 27001 certificate, no third-party
attestation of any kind. The audit chain — hash-chained events, RFC 6962 Merkle
proofs, a zero-dependency offline verifier — is designed to produce evidence an
auditor can check without trusting us or this codebase. That is the deliberate
division of labor: usertrust generates the receipts; certifying a deployment
that uses them is the deployer's work with their own auditors.

## 9. Proxy mode was deleted rather than shipped as theater

Early versions carried a proxy-mode stub for remote governance that returned
hardcoded success for every spend, settle, and void — which made the entire
two-phase lifecycle theater and was, in effect, a governance bypass. Under
AUD-456 we removed it: `connectProxy()` now throws, and passing `proxy` to
`trust()` fails fast with the reason. If proxy mode ships in the future it will
ship with real financial enforcement behind it. Until then: `dryRun` for
explicit bypass in testing, a real TigerBeetle for production.

---

Found a boundary we haven't documented? That is a bug in this file — open an
issue, or see [SECURITY.md](SECURITY.md) if it has security impact.
