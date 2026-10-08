# usertrust-server

Self-hostable HTTP control plane for the [usertrust](https://github.com/usertools/usertrust)
governance kernel. Wraps the headless Governor's two-phase lifecycle
(authorize → settle/abort) with per-tenant isolation, bearer-key auth, and SSE telemetry.

## Quickstart

```bash
# Generate a tenant key (high-entropy secret) and its SHA-256 hash for the config:
KEY=$(openssl rand -hex 32)
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$KEY"
```

`usertrust-server.config.json`:

```json
{
	"port": 4519,
	"stateDir": ".usertrust-server",
	"tenants": [{ "id": "acme", "keyHash": "<sha256 hex of the key>", "budget": 50000 }]
}
```

```bash
usertrust-server --config usertrust-server.config.json

curl -s localhost:4519/v1/authorize -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-6","estimatedInputTokens":200,"maxOutputTokens":100}'
curl -s localhost:4519/v1/settle -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"transferId":"<from authorize>","inputTokens":200,"outputTokens":40}'
```

`/v1/settle` also accepts `cacheReadTokens` / `cacheWriteTokens` (both optional, disjoint from
`inputTokens` — do not include cached tokens in `inputTokens` too, or they double-count). Absent
cache rates for the model still price those tokens at the input rate — see the money invariants
in `AGENTS.md` — omitting the fields is not the same as reporting zero cache activity.

`/v1/settle` also accepts `computeMs` (optional, finite and non-negative): wall-clock compute
duration in milliseconds, as reported by local runtimes (e.g. Ollama `eval_duration`). It
passes through to `receipt.meter.computeMs` and is not a pricing input.

`/v1/authorize` also accepts `actor` (a string) and `principal` (optional) — who the work is for:
`{ "id": "…", "type": "…", "origin": "…", "unit": "…", "role": "…" }`, every field optional and each
1–128 characters of `[A-Za-z0-9._:-]`. **Check `/v1/health` `capabilities` first:** an older server
strips request keys it does not know, so it would accept a `principal` and silently record the call as
nobody's. A server that honours it lists `"principal"`.

`/v1/authorize` also accepts `estimatedCacheReadTokens` and `estimatedCacheWriteTokens` (optional,
non-negative integers). With them, each cache tier is held at its own rate and `estimatedInputTokens`
should be the fresh input only. Without them, all estimated input is held at the higher of the input
and cache-write rates. A server that honours them lists `"authorize-cache-tiers"` in `capabilities`.
An older server strips them, so a client checks the list before relying on a smaller hold. Any other key, or an invalid field, is a `400`. Both are recorded on
the call's audit records, and the principal's `id`/`unit`/`role` become TigerBeetle `user_data` tags
on its ledger transfers for roll-ups. A principal never changes which wallet pays.

`/v1/authorize` also accepts `job` (1–128 characters of `[A-Za-z0-9._:-]`), `jobState` (only
`"invalid"`, exclusive with `job`: the caller's job state could not be trusted) and `usageFrom` (an
ISO-8601 UTC instant: when the usage the hold covers began); `/v1/settle` accepts `usageTo` (same
form, never before the hold's `usageFrom`). They are recorded verbatim on every audit record the hold
produces (a release or an expiry inherits them from the hold), so per-job cost is a query. A job is a
label: it never selects the wallet that pays, enters the policy gate or prices anything. A settle may
repeat `job` / `jobState` only to be checked: one that differs from the hold's is a `400`, nothing is
written and the hold stays settleable. A settle that states `usageFrom` is a `400`: the authorize is the
one source of a usage start. A server that honours these lists `"job"` in `capabilities`; an older one
strips them in silence, so a client checks the list first.

A `200` from `/v1/authorize` carries `expiresInMs`: the longest the hold can still be pending, in whole
milliseconds. That is the shorter of `pendingTtlMs` and the ledger's pending timeout (5 min; in dryRun,
`pendingTtlMs` alone), counted from when the request arrived. No expiry ends the hold sooner; a settle,
a void or a server restart can. It is a duration: add it to your own clock reading taken BEFORE you sent
the request, and you get a time no later than the hold's last moment, whatever the offset between your
clock and the server's. (`createdAt` in the same answer is the server's wall-clock time, for display
only.) A server that sends it lists `"hold-expiry"` in `capabilities`; an older one omits the field, and
so does this one for a ledger hold whose timeout it cannot state. Without the field, treat the hold as
one you cannot reuse.

## Endpoints

| Method | Path            | Auth   | Purpose                                             |
| ------ | --------------- | ------ | --------------------------------------------------- |
| POST   | `/v1/authorize` | Bearer | Phase 1: policy gate + PENDING budget hold          |
| POST   | `/v1/settle`    | Bearer | Phase 2a: post actual usage, returns a TrustReceipt |
| POST   | `/v1/abort`     | Bearer | Phase 2b: void the hold for a failed call           |
| POST   | `/v1/release`   | Bearer | Phase 2c: give back a hold that did not fail        |
| GET    | `/v1/budget`    | Bearer | Remaining tenant budget                             |
| GET    | `/v1/events`    | Bearer | SSE stream of tenant governance events              |
| GET    | `/v1/health`    | none   | Liveness and `capabilities`                         |

Errors: `403 policy_denied`, `402 budget_exceeded`, `429 anomaly`, `401 unauthorized`,
`404 not_found` (unknown/already-settled transferId), `413 too_large` (1 MiB body cap).
Pending holds are swept and released when their advertised life runs out: `pendingTtlMs` (default 5 min),
or the ledger's pending timeout when that comes first. The sweep reads hold ages on a monotonic clock, so
no wall-clock step moves it, and it never ends a hold before its advertised life. Declared: after the host
sleeps, a hold that was pending across the sleep can keep counting against the budget for at most one hold
life (T, 300 s by default) plus up to one sweep interval (30 s) after wake. In enforce mode that can mean
false denials. It's the safe direction: nothing is charged and the ledger releases the funds on time.
A TigerBeetle-state probe for this case is a follow-up (#241).

### Giving a hold back: `/v1/release`, not `/v1/abort`

`/v1/abort` means the call FAILED: it counts as a failure on the tenant's circuit breaker and records
`llm_call_failed`, and five in a row open the breaker, after which every authorize answers `500` for at
least a minute. To give back a hold you no longer need, call `/v1/release` with
`{ "transferId": "…", "reason": "…" }` (`reason` optional; servers that support it list `"release"` in
`capabilities`). It voids the hold and records a neutral `hold_released`, and it touches the breaker not
at all: not a failure, and not a success that could close a breaker real failures opened. The reason is
stored with control characters stripped and clipped to 200 characters, never refused.

It answers `200 { "released": true, "transferId": "…" }` only when that request ended the hold, plus
`voidError` (a fixed code) when the ledger refused the void: the hold is still ended, and the ledger's
pending timeout returns its funds. An unknown id, another tenant's id, or a hold that was already settled,
aborted or released is `404 { "error": "not_found", "reason": "unknown transferId" }`. An unknown ROUTE
is `404` with `"reason": "unknown route"` instead, which is how a client that could not read
`capabilities` tells an older server apart. The sweep and shutdown release, too: an expired hold is not a
failure. The SSE stream announces each release as `released` (shutdown included), with the reason the
chain recorded.

`/v1/abort` keeps the same rule: `200 { "aborted": true, "transferId": "…" }` (plus `voidError`) only
when that request ended the hold, and the `aborted` event only then. A hold the governor no longer held
(its settle in flight, or already settled, aborted or released) is `404 { "error": "not_found", "reason":
"unknown transferId" }`.

## Keys

Tenant keys are generated high-entropy secrets (`openssl rand -hex 32`), never passwords.
The config stores only the SHA-256 hash of each key — this is the standard API-key model
(hash-at-rest for a random 256-bit secret), not a password store, so no slow hash
(scrypt/argon2) is needed. Lookup is timing-safe. The server never logs request bodies,
messages, params, or Authorization headers.

## Shadow mode (`"enforcement": "evaluate_only"`)

In `evaluate_only` mode a denial is converted into a shadow allow: the client receives
`200 { shadow: true, shadowId: "shadow_…", decision: "would_deny", reason }` and a
`denied` event with `shadow: true` is emitted. No reservation is created — a `shadowId`
is not a `transferId` and cannot be settled or aborted (those routes 404). This is the
server-layer semantic; other usertrust layers define their own evaluate-only behavior.

## Audit authority

Only Governor-produced receipts and audit-chain records are authoritative. The server
invents no audit records of its own; every receipt returned by `/v1/settle` comes from
the tenant's Governor (per-tenant `stateDir/<tenant>` vault: separate audit chain and
spend ledger). The SSE stream is best-effort operational telemetry, NOT an audit
source — dropped subscribers lose events. Shadow denials produce no receipt and are
not auditable or verifiable.
