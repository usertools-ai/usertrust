# usertrust-claude-code

Ledger-backed governance for Claude Code: every tool call gets a two-phase spend
authorization against a [usertrust-server](../server) you host, and the session's
REAL token usage — per model, per subagent — is settled from Claude Code's own
transcripts. PreToolUse reserves a hold that covers the usage recorded since the
last one plus the upcoming tool, PostToolUse settles that hold at the real counts,
and Stop/SubagentStop post whatever no hold carried and terminate anything left
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
| `UT_CC_MODEL`        | `claude-sonnet-4-6`      | Model for an estimate hold before any transcript model is known |
| `UT_CC_USAGE`        | `transcript`             | `estimate` settles per-call estimates only       |
| `UT_CC_STATE_DIR`    | `$TMPDIR/usertrust-cc`   | Directory for pending-hold and transcript state  |
| `UT_CC_SEND_CONTENT` | `1`                      | `0` sends `{"redacted":true}` instead of content |
| `UT_FAIL_OPEN`       | unset                    | `1` allows tool calls when governance is down (see below) |

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

- **The hold is the settlement vehicle.** At PreToolUse the agent's new complete
  responses — those of the earliest one's model, the *window* — are assigned to the
  hold being authorized. The hold is sized to cover them (cache writes counted
  twice, so it never caps the real cost) PLUS the usual tool estimate, so the
  budget check before the call still covers the call. PostToolUse then SETTLES
  that hold, exactly once, at the window's real counts — on the normal path no
  hold is ever aborted. A tool call whose window is empty (a parallel call in the
  same response, say) settles at zero usage.
- **The remainder.** What no hold carried — another model's responses, a final
  answer with no tool call — is posted at SubagentStop (that subagent) and Stop
  (the parent and every subagent, so one whose SubagentStop never fired is still
  accounted), one authorize→settle per model. Stop then SETTLES a leftover hold
  that has usage assigned (its tool was interrupted, but the model turn was
  billed) and aborts one that has none.
- **What is counted.** One count per API response (`message.id`): the largest
  value of each count across its entries, so a response streamed over several
  entries is never added twice and a later entry can never lower it; a response
  still streaming waits. `cacheReadTokens` / `cacheWriteTokens` are sent separately
  from `inputTokens`, so each tier is priced at its own rate. The counts are the
  provider's own, so settles are `usageSource: "provider"`; the authorize carries
  `params.usageOrigin: "transcript"`.
- **Attribution.** A transcript authorize's actor is
  `claude-code:<session>:<agentType>:<agentId>` (`main:main` for the parent), with
  `agent_id` / `agent_type` in its params. This is request-side only: the server
  does not yet persist agent identity into the audit record (a core/server change
  is planned).
- **At most once.** Per (session, agent) a cursor records which response ids are
  assigned, accounted or denied. An id is claimed before anything could post it and
  released only when the server proved nothing was posted (the authorize failed,
  or the settle answered 400/404). A settle that answers 5xx or not at all may
  have posted, so its ids stay claimed and the hold is aborted for hygiene: an
  outage can lose usage, but never post it twice. A cursor that exists but cannot
  be read is never treated as empty — transcript usage is not posted until it is
  fixed or removed.
- **Denied usage.** If the remainder's authorize is refused (402 budget, 403
  policy, 429 anomaly), those responses are marked `denied` and never retried, and
  a stderr note gives the token counts that could not be recorded.
- **Sticky estimate mode.** If an agent's transcript cannot be read at any hook,
  that agent switches to the per-call estimate for the rest of the session —
  settled as `usageSource: "estimated"`, with a stderr note giving the reason — and
  its transcript is never read again, so no usage is ever counted both as an
  estimate and as real. `UT_CC_USAGE=estimate` does the same for every agent.
- **Private state.** Cursors live in `$UT_CC_STATE_DIR/transcripts/`, created
  `0700`; if that directory is not a real directory owned by you without group or
  other write access, transcript accounting is off for that run and holds settle
  at the estimate.
- **Hook time budget.** Each hook gives up after about 10 seconds (the hooks'
  timeout is 15), and Stop keeps time back to settle leftover holds; whatever it
  could not reach is posted at the next settle point.
- **Content.** Transcripts are read locally and only token counts, model names and
  agent ids/types are sent to your server — never transcript content.

**Declared costs.** Every hold is settled, so a tool call with an empty window
costs the server's 1-unit settle floor: a deliberate over-count of at most one unit
per extra parallel tool call, never an under-count. Responses of a second model
cost one extra authorize→settle at the next Stop. Attribution is request-side
only, as above.

**Trust.** Transcript mode prices files that the same OS user can edit.
usertrust governs cooperative agents on a machine you control; it is not a
sandbox against a process that wants to rewrite its own transcript.

## Fail-closed semantics

If the governance server is unreachable, times out, answers 5xx, or returns a
malformed body, the PreToolUse hook exits 2 and the tool call is **blocked**.
Set `UT_FAIL_OPEN=1` to invert this: the call proceeds with an explicit
"proceeding ungoverned" warning. `UT_FAIL_OPEN=1` is recommended for interactive
sessions where availability matters more than enforcement — a stopped server then
never blocks your session, and the usage it misses stays in the transcript to be
posted at a later settle point. Leave it unset when the budget must be enforced.
Policy (403) and budget (402) denials are always enforced denials, not failures.
PostToolUse/Stop/SubagentStop never block — the tool already ran; an estimate hold
whose settle fails is left on disk for Stop cleanup, and the server's pending-TTL
sweep voids anything orphaned.

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
