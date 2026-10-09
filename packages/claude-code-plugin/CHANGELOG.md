# Changelog: usertrust-claude-code

The Claude Code plugin's own changes. It is installed from this repository's
plugin marketplace (`/plugin marketplace add usertools-ai/usertrust`), not from
npm, and its version is its own: the `usertrust` packages and their
[changelog](../../CHANGELOG.md) are versioned separately.

## [Unreleased]

### Added

- **Watch mode stops asking a server that has stopped answering: a breaker.** Three
  timeouts in a row within a minute open it for a minute, host-wide, one per server URL
  (`~/.local/state/usertrust/breaker/` under the passwd home). An answer counts only once
  its body is read, so a server that sends headers and then stalls trips it too. While it
  is open, every hook sends nothing and touches no window or cursor, and writes one
  `breaker-open` record naming the holds it leaves. The one hold it touches is an estimate
  hold PostToolUse skips: renamed `.settling`, as its call ran, so Stop gives it back as
  `call-ran`. Each record is `deferred` where a later settle point posts the usage, `gap`
  where nothing will (an estimate-mode call, SessionEnd). One hook probes after the minute
  and closes it or re-opens it. Enforce mode never reads or writes it.
- **Every settle, give-back and remainder that does not end cleanly writes a `gap`
  record**, with its `phase`, its `outcome` (`claimed`, `unresolved`, `released`,
  `deferred`, `failed` or `unknown`) and its hold's `transferId`, including PreToolUse's
  settle of a repeated or resumed call's earlier hold. A give-back the server answers with a
  404 `unknown transferId` writes no `release` gap: the hold is gone. Until now only
  PreToolUse wrote records, for its own calls; the rest went to stderr alone.
- **A failed health probe still sends the principal**, from a remembered answer under a
  day old, per server and key. Nothing else is ever taken from it: no idempotency key.

### Changed

- **A request that got no answer is `unknown`, unless it was never sent**: this hook's own
  timeout, or a connection dropped after sending, may still land. Only a refused connection
  or a spent budget is `failed`, as an error answer is, and a transcript settle refused before
  it was sent is `released`: it cannot have posted. The gap records say which.
- **An estimate settle answered `settled: false` is a `claimed` gap**, as a transcript hold's
  is: its charge may be missing.
- **SessionEnd, the last settle point, writes down what it cannot finish**: a `deferred`
  remainder gap for usage it leaves unposted, and its call's gap for a hold it has no time to
  give back. Its breaker probe takes at most a fifth of its budget.
- **`usertrust-job coverage` lists a breaker's deferral inside a job's interval as a known
  gap**, as it does a gap: the record cannot say whether the usage was posted later.

## [2.0.0] - 2026-10-08

### Breaking

- **A session that cannot keep its pin under the passwd home is refused; 1.4.1 ran
  it as usual.** Each session's settings are now pinned once, under the home the
  passwd database gives (see *Changed*), so that a setting changed mid-session can
  never charge the same usage twice. There is no other place to keep the pin that
  is safe from that, so a session that cannot keep it there sends nothing.
  - **Who this affects:** sessions configured through the environment (no
    `UT_CC_CONFIG`) where:
    - the user has no passwd entry (a container running as a uid with none, say), or
      the passwd lookup fails;
    - the passwd home does not exist;
    - `.local/state/usertrust` or its `sessions` directory under that home is a
      symlink, is not a directory, is owned by another user, or is writable by its
      group or others;
    - or the pin cannot be written there: a read-only home, or a filesystem without
      hard links.
  - **What they get now:** each hook sends nothing, in the session's own mode, and
    SessionStart says why. In enforce mode every tool call is blocked (with
    `failOpen`, each proceeds ungoverned, as a gap); in watch mode each is recorded
    as a gap. A lookup that fails for a moment refuses only the hooks that run
    meanwhile.
  - **To keep such a setup working:** run as a user with a passwd entry whose home
    exists, and let the plugin make its directories there (0700), or make them the
    user's own, real directories, writable by no one else.
- **A setting changed mid-session reaches new sessions only, and a key changed
  mid-session is refused.** 1.4.1 read the environment afresh at every hook, so a
  change Claude Code applied to a running session took effect at its next hook. Now
  a session keeps the settings of its first hook for its life, a resumed session
  included (see *Changed*): that is what stops a moved state dir from posting the
  same usage twice.
  - A new url, mode, state dir or any other setting applies from the next session.
  - An environment session's pin holds no key, so each hook still reads
    `UT_SERVER_KEY`, and one that changed mid-session is refused as
    `pin: key changed`. The hook sends nothing, in the session's pinned mode: in
    enforce mode every call is blocked (with `failOpen`, each proceeds as a gap), and
    in watch mode each is a gap. That lasts until the old key is back, or the session
    ends and a new one starts, so rotate a key between sessions.

### Added

- **Say which job a session is working on: `usertrust-job start <job-id>` / `stop`.** The job is recorded on every ledger record the session produces (`job`, plus `usageFrom` / `usageTo`, the window of USAGE the record covers), so one session that fixes five bugs can say what each cost. It needs a usertrust-server that lists `"job"` in `/v1/health` `capabilities`; against an older one nothing is sent and every body is what it was.
  - The job log is `<state>/jobs/<session_id>.jsonl`, written by the SessionStart hook (`session-start`, for a new session id only: `startup`, `clear`, `fork`; a `resume` or `compact` writes nothing, so neither ends an open job) and by the CLI. There is no lock: every write is ONE complete line appended with ONE O_APPEND write (atomic on a local filesystem), and the order of a log is the position of its lines, not their clock. The reader is the authority: a partial line followed by more lines, or a torn last line, makes the log invalid (a known gap), and nothing ever repairs or truncates it. The CLI refuses, writing nothing, unless the log already exists with that `session-start`: it waits up to 10 s for the background SessionStart to land.
  - A call's job is the one open when it was made, and a transcript message's job is the one open at the message's own time, so the call that runs `start job-b` still bills the previous job, and a remainder that spans a switch settles once per job. A per-call hold takes only messages that happened under its own job; the rest go to a remainder under theirs.
  - An unreadable or inconsistent log is recorded as `jobState: "invalid"`, never guessed. The job is per session: a subagent shares its parent's job.
  - `usertrust-job coverage <job-id> --vault <.usertrust dir>` prints the job's tagged cost and its `knownGaps`: named reasons the figure may be incomplete, each with its evidence. It is a diagnostic, not a certification; an empty list does not mean the figure is complete (still-running job, a record outside the job's intervals, a call that cannot be placed, a denied request, a `would_block` or unmetered `gap`, a transfer known only through settlement metadata, a released hold whose usage is unconfirmed, an unparseable evidence line, a session without a usable log).
  - A hold given back after its call ran (an unanswered settle left `.settling`, or a call that never reached PostToolUse) is written to `watch.jsonl` as a `gap` ("ran, charge unconfirmed") and released with a structured `releaseClass`, so a hold given back with no usage ahead of it (`unused`) is told apart from one that was not.
  - A refused remainder of a job is also written to `watch.jsonl` as a `would_block` record naming the job and its tokens.

### Security

- **Settings from one file, which no environment variable can redirect.** Set
  `UT_CC_CONFIG` to a JSON file and the plugin reads every setting from it: the
  URL, the key, the mode and the rest (see the README's *Configuration file*).
  With `UT_CC_CONFIG` set, even empty, no `UT_*` variable is read. A project's
  settings can set environment variables for every hook, so one quiet line could
  otherwise send the tenant key to another server, switch the mode, turn content
  back on or move the state dir.
  - The file is accepted only inside `.config/usertrust/` under the user's home as
    the passwd database gives it (never `$HOME`), with no symlinked component, as
    a regular file the user owns with no group or other permission bits, and with
    every required field valid.
  - Any other file, or an empty `UT_CC_CONFIG`, runs the plugin watch-only and
    key-less: no request is sent, and each tool call is recorded as a `gap` with a
    fixed reason. It never falls back to the environment, and never enforces.
  - Nothing read from the file is echoed: a reason names only the plugin's own
    field names. A url with a user or password in it is refused: a request to it
    fails with an error that quotes the whole url.
  - Node and the C library can reroute or expose a request without any code: a
    proxy (`NODE_USE_ENV_PROXY`), a CA store (`NODE_EXTRA_CA_CERTS`,
    `SSL_CERT_FILE`, …), OpenSSL's config, or the resolver (`HOSTALIASES`,
    `LOCALDOMAIN`, `RES_OPTIONS`).
    - So a configured session's requests are sent by a child process the plugin
      starts with no node options, the working directory `/`, and nothing of the
      environment but Claude Code's `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`.
    - None of those variables, nor one no one has named yet, applies to it, so none
      is refused.
    - A child that finds anything else in its environment refuses to run. A server
      behind a private CA is not supported.
    - Configured sessions do not run on Windows yet: Windows adds `SYSTEMROOT`,
      `SYSTEMDRIVE` and `TEMP` to a child's environment, with the parent's values.
      There a configured session's hooks start no child, and say so: each call is
      a gap in watch mode, or blocked in enforce mode. A session configured through
      the environment is unaffected.
    - A hook whose child cannot start, or that fails in any other way, ends as an
      outage: PreToolUse in enforce mode blocks the call (unless `failOpen`), and
      every other case is a gap. It never exits 1, which Claude Code reads as a
      non-blocking error, letting the call run with no record.
  - This does not stop code from a project's settings: a hook, or a variable that
    loads code (`NODE_OPTIONS`, `PATH`), runs in the hook's own process and can
    read the file too. Without `UT_CC_CONFIG`, requests are sent as before.
- **A hold is ended only through the server and key that made it.** A session's
  settings are pinned (see *Changed*), but a pin deleted mid-session is made again
  from the settings then current, so the server or key can still change between
  the hook that made a hold and the one that ends it. PostToolUse, Stop, SubagentStop and SessionEnd now treat
  such a hold as 1.4.1's resumed PreToolUse does: its record is dropped, nothing
  about it is sent to the new server, and any usage it carried goes unrecorded.
  Ended through the new server, it answered 404 there, and the estimate path then
  charged the call to the new tenant on a fresh hold. An unresolved settle parked
  under one server and key is likewise never retried under another: there, under
  a key that server never saw, it could charge again what the first already did.
  Every such drop first writes a gap to `watch.jsonl`, stating when its call began,
  except a claim that only ends a deferred call's hold, whose call never ran. A
  stale `.settling` record that 1.4.1's resumed PreToolUse abandoned left no gap. A
  record without a binding (from before 1.4.1) is ended as it always was.
- **Hold files are created `0600`**, as every other file in the state dir already
  was. They were `0644`, readable by other users when the state dir allows it.

### Changed

- **A session reads its settings once, at its first hook, and keeps them for its
  life, a resumed session included.** This applies to the config file and the
  environment alike, and an edit applies to new sessions, a key rotation included.
  - They are kept in a pin under the passwd home:
    `.local/state/usertrust/sessions/<session id>.json`, 0600, in directories
    checked as the config anchor is. There is no other place: a session whose passwd
    home cannot hold its pin is refused (see *Breaking*). A pin is made only once a
    read of its name finds nothing there; one that is there but cannot be read
    refuses the hook.
  - An environment session's pin holds the key's hash, never the key. A key changed
    mid-session is refused for that hook: it sends nothing, and records a gap.
  - A pin unused for 30 days is removed when a session starts; that session, if
    resumed at or after the removal, is pinned again from the settings then current.
  - A pin that cannot be used runs the hook key-less: it sends nothing, in the
    session's own mode. An enforce session blocks every call (with `failOpen`, lets
    each through as a gap), and never silently stops enforcing. When the failure
    follows the hook's own read of the settings (a pin that could not be written),
    the mode is that read's: a config file read again could be caught mid-save, and
    name none. Only a refused config file, whose mode is unknown, runs watch-only.
  - Every hook now starts through `hooks/launch.mjs`.
  - `usertrust-job` reads a session's settings from the same pin, so `start` and
    `stop` write to the job log the session's hooks read, whatever the state dir
    says now.

### Fixed

- **A session whose state dir changed mid-session no longer charges usage twice,
  nor loses its holds.**
  - The record of what was already posted lives in the state dir.
  - Moved to a state dir that already existed (another session's, or its own
    earlier one), a session posted at its next Stop transcript usage it had already
    settled, and no key or ledger id caught it.
  - Its holds stayed in the old dir, never settled, and with no gap.
  - Claude Code applies a settings `env` change to a running session, so this
    happened with `UT_CC_STATE_DIR` as well as with a config file.

- **A server url with a trailing `/`, a query or a fragment reaches the server.**
  Requests were built from the url's text, so `http://host:4519/` sent
  `//v1/authorize`, and a query put the route inside the query. The server matches
  each route exactly and answered 404: in watch mode every call went unmetered, each
  recorded as a gap, and in enforce mode every call was blocked (or, with
  `failOpen`, went ungoverned). Requests now go to the url's origin and path, for
  `UT_SERVER_URL` and a config file's `url` alike. A hold still records the url as
  written, so one recorded under any spelling is ended as before.

- **A 1-hour cache write is priced at the 1-hour rate.** Anthropic bills a 1-hour
  cache write at twice the base input rate and a 5-minute one at 1.25 times it. The
  plugin sent only the write total, so the server priced every write at the 5-minute
  rate, and a 1-hour write was under-priced by 37.5%.
  - The transcript parser reads the 1-hour share
    (`cache_creation.ephemeral_1h_input_tokens`), and a transcript settle carries
    it as `cacheWrite1hTokens`, a subset of `cacheWriteTokens`, beside the total.
    When a message's breakdown names only one TTL, the write it leaves unattributed
    counts as 1-hour, the dearer rate.
  - The share goes only to a server that lists `cache-write-1h` in `/v1/health`
    `capabilities`. An older server would strip the key and bill the share at the
    5-minute rate, so it gets the total alone, as before.
  - While the server's capabilities are unknown (its health probe failed, and
    failed again when retried), a settle that carries a 1-hour share waits for a
    later settle point, rather than bill the share at the 5-minute rate for good. A
    pending hold stays as it is, and a remainder stays unposted.

### Known issues

- **Configured sessions do not run on Windows yet** (see *Security*). A session
  configured through the environment is unaffected.
- **What an older version left behind carries no server or key:** a hold record
  written before 1.4.1, and a settle that 1.4.1 or earlier left unresolved.
  Outside a resumed call, such a record or settle is still settled or retried
  through the current server and key, as before. Everything 2.0.0 writes carries
  its binding, and is ended only through it (see *Security*). Tracked in
  [#246](https://github.com/usertools-ai/usertrust/issues/246).
- **If a settle fails and its release also fails, the old hold may stay live until
  the server's sweep.** A later re-fire of the same call reserves a replacement,
  double-counting the budget until then: an early refusal, never an overspend.
  Tracked in [#248](https://github.com/usertools-ai/usertrust/issues/248).

## [1.4.1] - 2026-10-07

### Fixed

- **A tool call that is deferred and then resumed keeps one hold** (1.4.0's known
  issue; two resumes of the same call running at once can leave two, below). When
  the resumed call fires PreToolUse again, the plugin finds the hold
  it already has, by the ids its record stores. It never reuses that hold: it ends
  it, then reserves afresh, so the budget is checked at every resume and enforce
  mode denies on a 402.
  - A hold that carries transcript usage is settled once, at its counts. If that
    settle fails and the server does not confirm the hold is gone (its release
    unconfirmed too), no fresh hold is made beside it, and the call fails as a
    failed authorization does.
  - Any other hold is given back only through a `release` the server advertises,
    and never aborted. On a server without `release` it counts against the budget
    until the server's pending-hold sweep voids it, which can only refuse a call
    early, never overspend.
  - The cost is one more authorize per resume.
  - A call resumed under another server or key (`UT_SERVER_URL`, `UT_SERVER_KEY`)
    never touches its earlier hold through the new one. Each record carries the
    server's URL and a hash of the key that made it, never the key itself. On a
    mismatch, or for a record from before this change, the record is dropped and
    nothing about the old hold is sent to the new server. The old hold is left to
    its own server's sweep, and any transcript usage it carried goes unrecorded,
    an under-count. It is never charged to the new tenant. The same holds for a
    `.settling` record made under another server or key: the resumed call is
    refused while it is fresh, and abandons it through its own name once it is
    stale, its usage unrecorded, never parked for a retry through the new server.
  - The call is refused while that hold is not resolved: a `.settling` record left
    by a hook killed mid-settle, or a hold another hook is ending at that moment.
    Enforce mode denies it, whatever `UT_FAIL_OPEN` says, and watch mode records a
    gap. A stale transcript-mode record is decided by the transcript journal first,
    and the call then reserves afresh. Only the hook whose reconcile removed the
    record reserves; another resumed beside it is refused. The model's retry is a
    new tool call, which reserves as usual.
  - Each hold has its own files, named by its transfer as well as its call
    (`<session>__<agent>__<call>.<transferId>.json`, with its `.settling` and
    `.done` beside it), so a resumed call's earlier hold and its fresh one never
    share a file. A hook still acting on an earlier listing (a Stop that listed the
    earlier hold before the resume ended it) finds only that hold's file: it never
    claims, settles, journals over or deletes the fresh hold's. No hold file is
    written over another: a file already under a fresh hold's name is left as it
    is, the fresh hold is given back, and the call is refused (enforce denies it,
    whatever `UT_FAIL_OPEN` says; watch mode records a gap). A 1.4.0 record keeps
    its per-call name: hooks find it by the ids it stores, and end it once, through
    that name.
  - The server's transferId names a file only as it was sent, and only if it is
    1 to 128 of `A-Z a-z 0-9 _ -`. Any other id is refused, never rewritten into a
    name (two ids could then share one): the hold is given back through `release`
    (on a server without it, left to its sweep), and the call fails as a failed
    authorization does. A name too long for the filesystem fails the same way.
  - Two resumes of the same call running at once can leave it two holds, each with
    its own record: the call's PostToolUse settles one and Stop ends the other, so
    it is charged once, while the budget counts both until then. On a server
    without `release`, Stop gives the extra one back by an abort.
  - With `release` advertised, the call reserves afresh only once the earlier hold
    is released (a 200), or the server answers that it holds it no more (404
    `unknown transferId`). Any other answer, or none, leaves the hold possibly live:
    no fresh hold is made beside it, its record is kept for Stop to give back, and
    the call fails as a failed authorization does. A 404 from a server that has
    restarted leaves the ledger's hold pending until its timeout (300 s at most):
    the budget counts it twice until then, the safe direction.

### Known issues

- **The transcript journal does not check which server and key made a hold.**
  Any hook other than a resumed call's PreToolUse still reconciles a stale
  `.settling` record from another tenant like its own, as 1.4.0 does. If the
  record is keyed, the next Stop can retry its window through the current server
  and key, charging this tenant for the other's usage. It also applies to a hold
  still pending at Stop or SubagentStop: Stop settles it through the current
  server and key. This needs `UT_SERVER_URL` or `UT_SERVER_KEY` to change while
  such a record or hold is unresolved. Tracked in
  [#246](https://github.com/usertools-ai/usertrust/issues/246).
- **If a settle fails and its release also fails, the old hold may stay live until
  the server's sweep.** A later re-fire of the same call reserves a replacement,
  double-counting the budget until then: an early refusal, never an overspend.
  Tracked in [#248](https://github.com/usertools-ai/usertrust/issues/248).

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
