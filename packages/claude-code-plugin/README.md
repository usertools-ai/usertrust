# usertrust-claude-code

Ledger-backed governance for Claude Code: every tool call gets a two-phase spend
authorization against a [usertrust-server](../server) you host, and the session's
REAL token usage — per model, per subagent — is settled from Claude Code's own
transcripts. PreToolUse reserves a hold that covers the usage recorded since the
last one plus the upcoming tool, PostToolUse settles that hold at the real counts,
and Stop/SubagentStop — and SessionEnd, when the session ends — post
whatever no hold carried and terminate anything left hanging. Nothing is routed
through usertrust: it only reads what Claude Code already recorded.

**Watch-only by default.** Installed, the plugin never blocks a tool call. A call
the server refuses (over budget, denied by policy, or cut off as an anomaly) is
written down as one that would have been blocked, and a call that could not be
metered (the server is unreachable, say) as a gap. Set `UT_CC_MODE=enforce` to
block — see [Modes](#modes-watch-only-by-default). **In no mode does it approve a
call:** it can only deny, so Claude Code's own permission settings decide every
call it lets through, exactly as they would without it.

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

4. Start Claude Code. Each session opens with a line naming the mode, for example
   `usertrust: watch-only — nothing is blocked. …`. To block over-budget tool
   calls instead, also `export UT_CC_MODE=enforce` before launching it — after
   watching for a while first: see [From watching to enforcing](#from-watching-to-enforcing).

## Environment variables

| Variable             | Default                  | Meaning                                          |
| -------------------- | ------------------------ | ------------------------------------------------ |
| `UT_SERVER_URL`      | `http://127.0.0.1:4519`  | Base URL of your usertrust-server                |
| `UT_SERVER_KEY`      | (empty)                  | Tenant bearer key                                |
| `UT_CC_MODE`         | `watch`                  | `enforce` (matched case-insensitively) blocks over-budget calls; any other value is watch-only (see [Modes](#modes-watch-only-by-default)) |
| `UT_CC_UNIT`         | unset                    | The principal's `unit`, e.g. `platform` (see *Attribution*) |
| `UT_CC_ROLE`         | unset                    | The principal's `role`, e.g. `release-engineer` (see *Attribution*) |
| `UT_CC_MODEL`        | `claude-sonnet-4-6`      | Model for an estimate hold before any transcript model is known |
| `UT_CC_USAGE`        | `transcript`             | `estimate` settles per-call estimates only       |
| `UT_CC_STATE_DIR`    | `~/.claude/usertrust-cc` | Pending holds, and what was already posted (keep it; see below) |
| `UT_CC_SEND_CONTENT` | `1`                      | `0` sends `{"redacted":true}` instead of content |
| `UT_FAIL_OPEN`       | unset                    | Enforce mode only: `1` lets tool calls through when governance is down |

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
  hold being authorized. The hold is sized to cover them PLUS the usual tool
  estimate, so the budget check before the call still covers the call — and never
  below their real cost, which would cap what the settle can post. On a server
  that publishes `authorize-cache-tiers`, each cache tier is estimated apart and
  held at its own rate, as settle prices it. On any other, the counts go in as one
  sum, held at the server's higher input/cache-write rate: never under the real
  cost, but well over it for a window heavy in cache reads (below). PostToolUse
  then SETTLES that hold, exactly once, at the window's real counts — on the
  normal path no hold is ever aborted. A call that does not complete, and one
  that is deferred and then resumed, leave that path: see the known limitation
  and the note on deferred calls in [Modes](#modes-watch-only-by-default). A tool call whose
  window is empty (a parallel call in the same response, say) is given back
  (below).
- **The remainder.** What no hold carried — another model's responses, a final
  answer with no tool call — is posted at SubagentStop (that subagent) and Stop
  (the parent and every subagent, so one whose SubagentStop never fired is still
  accounted), one authorize→settle per model. Before that, Stop SETTLES a leftover
  hold that has usage assigned (its tool was interrupted, but the model turn was
  billed); after it, Stop gives back the holds that have none.
- **The final answer.** Claude Code writes the transcript asynchronously, so at
  Stop the turn's final response may not be in it yet — and after the last turn
  no later hook would ever post it. So Stop and SubagentStop first wait, at most
  about 2 seconds, until the transcript holds the response their input names
  (`last_assistant_message`), and say so on stderr when they give up; SessionEnd
  then scans once more. Every post goes through the same claims, so what Stop
  posted is never posted again. A response that reaches the transcript only after
  that wait is not posted in a session that never fires SessionEnd (a crash, a
  kill), or whose SessionEnd runs out of its budget first (below).
- **SessionEnd has 1.5 seconds.** Claude Code gives SessionEnd hooks a 1.5 s
  budget by default, and a plugin's own hook `timeout` does not raise it
  ([hooks reference](https://code.claude.com/docs/en/hooks#sessionend)). The
  plugin sizes SessionEnd's work to that budget — its calls, its claims, and its
  wait for a Stop still holding an agent's lock (a fifth of the budget) — and
  gives up cleanly instead of being killed mid-write. Against a slow server it may
  post nothing, and a final answer that Stop could not find then goes unposted:
  an under-count, never a double charge. `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`
  (milliseconds) raises the budget, and the plugin uses up to 10 s of it. The
  `timeout` in hooks.json does not raise the budget: it bounds the hook once the
  variable has (before Claude Code v2.1.268, a hook without its own timeout kept
  1.5 s even then).
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
- **The model, exactly as written.** The authorize names the response's model id
  verbatim (`llama3.3:70b`, `claude-sonnet-4@20250514`), because the server prices
  it by exact lookup — your `customRates` included. A response first written as
  Claude Code's `<synthetic>` placeholder is priced as the model a later entry of
  it names. An id that is not printable text (control or format characters,
  spaces, over 256 characters) is sent as `unknown`, never rewritten into another.
- **Forked subagents.** A forked subagent's transcript begins with a copy of its
  ancestor's entries — the same response ids — so the plugin posts each response
  id from ONE agent only: the first agent to claim it (a file per id under
  `$UT_CC_STATE_DIR/transcripts/claims`). The fork's own responses are its own;
  what it inherited was posted by the agent that made it — or, if the fork got
  there first, by the fork, never by both.
- **Attribution.** A transcript authorize's actor is
  `claude-code:<session>:<agentType>:<agentId>` (`main:main` for the parent), with
  `agent_id` / `agent_type` in its params. On a server that records a `principal`,
  every authorize also carries `{ id: <agentId>, type: <agentType>, origin:
  "claude-code:<session>" }`, which the server records on every audit record the
  call leaves (and, ledger-backed, as tags on its transfers); it is not echoed in
  the settle response. On the estimate path, where no transcript is read, the
  principal has the same shape, its `type` being `main` for the parent, else the
  hook's `agent_type`, else `subagent`. An older server keeps the attribution
  request-side only. The principal also carries `unit` and `role` from
  `UT_CC_UNIT` / `UT_CC_ROLE` — on PreToolUse's authorize and on every
  remainder's, at Stop, SubagentStop and SessionEnd — when each is a valid
  principal field: 1 to 128
  characters of `A-Z a-z 0-9 . _ : -` (so `release-engineer`, not `release
  engineer`). A value that is empty or invalid is left out, with a note on
  stderr, and never sent: a strict server refuses the whole authorize over one
  bad field. Where no principal is sent (that older server), neither is.
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
- **At most once, otherwise.** Every way a response can be posted — a tool call's
  hold, the remainder — takes its responses from ONE function, which posts a
  response only under a claim it has just made (or that this cursor recorded
  making). A claim that already exists is never posted again, whoever made it:
  another agent, this agent under a cursor since removed or reset, or a hook that
  died between claiming and saving. Nothing about such a claim says whether it was
  posted, so the worst a lost record does is under-count, with a note. Per
  (session, agent) a cursor records which response ids are bound to a hold or a
  remainder, accounted or denied — bound BEFORE any call that could post them. A
  binding whose outcome was never recorded (a hook killed just after its settle
  went out, or just before) may have posted, so its responses are never posted
  again: charged once, or not at all. An id is released only when the server
  proved nothing was posted (the authorize failed, or the settle answered 400 — or
  404, without a key). Without a
  key, a settle that answers 5xx or not at all may have posted, so its ids stay
  claimed and the hold is given back for hygiene: an outage can lose usage, but
  never post it twice. A cursor that exists but cannot be read is never treated as
  empty — transcript usage is not posted until it is fixed or removed, and tool
  holds are given back meanwhile, not settled at the estimate. Removing it never
  posts anything twice: the agent's claims still stand.
- **What the server honours** is read from its unauthenticated `/v1/health`
  `capabilities` once per hook, and never cached on disk: an older server strips
  request fields it does not know, so it would accept a key and silently ignore
  it. When the read fails, nothing is assumed either way: no key or principal is
  sent, and a hold is still released — falling back to abort only on a server
  that has no release route — with a note on stderr. **Today's usertrust-server
  publishes `principal` and `authorize-cache-tiers`, but not `idempotency-key`:**
  until one publishes it, the plugin runs the at-most-once path above — it never
  posts usage twice, and a settle lost to an outage can go unrecorded.
- **Denied usage.** If the remainder's authorize is refused (402 budget, 403
  policy, 429 anomaly), those responses are marked `denied` and never retried, and
  a stderr note gives the token counts that could not be recorded.
- **Sticky estimate mode.** If an agent's transcript cannot be read at any hook,
  or a hook names no `transcript_path`, that agent switches to the per-call
  estimate for the rest of the session — settled as `usageSource: "estimated"`,
  with a stderr note giving the reason — and its transcript is never posted
  again, so no usage is ever counted both as an estimate and as real. The switch
  is recorded OUTSIDE the agent's cursor (`$UT_CC_STATE_DIR/transcripts/estimate/`)
  before any estimate is settled, so losing the cursor cannot undo it; if it
  cannot be recorded, the hold is given back instead. `UT_CC_USAGE=estimate` uses
  the estimate for every agent, and records that the same way, so a session
  resumed without it posts nothing it already settled at the estimate. A subagent
  inherits the estimate mode of any agent of its session: a forked subagent's
  transcript begins with a copy of its ancestor's responses, which an agent in
  estimate mode never claims, and which agent a fork copied is recorded nowhere. A
  hold is settled at the estimate ONLY in these cases: when the plugin's own state
  is unusable for now, the hold is given back, because the transcript still holds
  that usage.
- **Private, durable state.** Cursors, claims and estimate-mode records live in
  `$UT_CC_STATE_DIR/transcripts/`, created `0700`; if that directory is not a real
  directory owned by you without group or other write access, transcript
  accounting waits: nothing is posted, and holds are given back rather than
  settled at the estimate — the first settle point that can use the directory
  posts that usage, once. The default is
  `~/.claude/usertrust-cc` (`$CLAUDE_CONFIG_DIR/usertrust-cc` when that is set),
  beside Claude Code's own transcripts — not a temp dir, which the OS may purge.
  The state records when it was first made (`transcripts/since`), and a transcript
  entry written before that is never posted: a session resumed after upgrading
  from the estimate-only plugin, or after the state dir was deleted, does not post
  its history again (entries carry Claude Code's timestamp; one without a
  timestamp counts as after it). After a host crash or power loss (not a process
  crash), usage posted in the moments before it can be posted again, because the
  plugin's state files are not fsynced. Idempotency keys on the server (#205) are
  the fix. **Restoring an older copy of the state dir can
  re-post what was posted after that copy was made.** The claim files are never
  pruned, and they are what keeps a message from being posted twice: one small
  file per response. A message whose claim cannot be made is not posted, and a
  stderr note says so.
- **Hook time budget.** Each hook gives up after about 10 seconds (the hooks'
  timeout is 15), SessionEnd after its own budget (above): its calls never run
  past that, claiming new responses stops early enough to leave them time, and
  Stop keeps time back to give back holds; whatever a hook could not reach is
  posted at the next settle point.
- **Bounded reads.** A transcript is read 1 MiB at a time, and one hook reads at
  most about 64 MiB of it — a long unread tail is read on by the next hooks. A
  line over 16 MiB is skipped unread, with a note (an entry with usage never comes
  near that size).
- **Content.** Transcripts are read locally and only token counts, model names and
  agent ids/types are sent to your server — never transcript content.

**Declared costs.** On a server without `/v1/release`, PostToolUse gives an empty
hold back by settling it at zero, so a tool call with an empty window costs that
server's 1-unit settle floor: a
deliberate over-count of at most one unit per extra parallel tool call (and per
tool call while the plugin's state is unusable), never an under-count.
Responses of a second model cost one extra authorize→settle at the
next Stop. On an older server, attribution is request-side only and an outage can
lose usage, as above. On a server without `authorize-cache-tiers`, a window's hold
reserves its cache reads at the cache-write rate (about 10x a typical window's
real input-side cost): near the budget that hold can be refused (402), and a
refused window is usage already spent, marked denied.

**Live totals.** The plugin settles at tool boundaries and at Stop. For a live
running total, Claude Code's own OpenTelemetry metrics are the source; a collector
for them is a separate piece, not part of this plugin.

**Trust.** Transcript mode prices files that the same OS user can edit.
usertrust governs cooperative agents on a machine you control; it is not a
sandbox against a process that wants to rewrite its own transcript.

## Modes: watch-only by default

`UT_CC_MODE` decides what PreToolUse — the one hook that can block — does with the
server's answer. Reservations, settlement and everything above work the same in
both modes.

| The server's answer at PreToolUse | watch (the default) | enforce (`UT_CC_MODE=enforce`) |
| --- | --- | --- |
| A reservation (200) | No decision: your permission settings apply | No decision |
| Refused: over budget (402), denied by policy (403), an anomaly cutoff (429) | No decision, and a `would_block` record | `deny`: the call is blocked |
| No usable answer: unreachable, a timeout, any other status, a malformed body | No decision, and a `gap` record | Blocked (exit 2). With `UT_FAIL_OPEN=1`: no decision, and a `gap` record |
| A shadow answer from an `evaluate_only` server | No decision | No decision |

**No decision** means PreToolUse exits 0 with nothing on stdout, which Claude
Code reads as "no decision": the call goes through its normal permission flow.
The plugin never answers `allow`, in either mode, because a hook's `allow` skips
the permission prompt
([PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control))
— a power a budget tool was never given. The only decision it ever makes is
`deny`. What it would have said goes to stderr, which Claude Code keeps in its
[debug log](https://code.claude.com/docs/en/hooks#debug-hooks). **Upgrading from
v1.3.0 or earlier:** those releases answered `allow` on every call they let
through, so nearly every call no permission rule covers ran without the prompt
Claude Code would otherwise show (deny and ask rules still applied); you will now
see those prompts.

**Watch** never blocks a tool call, and `UT_FAIL_OPEN` has no effect in it. Watch
changes what the plugin decides, not what the server records: past the budget the
server still refuses to authorize, so that usage is not on the ledger (the
remainder posted at Stop is refused too — see *Denied usage* above), and the
`would_block` records are where it shows.

**Enforce** blocks, as earlier releases did by default. A budget (402), policy
(403) or anomaly (429) refusal blocks the call, whatever `UT_FAIL_OPEN` says: it is
a decision, not an outage. If the server cannot
answer usably, the hook exits 2 and the call is **blocked** — unless
`UT_FAIL_OPEN=1`: then the call proceeds (no decision, and a "proceeding
ungoverned" reason in the debug log), and the miss is written down as a `gap`
record. `UT_FAIL_OPEN=1` suits interactive sessions where availability matters
more than enforcement — a stopped server then never blocks your session, and the
usage it misses stays in the transcript to be posted at a later settle point.
Leave it unset when the budget must be enforced. Upgrading from a release where
blocking was the default: set `UT_CC_MODE=enforce` to keep it.

**Known limitation: a call that does not complete keeps its reservation for a
while.** PostToolUse, the hook that closes a call's hold,
[runs only after a tool completes successfully](https://code.claude.com/docs/en/hooks#posttooluse),
and the plugin registers no other hook that sees the call end. That leaves:
- a call that fails, which Claude Code reports through
  [PostToolUseFailure](https://code.claude.com/docs/en/hooks#posttoolusefailure).
  That covers most commands that exit non-zero: exit 1 is a result, not a
  failure, only for `grep`, `rg`, `egrep`, `fgrep`, `find`, `diff`, `test`, `[`,
  `git diff` and `git grep` ([tools reference](https://code.claude.com/docs/en/tools-reference));
- a call you reject at the permission prompt;
- a call a permission rule, another hook or auto mode denies.

Each keeps its hold pending until a later Stop, SubagentStop or SessionEnd gives
it back (settling it at its real counts if it carries transcript usage). At the
latest, the server's pending-hold TTL voids it (`pendingTtlMs`, 300 000 ms by
default). Stop may not run at the end of that very turn: it does not run after a
user interrupt. Until then the hold counts against the budget: in enforce mode,
near the budget, a later call can be refused (402) although the budget would
cover it. In watch mode nothing is blocked; this only adds `would_block` records.
Nothing is charged twice, and in estimate mode such a call's estimate is never
charged. A fix for failed calls is tracked in
[#234](https://github.com/usertools-ai/usertrust/issues/234) (item 9). A call
auto mode denies fires
[PermissionDenied](https://code.claude.com/docs/en/hooks#permissiondenied), whose
input names the call's `tool_use_id`, but the plugin does not register it yet;
the same item notes that registering it would cover auto mode's denials, and
nothing else. A call you reject at the prompt, or one a permission rule or
another hook denies, fires none of PostToolUse, PostToolUseFailure and
PermissionDenied.

**Known limitation: on today's server, giving holds back can briefly fail every
call.** The usertrust-server has no release route, so the plugin gives a hold
back by aborting it in two places: leftover holds at Stop, SubagentStop and
SessionEnd, and the cleanups after a failure (an unanswered transcript settle, a
hold record that could not be written). The server counts each abort as a failure.
Five in a row (its circuit breaker's default) open the breaker. That happens when
a Stop gives back five or more leftover holds, and also when five holds expire
together and the server's own TTL sweep aborts them, about five minutes later. The
tenant's authorizations then fail (500) for at least a minute after the last
abort. After that minute they are let through again, and two successful settles
close the breaker. Meanwhile each call is a `gap` in watch mode, and in enforce
mode it is blocked unless `UT_FAIL_OPEN=1`.
Tracked in [#238](https://github.com/usertools-ai/usertrust/issues/238).

**A tool call that is deferred and then resumed keeps one hold.** In a
`claude -p` run, another PreToolUse hook can
[defer a tool call](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)
(this plugin never does, and interactive sessions ignore `defer`). The call does
not run, so it keeps its hold like a call that does not complete (above). When
the session is resumed (`claude -p --resume`), the same call fires PreToolUse
again, and the plugin finds the hold the call already has.
- **It never reuses that hold.** It ends the hold, then reserves afresh, so the
  budget is checked at every resume: one more authorize per resume. Whether a held
  reservation is still live, and still this server's and key's, cannot be known
  from the record, so the plugin does not rely on it.
  - A hold carrying transcript usage is settled once, at its counts.
  - Any other hold is given back only through a `release` the server advertises,
    and never aborted. On a server without `release`, it counts against the budget
    until the server's pending-hold sweep voids it: a call can be refused early,
    never overspend.
- **An unresolved hold refuses the call.** A hook can be killed while settling
  that hold, leaving its `.settling` record; or another hook can be ending it at
  that moment. The resumed call is then refused until that resolves: in enforce
  mode it is denied, whatever `UT_FAIL_OPEN` says, and in watch mode it is
  recorded as a gap. A stale record that carries transcript usage is decided by
  the journal first, and the call then reserves afresh.

In both modes PostToolUse/Stop/SubagentStop never block — the tool already ran;
an estimate hold is marked settle-attempted (`.settling`) before its one settle,
and one whose settle goes unanswered is given back at Stop — never settled again —
and the server's pending-TTL sweep voids anything orphaned. A call can wait at Claude
Code's permission prompt for longer than the server keeps a hold (five minutes).
A transcript hold whose settle then answers 404 gives its window back to a later
settle point. An estimate hold is charged once, on a fresh hold of its own — but
only on a clean 404 `unknown transferId` to its one settle. The plugin settles
each transferId at most once, so that 404 means the hold is gone unposted. A
timeout, no answer, a 5xx or `settled: false` may have posted, and is never
re-authorized. Neither is a 404 to a hold an earlier release recorded (its file
has no `gate` mark): that release kept a hold whose settle went unanswered, so
the hold may have been charged already. Such a hold is only given back at Stop,
and a host that sends no tool_use_id never pairs a call with it. A call denied
at the prompt never reaches PostToolUse: nothing is charged for it, and its hold
waits for a later settle point or the TTL sweep (see the known limitation
above). If the server runs in `evaluate_only` mode, denials
come back as shadow responses: nothing is reserved or settled for them, and the
would_deny reason goes to the debug log.

**Nothing a hook writes can drive your terminal.** Every line the plugin writes to
stderr (Claude Code's debug log) and the session-start message go through one
writer that replaces control characters (C0, DEL, C1) before it clips. That
covers server answers, transcript ids, your paths and error text alike, and a
test fails on any hook that writes around it.

**The mode is announced.** At every session start, including a resume, `/clear`
and a compaction, the plugin shows you which mode it runs in as a hook
`systemMessage`, the field Claude Code shows to the user. For example:

```
usertrust: watch-only — nothing is blocked. Calls that would have been blocked, and calls that could not be metered, are recorded in /Users/you/.claude/usertrust-cc/watch.jsonl. Set UT_CC_MODE=enforce to block over-budget calls.
```

A `UT_CC_MODE` value that is not a mode (`enforcing`, say) runs watch-only, and the
announcement names it, so a typo never looks like enforcement.

**The records** go to `watch.jsonl` in the state dir (`$UT_CC_STATE_DIR`, by
default `~/.claude/usertrust-cc`), one JSON object per line, appended and never
trimmed:

```json
{"at":"2026-10-06T10:00:00.000Z","kind":"would_block","session":"<session id>","agent":"main","tool":"Bash","status":402,"error":"budget_exceeded","reason":"<the server's reason>"}
{"at":"2026-10-06T10:00:05.000Z","kind":"gap","mode":"watch","session":"<session id>","agent":"main","tool":"Bash","reason":"fetch failed"}
```

`agent` is the subagent's id (`main` for the parent), and a `would_block`'s
`status` is the refusal's: 402, 403 or 429. A `gap` written in enforce
mode (only with `UT_FAIL_OPEN=1`) says `"mode":"enforce"`. In transcript mode a gap
loses no usage by itself: the responses the hold would have carried stay in the
transcript to be posted at a later settle point. In estimate mode
(`UT_CC_USAGE=estimate`) the call's estimate is not recorded. A record that cannot
be written goes to stderr instead, and the call proceeds either way. Nothing reads
the file back, so deleting it is safe — unlike the rest of the state dir.

## From watching to enforcing

Enforcement is opt-in. Turn it on in three steps, so the first thing a
misconfigured setup does is write a record, not stop your session.

1. **Install and watch.** Install the plugin, point it at your server (see the
   [Quickstart](#quickstart-against-usertrust-server)), and leave `UT_CC_MODE`
   unset. The plugin authorizes tool calls against your server and settles their
   usage, but blocks nothing, and each session opens with `usertrust: watch-only —
   nothing is blocked. …`. Keep the server's `enforcement` at its default, `enforce`: its
   refusals are what show you which calls would be blocked. A server in
   `evaluate_only` answers a refusal as a shadow answer, and the plugin writes
   that to the debug log only.
2. **Observe.** Work as usual, then read `watch.jsonl` in the state dir
   (`~/.claude/usertrust-cc/watch.jsonl` by default; see [Modes](#modes-watch-only-by-default)):
   - A `would_block` record is a call enforcement would have blocked: over budget
     (402), denied by policy (403) or an anomaly cutoff (429). These should be the
     calls you mean to stop. If they are not, fix the budget or the policy first.
   - A `gap` record is a call the plugin could not meter: the server was
     unreachable, timed out or answered something unusable. **In enforce mode
     each of these blocks the call**, unless `UT_FAIL_OPEN=1`. Make the gaps go
     away, or understand them, before you enforce.

   For example: `grep '"kind":"gap"' ~/.claude/usertrust-cc/watch.jsonl`.
3. **Enforce.** `export UT_CC_MODE=enforce` before launching Claude Code. The
   session-start message now begins `usertrust: ENFORCING`. Over-budget, policy
   and anomaly refusals are blocked. Then decide what an outage does:
   - `UT_FAIL_OPEN` unset: while the server cannot answer, every tool call is
     blocked. Use this where the budget must hold.
   - `UT_FAIL_OPEN=1`: while the server cannot answer, calls proceed unmetered,
     and each is recorded as a `gap`. Use this where availability matters more.

   Before enforcing near a tight budget, read the known limitations and the
   known issue in [Modes](#modes-watch-only-by-default).

To go back to watching, unset `UT_CC_MODE` (`enforce` is matched
case-insensitively; any other value runs watch-only) and relaunch Claude Code.

## Content flow and audit

PreToolUse sends the stringified `tool_input` (truncated at 16 KiB) to your
**self-hosted** server as message content so the core PII policy can scan it.
It never goes to any third party. Set `UT_CC_SEND_CONTENT=0` to send
`{"redacted":true}` instead — size-based cost estimation still uses the real
input length, so budgets stay accurate. The usertrust audit chain stores
content hashes, never raw bodies; raw tool input exists only in transit to
your server and is not persisted by governance.
