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
2. Add its SHA-256 hash to your `usertrust-server` config, set `"enforcement":
   "evaluate_only"`, and start the server.

   > **Stage 1 needs a server with no enforced tenants on it.** `enforcement` is a
   > **server-wide** field, not per-tenant: setting `evaluate_only` to roll out ONE
   > tenant converts every other tenant's budget, policy, and anomaly denials on that
   > server into shadow responses. Rolling out one agent would silently stop enforcing
   > for everyone else, and nothing in the response tells them. So run stage 1 against
   > a separate instance (a different port and `stateDir` is enough).
   >
   > **Switch to the server you will actually run on at the start of STAGE 2, not
   > stage 3.** Stage 2 is where a wrong key, an unreachable ledger, or a different
   > policy on that server is supposed to surface — while fail-open still protects
   > you. Discovering any of them in stage 3 means discovering them as blocked tool
   > calls. Everything you test in stage 2 must be the thing you keep in stage 3.

   **Both halves are required for stage 1** —
   `enforcement` defaults to `enforce`, and `UT_FAIL_OPEN=1` does NOT soften a
   **402 / 403 / 429** — budget, policy, and anomaly verdicts are enforced denials in
   every stage — so a matching policy, an exhausted budget, or an anomaly cutoff would
   block tool calls on a server left at its default.

   > **What `UT_FAIL_OPEN=1` does soften, and it is more than "the server is down":**
   > every response that is not a verdict, including **401 unauthorized**. A missing,
   > stale, or wrong `UT_SERVER_KEY` therefore runs the whole session **ungoverned and
   > silently** in stages 1-2 — the hook allows with a "proceeding ungoverned" warning
   > that is easy to miss in a passing session. Verify with `/v1/budget` before
   > trusting a stage-2 deny rate: a tenant that never authorizes anything also never
   > denies anything.
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

Prove the real path completes a round trip against the **server you will run on**,
with the **real tenant key**. `/v1/health` answers without touching the ledger, so a
server that can never authorize anything still reports healthy:

```sh
# 1. Liveness — necessary, NOT sufficient. Says nothing about the ledger.
curl -fsS --max-time 5 "$UT_SERVER_URL/v1/health"

# 2. The one that matters: RUN THE HOOK ITSELF. Not a curl that resembles it.
PLUGIN=~/.claude/plugins/usertrust-claude-code   # or this repo's packages/claude-code-plugin
echo '{"session_id":"ut-preflight","tool_name":"Bash","tool_input":{"command":"echo preflight"}}' \
  | node "$PLUGIN/hooks/pre-tool-use.mjs"; echo "  <- exit $?"

# 3. Release the hold through the shipped cleanup, so the probe costs nothing.
echo '{"session_id":"ut-preflight"}' | node "$PLUGIN/hooks/stop.mjs"
```

**Why the hook and not a `curl`:** a hand-written probe has to re-state the model,
the output reservation, the request timeout, the content handling and the auth
header — and it drifts from the hook silently, in the direction that says "ready".
Three separate versions of this check were wrong in exactly that way: a 20s timeout
against a hook that aborts at 5s, a hardcoded model against a hook that sends
`UT_CC_MODEL`, and a 100-token reservation against a hook that reserves ~4096 — the
last of which passes on a budget that then denies every real call with `402`, which
`UT_FAIL_OPEN` cannot soften. Running the hook cannot drift, because it **is** the
deployed path.

Read the result:

- `"permissionDecision":"allow"` and exit 0 — ready.
- `"permissionDecision":"deny"` — governance is working and is denying you; fix the
  policy or the budget, not the plumbing.
- exit **2** — the hook failed closed. The stderr line names the cause, e.g.
  `503 — ledger_unavailable: TigerBeetle …`. This is what stage 3 would do to every
  tool call. **Do not enter stage 3.**

If it reports `503 ledger_unavailable`, the server is up but its TigerBeetle is not.
Start one — `npx usertrust tb start` does NOT do this, it prints "not yet
implemented" — or run the server with `"dryRun": true` to skip the ledger:

```sh
# LOCAL DEVELOPMENT ONLY. --development on BOTH commands (the repo's own CI does
# this): without it these fail on hosts where Direct I/O is unavailable, and
# cluster 0 with one replica is reserved for testing — TigerBeetle says so on
# startup. A production ledger is a real cluster, not this.
#
# CHECK THE VERSION FIRST. The client must not be newer than the server, and a
# mismatch is not a connection error — the cluster starts, accepts the socket, and
# EVICTS the client ("your client is too new"), so recovery still ends in
# ledger_unavailable and looks like the original fault:
#   tigerbeetle version   # must match the tigerbeetle-node in packages/core/package.json
tigerbeetle format --cluster=0 --replica=0 --replica-count=1 --development ./0_0.tigerbeetle
tigerbeetle start --addresses=3001 --development ./0_0.tigerbeetle   # 3001 is the client default
```

Check what is actually on that port, too: a foreign listener hangs the ledger client
exactly like an absent one, and 3001 is a popular port.

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
"proceeding ungoverned" warning — that is stage 1 or 2 above, depending on the
server's `enforcement`. Blocking is **stage 3**, the posture you get by leaving
`UT_FAIL_OPEN` unset; do not arrive there by accident.

A block repeats whatever the server said, so the stderr line names the cause —
e.g. `unexpected governance response 503 — ledger_unavailable: TigerBeetle …`
rather than a bare status code.

> **Requires `usertrust-server` >= 3.3.2, WHICH IS NOT MERGED YET.** The shipped
> server (3.3.1) has no request deadline and maps a ledger failure to an opaque
> `500 internal`, so against it a stalled ledger reaches you as a client-side
> timeout with no diagnosis. The hook change is safe either way — it repeats
> whatever it is given — but the labelled 503 it repeats comes from the server, and
> that work is tracked separately. Everything else in this guide works against
> 3.3.1; only the labelled reason is unavailable.

For that to be reachable the timeouts have to be **monotonic**, and there are two
different client timeouts here, which is easy to get wrong:

```
server ledger deadline (3s)  <  server request deadline (4s)
  <  this hook's HTTP abort (5s, hooks/lib.mjs)  <  the hook process timeout (15s, hooks.json)
```

The 15s in `hooks.json` bounds the **process**; the HTTP request itself aborts at
**5s**. So a server whose own deadline is longer than 5s can only ever reach you as
a generic transport error — its labelled 503 arrives after you stopped listening. If
you raise `requestTimeoutMs` past 5s, raise `hooks/lib.mjs`'s abort with it or the
diagnosis above goes away. Policy (403), budget (402), and anomaly (429) responses are
always enforced denials, not failures — `UT_FAIL_OPEN` does not soften a verdict. PostToolUse/Stop/SubagentStop never
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
