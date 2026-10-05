# usertrust-claude-code

Ledger-backed governance for Claude Code: every tool call gets a two-phase spend
authorization against a [usertrust-server](../server) you host, and the session's
REAL token usage — per model, per subagent — is settled from Claude Code's own
transcripts. PreToolUse reserves an estimate, PostToolUse/Stop/SubagentStop settle
the real usage and void the estimate, and Stop/SubagentStop abort anything left
hanging. Nothing is routed through usertrust: it only reads what Claude Code
already recorded.

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
```

## Environment variables

| Variable             | Default                  | Meaning                                          |
| -------------------- | ------------------------ | ------------------------------------------------ |
| `UT_SERVER_URL`      | `http://127.0.0.1:4519`  | Base URL of your usertrust-server                |
| `UT_SERVER_KEY`      | (empty)                  | Tenant bearer key                                |
| `UT_CC_MODEL`        | `claude-sonnet-4-6`      | Model name used for the pre-call estimate hold   |
| `UT_CC_USAGE`        | `transcript`             | `estimate` settles per-call estimates only       |
| `UT_CC_STATE_DIR`    | `$TMPDIR/usertrust-cc`   | Directory for pending-hold state files           |
| `UT_CC_SEND_CONTENT` | `1`                      | `0` sends `{"redacted":true}` instead of content |
| `UT_FAIL_OPEN`       | unset                    | `1` allows tool calls when governance is down — **recommended for interactive sessions** |

> **Caution:** `UT_SERVER_URL` and `UT_SERVER_KEY` are read from the environment,
> and every PreToolUse authorization sends the tenant key (and tool input as
> message content) to that URL — point them only at a `usertrust-server` you host
> and control, never a third-party or untrusted endpoint.

## Real usage: what is settled, and how

Claude Code records every API response's `usage` block (fresh input, cache read,
cache write, output — four disjoint counts) and its model in the session
transcript it passes to hooks as `transcript_path`. Subagents write their own
transcripts under `<session>/subagents/agent-<agentId>.jsonl`, beside a
`.meta.json` naming the agent type.

- **Settle points.** PostToolUse settles the calling agent's new usage, SubagentStop
  the stopping subagent's, and Stop the parent's AND every subagent's (so an agent
  whose SubagentStop never fired is still accounted).
- **What is counted.** One count per API response (`message.id`), from its final
  entry: a response streamed over several transcript entries is never added twice,
  and one still streaming waits for the next settle point. Each settle is one
  authorize→settle pair per model with `cacheReadTokens` / `cacheWriteTokens`
  sent separately from `inputTokens`, so each tier is priced at its own rate.
  The counts are the provider's own, so the settle is `usageSource: "provider"`;
  the authorize carries `params.usageOrigin: "transcript"`.
- **Attribution.** Every settle's actor is `claude-code:<session>:<agentType>:<agentId>`
  (`main:main` for the parent), with `agent_id` / `agent_type` in its params, so the
  ledger separates the parent from each subagent.
- **Idempotency.** The message ids already accounted are kept per (session, agent)
  in `$UT_CC_STATE_DIR/transcripts/`. Ids are claimed before anything is posted and
  released only when the server proves nothing was posted, so re-runs, crashes and
  concurrent hooks can defer a settle but never post the same usage twice.
- **The estimate hold.** PreToolUse still reserves an estimate so budget is enforced
  BEFORE a call. Once real usage is settled, PostToolUse voids that hold instead of
  settling it — the real numbers replace the estimate, never add to it. Only when
  the transcript is missing or corrupt does PostToolUse settle the hold at the
  estimate, as `usageSource: "estimated"`, with a stderr note saying why.
- **Content.** Transcripts are read locally and only token counts, model names and
  agent ids/types are sent to your server — never message content.

## Fail-closed semantics

If the governance server is unreachable, times out, answers 5xx, or returns a
malformed body, the PreToolUse hook exits 2 and the tool call is **blocked**.
Set `UT_FAIL_OPEN=1` to invert this: the call proceeds with an explicit
"proceeding ungoverned" warning. **For interactive use `UT_FAIL_OPEN=1` is
recommended** — a stopped or unreachable server then never blocks your session;
the usage it misses stays in the transcript and is settled at the next settle
point once the server is back (for messages not yet accounted). Policy (403) and budget (402) denials are
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
