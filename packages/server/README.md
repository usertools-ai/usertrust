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

That config runs with `"dryRun": false` — the default — so it needs a reachable
TigerBeetle (`npx usertrust tb start`, default `127.0.0.1:3001`). Without one, every
`/v1/authorize` answers `503 ledger_unavailable` after `tigerbeetle.connectTimeoutMs`;
add `"dryRun": true` to run the governor with no ledger at all. Check the port is
actually TigerBeetle and not something else of yours — the failure looks identical
whether nothing is listening or the wrong thing is.

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

## Endpoints

| Method | Path            | Auth   | Purpose                                             |
| ------ | --------------- | ------ | --------------------------------------------------- |
| POST   | `/v1/authorize` | Bearer | Phase 1: policy gate + PENDING budget hold          |
| POST   | `/v1/settle`    | Bearer | Phase 2a: post actual usage, returns a TrustReceipt |
| POST   | `/v1/abort`     | Bearer | Phase 2b: void the hold for a failed call           |
| GET    | `/v1/budget`    | Bearer | Remaining tenant budget                             |
| GET    | `/v1/events`    | Bearer | SSE stream of tenant governance events              |
| GET    | `/v1/health`    | none   | Liveness                                            |

Errors: `403 policy_denied`, `402 budget_exceeded`, `429 anomaly`, `401 unauthorized`,
`404 not_found` (unknown/already-settled transferId), `413 too_large` (1 MiB body cap),
`503 ledger_unavailable` (TigerBeetle unreachable — the `reason` names the addresses tried),
`503 governor_timeout` (the governor did not answer within `requestTimeoutMs`).
Pending holds not settled within `pendingTtlMs` (default 5 min) are swept and aborted.

## Timeouts

Every request is bounded, because a governance server that HANGS is strictly worse than
one that errors: a caller cannot tell "slow" from "dead", and `usertrust-claude-code`
resolves that ambiguity by failing CLOSED — so an unbounded wait there is not a slow tool
call, it is a blocked one.

| Setting | Default | Bounds |
| --- | --- | --- |
| `tigerbeetle.connectTimeoutMs` (tenant's usertrust config) | 3 s | Building a governor: the TigerBeetle handshake. Yields `503 ledger_unavailable`. |
| `requestTimeoutMs` (server config) | 4 s | Any governor call that stalls some other way — including a cluster that dies AFTER the governor was built. Yields `503 governor_timeout`. |

The whole chain must be **monotonic**, or the specific error loses a race to the generic
one:

```
connectTimeoutMs (3s)  <  requestTimeoutMs (4s)  <  your client's HTTP timeout  <  its outer timeout
```

That is not hypothetical. These defaults were first set to 5s and 10s "below the client's
15s timeout" — but `usertrust-claude-code`'s 15s is its hook *process* timeout, while its
HTTP request aborts at **5s**. A 5s ledger deadline answered at ~5.03s, so the client had
already given up and the user saw a generic transport error instead of the labelled 503,
every single time. Raising these without raising your client's timeout re-breaks it.

`/v1/settle` and `/v1/abort` deliberately bound only governor CONSTRUCTION, not the
settle/abort call itself: a timed-out settle has an unknown outcome on the money path (the
post may still land), and reporting it as failed would invite a double-settle.

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

Only governance verdicts (4xx) are shadowed. Infrastructure failures (5xx — including
`ledger_unavailable` and `governor_timeout`) are returned as failures even in
`evaluate_only`: reporting an outage as `would_deny` would tell an operator their policy
reached a verdict at the exact moment nothing evaluated one.

## Audit authority

Only Governor-produced receipts and audit-chain records are authoritative. The server
invents no audit records of its own; every receipt returned by `/v1/settle` comes from
the tenant's Governor (per-tenant `stateDir/<tenant>` vault: separate audit chain and
spend ledger). The SSE stream is best-effort operational telemetry, NOT an audit
source — dropped subscribers lose events. Shadow denials produce no receipt and are
not auditable or verifiable.
