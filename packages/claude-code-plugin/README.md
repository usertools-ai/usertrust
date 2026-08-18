# usertrust-claude-code

Ledger-backed governance for Claude Code: every tool call gets a two-phase spend
authorization against a [usertrust-server](../server) you host. PreToolUse reserves,
PostToolUse settles, Stop/SubagentStop abort anything left hanging.

## Install

```
/plugin marketplace add usertools-ai/usertrust
/plugin install usertrust-claude-code@usertrust
```

## Quickstart (against usertrust-server)

1. Generate a tenant key (high-entropy secret — this is an API-key model, not a password):
   `openssl rand -hex 32`
2. Add its SHA-256 hash to your `usertrust-server` config and start the server.
3. Export the plugin environment before launching Claude Code:

```sh
export UT_SERVER_URL="http://127.0.0.1:4519"
export UT_SERVER_KEY="<the key from step 1>"
export UT_FAIL_OPEN=1          # stage 1 — see "Rolling this out safely" below
```

`UT_FAIL_OPEN=1` is here on purpose. This plugin blocks tool calls by default when
governance cannot answer, which is the correct end state but the wrong place to
start: on day one you are testing your server setup, not your policy. Roll forward
through the stages below and drop the variable when the server has earned it.

## Rolling this out safely

The default posture is **fail-closed** — if governance cannot answer, the tool call
is blocked. That is right for a governance product: governance that fails open
under load is decorative. But it means a misconfigured or unreachable server does
not degrade your session, it **stops** it, and the symptom is a stall inside a hook
you are not watching rather than an error message you can read.

So there are three postures, and they are meant to be walked in order. Each one is
a pair — the server's `enforcement` and the client's `UT_FAIL_OPEN` — and changing
only one of them gets you a posture nobody intended.

| Stage | Server `enforcement` | Client | Can deny? | Survives a dead server? |
| --- | --- | --- | --- | --- |
| 1. Shadow | `evaluate_only` | `UT_FAIL_OPEN=1` | no — reports `would_deny` | yes |
| 2. Fail-open enforcement | `enforce` | `UT_FAIL_OPEN=1` | yes | yes |
| 3. Fail-closed | `enforce` | unset | yes | **no — by design** |

**Stage 1 — shadow.** Nothing can block. Denials come back as `would_deny` and the
hook allows the call, so you can read your real deny rate against real traffic
before it can cost you anything. Stay here until the reasons stop surprising you.

**Stage 2 — fail-open enforcement.** Policy and budget denials are now real, but a
governance *outage* still cannot block you. This is the stage that tells you
whether your server is stable enough for stage 3, and it is the one people skip.

**Stage 3 — fail-closed.** Drop `UT_FAIL_OPEN`. An unreachable server now blocks
tool calls. Enter it deliberately, once stage 2 has run long enough that an outage
would be a surprise rather than a Tuesday.

### Before you enter stage 3

Prove the server actually completes a round trip with the *real* tenant key — not
just that it is listening. `/v1/health` answers without touching the ledger, so a
server that can never authorize anything still reports healthy:

```sh
# 1. Liveness — necessary, NOT sufficient. This says nothing about the ledger.
curl -fsS "$UT_SERVER_URL/v1/health"

# 2. The one that matters: a real authorize, with your real key, bounded.
TX=$(curl -fsS --max-time 20 "$UT_SERVER_URL/v1/authorize" \
  -H "Authorization: Bearer $UT_SERVER_KEY" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-6","estimatedInputTokens":200,"maxOutputTokens":100}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).transferId')

# 3. Give the hold back, so the preflight does not itself leak budget.
curl -fsS --max-time 20 "$UT_SERVER_URL/v1/abort" \
  -H "Authorization: Bearer $UT_SERVER_KEY" -H "content-type: application/json" \
  -d "{\"transferId\":\"$TX\"}"
```

If step 2 returns `503 ledger_unavailable`, the server is up but its TigerBeetle is
not — start it (`npx usertrust tb start`) or run the server with `"dryRun": true`.
Do not enter stage 3 until step 2 succeeds; in stage 3 that same failure is every
tool call blocking instead of one curl printing an error.

## Environment variables

| Variable             | Default                  | Meaning                                          |
| -------------------- | ------------------------ | ------------------------------------------------ |
| `UT_SERVER_URL`      | `http://127.0.0.1:4519`  | Base URL of your usertrust-server                |
| `UT_SERVER_KEY`      | (empty)                  | Tenant bearer key                                |
| `UT_CC_MODEL`        | `claude-sonnet-4-6`      | Model name used for cost estimation              |
| `UT_CC_STATE_DIR`    | `$TMPDIR/usertrust-cc`   | Directory for pending-hold state files           |
| `UT_CC_SEND_CONTENT` | `1`                      | `0` sends `{"redacted":true}` instead of content |
| `UT_FAIL_OPEN`       | unset                    | `1` allows tool calls when governance is down (stages 1-2) |

> **Caution:** `UT_SERVER_URL` and `UT_SERVER_KEY` are read from the environment,
> and every PreToolUse authorization sends the tenant key (and tool input as
> message content) to that URL — point them only at a `usertrust-server` you host
> and control, never a third-party or untrusted endpoint.

## Fail-closed semantics

If the governance server is unreachable, times out, answers 5xx, or returns a
malformed body, the PreToolUse hook exits 2 and the tool call is **blocked**.
Set `UT_FAIL_OPEN=1` to invert this: the call proceeds with an explicit
"proceeding ungoverned" warning. This is stage 3 above; do not arrive here by
accident.

A block repeats whatever the server said, so the stderr line names the cause —
e.g. `unexpected governance response 503 — ledger_unavailable: TigerBeetle …`
rather than a bare status code. The server bounds its own work
(`requestTimeoutMs`, default 10s) below this hook's 15s timeout, specifically so
that a stalled dependency reaches you as a labelled 503 you can read instead of a
hook timeout you have to guess at. Policy (403) and budget (402) denials are
always enforced denials, not failures. PostToolUse/Stop/SubagentStop never
block — the tool already ran; failed settlements leave the hold on disk for
Stop cleanup, and the server's pending-TTL sweep voids anything orphaned.

If the server runs in `evaluate_only` mode, denials come back as shadow
responses: the hook allows the call and surfaces a "would_deny" reason —
nothing is reserved or settled for shadow decisions.

## Content flow and audit

PreToolUse sends the stringified `tool_input` (truncated at 16 KiB) to your
**self-hosted** server as message content so the core PII policy can scan it.
It never goes to any third party. Set `UT_CC_SEND_CONTENT=0` to send
`{"redacted":true}` instead — size-based cost estimation still uses the real
input length, so budgets stay accurate. The usertrust audit chain stores
content hashes, never raw bodies; raw tool input exists only in transit to
your server and is not persisted by governance.
