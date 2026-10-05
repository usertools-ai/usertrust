# usertrust-server

Self-hostable HTTP control plane for the [usertrust](https://github.com/usertools/usertrust)
governance kernel. Wraps the headless Governor's two-phase lifecycle
(authorize → settle/abort/release) with per-tenant isolation, bearer-key auth, and SSE telemetry.

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

## Endpoints

| Method | Path            | Auth   | Purpose                                              |
| ------ | --------------- | ------ | ---------------------------------------------------- |
| POST   | `/v1/authorize` | Bearer | Phase 1: policy gate + PENDING budget hold           |
| POST   | `/v1/settle`    | Bearer | Phase 2a: post actual usage, returns a TrustReceipt  |
| POST   | `/v1/abort`     | Bearer | Phase 2b: void the hold for a FAILED call            |
| POST   | `/v1/release`   | Bearer | Phase 2c: void a hold that is not a failure          |
| GET    | `/v1/budget`    | Bearer | Remaining tenant budget                              |
| GET    | `/v1/events`    | Bearer | SSE stream of tenant governance events               |
| GET    | `/v1/health`    | none   | Liveness, `capabilities`, `settlementsUnrecoverable` |

Errors: `403 policy_denied`, `402 budget_exceeded`, `429 anomaly`, `401 unauthorized`,
`404 not_found` (unknown/already-settled transferId), `409 already_settled`, `409 hold_active`,
`410 settlement_unrecoverable`, `413 too_large` (1 MiB body cap), `503 ledger_unavailable`.

`/v1/abort` means the call failed: it records a circuit-breaker failure and `llm_call_failed`.
`/v1/release` means the hold is no longer needed: the same void, recorded as `hold_released`,
with no breaker failure. Pending holds not settled within `pendingTtlMs` (default and maximum
240 000 ms) are swept and **released** (`pending_expired` on SSE); shutdown releases the rest
(`released`). The sweep runs every 30 s, claims every due hold at once and releases them
concurrently, so each is out of the server's hands a full interval before the ledger's own 300 s
pending timeout; a late settle then reaches the `settlement_unrecoverable` path, never an expired
hold.

### Idempotency keys and `principal`

`/v1/authorize` accepts an optional `idempotencyKey` (1–256 printable ASCII characters, no
spaces) and an optional `principal` (`{ id, type, origin? }`, each 1–128 characters of
`[A-Za-z0-9._:-]`). **Check `/v1/health` `capabilities` first:** an older server strips request
keys it does not know, so it would accept an `idempotencyKey` and silently ignore it. Keys are
scoped per tenant: each tenant's vault (`stateDir/<tenant>`)
persists a random scope id on its first keyed call, so two deployments sharing one ledger cluster
never share keys, and a restarted server still recognises the keys it charged.

- A replay while the first hold is live answers with the same `transferId` — never a second hold.
- A key whose charge already posted is `409 already_settled`, at authorize or at settle; the
  ledger allows at most one charge per key, across restarts.
- `principal` labels every record the hold leaves (and the receipt). It never selects a wallet
  and never enters the policy gate.

A settle whose hold the server no longer holds (its TTL released it, or the server restarted)
is a plain `404` — unless it carries its `idempotencyKey`. Then the usage it reports is
recorded on the tenant's chain as `settlement_unrecoverable` and the answer is
`410 settlement_unrecoverable` (or `409 already_settled` when the key's charge stands, or
`409 hold_active` — naming the live hold's `transferId` — when the key has a live hold under another
`transferId`). A settle still in flight for the key is waited out first. To charge the usage,
authorize again under the same key and settle.

In `evaluate_only` mode only governance decisions (402, 403, 429) become shadow allows; a ledger
outage (`503`) or an already-charged key (`409`) is returned as is.

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
