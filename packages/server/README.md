# usertrust-server

Self-hostable HTTP control plane for the [usertrust](https://github.com/usertools-ai/usertrust)
governance kernel. Wraps the headless Governor's two-phase lifecycle
(authorize → settle/abort) with per-tenant isolation, bearer-key auth, and SSE telemetry.

## Quickstart

```bash
npm install -g usertrust-server
```

```bash
# Generate a tenant key (high-entropy secret) and its SHA-256 hash for the config:
KEY=$(openssl rand -hex 32)
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$KEY"
```

Choose one of two ways to run the server, then write the config below.

**Try it (no ledger).** Add `"dryRun": true` to the config. dryRun skips TigerBeetle, so the server needs no ledger replica. The audit chain and the policy engine still run. This is the fastest way to try the API.

**Full mode, locally (TigerBeetle).** Leave `dryRun` out or set it to `false`, which is the default. The server then needs a running TigerBeetle at `127.0.0.1:3001`, the default address. Run the TigerBeetle release that matches the ledger client your install resolved. usertrust depends on `tigerbeetle-node` `^0.17.9`, so a later install can resolve a newer 0.17.x client, and a replica evicts a client whose release it does not support (`client_release_too_high` for a client newer than the replica). `npm ls tigerbeetle-node` where you installed usertrust-server (`npm ls -g tigerbeetle-node` for a global install) shows the client's version (0.17.9 when this was written); set `TB_VERSION` below to it. These commands were run on Linux on arm64 with the 0.17.9 `tigerbeetle-aarch64-linux.zip` asset; for another platform, take the asset for your platform from the [release with that version](https://github.com/tigerbeetle/tigerbeetle/releases).

```bash
TB_VERSION=0.17.9   # the tigerbeetle-node version `npm ls tigerbeetle-node` shows
curl -sSL -o tigerbeetle.zip "https://github.com/tigerbeetle/tigerbeetle/releases/download/${TB_VERSION}/tigerbeetle-aarch64-linux.zip"
unzip tigerbeetle.zip
./tigerbeetle format --cluster=0 --replica=0 --replica-count=1 --development 0_0.tigerbeetle
./tigerbeetle start --addresses=3001 --development 0_0.tigerbeetle
```

**These commands start ONE replica in `--development` mode: a local full-mode run, not a production deployment.** A single replica has no replication and no high availability: lose its data file and the ledger is gone. For production, deploy a replicated TigerBeetle cluster following TigerBeetle's own guidance ([cluster recommendations](https://docs.tigerbeetle.com/operating/cluster/), [deploying](https://docs.tigerbeetle.com/operating/deploying/)), and give the governor all the replica addresses (`tigerbeetle.addresses`).

Format the data file once; start the replica each time you need it. TigerBeetle and its client need `io_uring` on Linux, and Docker's default seccomp profile blocks it; with it blocked, the client cannot start. In a container, run with `--security-opt seccomp=unconfined` (or a seccomp profile that allows `io_uring`). On a host where `kernel.io_uring_disabled` is set, it must be `0`.

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

### A settle for a hold the server no longer has (**BREAKING since 4.1.x: was `404`**)

A `POST /v1/settle` for a `transferId` this server holds no hold for (a TTL sweep ended the hold, the
server restarted, or the settle is a retry) used to answer `404` and drop the spend on the floor. It
now answers one of three, and `/v1/health` lists the capability `settle-unrecoverable` so a client can
check before relying on them:

| Status | `error` | Meaning | What a client does |
|---|---|---|---|
| `410` | `settlement_unrecoverable` | No hold here. The settle is **recorded on the audit chain** (usage only, the id as its SHA-256) and counted per tenant in `settlementsUnrecoverable` on the authenticated `GET /v1/budget` (never on the unauthenticated `/v1/health`); `recorded: false` marks an exact retry already recorded, or a request that shares a concurrent identical request's in-flight append. **Nothing is charged and no hold is re-opened.** If the record is on the chain but the writer reported a failure after it, the body also carries `auditDegraded: true`, which means the write this request made OR shares was degraded. `recorded` stays `true` for the request that wrote it and is `false` for a retry or a concurrent sharer, which write nothing. | Authorize again and settle if the spend must be charged. Do not retry the same settle. |
| `409` | `settlement_ambiguous` | The first settle's ledger post was ambiguous (it may have charged). Nothing recorded. | Do **not** authorize again to settle it: check the ledger. |
| `409` | `already_settled` | A retry of a settle that went through in this process. The charge stands. Nothing recorded. | Treat as success. |
| `409` | `settle_in_progress` | A settle for this id is still running. Nothing recorded. | Retry shortly. |

The server remembers the last 10 000 settled ids PER TENANT (FIFO, in-process; a restart forgets them). Past that
memory, a retry of an older settle reads as an unknown hold and is **recorded** as
`settlement_unrecoverable` (a duplicate record of a charged settle, never a lost one). Without an
idempotency key a late settle and a retry of a charged one cannot be told apart, and a record is the
safe direction. A record that cannot be appended is a `5xx`, never swallowed. Each record is an fsync'd append, so a tenant may write at most 1 000 new ones per minute: past that the settle is refused with `429 rate_limited` (nothing recorded; retry later). `/v1/abort` and
`/v1/release` keep their `404`.

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

An authorize may ask its hold to live longer than the default, for a call expected to run past it:
`holdTtlMs`, in milliseconds. The server clamps it to [`pendingTtlMs`, `maxPendingTtlMs`] (default one
hour), and that life is both the ledger's pending timeout for the hold and the server's own sweep life
for it; `expiresInMs` states it as usual. A server that honours it lists `"hold-ttl"` in `capabilities`
and states the ceiling as `maxHoldTtlMs` on `/v1/health`; an older one strips the key, and the hold keeps
the default life. The trade: a hold whose client crashes keeps its budget reserved for up to its life
before the ledger voids it, so a longer ceiling holds a crashed client's reservation longer.

## Endpoints

| Method | Path            | Auth   | Purpose                                               |
| ------ | --------------- | ------ | ----------------------------------------------------- |
| POST   | `/v1/authorize` | Bearer | Phase 1: policy gate + PENDING budget hold            |
| POST   | `/v1/settle`    | Bearer | Phase 2a: post actual usage, returns a TrustReceipt   |
| POST   | `/v1/abort`     | Bearer | Phase 2b: void the hold for a failed call             |
| POST   | `/v1/release`   | Bearer | Phase 2c: give back a hold that did not fail          |
| GET    | `/v1/budget`    | Bearer | Remaining tenant budget, `voidsOwed`, `ledger`        |
| GET    | `/v1/events`    | Bearer | SSE stream of tenant governance events                |
| GET    | `/v1/health`    | none   | Liveness, `ledger`, `capabilities`, dropped log lines |

Errors: `403 policy_denied`, `402 budget_exceeded`, `429 anomaly`, `401 unauthorized`,
`404 not_found` (unknown transferId on `/v1/abort` and `/v1/release`; for `/v1/settle` see the three codes below), `413 too_large` (1 MiB body cap),
`503 ledger_unavailable` (`/v1/authorize` and `/v1/budget`; see below).
Pending holds are swept and released when their advertised life runs out: `pendingTtlMs` (default 5 min),
or the life its authorize asked for (`holdTtlMs`), or the ledger's pending timeout when that comes first. The sweep reads hold ages on a monotonic clock, so
no wall-clock step moves it, and it never ends a hold before its advertised life. Declared: after the host
sleeps, a hold that was pending across the sleep can keep counting against the budget for at most one hold
life (T, 300 s by default) plus up to one sweep interval (30 s) after wake. In enforce mode that can mean
false denials. It's the safe direction: nothing is charged and the ledger releases the funds on time.
A TigerBeetle-state probe for this case is a follow-up (#241).

### `GET /v1/health`

Unauthenticated, and always HTTP `200`. It answers:

```json
{ "ok": true, "ledger": "reachable", "name": "usertrust-server", "version": "…", "capabilities": ["…"], "maxHoldTtlMs": 3600000, "logLinesDropped": 0 }
```

- **`ledger`**: whether the server can reach its ledger (see "Ledger reachability" below for how
  it is observed). It covers every ledger the tenants use and reads the worst of them, and
  `unknown` while a tenant's governor is still being created or reads another ledger than the one
  watched for it.

  | `ledger`      | Meaning                                                        | `ok`    |
  | ------------- | -------------------------------------------------------------- | ------- |
  | `reachable`   | The ledger answered the last probe.                            | `true`  |
  | `unreachable` | A probe has gone unanswered for longer than `ledgerTimeoutMs`. | `false` |
  | `unknown`     | Reachability is not known. Not evidence of an outage.          | `true`  |
  | `none`        | dryRun: there is no ledger.                                    | `true`  |

- **`ok`** is `false` exactly when `ledger` is `unreachable`, and nothing else changes it.
  **A monitor should read `ledger`**, not the HTTP status. A server whose `ledgerHealth` is
  `"off"` (the default for `createUsertrustServer()`) answers `ledger: "unknown"` and `ok: true`
  through an outage.
- **`name`, `version` and `capabilities`**: what this server is and honours.
- **`maxHoldTtlMs`**: the longest life an authorize may ask its hold for (`holdTtlMs`, capability
  `hold-ttl`): the config's `maxPendingTtlMs` (an integer of at least 300 000; default 3 600 000, one
  hour), never less than `pendingTtlMs`.
- **`logLinesDropped`**: the number of log lines this server could write nowhere, because its log
  sink failed and its write to stderr failed too (a stderr whose reader has gone, say). It is `0`
  normally. It is process-wide, counted across every tenant and route, and names no tenant, route
  or error. It never resets except on a restart. It is informational and never changes `ok`.
  Alert on it going above `0`: server diagnostics (internal errors, the late-hold, expiry and
  shutdown notices, and the ledger observer's own lines) happened that no log recorded.

### When the ledger does not answer: `503 ledger_unavailable`

A ledger-backed server waits at most `ledgerTimeoutMs` (config, an integer of at least 100,
default 5000; not read in dryRun) for the tenant's governor and the ledger on
`POST /v1/authorize`. That wait includes this tenant's earlier authorizes queued ahead of the
request: the governor serves a tenant's authorizes one at a time. Past it the server answers:

```json
{ "error": "ledger_unavailable", "reason": "no answer came within 5000 ms, either from the ledger or from this tenant's earlier authorizes queued ahead of this one; nothing was authorized; retry later", "retryAfterMs": 5000 }
```

**Nothing was authorized.** `retryAfterMs` (the deadline) is a suggested wait before retrying,
not a promise that a retry then succeeds (see *Retrying*, below). The TigerBeetle
client has no timeout or cancel, so the refused request stays queued and executes when the ledger returns. The hold it then
creates is given back at once by an explicit void (a `hold_released` record), never registered as
pending; the ledger's pending timeout stays the backstop, and a hold it ends expires there. A
request whose client hangs up before its answer is treated the same way. The record states why
(`releaseClass`): `unused`, since the client never received the transferId, or
`call-unconfirmed` in the rare case where writing the `200` itself failed, when the answer may
have reached the client.

- **Fast-fail.** While an authorize the ledger has not answered within the deadline is still
  outstanding on a tenant (refused, or abandoned by its client and now past the deadline), every
  new authorize on that tenant gets the same 503 at once, without queueing another ledger
  request. A client hanging up earlier engages nothing. If that request never completes, they keep failing fast until it does: the fail-closed
  direction. If it ends with a local error while the ledger is still down, the next authorize
  waits one deadline and is refused again. While the tenant's governor is still being created
  (its acquisition hangs), fast-fail does not engage: each authorize waits one deadline before
  its 503.
- **Cold start.** A tenant's governor is created on its first authorize, inside the deadline, so
  the first authorize after boot on a slow ledger can get the 503. It is retryable.
- **Bursts.** A tenant's authorizes are served one at a time, so a burst counts against the
  deadline too. Measured on an Apple M4 Pro against a local single-node TigerBeetle, each took
  about 14 ms, and the default 5 s deadline was reached at roughly 350 concurrent authorizes for
  one tenant (300 were all served; 400 drew 503s). A slower or remote ledger reaches it sooner. A
  tenant that issues many concurrent authorizes should raise `ledgerTimeoutMs`. With a deadline
  above about 6.5 s, the Claude Code plugin's PreToolUse cannot receive the `503` (it gives up
  first) and treats the call as an outage.
- **Retrying.** `retryAfterMs` is a suggestion, not a promise. A client that can wait should back
  off with jitter, waiting longer after each 503, rather than retrying at one common moment: a
  burst's clients all retrying at `retryAfterMs` re-create the burst. A client with its own hard
  deadline may instead retry once sooner, expecting another 503, which is cheap: a fast-fail costs
  the server no ledger request. The Claude Code plugin's PreToolUse does exactly that, one retry
  after up to 1 s within its time budget (see its README). How long a 503 lasts: after a burst,
  the fast-fail lasts until the tenant's admitted authorizes have drained, at about one
  authorize's time each: draining a burst of N takes roughly N ÷ 65 seconds from its start on the
  machine above, and the fast-fail ends a little after that (measured: about 7 to 8.5 s after the
  start for 400, about 18.5 to 19 s for 1000). That is an order of magnitude, not a promise.
  Measured there with the default 5 s deadline, the first 503 came about 5.2 s after the burst
  began. After a burst of 400 the fast-fail ended 1.7 to 3.3 s later, and after a burst of 1000
  about 13 s later. A client retrying every 25 ms after a 503 during a 1000-request burst's
  fast-fail typically got its first success about 21 s later. Retries extend the window: one that
  is let in while the queue is still long waits behind it and can reach the deadline itself. In an
  outage nothing predicts when the ledger returns.
- **`voidsOwed`** on the authenticated `GET /v1/budget` counts the tenant's late holds whose
  give-back has not landed: those still waiting on the ledger (a second outage), and those whose
  void the ledger refused, until the hold's own life has run out. The server also logs each of
  these (to stderr, unless an embedder gives it a log sink), naming the transfer only by a short
  SHA-256 prefix.
- **Residual race.** A client that hangs up AFTER the `200` is written cannot be detected: that
  hold is registered as pending and swept as any other.
- `/v1/settle`, `/v1/abort` and `/v1/release` still wait for the ledger without a bound.

### Ledger reachability: how `ledger` is observed, and `/v1/budget`

`ledger` on `GET /v1/health` (above) and on the tenant's `GET /v1/budget` (below) comes from a
ledger observer.

**How it is observed (`ledgerHealth`).** With `"ledgerHealth": "child"` the server runs one
long-lived child process per distinct ledger target the tenants configure (the same
`[clusterId, addresses]` pair), started by `listen()` and killed by `close()`. Each child holds one
TigerBeetle client and answers probes (`lookupAccounts([])`): its first at once, then one every
30 s, and at most one more per `ledgerTimeoutMs` when `/v1/health` is asked. The server process
loads no native TigerBeetle code for this: a native panic, or a host where the client cannot start
(io_uring blocked), kills only the child. The child holds nothing that keeps the server process
alive, and exits within about 250 ms when the server process dies, SIGKILL included.

- **The CLI defaults to `"child"`.** `createUsertrustServer()` defaults to `"off"`: a library
  starts no background process its caller did not ask for. **With `"off"`, `/v1/health` answers
  `ledger: "unknown"` and `ok: true` while the ledger is down.** An embedder who wants health to
  report reachability sets `"ledgerHealth": "child"`. dryRun runs no child and answers `none`.
- **The session budget.** Each child is one TigerBeetle client session, held for the life of the
  server: one session per distinct configured target per running server, beside the governors'
  own. Two address lists for the same cluster are two targets, and cost two sessions on it, so
  **configure every tenant of one cluster with identical `tigerbeetle.addresses`**. The 30 s probe
  makes the health session less likely to be the one a full cluster evicts, never immune: a child
  whose session is evicted exits and is started again after the cooldown.
- **When it reads `unknown`.** Before a new child's first answer (the child has `ledgerTimeoutMs`
  to say it is ready; its first probe's `ledgerTimeoutMs` counts from when it is sent, after which
  an unanswered probe reads `unreachable`, so a slow start is never read as an outage); when a child is not ready within
  `ledgerTimeoutMs` (say its TigerBeetle load hangs): the ledger was never asked, so it reads
  `unknown` (`not_ready`), never `unreachable`, and the child is killed and started again after the
  cooldown; after a probe answered with an error; while a
  child that exited, was evicted or failed to start waits out `healthRespawnCooldownMs` (default
  300000, counted from its exit) to be started again; and with `"off"`. After a child dies,
  `unknown` lasts at most the cooldown plus two `ledgerTimeoutMs`, **only if its replacement starts
  and survives to its first probe**. If every replacement fails (it cannot spawn, or crashes at
  load), `unknown` lasts as long as that does, and is never read as `unreachable`: a failing
  observer says nothing about the ledger. Each failure is logged once per kind per cooldown.
- **A tenant's own `ledger`.** A tenant's ledger is compared with the one its governor actually
  uses, once the governor exists. Until then (its first request has not finished creating it),
  the tenant reads `unknown`, and so does health. If the governor reads a ledger other than the
  one resolved when the server started (its config changed since), the tenant reads `unknown`
  for as long as the server runs, and the server logs that the tenant's config changed after
  start: restart the server to watch the new ledger.

The authenticated `GET /v1/budget` adds the tenant's own `ledger` and `ledgerObserver`:

```json
{ "remaining": 49500, "settlementsUnrecoverable": 0, "voidsOwed": 0, "ledger": "reachable", "ledgerObserver": { "failures": 0, "lastFailure": null } }
```

`ledgerObserver` counts the times the child for this tenant's ledger failed, and names the last
failure's class only (`spawn_failed:EAGAIN`, `child_exited`, `child_error`, `not_ready`, `evicted`, `panic`),
never a path, address or error message. Like authorize, `/v1/budget` waits at most
`ledgerTimeoutMs` for the tenant's governor; past it, it answers `503 ledger_unavailable`, with
the tenant's `ledger` and no `remaining`:

```json
{ "error": "ledger_unavailable", "reason": "the tenant's governor was not ready within 5000 ms; retry later", "retryAfterMs": 5000, "ledger": "unknown" }
```

### Giving a hold back: `/v1/release`, not `/v1/abort`

`/v1/abort` means the call FAILED: it counts as a failure on the tenant's circuit breaker and records
`llm_call_failed`, and five in a row open the breaker, after which every authorize answers `500` for at
least a minute. To give back a hold you no longer need, call `/v1/release` with
`{ "transferId": "…", "reason": "…" }` (`reason` optional; servers that support it list `"release"` in
`capabilities`). It voids the hold and records a neutral `hold_released`, and it touches the breaker not
at all: not a failure, and not a success that could close a breaker real failures opened. The reason is
stored with control characters stripped and clipped to 200 characters, never refused.

`/v1/release` also takes `releaseClass` (optional): `unused`, `call-unconfirmed` or `call-ran`, why the
hold is given back, derived by the client from its own hold state and recorded verbatim on the
`hold_released` record (capability `job`). The free-text `reason` is never read as the class: a release that
states none (a TTL expiry, a shutdown) proves nothing about whether usage hides behind the hold.

It answers `200 { "released": true, "transferId": "…" }` only when that request ended the hold, plus
`voidError` (a fixed code) when the ledger refused the void: the hold is still ended, and the ledger's
pending timeout returns its funds. An unknown id, another tenant's id, or a hold that was already settled,
aborted or released is `404 { "error": "not_found", "reason": "unknown transferId" }`. An unknown ROUTE
is `404` with `"reason": "unknown route"` instead, which is how a client that could not read
`capabilities` tells an older server apart. The sweep and shutdown release, too: an expired hold is not a
failure. The SSE stream announces each release as `released`, with the reason the chain recorded, except
at a signal shutdown. A server stopped by SIGINT or SIGTERM with a pending hold sends no `released` event
for that hold. The hold may stay reserved until the ledger's 300 s timeout, and its release may not be
recorded on the chain: a known issue in 5.0.0. See the repository's `LIMITATIONS.md`.

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
spend ledger). Each tenant vault is owner-only (directories `0700`, files `0600`, whatever
the umask; a vault another user owns is refused), and the server writes nothing outside
`stateDir`; a `stateDir` the server creates is `0700`, and one you created is left as you
made it. At start the CLI creates every configured tenant's vault that does not exist yet
(owner-only) and checks each the way its governor will, and refuses to start, naming the tenant
and the reason, on one it cannot create or the governor would refuse. An error a client sees only
as the opaque `500 internal` is written to stderr as
`usertrust-server: internal error: tenant=<id> route=<route>: <reason>`, never with a header or a
request body; a bearer key or api-key value quoted in the reason is replaced with `[redacted]`.
In that line only three kinds of value are redacted: the caller's own bearer key, any `Bearer`
token, and any `x-api-key`, `api-key` or `api_key` value. Any other secret a reason quotes, such
as a password or a token in another format, is logged as it is; the cleanup of terminal escape
sequences and control characters removes those, not secrets. On Windows the server
neither sets nor checks permissions: the `stateDir` folder's
inherited ACL decides who can read it, so keep it under the service account's own profile or
give it an owner-only ACL (see the repository's `LIMITATIONS.md`). The SSE stream is
best-effort operational telemetry, NOT an audit source — dropped subscribers lose events.
Shadow denials produce no receipt and are not auditable or verifiable.
