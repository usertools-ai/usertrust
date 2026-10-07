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

A `200` from `/v1/authorize` carries `expiresInMs`: the hold's remaining life in whole milliseconds,
the shorter of `pendingTtlMs` and the ledger's pending timeout (5 min; in dryRun, `pendingTtlMs` alone),
counted from when the request arrived. It is a duration: add it to your own clock reading taken BEFORE you sent the request, and you
get a time no later than the hold's real expiry, whatever the offset between your clock and the
server's. (`createdAt` in the same answer is the server's wall-clock time, for display only.) A server
that sends it lists `"hold-expiry"` in `capabilities`; an older one omits the field.

## Endpoints

| Method | Path            | Auth   | Purpose                                             |
| ------ | --------------- | ------ | --------------------------------------------------- |
| POST   | `/v1/authorize` | Bearer | Phase 1: policy gate + PENDING budget hold          |
| POST   | `/v1/settle`    | Bearer | Phase 2a: post actual usage, returns a TrustReceipt |
| POST   | `/v1/abort`     | Bearer | Phase 2b: void the hold for a failed call           |
| GET    | `/v1/budget`    | Bearer | Remaining tenant budget                             |
| GET    | `/v1/events`    | Bearer | SSE stream of tenant governance events              |
| GET    | `/v1/health`    | none   | Liveness and `capabilities`                         |

Errors: `403 policy_denied`, `402 budget_exceeded`, `429 anomaly`, `401 unauthorized`,
`404 not_found` (unknown/already-settled transferId), `413 too_large` (1 MiB body cap).
Pending holds not settled within `pendingTtlMs` (default 5 min) are swept and aborted. The sweep reads
hold ages on a monotonic clock, so a wall-clock step does not move it.

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
