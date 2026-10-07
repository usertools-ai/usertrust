# Changelog: usertrust-claude-code

The Claude Code plugin's own changes. It is installed from this repository's
plugin marketplace (`/plugin marketplace add usertools-ai/usertrust`), not from
npm, and its version is its own: the `usertrust` packages and their
[changelog](../../CHANGELOG.md) are versioned separately.

## [1.4.0] - 2026-10-07

### Security

- **The plugin no longer grants permission. Upgrade from 1.3.0.** In 1.3.0, the
  PreToolUse hook answered `allow` for every call it let through: a call within
  the budget, a shadow answer from an `evaluate_only` server, and, with
  `UT_FAIL_OPEN=1`, a call whose authorization failed (the server unreachable, a
  429, any other unusable answer). A hook's `allow` skips the permission prompt
  Claude Code would otherwise show (your deny and ask rules still apply), so with
  1.3.0 installed, nearly every call no permission rule covers ran without asking
  you.
  In 1.4.0 the plugin never answers `allow`. In enforce mode it denies a refused
  call (402, 403 or 429) and blocks a call it could not authorize (unless
  `UT_FAIL_OPEN=1`); every other call gets no decision and goes through your own
  permission settings, as it would without the plugin. Watch mode, the new
  default, never decides at all. After upgrading you will see the permission
  prompts 1.3.0 was skipping.
- **Nothing the plugin writes can drive your terminal.** Every line it writes to
  stderr (Claude Code's debug log) and its session-start message pass through one
  writer that replaces control characters (C0, DEL and C1) before clipping:
  server answers, transcript ids, paths and error text alike.

### Changed

- **Watch-only by default.** Installed, the plugin never blocks a tool call. A
  call the server refuses (over budget, 402; denied by policy, 403; an anomaly
  cutoff, 429) is recorded as `would_block`, and a call it could not meter as a
  `gap`, in `watch.jsonl` in the state dir. Each session opens with a message
  naming the mode. `UT_CC_MODE=enforce` opts in to blocking, which 1.3.0 did by
  default: set it to keep that behaviour. In enforce mode a 429 is now denied,
  whatever `UT_FAIL_OPEN` says; 1.3.0 treated it as an unusable answer. The
  README's new section *From watching to enforcing* walks through the switch.
- **Real usage, per model and per subagent, from Claude Code's transcripts.** The
  plugin settles the token usage Claude Code recorded for each API response
  (fresh input, cache read, cache write and output, under the response's own
  model), for the parent and every subagent. 1.3.0 settled each tool call at a
  size-based estimate priced at one fixed model.
  - A tool call's hold carries the new complete responses of one model, and
    PostToolUse settles it at their real counts. Stop, SubagentStop and SessionEnd
    post what no hold carried, such as a final answer with no tool call.
  - Each response is posted at most once, across agents and hooks: a forked
    subagent's copy of its parent's responses is not charged again, and a hook
    killed at any point never causes a second charge. The README lists the two
    exceptions: a host crash or power loss, and restoring an older copy of the
    state dir. A settle lost to an outage can go unrecorded, and so can the usage
    before a tool call that is deferred and then resumed (see Known issues): an
    under-count, never a double charge.
  - `UT_CC_USAGE=estimate` keeps 1.3.0's per-call estimates.
  - The state dir moves to `~/.claude/usertrust-cc` (`$CLAUDE_CONFIG_DIR/usertrust-cc`
    when that is set), from the temp dir 1.3.0 used, which the OS may purge.
    Unless `UT_CC_STATE_DIR` was set, holds 1.3.0 left pending in its temp dir
    are not carried over, and the server's pending-hold sweep voids any still
    pending. Transcript entries written before the plugin's state was first made
    are never posted, so upgrading does not post your history.
- **Who spent it.** On a server that publishes `principal` (today's
  usertrust-server does), every authorize now carries a principal whenever the
  hook can read the server's capabilities: the agent's id and type, with the
  session as its origin, plus an optional `unit` and `role` from `UT_CC_UNIT` and
  `UT_CC_ROLE`. 1.3.0 sent none.
- **Each estimate hold is settled at most once.** It is marked settle-attempted
  before its one settle, so a settle whose answer is lost is never sent again:
  that hold is given back at Stop. A hold an earlier release recorded carries no
  such mark and may have been charged already, so it is only given back at Stop,
  never paired with another call or charged again.
- **A call that outlives its hold is still charged, once.** The server voids a
  pending hold after five minutes by default, and a call can wait that long at
  the permission prompt; 1.3.0 then left that call unrecorded. In transcript mode
  the responses its hold carried now go to a later settle point (a call that is
  deferred and then resumed is the exception: see Known issues). In estimate
  mode, when the settle answers that the hold is gone (404 `unknown transferId`),
  PostToolUse now charges the call once on a fresh hold. Each request of that
  chain (the settle, the fresh authorize and the fresh settle) waits at most 5
  seconds and never past the hook's own time budget. A fresh hold whose record
  cannot be written (a full disk, say) is not left reserved until the server's
  pending-hold sweep: PostToolUse asks the server to release it at once, as
  PreToolUse now does on the same failure. If the server does not confirm the
  release, a note on stderr says so, and the sweep releases that hold.

### Known limitations

- **A call that does not complete keeps its reservation for a while.** No hook
  the plugin registers fires for a tool call that does not complete successfully
  after PreToolUse reserved for it: one that fails (most commands that exit
  non-zero), one you reject at the permission prompt, or one denied by a
  permission rule, another hook or auto mode. Its hold stays pending until a
  later Stop, SubagentStop or SessionEnd gives it back (settling it at its real
  counts if it carries transcript usage), and at most until the server's
  pending-hold TTL voids it (`pendingTtlMs`, 300 000 ms by default). Stop may not
  run at the end of that very turn: it does not run after a user interrupt. Until
  then the hold counts against the budget: in enforce mode, near the budget, a
  later call can be refused (402) although the budget would cover it. In watch
  mode nothing is blocked; this only adds `would_block` records. Nothing is
  charged twice, and in estimate mode (`UT_CC_USAGE=estimate`) such a call's
  estimate is never charged. A fix for failed calls is tracked in #234 (item 9).
  A call auto mode denies fires `PermissionDenied`, which the plugin does not
  register yet; item 9 notes that registering it would cover those denials. A
  call you reject at the prompt, or one a permission rule or another hook
  denies, fires none of PostToolUse, PostToolUseFailure and PermissionDenied.
- **On today's server, giving holds back can briefly fail every call.** The
  usertrust-server has no release route, so the plugin gives back by aborting:
  leftover holds at Stop, SubagentStop and SessionEnd, and the cleanups after a
  failure. PostToolUse gives an empty hold back by settling it at zero instead.
  The server counts each abort as a failure, and five in a row (its circuit
  breaker's default) open the breaker. That happens when a Stop gives back five
  or more leftover holds, and also when five holds expire together and the
  server's own TTL sweep aborts them, about five minutes later. The tenant's
  authorizations then fail (500) for at least a minute after the last abort.
  After that minute they are let through again, and two successful settles close
  the breaker. Meanwhile each call is a `gap` in watch mode, and in enforce mode
  it is blocked unless `UT_FAIL_OPEN=1`. Tracked in #238; see also #204 and #205.

### Known issues

- **A tool call that is deferred and then resumed is reserved twice.** In a
  `claude -p` run, another PreToolUse hook can defer a tool call (this plugin
  never does). When the session is resumed (`claude -p --resume`), the same call
  fires PreToolUse again, and the plugin reserves a second hold and overwrites
  its record of the first. The first hold can then stay pending until the
  server's pending-hold TTL voids it, and in transcript mode the usage it
  carried can go unrecorded, silently: an under-count, never a double charge.
  In estimate mode the call is still charged once, on the second hold. Each
  further deferral of the same call repeats this. Only flows that defer a tool
  call and resume it are affected. The fix is tracked in #234 (item 10).

## [1.3.0] - 2026-07-18

The plugin's first version in this repository: PreToolUse authorization against
a usertrust-server, PostToolUse settlement at a per-call estimate, and
Stop/SubagentStop cleanup. Its behaviour changed once more without a version
bump (2026-08-15): a hold's output leg was sized to the 16 KiB content cap and both
legs were priced at settle, and a call that names its `tool_use_id` stopped
settling another call's hold.
