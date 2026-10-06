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
| `UT_CC_STATE_DIR`    | `~/.claude/usertrust-cc` | Pending holds, and what was already posted (keep it; see below) |
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
  same response, say) is given back (below).
- **The remainder.** What no hold carried — another model's responses, a final
  answer with no tool call — is posted at SubagentStop (that subagent) and Stop
  (the parent and every subagent, so one whose SubagentStop never fired is still
  accounted), one authorize→settle per model. Before that, Stop SETTLES a leftover
  hold that has usage assigned (its tool was interrupted, but the model turn was
  billed); after it, Stop gives back the holds that have none.
- **Empty holds are given back.** A hold no usage was assigned to (a parallel tool
  call in the same response, say) is RELEASED at PostToolUse: no charge, and not a
  failure. A server without `/v1/release` gets the old settle at zero usage, which
  costs its 1-unit settle floor.
- **What is counted.** One count per API response (`message.id`, which is
  one-to-one with the entry's `requestId`): the largest value of each count across
  its entries, so a response streamed over several entries is never added twice
  and a later entry can never lower it; a response still streaming waits, and one
  that never completes (an interrupted stream) is never posted.
  `cacheReadTokens` / `cacheWriteTokens` are sent separately from `inputTokens`, so
  each tier is priced at its own rate. The counts are the provider's own, so
  settles are `usageSource: "provider"`; the authorize carries
  `params.usageOrigin: "transcript"`.
- **Forked subagents.** A forked subagent's transcript begins with a copy of its
  ancestor's entries — the same response ids — so the plugin posts each response
  id from ONE agent only: the first agent to claim it (a file per id under
  `$UT_CC_STATE_DIR/transcripts/claims`). The fork's own responses are its own;
  what it inherited was posted by the agent that made it — or, if the fork got
  there first, by the fork, never by both.
- **Attribution.** A transcript authorize's actor is
  `claude-code:<session>:<agentType>:<agentId>` (`main:main` for the parent), with
  `agent_id` / `agent_type` in its params. On a server that records a `principal`,
  every transcript-mode authorize also carries `{ id: <agentId>, type:
  <agentType>, origin: "claude-code:<session>" }`, which the server writes onto
  every record the hold leaves and onto its receipt. An older server keeps the
  attribution request-side only.
- **Exactly once, on a server that honours idempotency keys.** Every authorize
  that carries responses goes in under the VEHICLE KEY of exactly those responses
  (`cc:` + 48 hex, a hash of the session, the agent and the sorted response ids —
  the ids themselves never leave the machine), and the server charges a key at
  most once. A settle whose outcome is unknown — a 5xx, no answer, a `404` after a
  server restart, a receipt that says `settled: false`, a hook that died mid-settle
  — leaves its responses UNRESOLVED: the next Stop/SubagentStop retries them as
  the same vehicle (same key, same responses, same counts). The server answers
  `409 already_settled` if the first settle landed, or charges them now; it never
  charges them twice. An unresolved vehicle is never folded into a new window, and
  waits for a server that honours keys rather than be retried without one. A
  remainder is parked this way before its call, so a hook killed mid-call leaves
  it to be retried too. A `dryRun` server does not claim keys (it has no ledger to
  anchor them), so against one the plugin keeps the at-most-once rule below.
- **At most once, otherwise.** Per (session, agent) a cursor records which
  response ids are assigned, accounted or denied. An id is claimed before anything
  could post it and released only when the server proved nothing was posted (the
  authorize failed, or the settle answered 400 — or 404, without a key). Without a
  key, a settle that answers 5xx or not at all may have posted, so its ids stay
  claimed and the hold is given back for hygiene: an outage can lose usage, but
  never post it twice. A cursor that exists but cannot be read is never treated as
  empty — transcript usage is not posted until it is fixed or removed. Removing it
  never posts anything twice: the agent's claims still say which responses it took
  on, and those are not posted again — any of them it had not yet posted
  (including unresolved settles) is written off, with a note.
- **What the server honours** is read from its unauthenticated `/v1/health`
  `capabilities` once per hook, and never cached on disk: an older server strips
  request fields it does not know, so it would accept a key and silently ignore
  it. When the read fails, nothing is assumed either way: no key or principal is
  sent, and a hold is still released — falling back to abort only on a server
  that has no release route — with a note on stderr. **No released
  usertrust-server publishes these capabilities yet:** until one does, the plugin
  runs the at-most-once path above — it never posts usage twice, and a settle lost
  to an outage can go unrecorded.
- **Denied usage.** If the remainder's authorize is refused (402 budget, 403
  policy, 429 anomaly), those responses are marked `denied` and never retried, and
  a stderr note gives the token counts that could not be recorded.
- **Sticky estimate mode.** If an agent's transcript cannot be read at any hook,
  that agent switches to the per-call estimate for the rest of the session —
  settled as `usageSource: "estimated"`, with a stderr note giving the reason — and
  its transcript is never read again, so no usage is ever counted both as an
  estimate and as real. `UT_CC_USAGE=estimate` does the same for every agent.
- **Private, durable state.** Cursors and claims live in
  `$UT_CC_STATE_DIR/transcripts/`, created `0700`; if that directory is not a real
  directory owned by you without group or other write access, transcript
  accounting is off for that run and holds settle at the estimate. The default is
  `~/.claude/usertrust-cc` (`$CLAUDE_CONFIG_DIR/usertrust-cc` when that is set),
  beside Claude Code's own transcripts — not a temp dir, which the OS may purge:
  **deleting the state dir while transcripts remain re-posts their usage.** A
  message whose claim cannot be made is not posted, and a stderr note says so.
- **Hook time budget.** Each hook gives up after about 10 seconds (the hooks'
  timeout is 15): its calls never run past that, claiming new responses stops
  early enough to leave them time, and Stop keeps time back to give back holds;
  whatever a hook could not reach is posted at the next settle point.
- **Content.** Transcripts are read locally and only token counts, model names and
  agent ids/types are sent to your server — never transcript content.

**Declared costs.** On a server without `/v1/release`, every hold is settled, so a
tool call with an empty window costs that server's 1-unit settle floor: a
deliberate over-count of at most one unit per extra parallel tool call, never an
under-count. Responses of a second model cost one extra authorize→settle at the
next Stop. On an older server, attribution is request-side only and an outage can
lose usage, as above.

**Live totals.** The plugin settles at tool boundaries and at Stop. For a live
running total, Claude Code's own OpenTelemetry metrics are the source; a collector
for them is a separate piece, not part of this plugin.

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
