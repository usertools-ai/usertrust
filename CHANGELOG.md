# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Read before upgrading

- **`allowUngoverned` refuses an entry that names a free or governed method, when the client is created.** Listing `models.list` or `messages.countTokens` (free), or `messages.create` or `chat.completions.create` (governed), was accepted, but the free branch or the governed trap ran first, so those calls carried no `ungoverned_call` event, though the option promises one for every listed method. `trust()` now throws a `TypeError` naming the entry and whether it is free or governed on that client. No billable work escaped; the audit promise was what broke.

- **On a Google client, the billable methods usertrust does not govern are now refused instead of running ungoverned.** `models.embedContent`, `models.generateImages`, `models.editImage`, `models.upscaleImage`, `models.generateVideos`, `models.recontextImage`, `models.segmentImage`, `chats.create`, `live.connect`, `live.music.connect`, `batches.create`, `batches.createEmbeddings`, `interactions.create`, `tunings.tune`, `caches.create`, `caches.update`, `fileSearchStores.uploadToFileSearchStore` and `fileSearchStores.importFile` each send a billable request (generation, embedding, tuning, cache storage or file-search indexing); called through a `trust()` client they now return a promise that rejects with a `PolicyDeniedError` naming the method, after recording a `policy_denied` audit event whose hash the error carries as `auditEventHash`, and the SDK is never called. They used to run unmetered, unpoliced and unaudited (`chats.create` is refused because the `Chat` it returns drives the SDK's unwrapped `models`, so every `sendMessage` / `sendMessageStream` bypassed governance). To make one of these calls, run it on the original (unwrapped) client inside `governAction()` with a cost estimate. `TrustedClient` types them as returning `Promise<never>` (`chats.create`, synchronous in the SDK, included: it returns a rejected promise, not a `Chat`). **`models.generateContentStream` with automatic function calling now rejects the same way** (a callable tool in `config.tools`, AFC not disabled, a valid `maximumRemoteCalls`): the SDK streams one provider round after another inside the call, and a streamed loop is not yet metered round by round. `models.generateContent` with automatic function calling is NOT refused: it is metered per round (#324), each round its own governed call. To stream with tools, use `models.generateContent`, or set `config.automaticFunctionCalling.disable: true` and run the tool calls yourself, or make the call on the original client inside `governAction()` with a cost estimate. When tools are passed to either method, `params`, `config`, `config.tools`, each tool and `config.automaticFunctionCalling` must be plain objects: a Proxy in any of them is refused the same way (the error names where), since a Proxy can show the check one config and the SDK another. An accessor (getter) there is read once and its value captured: the check and the SDK both use that one value, and a getter that throws, or a `config` that is not an object, is refused the same way. The request is then forwarded as a snapshot of the checked config, not your object: changing `config.tools` or `config.automaticFunctionCalling` after the call cannot reach the SDK, and with automatic function calling not disabled each non-callable tool must be copyable as data (`structuredClone`), or the call is refused naming it. Calls that are not billed (`models.countTokens`, `computeTokens`, `list`, `get`, `update`, `delete`, and the batch, interaction, tuning, cache and file-search-store read methods, `files`, `operations`) pass through as before.

### Fixed

- **The weekly report's ungoverned section says call attempts.** An `ungoverned_call` record is written as the call is made, so it proves an attempt, not a call that reached the provider. The section is headed "Ungoverned call attempts", its line and method table count attempts, and its note says the record is written before the provider is reached when `audit.failClosed` is set and best-effort otherwise, so an attempt may have failed or never reached the provider, and a call whose record could not be written is not counted. The report's disclaimer says the same. The JSON field `ungoverned: { calls, byMethod }` is unchanged.

- **`usertrust verify --json` on the anchored path reports `success` as the exit code.** With `--require-anchor` or `--require-external-anchor`, an unanchored vault exited 1 but printed `"success": true`, so a pipeline that parsed the JSON saw a pass that the exit code refused. `success` is now `true` exactly when the exit code is 0, whichever check decided it.

- **The standalone `usertrust-verify` CLI scrubs every string from the vault before printing it.** It prints at an auditor's terminal, from a vault owned by the party under audit. Several of the vault's strings reached that terminal verbatim: the chain-error lines (an event's `id` and `previousHash`), `First event:` / `Last event:`, the latest anchor's key id and timestamp, the witness error, each anchoring warning, and the echoes of arguments and caught errors. An escape sequence in any of them could erase a FAILED line and print a forged verdict. Each now goes through `forDisplay`, which replaces control characters (C0, DEL, C1) and every Unicode format character (bidirectional controls, zero-width characters, the byte-order mark) with `?`. The anchor's key id is sanitized first, then clipped by code points.

- **Google `models.generateContentStream()` is governed; it was unmetered.** On a Google client `trust()` governed `models.generateContent()` alone, and every other method passed straight to the SDK, so a streaming Gemini call placed no budget hold, ran no policy (budget, PII, injection), produced no receipt and wrote no audit event. It now runs the same two-phase path as every other provider's stream: the policy check and the hold come first (a denial is thrown before the SDK is called), the chunks reach you unchanged and in order, `usageMetadata` is read from the latest chunk that carries it (each one is a running total, so nothing is summed) and priced like the non-stream call, and the hold settles when the stream ends, with an `llm_call` audit event. It resolves to the stream itself, as the SDK's method does, with the settled receipt on it: `const stream = await client.models.generateContentStream({ ... })`, `for await (const chunk of stream)`, then `await stream.receipt`. A `break` settles the usage consumed so far, a stream that reports no `usageMetadata` settles at the estimate, and a stream that throws mid-way voids the hold and records a `stream_partial_delivery` event, exactly as on the other providers' streams. `TrustedClient` types the method accordingly. A stream that would run the SDK's automatic function calling is refused instead (see "Read before upgrading"); `generateContent` with it is metered per round.

- **A stream you cancel with your own abort signal settles what was delivered, like a `break`, instead of voiding.** When the caller's own signal for the call (Google `config.abortSignal`, OpenAI's and Anthropic's request-options `signal`) is aborted, the SDK's iterator throws; the governed stream treated that as a stream failure, voided the hold (the delivered usage went uncharged) and recorded a circuit-breaker failure, so repeated cancellations could open the breaker. It now settles the usage delivered so far (the estimate when none was reported) and records no breaker failure; `.receipt` resolves and the abort error still reaches the caller's loop. Decided by the signal's state, never the error's name. Provider errors with the signal not aborted, and anomaly cutoffs, still void. The signal is the one the caller passed, captured when the call is made, so replacing or deleting `options.signal` while the provider call is pending changes nothing. Under `pii: "redact"` the Google signal now reaches the SDK as the same object: redaction keeps a real `AbortSignal` by reference at `config.abortSignal` only (recognised by brand, and carrying no own property, enumerable or not), where it used to flatten it to `{}` and the call could not be cancelled. A signal anywhere else in the request, and every other non-plain value (class instances, binary data), is still flattened and redacted as before. (OpenAI's and Anthropic's signal is in the request options, which redaction does not touch.)

- **A governed stream closed before its first read now ends its hold.** Calling `.return()` or `.throw()` on a governed stream (any provider's `stream: true` call, and Google `generateContentStream`) before the first `next()` completed the generator without running its body, so the hold was neither settled nor voided, `.receipt` never resolved, and `destroy()` waited out its 5-second deadline. Now `.return()` there is an early `break` with nothing read: the provider stream is closed and the hold settles at the estimate. `.throw(err)` is a stream failure: the hold is voided, and `.receipt` and the `.throw()` call reject with `err`.

- **On Anthropic and OpenAI clients, a refused method no longer touches an audit writer that is already degraded.** Under `audit.failClosed`, a client whose audit writer had already failed refused an ungoverned method with a `PolicyDeniedError` after trying to record the refusal, where every governed call rejects with `AuditDegradedError` before anything is recorded. Every refusal, on every provider, now runs that same check first.

## [5.0.0] - 2026-10-12

### Read before upgrading

- **On Anthropic and OpenAI clients, every SDK method usertrust does not govern is now refused instead of running unmetered.** `trust()` used to govern a short list of methods and pass every other one to the raw SDK, with no budget hold, no policy check and no audit record. Every function-valued SDK method reached off the governed client, at any depth, is now refused unless it is governed or on the free list: the call returns a promise that rejects with a `PolicyDeniedError` whose reason starts `ungoverned_method: <path>`, after a `policy_denied` audit event (the path as `actionName`) whose hash the error carries as `auditEventHash`. The SDK is never called and nothing is held. A synchronous SDK helper returns the rejected promise too. What is refused is every method that can start work: Anthropic `messages.batches.create`, `beta.messages.batches.create`, legacy `completions.create`, `beta.messages.toolRunner`, and the Managed Agents creates and runs (`beta.sessions.create`, `beta.sessions.events.send`, `beta.deployments.run`, `beta.dreams.create`, …); OpenAI `embeddings`, `images`, `audio`, `batches.create`, `fineTuning.jobs.create`/`resume`, `fineTuning.alpha.graders.run`, `beta.assistants.create`, `beta.threads.create`/`createAndRun*`, `beta.threads.messages.create`, `beta.threads.runs.create` and its stream and poll helpers, `vectorStores` creates and uploads, `files.create`, `uploads.create`, `realtime.clientSecrets.create`/`calls.accept`, `beta.realtime`, `containers.create`, `videos.create`/`edit`/`extend`/`remix`/`createCharacter`, `evals.runs.create`, `beta.chatkit.sessions.create`, `skills` creates, `contentProvenanceChecks.create`, legacy `completions.create`, `beta.responses.create`/`compact`, `responses.compact` and `responses.inputTokens.count`, and the helpers that call the SDK's raw client internally: `chat.completions.parse`/`stream`/`runTools` and `responses.parse`/`stream`. The free list follows one rule, so reads keep working: every method whose requests are all GET or DELETE runs, on the raw SDK resource and unaudited (retrieves, lists, downloads, deletes, polls of existing objects, OpenAI's Usage and Costs API), as do the POSTs named with a reason (token counts, `moderations.create`, cancels, pauses, metadata updates, `fineTuning.alpha.graders.validate`, checkpoint access grants, eval definitions, conversation state) and the local webhook signature checks. Six GET or DELETE methods are refused by name: Anthropic `beta.environments.work.poll`, which claims a session's work item, and OpenAI's spend-control deletes (`admin.organization.spendLimit.delete`, `spendAlerts.delete`, their `projects.` twins, and `projects.modelPermissions.delete`). The exact list, with each method's SDK source line and verb, is in `packages/core/src/default-deny.ts`, and a test fails if a POST joins it without a named reason. A resource's `_client` is the SDK's raw client, so every call through it is refused; `client.post`/`get`/`request` and the other raw HTTP members are refused with a `PolicyDeniedError` (they used to fail with a private-field `TypeError`); and `client.withOptions(...)` now returns a client governed by the same governor (same budget, audit chain and ledger) instead of a raw one. A `withOptions()` clone shares its parent's governor: `destroy()` on either ends both, and `governAction()` on a clone runs under that shared governor. A `withOptions()` client that changes where or how calls are sent is refused (every call through it rejects): any option other than `timeout`, `maxRetries`, `defaultHeaders`, `defaultQuery`, logging, `dangerouslyAllowBrowser` and the API key or account options, so `baseURL`, `fetch`, `fetchOptions`, Anthropic `middleware`, `credentials`, `config` and `profile`, OpenAI `provider` and `workloadIdentity`, and any key the SDK adds later. A governed client meters for the endpoint and transport it was created for. For the same reason, writes through the governed client now throw a `TypeError`: assigning, defining or deleting a property on the client, a resource or `_client`, and mutating its transport objects (`middleware`, `fetchOptions`, `_options`, Anthropic `_authState`, which are now read-only views); before, they changed the raw client underneath. To run a refused method anyway, list it: `trust(client, { allowUngoverned: ["embeddings.create"] })` runs it on the raw SDK resource with no hold and no cost, and appends one `ungoverned_call` event (`{ method, provider }`) per call. The append is best-effort, and the method returns what the SDK returns. Under `audit.failClosed` the append is awaited before the SDK is called, a failed append refuses the call, and the method always returns a promise: one that is synchronous in the SDK (`chat.completions.stream`) returns a Promise of its value, and `beta.messages.toolRunner`, whose runner is thenable, returns a Promise of the runner's FINAL result (promise resolution adopts the thenable and runs it to completion), not the runner object. `allowUngoverned` is validated when `trust()` is called: an array of non-empty paths, none through `_client` or a raw HTTP member. Governed methods behave as before, Google clients are unchanged, and `TrustedClient` still types a refused method with its SDK signature. Deliberate bypass from your own code is out of scope: code that holds a provider key can always reach the provider. (LIMITATIONS.md, "1. The governance surface is the wrapped SDK methods — nothing else".)

- **The minimum supported SDK versions are now `openai` 7.4.0 and `@anthropic-ai/sdk` 0.116.0** (the optional peer ranges were `>=4.70.0` and `>=0.30.0`). The default-deny free list below is classified against these versions, and older SDKs expose method names it does not know. Upgrade the SDK before upgrading usertrust.

- **Claude Haiku 5.5 calls with prompts of up to 100,000 tokens settle at the lower tier (#282).** Their recorded spend falls to about one fifth of the old charge. Holds still reserve the higher tier, so a call still reserves about five times what it settles at. Compare spend across the upgrade with that in mind. (See *Fixed*.)

- **An inconsistent checkpoint history no longer verifies (#284).** A history that contradicts the receipt's own Merkle proof returns `HISTORY_INVALID`, where it could be awarded `VERIFIED_CHECKPOINT_HISTORY`. A consistent history verifies as before. (See *Fixed*.)

- **Raised dependency floors (#286).** The ranges for `@clack/prompts` (`^1.8.1`), `yaml` (`^2.9.1`) and `zod` (`^4.6.5`) in usertrust, and for `zod` (`^4.6.5`) in usertrust-server, need at least those versions. (See *Dependencies*.)

- **`AuditWriter.release()` throws `AuditLockReleaseError` when a lock is left behind (#195).** `destroy()` does not reject for it; it emits a `USERTRUST_AUDIT_LOCK_LEFT` warning instead. (See *Fixed*.)

- **`destroy()` may reject with an `AggregateError` (#292).** It runs every teardown step before it rejects. When several steps fail, it rejects with one `AggregateError` listing their errors in step order. (See *Fixed*.)

- **A torn audit log tail is refused, not appended to (#293).** An append onto a log whose last bytes follow its last newline is refused with `AuditTornTailError`. `usertrust audit quarantine-tail` moves only that torn final line to evidence. (See *Fixed*.)

- **A restarted single-container server can stop on its own old audit lock (#294).** A container restarts in a new PID namespace, so a lock its previous instance left reads as foreign and is held. Confirm that no writer is still live, then remove the lock file the error names. A filesystem without hard links now fails the audit lock acquire, closed. (See *Fixed*.)

- **The server refuses to start when its ledger cannot run (#300).** It probes each tenant's ledger before it listens, and stops with the reason when the probe fails. (See *Changed*.)

**Declared residue:** on the Claude Code plugin's unkeyed transcript path, a `429 rate_limited` (above 1 000 unknown-hold settles a minute for one tenant) and a lingering `409 settle_in_progress` stay "claimed": the usage may be unrecorded and is never retried, like any transient failure there. The plugin never sends a second settle for a hold, so re-sending is not an option; the record is kept rather than traded for an abuse bound. A settle that races the TTL sweep is handled on the server instead: it waits for the sweep's release to land and answers the recorded `410`. That wait is bounded at 30 s (beyond the ledger's own timeout): past it the settle falls back to `409 hold_active`, which the plugin reads as claimed. A settle that finds the hold live again (a release or abort that claimed it failed and put it back), already settled, or in flight while it waits is answered `409` rather than recorded as unrecoverable, because that charge may stand.

- **BREAKING (usertrust-server wire): `POST /v1/settle` for a `transferId` the server holds no hold for no longer answers `404`.** It answers `410 settlement_unrecoverable` (the settle is recorded on the audit chain; nothing is charged and no hold is re-opened; the client authorizes again and settles to be charged), `409 already_settled` (a retry of a settle that went through in this process: the charge stands), `409 settlement_ambiguous` (the first settle's ledger post was ambiguous and may have charged: do not authorize again to settle it) or `409 settle_in_progress`. The Claude Code plugin in this repository is one such client and now reads either a `404 unknown transferId` or the `410` as an expired hold. A client that treated every settle `404` as "retry, or give up" must read the new codes: `409 already_settled` is success, `410` means re-authorize if the spend must be charged. `/v1/health` lists `settle-unrecoverable` in `capabilities` (check it before relying on the codes); the per-tenant `settlementsUnrecoverable` count is on the authenticated `GET /v1/budget`. A tenant may write at most 1 000 new records a minute: past that the settle answers `429 rate_limited` with nothing recorded. `/v1/abort` and `/v1/release` keep their `404`. **This is a wire-status change on a public API: it ships only in a major release, not a patch or minor.** The server remembers the last 10 000 settled ids PER TENANT in process; past that, or after a restart, a retry of an older settle is recorded as `settlement_unrecoverable` (a duplicate record of a charged settle, never a lost one). New headless `Governor.recordUnheldSettlement()` is the record-only primitive behind it; it is an addition to the exported `Governor` interface, so a custom implementation of that interface must add it.

- **Under `audit.failClosed`, a degraded client refuses calls before they are charged, and on the governed `create` streams a completed stream whose settlement audit fails ends its loop with `AuditDegradedError` (#327, #304).** A `messages.stream()` caller under `failClosed` must await `.receipt`. (See *Fixed*.)

- **Vaults are owner-only, and a governor refuses a vault another user owns (#309, #314, #318, #320).** A governor creates `.usertrust/` itself at `0700`, and on its first start closes an existing one that an earlier version left readable by other users to `0700`. It refuses, without changing it, a `.usertrust/` another user owns, even as root, and it refuses by name a vault this process cannot write to, before the first write. Run as the owning user, or change the vault's owner to the user that runs it. The CLI commands warn rather than refuse. (See *Security*.)

- **A usage figure above 100,000,000 tokens in one tier is refused, not counted (#306).** The call settles at its estimate, and a `usage_implausible` event records the refused figures. (See *Fixed*.)

- **Two `trust()` clients on one vault in one process share one audit writer (#315).** Run `usertrust verify` on a vault an earlier version wrote with several clients in one process. It reports each dead-lettered event that is not on the chain, and exits 1. (See *Fixed*.)

- **`usertrust init --reconfigure` replaces a symlinked `.env` instead of writing through it (#317).** The new key goes to a fresh owner-only file that is renamed over `.env`, so the link's target keeps its old contents. (See *Security*.)

- **A usage component above the plausibility ceiling is refused, not summed (#321).** Each component is checked before it is summed. A refused component is refused by its own figure, so the call is charged at the estimate and recorded as `usage_implausible`. The same rule now covers every OpenAI usage figure (#323): the prompt or input, the completion or output, the cached read and the cache write, each read as the provider sent it, and a figure that is not a count is refused too. (See *Fixed*.)

- **Google calls with automatic function calling are charged for every round.** In 4.x the SDK ran the whole loop inside one governed call that was charged for the final round only. From 5.0.0 each round is held, audited and charged on its own: expect one hold and one audit event per round, budgets that deplete by every round, and a denial (policy, PII or insufficient balance) that can stop the loop part-way after earlier rounds have settled. This applies to `generateContent` only; `generateContentStream` is unchanged. (See *Fixed*.)

- **A vault base with `..` is resolved by the operating system (#319).** A base that contains a `..` segment is resolved by realpath(3), so a `..` after a symbolic link now reaches the directory the link leads to, where it used to be read as text. Two bases are refused by name: a `..` after a directory that does not exist yet, and a `..` on a system where realpath(3) does not work. (See *Security*.)

- **The Claude Code plugin is now `usertools`.** Uninstall `usertrust-claude-code` before installing it: with both installed, every tool call is metered twice. The plugin is versioned on its own (3.0.0) and is unrelated to the npm packages' version in this release.

### Added

- **A settle that cannot charge is recorded, never dropped: `settlement_unrecoverable` and `Governor.recordUnheldSettlement()`.** When a settle arrives for a hold the governor no longer has (swept by its TTL, lost to a restart, already settled), the spend is real and the ledger will never charge it. `recordUnheldSettlement({ transferId, usage?, principal? })` appends one `settlement_unrecoverable` chain event: the transfer id as its SHA-256 (never the id), the usage the caller reported (counts it cannot use are dropped, never zeroed), `usageSource`, `computeMs`, `usageTo` and the principal. **It is a record only**: it calls no ledger method, changes no budget and leaves no hold behind (pinned by tests that spy every engine call and re-try release and abort of the id), and it prices nothing, since it has no model. A live hold answers `{ outcome: "held" }` with nothing recorded. An exact retry (same id, same usage) of one of the last 10 000 records answers `recorded: false` with no second record; past that memory it is recorded again. A failed append is thrown, never swallowed (one that was already durable when it failed counts as recorded, so its retry writes no duplicate). The record is counted as a settlement attempt and a money-versus-audit desync by `usertrust health`'s entropy signal, makes `usertrust health` report spend as unknown rather than zero when no ledger is readable, and is a known gap for a job log even with no session. A settle that arrives while a client release or abort is still voiding the hold waits for that terminal and then records, like one racing the TTL sweep (one `claim` function now ends every hold). `usertrust-verify --tx <id>` finds the record (matched by the id's SHA-256) and shows it as UNRECOVERABLE.

- **`usertrust report --week` writes a weekly spend report from your own vault.** `usertrust report --week --end <ISO instant with zone>` builds spend by agent and model, token cost by tier, top costs, budget status and governance activity counts, as Markdown, a self-contained HTML page, or JSON. It reads the vault and nothing else: no ledger and no network. The verdict is `usertrust verify`'s own on the live vault. An exact amount is shown only when the ledger has posted a usable figure; anything else is reported as an upper bound. `--out` writes through a 0600 temp file renamed into place, and is refused when it would land inside the vault.

- **The weekly report counts calls run ungoverned, by method, and never as spend.** A call a caller opted out of governance with `allowUngoverned` leaves an `ungoverned_call` record: it went to the provider with no budget check, no hold and no recorded cost. `usertrust report --week` now reads that kind (it is no longer listed among the records the report does not read) and discloses "Calls run ungoverned (opted out with allowUngoverned, unmetered): N" with a per-method count in Markdown and HTML, and as `ungoverned: { calls, byMethod }` in JSON. These calls are in no spend, cost, budget, governed-call or action figure, and no amount is estimated for them. The method label is read only as a string the record stores (never through an accessor or a Proxy; anything else counts as "(unknown method)"), passes the same Markdown and HTML boundaries as every other vault string, and the breakdown is capped at 50 methods. With no such call, no line is shown.

### Changed

- **usertrust-server refuses to start when its ledger cannot run, before it listens; `usertrust init` works without a terminal.** Before, a server on a host where io_uring is blocked printed "listening", then the first `/v1/authorize` killed the process; with no TigerBeetle answering, the first authorize hung. The server now probes each tenant's ledger before it listens, and refuses to start, with the reason, when the probe fails. A `dryRun` server is never probed. A tenant config that cannot be read or parsed also stops the server at startup, instead of failing that tenant's first request. `usertrust init` with no terminal writes the same defaults `--json` writes, says so, and exits 0; any path that ends without a vault exits 1. The ledger error's hint now names `tigerbeetle format`, then `tigerbeetle start` on the configured address. (#300)

- **Site: no font file lives in this repository; the site's fonts load at runtime from the brand kit.** `usertrust.ai` drops `next/font/local` and its seven self-hosted woff2 files (Usertools Sans, JetBrains Mono, Khand), the `/og` card's two Khand TTFs and `OFL.txt`. `@font-face` in `site/app/globals.css` points at `https://usertrust.ai/kit/fonts/` for the same faces (Usertools Sans 400/500/700, JetBrains Mono 400/500/700, Khand 600/700 as the display voice), with `font-display: swap` and the existing system fallback stacks; the root layout preconnects to the kit and preloads the display and mono faces the hero paints first. The `/og` card loads Khand through the same sha384-pinned loader as the receipt share card, pinned to the bytes the site self-hosted, and falls back to the renderer's default font if the kit is unreachable at build. `site/scripts/no-font-files.test.mts` fails if any tracked file anywhere in the repository holds font data, found by its bytes whatever its name: a font format's signature, an sfnt table directory or a WOFF, WOFF2 or EOT header anywhere in the file, a bare CFF, or a font inlined as a `data:` URL, base64, SVG or PostScript. It also checks, on a best-effort basis, that every font URL in site source is the kit's.

- **Site: no brand image is tracked in this repository; the site loads its brand images at runtime from the brand kit.** The mascot plate, the hero's first and settled frames and the favicon now load by absolute URL from `https://usertrust.ai/kit/images/` (one module, `site/app/lib/kit-images.ts`), so a preview or Git deploy shows the same images as production. The `/og` card fetches its ground, the hero's settled frame, through the same sha384-pinned fetch as the receipt share card's fonts and frame, and renders on its plain ground if the kit is unreachable at build or the bytes do not match the pin. The unreferenced `mascot-full.png`, `mascot-mark.png`, `og.png` and `bliss.jpg` are removed. `site/scripts/no-brand-assets.test.mts` fails on any tracked path under a `brand/` directory or named `mascot*`, and on any tracked file that is a byte-exact copy of a kit file (by sha256); a modified, resized or re-encoded copy is not caught and needs review. The marks drawn in code are unchanged, pending review.

- **The Claude Code plugin is renamed `usertools`, at its own version 3.0.0.** It was `usertrust-claude-code`. Install it with `/plugin install usertools@usertrust`. An existing install does not migrate itself, so uninstall `usertrust-claude-code` before installing `usertools`. The plugin's version is its own and is unrelated to the npm packages' versions. (See *Read before upgrading*.)

- **Error messages no longer carry an internal reference.** The proxy-removal errors, and the description of the OpenClaw `proxy` setting, named an internal tracker id. The id is removed; each message keeps its meaning.

### Fixed

- **Claude Haiku 5.5 is priced per request by prompt length, at both of its published tiers.** Anthropic prices `claude-haiku-5-5` by the length of each request's prompt: up to 100,000 prompt tokens $0.10 in / $0.50 out / $0.01 cache read / $0.125 5-minute write / $0.20 1-hour write per MTok, and over 100,000 tokens $0.50 / $2.50 / $0.05 / $0.625 / $1. The prompt length counts all of the request's input tokens: fresh input, cache reads and cache writes. The row held only the higher tier, so every request with a prompt of up to 100,000 tokens was overstated 5×. `ModelRates` gains an optional `longPrompt: { thresholdTokens, rates }`, and the `claude-haiku-5-5` row now carries the lower tier as its own rates and the higher tier as `longPrompt` (threshold 100,000; a prompt of exactly 100,000 tokens is the lower tier). `costFromRates` selects the tier from the counts it prices, so estimates, settles, streams and the spend-velocity meter all apply one rule. A receipt's `pricing.appliedRates` (and the 1-hour `cacheWrite1h.ratePer1k`) are the rates of the tier the call **settled** at, decided from the reported prompt length, so `ceil(sum(counts × appliedRates / 1000))` still reproduces its `cost`. `trust()` and `createGovernor().authorize()` cannot know an estimated prompt's side of the threshold, so they **hold at the higher tier**; the settle posts the actual tier and the two-phase post releases the difference. A consequence to expect: a short Haiku 5.5 call reserves about 5× what it settles at. The openshell gate sizes from an upper bound on the prompt and holds the lower tier whenever that bound is at or under 100,000 tokens. `customRates` and local-model rates stay flat: a `longPrompt` on one (for example a row spread from the table) is dropped at lookup, so it cannot size a hold below the settle. A settle prices its counts as one request, so a caller that settles several requests together (the Claude Code plugin's transcript windows) is priced at the tier of their combined prompt: before rounding, never below the per-request total and never above the higher tier; the charge can be lower, since the settle is rounded up to a whole UT once, with a 1 UT floor. New exports: `promptTokenCount`, `promptTierRates`, `holdTierRates`, `snapshotRates` and the `LongPromptTier` type; `resolveAppliedRates` takes an optional prompt length. `usertrust pricing` shows both tiers (`--json` adds `longPrompt` to a tiered row). `PRICING_TABLE_VERSION` is `2026-10-11`; every other Claude row was re-read against the page and is unchanged.

- **The receipt verifier could award `VERIFIED_CHECKPOINT_HISTORY` to a checkpoint history that contradicted the receipt's own Merkle proof.** Two signed values in the history were never compared with what the receipt exposes. One is a served successor's `segmentStartPreviousHash`, which is the embedded segment's final leaf and appears as an inclusion-proof sibling. The other is the root of a single-event predecessor segment, which its signed chain link and the next segment's start hash fully determine. Both are now recomputed from the leaves the receipt knows, under one rule that also covers siblings at promoted proof levels, and a disagreement returns `HISTORY_INVALID`. Histories that are consistent verify as before. Receipt spec v0.10 records this as an amendment (§4a, §7).

- **Since 4.0.0, the in-process lock registry is keyed by writer and lock file, not by the vault's directory.** 4.0.0 keyed it on the directory's real path (`realpathSync`), with the path as written as the fallback when the directory did not exist yet. Now whether a lock file belongs to a live writer in this process is read from the lock file itself, on both `createAuditWriter` and `withAuditWriterLock`. The file is a live writer's only if it carries that writer's id, that writer is still live in this process, and the file is the exact one (the same inode) its exclusive create made. Every spelling, symlink and letter case of one directory reaches that one lock file, with no `/proc` needed, so the second writer gets `AuditWriterLockHeldError` and the first writer's lock is untouched. The same holds when the directory is replaced while the lock is being taken. A lock file that cannot be read (an I/O or permission error) is never reclaimed: the acquire throws. Only a file that was read and does not parse counts as corrupt. A same-PID lock file that no live writer in this process holds (left by a crashed earlier instance of this PID, a recycled PID, or a copy of a lock file) is still reclaimed. A writer that is never released keeps its locks for the life of the process. A lock is registered only once its create has fully succeeded. If any step after the create fails, including the close, the acquire throws with nothing registered, and the file is removed if it is still the one that create made: the same inode and the same writer id. An inode alone is not enough, because Linux can give a freed inode to the next file created, including another writer's lock. A writer can hold several locks (its vault path may be a symlink retargeted between appends), and `release()` releases all of them. Each lock's location is remembered physically (the directory's real path) and refreshed whenever the writer verifies the lock. On release the writer looks there, then where its vault path leads now, and removes only a file that is still that lock. So locks are released after a symlink they were taken through is removed or retargeted, and after the vault is renamed and its symlink repointed. Release attempts every lock. A lock it cannot read, or whose unlink fails, is left in place and reported. `AuditWriter.release()` throws one `AggregateError` (`AuditLockReleaseError`) after the last lock, naming each lock left behind and its error code. `destroy()`, on both `trust()` and `createGovernor`, never rejects for it, because callers often call `destroy()` without await or catch. It emits a process warning with code `USERTRUST_AUDIT_LOCK_LEFT` (also logged with `console.warn`) naming each lock path and its error code, with terminal control characters in a path printed as `?`, and tears the engine and proxy down regardless. `withAuditWriterLock` rejects with the release error only when its callback succeeded; when the callback threw, the callback's error is the rejection, unchanged, and the release failure is logged with `console.error`. `usertrust secret` now destroys its vault and releases its audit writer even when the other step throws, and a failure there never hides the command's own error. After a failed command it is printed as a warning; after a successful one the CLI prints it to stderr and exits non-zero. Either message is scrubbed for the terminal, like the command's other output. An acquire now reports success only if, after its create, the requested path still holds the file that create made; if the directory was replaced in between, it throws `AuditWriterLockHeldError` instead of reporting a lock the requested directory does not have. A release failure is reported at the place it actually failed: for a vault renamed after its lock was taken, that is the lock's new path. When both a `withAuditWriterLock` callback and the release fail, the release failure is logged as one scrubbed line rather than as the raw error object. **Threat model:** the lock prevents accidental concurrent writers (two processes, or two writers in one process, on one vault). It is not a defence against an actor who can rename or recreate the audit directory, since that actor can already write the chain directly. Pathname races under concurrent directory replacement are out of scope: Node has no atomic, inode-bound unlink, so stale-lock cleanup, release and the rollback of an unreported create each check and then unlink by path. A kernel advisory lock held on an open fd (flock/fcntl) would remove that dependence (#288). A writer that finds its lock gone re-acquires it and reads the chain tail from disk rather than its cache. A directory that does not exist still throws `ENOENT` before any lock is created (#182).

- **`destroy()` always runs every teardown step, so a failing step can no longer leave the TigerBeetle client open.** On both `trust()` and `createGovernor`, `destroy()` ends with a fixed sequence of steps: on `createGovernor`, voiding and recording the holds still held; on both, the engine's sweep of its remaining pending transfers, the audit flush, the audit release, the engine destroy and the proxy-connection destroy. These ran one after another, so a step that threw skipped every step after it: on `trust()` a sweep that threw, and on both a flush that threw, left the TigerBeetle client open (which can keep the process from exiting) and the audit lock held. On master an engine destroy that threw also skipped the proxy-connection destroy. Each step now runs in its own `try`, in the same order, and every step is attempted whatever an earlier one does. What `destroy()` rejects with is unchanged, but it now rejects only after the last step has run: with that step's own error when one failed, or with one `AggregateError` listing the errors in step order when several did. Nothing that did not reject before rejects now: `createGovernor`'s sweep failure is still swallowed, and an audit lock left behind is still only a `USERTRUST_AUDIT_LOCK_LEFT` warning. The `beforeExit` safety net is unchanged.

- **Audit writer: a short write is never claimed durable (#194).** `appendEvent` ignored `writeSync`'s byte count, so a partial line was reported appended and durable — a torn tail with a durability claim. Every write (the log line, the `.meta` anchor, the lock file's content) now writes every byte or throws, and a failed append drops the writer's cached tail.

- **Audit writer: never appends onto a torn tail (#194).** A log whose last bytes follow its last newline refuses the append (`AuditTornTailError`, exported) instead of concatenating the new line onto the torn bytes and burying them mid-file. The writer's appends are opened `O_NOFOLLOW`, so a symlinked `events.jsonl` is never written through.

- **Audit: a recovery path for a torn tail (#194).** `usertrust audit quarantine-tail [--dry-run] [--json]` (and `quarantineTornTail`, exported with `AuditQuarantineRefusedError`) moves ONLY a torn final line — unparseable bytes after the last newline, on a single `events.jsonl` with one name (a hard-linked log is refused) that otherwise verifies from genesis, with a `.meta` anchor at the head or one behind it (absent only on a chain of at most one event) — byte for byte to `audit/quarantine/<sha256>-<offset>.torn`, cuts the log back, and records a chained `audit.quarantine.torn_tail` event naming that file. Any other state is refused and nothing is changed (exit 1, as is an interrupted repair; a malformed invocation exits 2, and the global flags are accepted as by every command); an unterminated last line that parses is refused with the operator's remedy in the message. Each cut is identified by its digest AND offset, in the evidence file's name and its record alike, so identical torn bytes cut twice get two records, and a run interrupted before its record is finished by the next run. Before anything is appended, the log is fsync'd and an anchor one behind, or absent, is brought to the verified head, so no interruption leaves a state no run accepts; every refusal happens before the first write (the log's link count is checked on the descriptor that is cut, immediately before the first repair write), so a refusal changes nothing; a hard link made after that check is reported as an interrupted repair (`AuditQuarantineInterruptedError`, exported), which names what was already done, does not cut, and is finished by the next run once the link is removed. A crash-point sweep test holds both properties over every durable step and start state. A real run holds the vault's writer lock (`createAuditWriter`'s `lockAtCreate`), so it refuses while another writer is live; a dry run is read-only and takes no lock. The log is read and cut on ONE `O_NOFOLLOW` descriptor and never through a link; `quarantine/` must be a real directory; evidence is published atomically (a private temp file, fsync, then a hard link that never replaces an existing name) and an existing evidence file is accepted only as a regular file whose bytes hash to its name. The parent directory is fsync'd before the log is cut (an unsupported directory fsync is best effort), a retry repairs a `.meta` anchor left one behind or absent, and vault-derived text is scrubbed before it reaches the terminal.

- **Audit writer: the `.meta` head anchor is replaced atomically.** It was rewritten in place (truncate, then write), so a crash mid-write left an empty or half-written anchor that reads as corrupt and refuses every append. It is now written to a private temp file, fsync'd, renamed over the anchor, and the directory is fsync'd: always the old anchor or the new one. Only an unsupported directory fsync is best effort; a genuine failure (EIO and the like) surfaces through the degraded-append / durable-hash contract.

- **A tripwire for audit-log segment rotation.** A core test fails the day core gains segment rotation (a census of every `*.jsonl` name and every rename in the audit layer, and a 200-append behaviour check), so the rotation PR must land a multi-segment verify in every incremental verifier that refuses multi-segment chains.

- **The audit writer's lock file is never seen half-written, and a lock from before a reboot, written in this PID namespace, is no longer held forever.** The lock was created exclusively and then written, so another process could read it EMPTY in between, judge it corrupt, and remove a LIVE writer's lock: two writers on one chain, which forks it. The content is now written in full and fsync'd to a private temp file (`.audit-writer.lock.<writerId>.tmp`, created exclusively, never through a symlink), which is then hard-linked to the lock's name. `link` fails with EEXIST when the name is taken, so it is the exclusive create, and the name never exists without its content. The temp file is removed on every path; a writer that takes the lock also removes temp files that crashed writers left behind, once they are over a minute old, and a temp file is never read as a lock. The directory is fsync'd after the link (best effort: a failure there is reported, never fatal, since every holder of a lock dies with its boot). A filesystem without hard links (`link` answers `EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `EXDEV` or `ENOSYS`, as on FAT/exFAT and some network and FUSE mounts) now fails the acquire, closed, with that code and an error saying why. It does not fall back to the old create-then-write. The lock's name is never followed: a symlink there makes the acquire throw (`ELOOP`) instead of being judged by its target. A writer that already holds its lock verifies it with one read per append, with no temp file. **Boot-aware staleness:** the lock now records the kernel's boot id (Linux: `/proc/sys/kernel/random/boot_id`) and the writer's PID namespace (`/proc/self/ns/pid`) where they can be read. A lock from this PID namespace (or one that names none) is reclaimed on boot grounds only when both boot ids are known and differ exactly. That is the case where its PID was recorded before a reboot and may now belong to an unrelated live process, which previously kept the lock held forever. An unknown boot id on either side is never stale; the PID judgement decides as before. Only a successful read of this boot's id is cached. A lock from another PID namespace is HELD, even one carrying this process's own PID, and whatever its boot id says. `kill(pid, 0)` cannot see another namespace, and containers on one host share a boot id and often both run their writer as PID 1. A boot id is not always the kernel's, either: systemd-nspawn gives each container a private one on the host's kernel, so a host and an nspawn container sharing a vault would read each other's live locks as written before this boot. The namespace is therefore judged before the boot id. **Behaviour change for single-container deployments: after a crash and restart, the server stops on its own old lock.** A restarted container runs in a new PID namespace, so its previous instance's lock now reads as foreign and is held, where before it was reclaimed as a crashed instance of the same PID. The error names the lock file. Confirm that no writer is still live, then remove that file. Locks written before this change carry neither field and are judged by PID exactly as before. No boot id is read off Linux, so elsewhere the PID judgement decides as before. A lock file's content is untrusted (a vault restored from someone else's snapshot can carry one), so no field read from it reaches a message, a warning or an error unvalidated: a `pid` that is not a non-negative safe integer is printed as `<invalid>` (the older "held by PID" errors included), and a boot id or namespace not of its form likewise.

- **A governed stream that fails mid-way no longer crashes the process.** When a stream was cut, or the provider sent an error event, `response.receipt` rejected too; a caller that caught the iteration error and never awaited `response.receipt` (the pattern the docs showed) got an unhandled rejection, and Node ended the process with exit code 1. Reproduced on Anthropic `messages.create({ stream: true })`, OpenAI `chat.completions.create({ stream: true })` and OpenAI `responses.create({ stream: true })` (a cut connection; the SDK yields a Responses error event rather than throwing it), under real SDKs; the fix is in the stream wrapper they share (`createGovernedStream`). Anthropic's `messages.stream()` helper was already safe. `response.receipt` can no longer go unhandled, and a caller who awaits it still gets the rejection, as the same error object the iteration threw. The ledger outcome of a failure the iteration THROWS is unchanged: the hold is voided exactly once, never charged, and a `stream_partial_delivery` event records what was delivered. A Responses `error` event is not thrown (the SDK yields it as a chunk), so that stream settles like a completed one and is charged. Under `audit.failClosed`, a completed stream whose settlement audit fails (`AuditDegradedError`, after settlement ran: the charge posted, or its POST failed and may still post; nothing voided) now also ends the iteration on the governed `create` streams: the loop's last step, or the `break` that ends it early, throws it (a throw from the caller's own loop body wins instead, so the refusal then reaches `.receipt` alone). Only that refusal ends the iteration: any other settlement error rejects `.receipt` alone, and the loop ends cleanly. Before, only `.receipt` carried the refusal, and a caller who caught the loop without awaiting `.receipt` went on silently. With `failClosed` off, nothing changes: the loop ends at once and settlement stays in the background. A `messages.stream()` caller under `failClosed` must await `.receipt`. The streaming docs now show catching the iteration and awaiting `response.receipt`, tell a voided failure from an `AuditDegradedError` whose work may be billed (`instanceof`; it is exported), say that a throw from the caller's own loop body is not a stream failure (the early exit settles and is charged, like a `break`), and say that the `receipt` returned beside a stream is provisional (`settled: false`).

- **One implausible usage figure no longer bricks a vault, and the session counter follows the ledger's cap (#306).** A count above 100,000,000 tokens in one tier, or an invalid one, is refused rather than counted: holds, sums and subtractions use arithmetic-safe counts only, and the call settles at its estimate. A `usage_implausible` event names the call, the model, the refused figures and what was charged, on every stream path, the headless governor, OpenShell settlement and the unheld record. The session counter is charged what the ledger posts, `min(cost, hold)`, while the receipt and the chain keep the metered cost. A server advertises the `refused` capability.

- **`settlement_unrecoverable`: a record that is on the chain but whose writer reported a failure now says so, and `--tx` no longer crashes on a hand-edited record.** `Governor.recordUnheldSettlement()` answers `{ outcome: "unrecoverable", recorded: true, auditDegraded: true }` when the append was durable but a later write (the sidecar) failed, and `POST /v1/settle` carries `auditDegraded: true` in its 410 body (a clean record has no such key). An exact retry of that record, and a request that shares its in-flight append, answer `recorded: false` with the same `auditDegraded: true`. `usertrust-verify --tx <id>` drops a non-string `transferId` / `transferIdHash` from a record instead of passing it to the renderer.

- **Two `trust()` clients on one vault no longer dead-letter the second client's audit events.** The README's own pattern, `trust(new Anthropic())` and `trust(new OpenAI())` in one process on one vault, gave each client a writer of its own. The first to append took the vault's lock, and every audit write by the other then failed (`AuditWriterLockHeldError`: a live writer in this process) and went to the dead-letter queue instead of the chain. With `audit.failClosed` at its default `false` those calls still settled, so the events were not lost but they were invisible: on 4.1.0, 200 calls through the two clients left 94 events on the chain and 109 in `.usertrust/dlq/dead-letters.jsonl`, with 107 receipts `auditDegraded`, while `usertrust verify` answered `valid: true` and `usertrust health` "healthy". Now every `trust()` client and `createGovernor()` in a process that names a vault appends through ONE writer for it (internally `openSharedAuditWriter`): one mutex, one tail, one lock, released with the last client. A vault is one vault however it is spelled: it is resolved once, when the client is created, to its real path on disk (with a portable fallback where realpath(3) is unavailable, as on musl without `/proc`, used only when it names the same directory and refused otherwise) and keyed by its directories' inode identity, so a symlink, a relative `vaultBase`, another letter case (on a case-insensitive filesystem, macOS's default) or a firmlinked path all share the one writer, and a client created with a relative `vaultBase` keeps its vault, audit trail and spend ledger alike, if the process later changes directory. Existing vaults need no migration: they are the same files, reached by their real path. Each client's `isDegraded()` still counts only its own writes, so one client's failure never trips another's `failClosed`, and a call that finishes after its client was destroyed still lands on the chain without keeping the writer from being released. `createAuditWriter` is unchanged, and still exclusive. A second PROCESS on the vault still cannot write to it (LIMITATIONS §5); its dead-lettered events are now loud and detectable, below. **A vault written by an earlier version with several clients in one process:** run `usertrust verify` after upgrading. It reports each dead-lettered event (the count, the kinds, the transfers with no audit event) and exits 1. `dead-letters.jsonl` holds each one's full event, so keep it; putting dead letters back on the chain is not part of this release.

- **A degraded audit write is loud, not only a receipt flag, and `verify` sees the gap.** `failClosed: false` means "settle anyway", not "say nothing":
  - A governor's writer emits a `USERTRUST_AUDIT_DEGRADED` process warning (`AUDIT_DEGRADED_WARNING`, exported) at its first failed write, and again, with the count, when the client is destroyed (or, when writes are still queued then, once the last of them finishes). It is once per client, not per call, so `process.on("warning")` can watch for it without a storm.
  - `usertrust verify` reads the vault's dead-letter queue against the chain it has just verified. A chain with an event missing still verifies link by link, so a dead-lettered event that is not on the chain makes the vault INCOMPLETE: verify prints the count, the kinds and the transfers with no audit event, reports `complete: false` and `deadLetters` in `--json` (`valid`, the integrity verdict, is unchanged), and exits 1, in plain and anchored mode alike. A dead-letter queue that cannot be read is reported, never read as "nothing missing". Every check of one verdict reads the log ONCE: the dead letters, the caller's receipts and, in anchored mode, the anchors' coverage are judged against the events the integrity walk read, never against the log read again (which let a log changed during the verification pass its walk as one chain and its other checks as another). `usertrust health` matches the dead letters against the chain its integrity line verified, in the same way, and the standalone `usertrust-verify` checks the anchors against the hashes of the events its own walk read.
  - `usertrust health` counts missing events as a chain-integrity failure ("verified, N events MISSING (dead-lettered) [critical]"), with `missingEvents` in `--json`.
  - A dead letter now records the event's `eventHash` when its bytes reached the chain before the failure (a `.meta` sidecar failure after the fsync), so it is not counted as missing. Dead letters are written whole (a short write is looped, as for the log), and as the canonical bytes their checksum covers. A dead letter records the event as it was persisted (its kind, actor and data as hashed), never the caller's input serialised a second time, so an input that would serialise differently twice still matches its own event.
  - A dead letter is trusted only as far as it can be checked. Its checksum is recomputed exactly as it was written, and a record that fails it, or has none, counts as missing (a corrupted `source` can no longer hide a lost event as "not a chain event"). A dead letter counts as on the chain only when the event at its `eventHash` is that same event.
  - `usertrust verify --receipts <file>` checks the caller's own receipts (JSON Lines, or one JSON array) against the chain: a receipt is audited only when its `auditHash` is its own event on the chain, naming its transfer and of the kind that records its spend (`llm_call`, or the action's `actionKind`; an `actionKind` that is not a governed action kind makes the receipt unreadable). This sees a gap the dead-letter queue cannot (a dead letter whose own write failed, or a deleted queue). A receipts file that holds nothing (empty, or only whitespace) is unreadable, never "every receipt found"; an explicit `[]` is a caller with no receipts. A degraded receipt (`AUDIT_DEGRADED` from `trust()`, or `auditDegraded` with a placeholder hash from a headless governor) is audited when the chain holds its own event, by transfer and kind (its `.meta` update failed after the event was written, or a follow-up event failed after it), and otherwise reported. The dead-letter queue takes no part in this check.
  - The shared vault reader skips a chain line that parses but is not an event (`null`, a number, an array), as it already skipped an unparseable one, so `usertrust inspect`, `export` and the UI give a verdict instead of throwing, as verify's completeness checks do over the lines its walk read; `verify` still reports the line as invalid.

- **Under `audit.failClosed`, a client whose audit writer is already degraded refuses a call before it is charged.** A `trust()` client's writer stays degraded from its first failed audit write until the client is destroyed, so every later call on it was always going to be refused. Such a call still placed its hold, reached the provider and settled, and only then threw `AuditDegradedError`: the charge had posted. It now throws `AuditDegradedError` before anything happens: no hold, no provider call (`governAction`: the action never runs), no spend and no audit event. The message says so, and that the client must be recreated after the audit directory is fixed. A writer that fails DURING a call is refused as before. Without `failClosed`, a degraded client runs calls as before, and `createGovernor()` and `usertrust-server` still do not enforce `failClosed`.

- **`governAction` never voids a hold it has already settled.** Under `audit.failClosed`, the check that refuses a call whose audit writer degraded runs after the action's budget commit and ledger POST. Its `AuditDegradedError` reached the action path's failure handler, which voided the hold unconditionally: a void request for a transfer that had just been posted (TigerBeetle rejects it with `pending_transfer_already_posted` and moves nothing). The action path now has the same one-outcome gate as the LLM path: a hold is settled or voided, never both. A failure before the settlement (the action threw, or its own audit write failed under `failClosed`) still voids the hold once.

- **A usage component is held to the plausibility ceiling before it is summed.** The Gemini extractor added components into one tier (the prompt and the tool-use prompt into input, candidates and thoughts into output), and the Anthropic one added the two cache-write TTLs into the write total, BEFORE any figure was checked against `MAX_PLAUSIBLE_TOKENS_PER_TIER`. Two finite components could sum past the safe-integer range or to Infinity, which then read as a missing count: the call settled without a `usage_implausible` record, and an Anthropic payload whose write TTLs summed to Infinity kept only its 1-hour share in the record, so on a model without the 1-hour tier it was charged as provider-reported with no cache write at all. One absurd component was also reported only inside a sum. Each component is now checked first and refused by its own figure (`implausibleBy: "refused"`), so the call is charged at the estimate and recorded as `usage_implausible`, as for any refused figure; components that pass are each at most the ceiling, so their sums stay safe integers. Components that are each plausible but sum past the ceiling are still flagged by the existing per-tier check. The OpenAI extractors only subtract (the inclusive prompt minus its cache tiers), so they had no such sum.

- **Google automatic function calling is governed round by round on `generateContent`.** Each round the SDK would run is its own governed call: held, metered, audited and charged. A denied or failing round ends the call there, and earlier rounds stay settled. The result's `receipt` is the last round's. `receipts`, present only when automatic function calling ran, lists one receipt per round. `generateContentStream` is not governed by this change: a streamed call passes through to the SDK unmetered, as it did before.

- **An OpenAI raw prompt is held to the plausibility ceiling before the tiers are derived from it.** `chat.completions` and Responses usage report an inclusive prompt and subtract the cache tiers out of it, and only the derived tiers were checked against `MAX_PLAUSIBLE_TOKENS_PER_TIER`. An absurd prompt could hide behind a large cache: 150M prompt tokens with 100M cached left 50M of fresh input, every derived tier passed, and the call was charged as provider-reported. The raw prompt (or Responses `input_tokens`), and each cache figure subtracted from it, are now checked first; one above the ceiling is refused by its own figure, the raw prompt under the input tier, so the call settles at the estimate and records `usage_implausible`. **Every OpenAI usage figure is read raw:** in `chat.completions` and Responses, the prompt or input, the completion or output, the cached read and the cache write or creation are each read as the provider sent them, so a present figure that is not a count (an infinity such as `1e400`, NaN, a negative, a string, an object) is refused and the call settles at the estimate with a `usage_implausible` record. Before, such a figure was read as absent, so a cache tier, or the completion or output count (which was never checked at all), could be priced at 0 under a "provider" label. A cache-write fallback field (`prompt_tokens_details.cache_write_tokens`, or Responses `input_tokens_details.cache_write_tokens`) is now consulted only when the first field is missing; a present invalid first field is refused, not skipped over. **Stream labels:** in a stream's `usage_implausible` record, a tier refused on its own figure is labelled `refused` even when the aggregate `sum` check named it first.

### Security

- **CI refuses committed agent config: the `agent-config` check.** Agent config runs on the
  machine of anyone who opens a checkout in a coding agent: Claude Code's `.claude/`, an
  `.mcp.json`, and the Grok and Codex CLIs' `.grok/` and `.codex/`, at any depth, matched as a
  case-insensitive filesystem opens them.
  - A pull request or push that adds, edits or removes agent config the repository has not
    allowlisted fails. The allowlist, `.github/agent-config-allowlist.json`, is empty here.
  - An exact entry may pin its file's `sha256`, for that path as it is written; a file in the
    tree under another spelling of a pinned path fails.
  - Every path a change adds, anywhere in the repository, must be one name to every filesystem:
    each segment only `A-Z a-z 0-9 . _ - [ ]`, unless the allowlist's `nonportable` list names
    it by its exact bytes, and no name it makes, a file's or a directory's, may fold to another
    name in the change's tree.
  - Agent config must be checked out as it is stored: no `working-tree-encoding`, `filter` or
    `ident` attribute may apply to it, and no attributes file may give one of them the literal
    value `unset` or `unspecified`, or hold a NUL byte, where git stops reading it. Nor may one
    apply to an attributes file, at any depth, so git reads at checkout the rules the check read.
    And an attributes file must be a regular file: git before 2.32 reads a symlinked one through
    its link, and git reads no rules from a submodule. Each refusal names the reason for its
    mode.
  - A submodule a change adds, or moves to another commit, must be on the allowlist: its own
    tree can hold agent config.
  - A pull request is checked as the merge commit GitHub tests: what lands, not the branch's head.
  - The launcher counts the guard's exit 0 only beside its own `agent-config: OK` line, so a guard
    that exits 0 without checking fails.
  - Nothing the change controls runs before the guard: only the checkout, with no setup step or
    cache, and the launcher is read from the graded commit's object.
  - A committed Claude Code settings file may hold only `$schema`, and `permissions` that
    tighten (`deny`, `ask`).
  - The guard and its allowlist are read from the base, so a change cannot allowlist itself.
  - `.github/CODEOWNERS` names an owner for the check's launcher and allowlist (`.github/`),
    and for the guard and its tests (`scripts/agent-config-guard.mjs`, `.test.mjs`).

- **Vaults are owner-only, whoever creates them.** usertrust-server, and any governor (`trust()`, `createGovernor()`), created the vault with the process umask's defaults, so under the common `022` every directory was `0755` and every file `0644`: the audit trail, the spend ledger, receipts and pattern memory were readable by any local user, and with content capture on so were prompts and tool inputs. Every directory usertrust creates in a vault is now `0700` and every file `0600`, whatever the umask: the audit log and its `.meta`, the writer lock, the spend ledger, receipts and their index, dead letters, pattern memory, snapshots and restores, board sessions, scope leases and the anchoring directories. A governor opening a vault that an earlier version left group- or world-readable closes its `.usertrust/` directory to `0700` before writing to it, and refuses to start if it cannot. A `.usertrust/` another user owns is refused whatever its mode, because its owner could replace the files written in it: a governor compares the owner of the directory (or of a link's target) with the process's effective uid before accepting or changing it, and never changes a foreign vault, even as root; the CLI commands below warn about one instead. A governor now creates an absent `.usertrust/` itself, before any writer touches it, with an exclusive (non-recursive) mkdir, and puts what is there through the same checks, so a directory another user creates first in a shared, sticky parent such as `/tmp` is refused rather than adopted; a parent directory other users can write to that is not sticky cannot be defended by path checks at all, so keep vaults out of one (see LIMITATIONS.md). A `.usertrust` that is a symbolic link is never changed through the link: a target other users can read is refused, with the `chmod 700 <target>` that fixes it, and an owner-only target is used. The CLI commands that open an existing vault without starting a governor (`inspect`, `health`, `policy`, `verify`, `export`, `anchor`, `snapshot`, `pricing`, `budget`, `audit`, `secret`, `skill`) never change a mode: on a vault other users can read they print a warning on stderr with the `chmod 700` that fixes it, and carry on. The vault base you name (the server's `stateDir`, your project directory) is never changed. On Windows usertrust neither sets nor checks permissions, because POSIX modes do not map to ACLs: the vault folder's inherited ACL decides who can read it, so keep the vault (and a server's `stateDir`) under your own user profile, or give it an owner-only ACL yourself (see LIMITATIONS.md). `usertrust init` creates the same modes: it already closed `.usertrust/` itself, but the directories and files inside it are now owner-only too.

- **A governor writes nothing outside its vault.** Pattern memory went to `.usertrust/patterns/memory.json` under the process's working directory, whatever vault the governor was given, so usertrust-server left a stray `.usertrust/` wherever it was started. It now goes to the governor's own vault (`<vaultBase>/.usertrust/patterns/`).

- **An existing vault no longer creates its parent first, and a linked vault is judged by what the operating system opens (#314).** An existing vault goes straight to the checks, so a vault under a parent this process cannot write still opens. The parents are created, owner-only, only when one is missing. A link target this process cannot open is refused by name, with the fix, instead of failing later with a bare `EACCES`.

- **A real vault directory this user owns, whose mode is already owner-only, is refused by name when this process cannot write to it (#320).** The refusal comes before anything is written, and gives the mode and the `chmod 700` that fixes it, instead of a bare `EACCES` at the first write. Nothing is tightened in that case.

- **A vault reached through a symbolic link is judged by `stat(2)` (#318).** The kernel resolves the link, so a `..` after it judges the directory the operating system reaches, and a linked vault whose target is `0300` (write and search, no read) is accepted. A target this process cannot reach or write to is refused by name with its fix. A dangling link and a path through a non-directory keep their own refusals, and nothing is changed through a link.

- **`usertrust init --reconfigure` no longer writes a new API key into a `.env` other users can read.** `.usertrust/.env` was written in place with `mode: 0o600`, which applies only when a file is CREATED: a reconfigure over an existing 0644 `.env` truncated it and wrote the new key into that 0644 file (and through a symlinked `.env` into its target). The owner-only vault directory above already keeps other users from reaching it; this fixes the file's own mode too, so a key never sits in a group- or world-readable file. `.env` is now written to a fresh temp file beside it, created exclusively, not following a link, owner-only (`fchmod` 0600 whatever the umask), fsync'd, then renamed over `.env`, and the directory fsync'd (`writePrivateFileAtomic`, in `shared/private-fs.ts`). A new or rewritten `.env` is always mode 600, the old file is never written, and a symlink is replaced rather than followed. The temp file is removed on any failure, and the vault's `.gitignore` now also lists `.env.*.tmp`.

- **A vault base with `..` is resolved where the operating system resolves it.** A governor (`trust()`, `createGovernor()`) built every vault path by joining onto its `vaultBase`, and joining folds `..` as text: for a base `link/../vault` where `link` is a symbolic link to `x/y`, usertrust named `<cwd>/vault`, while the operating system follows the link first and opens `<cwd>/x/vault`. usertrust-server did the same to a `..` in `stateDir` before a governor saw it. A base that contains a `..` segment is now resolved by the system's own path resolver (realpath(3)): the deepest part of it that exists is resolved, and the rest is appended. A base without `..` is used exactly as given. On Windows a drive-relative base such as `C:tenant\..\vault` is taken relative to that drive's working directory, not the current drive's. When a governor resolves its base it says so once, on stderr, when it is created: `usertrust: vault base "<as given>" resolves to "<real path>"`, with any control character in either path shown as an escape (`\n`, `\x1b`), so a directory name cannot forge a line or drive the terminal; the refusals below name the base the same way. Two bases are refused by name: one with a `..` after a directory that does not exist yet (where it would lead cannot be known until that directory exists), and one with a `..` on a system where realpath(3) does not work, since usertrust never falls back to resolving `..` as text. usertrust-server now builds a tenant's vault base as `stateDir`, without its trailing separators, followed by the tenant id, so a `..` in `stateDir` reaches the governor as written. Its start-up ledger probe resolves that base as the governor does, so it reads the `usertrust.config.json`, and probes the ledger, that the tenant's governor will use; it refuses the same bases, naming the tenant. `kernelVaultBase` is exported for a host that needs the same reading.

### Dependencies

- **The production dependency ranges are raised for `@clack/prompts`, `yaml` and `zod` in usertrust, and for `zod` in usertrust-server.** (#286)

### Known issues

- A stream aborted by the caller's own `AbortSignal` is not charged for the usage it consumed (OpenAI and Anthropic `create({ stream: true })`). Fixed in the next release.

- Under `failClosed`, if the audit writer is already degraded, refusing an ungoverned Anthropic or OpenAI method attempts an audit append and rejects with `PolicyDeniedError` instead of refusing at once with `AuditDegradedError`. No call reaches the provider. Fixed in the next release.

- With a ledger-backed usertrust-server, if the ledger becomes unreachable, authorize calls hang without an answer (health stays ok), and a request the client abandons can leave a hold reserved for up to 300 s after the ledger returns. Use a client timeout.

- A ledger-backed usertrust-server stopped by SIGINT or SIGTERM with a pending hold can exit before ending it: the hold may stay reserved until the ledger's 300 s timeout, and its release may not be recorded.

## [4.1.0] - 2026-10-08

### Added

- **Every ledger record can say which job it was spent on: `job`, `jobState`, `usageFrom` and `usageTo`.** `AuthorizeParams` takes `job` (an opaque id under the principal's field rule), `jobState: "invalid"` (the caller's job state could not be trusted; exclusive with `job`) and `usageFrom` (an ISO-8601 UTC instant: when the usage the hold covers began). They are captured once at authorize into the governor's own record and spread onto every record the hold produces: `llm_call`, `llm_call_failed`, `hold_released` (a release, a TTL expiry, `destroy()`), `settlement_*`, `policy_denied`, `ledger_rejected` and the rotated receipt. `SettleParams` adds only `usageTo`, validated before the claim. A job is a label, never a payer: it selects no account, enters no policy context, prices nothing and takes none of the principal's three `user_data` slots. An unlabelled call's records are unchanged. usertrust-server accepts `job`, `jobState` and `usageFrom` on `POST /v1/authorize` and `usageTo` on `POST /v1/settle`, and advertises `"job"` in `/v1/health` `capabilities` (dryRun too); an older server strips the keys in silence, so a client sends them only to a server that lists it. A settle may name `job` / `jobState` only to be checked against the hold's: a different one is a `400` with nothing written and the hold still settleable, and a settle that states `usageFrom` is a `400` (the authorize capture is the one source of a usage start). `usageTimeRefusal` is exported beside `principalFieldRefusal`. `Governor.release(auth, reason?, { releaseClass? })` and `POST /v1/release` take a structured `releaseClass` (`unused`, `call-unconfirmed`, `call-ran`) recorded on `hold_released`; a release that states none proves nothing. `Governor` implementations outside this repo are unaffected.

### Fixed

- **1-hour cache writes are priced at the 1-hour rate** (closes #203; the 5-minute collapse documented under #209). Anthropic bills a 1-hour cache write at 2x base input and a 5-minute one at 1.25x, but the settle contract had one write tier, so every 1-hour write was under-priced by 37.5%. `cacheWriteTokens` stays the TOTAL written and a new `cacheWrite1hTokens` is its 1-hour SUBSET (clamped to it; sent alone to `settle()` it is not usage, so the settle meters at the estimate). `ModelRates.cacheWrite1hPer1k` is explicit on every Anthropic row (the page's "1h cache writes" column, read raw on 2026-10-08 for all 20 models; `PRICING_TABLE_VERSION` is now `2026-10-08`, since v4.0.0 shipped a different table under `2026-10-07`; `customRates` accepts it too), and an absent one resolves in one place to the dearer of the 5-minute write and 2x input. The split rides through every path that carries usage: the non-stream and both stream surfaces (`cache_creation.ephemeral_1h_input_tokens`), `Governor.settle()` (`SettleParams.cacheWrite1hTokens`), `usertrust-server` (`POST /v1/settle`, advertised as `cache-write-1h` in `/v1/health` `capabilities`; an older server strips the key, so a client sends it only when listed), the Claude Code plugin (which reads the transcript's per-TTL breakdown and sends the share only to a server that lists the capability), the OpenShell settlement and gate, and the anomaly detector's spend velocity. A host with no TTL split (the OpenClaw plugin) and a payload that carries only the flat write total still price at the 5-minute rate. **On the receipt**, a call that wrote 1-hour cache carries a new ROOT field `cacheWrite1h: { tokens, ratePer1k }` (also on the `llm_call` chain event), never inside `usage` or `pricing.appliedRates`, which the v2 schema closes: it is absent otherwise, so every other receipt is byte-identical, every existing v2 validator accepts the new one, and the released `usertrust-verify` verifies its chain. An auditor's recompute splits the write term: `(usage.cacheWriteTokens - cacheWrite1h.tokens) x cacheWritePer1k + cacheWrite1h.tokens x ratePer1k`. **Holds**: a hold cannot be smaller than the settle it must cover, so the 1-hour write rate joins the hold's input-leg max for the worst case THIS REQUEST can produce. `trust()` reads the request and reserves it only when the request declares a 1-hour TTL (`cache_control` with `ttl: "1h"` anywhere in it); headless `authorize()` cannot see the TTLs and reserves the dearest write rate, so **holds on headless Anthropic calls run about 60% fatter on the input leg** (2x input against 1.25x) and a 402 near the budget comes sooner; a table model whose row publishes no 1-hour rate (it has no such tier) holds as before and ignores a reported 1-hour share at settlement, so hold and settle agree, while operator-owned rates (a custom row, a local rate, the fallback) with no 1-hour rate hold the derived 2x input, matching how their 1-hour tokens are metered. The fallback's 1-hour cache-write rate is 500. (fallback 1-hour rate added to this entry after release)

## [4.0.0] - 2026-10-08

### Added

- **A hold given back is a release, not a failure: `POST /v1/release` and `Governor.release()`.** Headless gets a third terminal beside `settle` and `abort`. `release(auth, reason?)` voids the hold, gives back its in-flight budget, and writes a neutral `hold_released` record (`model`, `transferId`, `reason`, `source`, and `costCenter` / `principal` when the hold had them). It touches the circuit breaker not at all: not a failure, and not a success either, so give-backs can neither open the breaker nor close one that real failures opened. `abort()` keeps its meaning, a call that failed. It answers `{ released: true }` only when that call ended the hold, and `{ released: false }` when the governor no longer held it (its settle in flight, or already settled, aborted or released). A void that failed still ends the hold, named in `voidError` by a fixed code for its cause (TigerBeetle's status name for a void it refused, `no_pending_entry` when the engine held no record of the hold, otherwise `ledger_unavailable`), never by the error's text. The reason is caller text, so it is recorded through `sanitizeReleaseReason` (exported): every control character stripped, then clipped to 200 code points. usertrust-server exposes it as `POST /v1/release` with body `{ transferId, reason? }`, publishes `"release"` in `/v1/health` `capabilities` (dryRun too), and announces it as a `released` event carrying that same sanitized reason. It answers `200 { released: true, transferId }` (with `voidError` when the void failed) only when the governor ended the hold. An unknown or another tenant's id, or a hold the governor no longer held, is `404 { error: "not_found", reason: "unknown transferId" }`. The Claude Code plugin 1.4.0 already gives every hold back through `/v1/release` when the server publishes `release`, so no plugin change is needed. usertrust-verify resolves a `hold_released` record as RELEASED, a conclusive terminal like a failure: a later `settled: true` for the same transfer cannot rewrite it. The UI shows it as `released`. `Governor` implementations outside this repo must add `release()`.

- **usertrust-server: every authorize states the hold's remaining life.** The `200` answer to `POST /v1/authorize` carries `expiresInMs`: the longest the hold can still be pending. That is the shorter of the server's `pendingTtlMs` sweep and the ledger's own pending timeout, counted from when the request arrived, in whole milliseconds. No expiry ends the hold sooner, though a settle, a void or a server restart can. It is a duration, so a client on another machine adds it to its own clock reading taken before it sent the request, and gets a time no later than the hold's last moment whatever the offset between the clocks. A ledger hold whose timeout the server cannot state gets no `expiresInMs`. The answer reads a hold's age on a monotonic clock, so a wall-clock step cannot lengthen it. The sweep ends a hold when its advertised life runs out: with `pendingTtlMs` above the ledger's timeout, the hold's budget is freed at the ledger's timeout instead of being held until `pendingTtlMs`. The sweep reads the same monotonic age, so no wall-clock step moves it, and it never ends a hold before its advertised life. Declared: After the host sleeps, a hold that was pending across the sleep can keep counting against the budget for at most one hold life (T, 300 s by default) plus up to one sweep interval (30 s) after wake. In enforce mode that can mean false denials. It's the safe direction: nothing is charged and the ledger releases the funds on time. A TigerBeetle-state probe for this case is a follow-up (#241). `/v1/health` advertises `"hold-expiry"` in `capabilities`, in dryRun too. Underneath, both governors' engines now pass the TigerBeetle pending `timeout` explicitly (`LEDGER_HOLD_TIMEOUT_MS`, 300 s, the value the client defaulted to before), and a headless `Authorization` carries it as `holdTimeoutMs` (absent in dry run). In the receipt spec's terms these SDK holds are not armed: like every SDK hold before (then by the client's implicit default), they carry the ledger's 300 s timeout, where §15.2 RA-1 requires `timeout = 0` of an armed hold. Only the proxy mints in v1 (R2-7), so nothing mints from them today, but SDK minting would have to account for this before it adopts the projection unchanged.

- **Headless: per-tier estimates at authorize.** `authorize()` takes optional `estimatedCacheReadTokens` and `estimatedCacheWriteTokens` (non-negative integers; anything else is a `TypeError` before any I/O). Each cache tier is held at its own resolved rate, the same resolution settle uses, and only the fresh-input estimate keeps the D3 cache-write premium. A mostly-cache-read window is no longer reserved at the cache-write rate: on Sonnet, the window fresh 150 / read 82,000 / write 2,000 / output 1,000 holds 477 usertokens instead of 3,306 when all of it is sent as input. Omitted tiers are 0, so existing callers are held exactly as before. `usertrust-server` accepts both fields on `POST /v1/authorize` and advertises `"authorize-cache-tiers"` in `/v1/health` `capabilities`.

- **Headless: who did the work, on every record and on the ledger.** `authorize()` takes an optional `principal` — `{ id?, type?, origin?, unit?, role? }` (agent instance and kind, where the work came from, business unit, role). Each field is 1–128 characters of `[A-Za-z0-9._:-]`; an invalid field is a `TypeError` before any I/O. The principal is captured once, frozen, and recorded on `policy_denied`, `ledger_rejected`, `llm_call`, `llm_call_failed`, `settlement_ambiguous`, `settlement_shortfall` and the rotated receipt; with no principal, the key is absent. The PENDING hold carries it as TigerBeetle `user_data` tags (`id` → `user_data_128`, `unit` → `user_data_64`, `role` → `user_data_32`), which the post and void inherit, so `query_transfers` can roll work up by agent, unit and role. `principalLedgerTags()` computes the filter values and `principalFieldRefusal()` is the field rule; both are exported, with the `Principal` type, from `usertrust` and `usertrust/headless`. A principal never selects the account that pays — that is still `withCostCenter`. `usertrust-server` accepts `principal` on `POST /v1/authorize`, validated with the same rule, and refuses an unknown key instead of stripping it. `GET /v1/health` now publishes `capabilities` (`["principal"]`, in dryRun too): an older server strips the key, so a client checks the list before sending a principal.

- **openshell: the hold journal's schema is versioned** (`PRAGMA user_version`, now 2). A journal written by the slice-1b code (version 0, with `admit_by` and without `incident_json`) is **migrated at open** in one transaction: the `incident_json` column is added and version 2 is stamped together, and every hold row and all recorded debt are kept. The migration is decided inside the write lock, so concurrent openers of one file all succeed. Any other version (newer, whatever tables the file has, or a v0 whose columns differ from that schema) is refused with `JournalSchemaError` before anything is written: the file is left byte-for-byte untouched, with no WAL switch. The error never advises recreating a journal: doing so would forget recorded debt and drop holds in flight.

- **The audit writer is exported, with an eager lock.** `createAuditWriter`, `AuditWriter`, `AppendEventInput`, `CreateAuditWriterOptions` and `AuditWriterLockHeldError` are now exported from the package entry. `createAuditWriter(vaultPath, { lockAtCreate: true })` takes the vault's advisory lock in the factory, so a second writer fails at creation with `AuditWriterLockHeldError` instead of at its first append. That second writer can be another live process, or another live writer in the same process. The default (`lockAtCreate` omitted or `false`) is unchanged: the lock is taken at the first append.

- **`isModelPriced(model, customRates?)`** — true only when a model has rates of
  its OWN: an operator custom rate or an EXACT pricing-table entry. It is for a
  caller that must refuse what it cannot price exactly rather than bill it at a
  guess. It is deliberately stricter than `getModelRates`, which meters a dated
  snapshot (`-YYYYMMDD` or `-YYYY-MM-DD`) at its base model's row when the
  snapshot has no row of its own, and prices any other unknown id (`o3-pro`, a
  `-pro` or `-fast` tier) at the dearest-known fallback.

- **Core exports `TBTransferError` and `XFER_SPEND`** from the package entry. `TBTransferError` is the base of the replay errors already exported, so a caller can read a failed transfer's `code` without an internal import.

### Fixed

- **A destroyed ledger client no longer reconnects** (closes #249). `TrustTBClient` kept no record that it was destroyed, and its reconnect logic read the native client's `Client was closed.` as a lost connection. An operation in flight when `destroy()` closed the client (a reserve, a settle's POST, a health-check ping) therefore reconnected through a fresh native client and retried on it, and nothing ever destroyed that client. An open TigerBeetle client keeps the process alive after shutdown. Measured against TigerBeetle 0.17.9: a reserve held across a governor's `destroy()` left 2 clients built and 1 destroyed. `destroy()` now sets a `closed` flag first, and from then on nothing reconnects:
  - an operation in flight at `destroy()` fails with its own error;
  - no request reaches a native client after `destroy()`, wherever `destroy()` lands in an operation: between two of its steps, or between a lost connection's reconnect and the retry. Each request is checked when it is made, so a step or retry that would have come after `destroy()` fails with `LedgerClientClosedError` instead. That holds even when the native destroy throws and leaves its client open, which would otherwise let a transfer execute after `destroy()`. Once the native destroy has returned, the client holds a stand-in that refuses every request. A native destroy that throws keeps its client, for a second `destroy()` to retry;
  - an operation started after `destroy()` fails with the new, exported `LedgerClientClosedError`, without reaching the native client, whatever its arguments. The check comes before the operation's own input checks (a reserved name, a transfer id out of range, a fractional amount, a treasury never set), so a caller can tell shutdown from a refused input. It also comes before any shortcut that would have answered without the ledger, such as `createUserWallet()` with a cached id or `lookupBalances([])`. `ping()` reports unhealthy, its start-up grace period included, and `reconnect()` is refused, even while a reconnect that just finished is still cached;
  - a reconnect that was waiting out its backoff builds nothing, and every operation awaiting it fails with `LedgerClientClosedError`.

  A POST that committed but lost its reply when the client closed used to be retried into an `exists` success, on a client nothing destroyed. It now fails, and a settle records `settlement_ambiguous`. The charge stands on the ledger; only the record is less certain. Unchanged: a settle still posting past `destroy()`'s drain bound could already lose its charge, because `destroy()` voids every pending transfer before it closes the client.

- **Model pricing is exact, current and fails dearest** (closes #209; removes the prefix match that #143 reports, which stays open). Re-verified against Anthropic's pricing page on 2026-10-07 (`PRICING_TABLE_VERSION` `2026-10-07`). `claude-sonnet-5` is $2 / $10, not $3 / $15: the announced increase did not happen, and the old row overstated every Sonnet 5 call by 50%. New exact rows: `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `claude-mythos-5`, `claude-mythos-5-1`, `claude-mythos-preview`, `claude-haiku-5-5` (priced at its over-100,000-token tier, an overstatement for shorter prompts), the older Opus / Sonnet / Haiku ids the page still lists, `gpt-4o-2024-05-13` (priced above `gpt-4o`) and `mistral-large-latest`. Cache reads are 0.05x on Opus 5.5 and Sonnet 5.5 and 0.025x on Fable 5.1 and Mythos 5.1, not 0.1x. **`getModelRates` and `resolveRates` no longer prefix match**: a longer id used to be billed at a shorter key's row with `rateSource: "table"` (`claude-sonnet-5-5` at `claude-sonnet-5`). Lookup is now an exact row, then the id with one trailing `-YYYYMMDD` or `-YYYY-MM-DD` stripped, then `FALLBACK_RATE`. **`FALLBACK_RATE` is now the highest rate in the table** (250 / 1250, cache write 312.5), no longer sonnet-class 30 / 150, so an unknown id over-counts visibly (`rateSource: "fallback"`, `unknown: true`) instead of under-counting silently. A consequence to expect: an unknown model's hold at the default `max_tokens` is far larger, so a small budget refuses it before the provider is reached, and the spend-velocity anomaly trips sooner for it. Fast mode (a `speed` usage field) is still not priced: #256. The fleet rollup's list-price table follows the same lookup rule and carries the per-model cache-read multipliers. (corrected after release: #143 remains open)

- **usertrust-server's `/v1/abort` answered 200 for a hold it had not aborted** (addresses #240). It answered `200 { aborted: true }` whatever the governor did, and published an `aborted` event, so an abort of a hold the governor no longer held (its settle in flight, or already ended) said it had aborted it. It now keeps `/v1/release`'s rule: `200 { aborted: true, transferId }` (with `voidError` when the ledger refused the void) only when the governor ended the hold, else `404 { error: "not_found", reason: "unknown transferId" }` with no event, and the entry stays out. A governor that throws still puts the entry back, so a failed abort stays retryable. The answer's type is exported as `AbortResponse`.

- **Headless `destroy()` no longer ends a hold under a terminal still working on it, or with no record** (addresses #243). It waited for settles only. An `abort()` or `release()` that had claimed its hold and was parked on its ledger void (or the budget lock) was in neither map `destroy()` walks: the engine sweep voided the hold under it, and its record landed after the audit writer was released, taking the vault's lock again. `destroy()` now waits for those too, under one 5 s deadline shared with settles, never one per kind. At the deadline it takes every remaining hold in one synchronous step, before its first await, so no terminal can claim one while it records another. An abort or release still in flight is recorded by `destroy()` (`hold_released`, reason `governor destroyed (terminal still in flight: its void had not completed)`, and no `voidError`: there was no outcome yet), and writes no record of its own when its void lands; it still answers its caller from its own void. Every hold still held is voided and recorded as `hold_released` with reason `governor destroyed`, attributed as the hold was, with `voidError` when the ledger refused the void. These records carry no `model`: the governor keeps none per hold. Declared, unchanged: the engine sweep that follows writes no record, because what it can still find has one already, though an abort or release whose own void failed may have its funds returned by that sweep while its record names the `voidError`. A settle still posting at the deadline keeps its own records, which still land after the writer is released, and that late append takes the vault's lock again (#245).

- **A give-back or an expired hold no longer opens the tenant's circuit breaker** (addresses #238 and #204). Every hold a client gave back through `/v1/abort`, and every hold usertrust-server's own TTL sweep or shutdown ended, went through `abort()`, which counts as a breaker failure and records `llm_call_failed`. Five in a row opened the tenant's breaker, and every authorize then answered `500` for at least a minute after the last of them, though nothing had failed. The sweep and shutdown now RELEASE (above), and a client that gives holds back through `/v1/release` never feeds the breaker at all. A client's `/v1/abort` after a failed call still counts: five still open it.

- **Headless: a caller's getter can no longer end a hold that `settle()` is settling.** `settle()` claimed its hold and then read caller input: the `SettleParams` fields and the handle's own. A getter there that called `abort()` (or the new `release()`) on the same hold found it in the "claimed, not yet posted" set, claimed it too, and the ledger got a POST and a VOID for one hold, with two terminal records and the in-flight budget given back twice. It was pre-existing in `abort()`. The server path cannot reach it, because its settle parameters are parsed JSON.
  - `settle()` now reads every `SettleParams` field once, before it claims anything. A getter that ends the hold is then the first terminal, and the settle is refused; a getter that throws leaves the hold untouched and still settleable.
  - `settle()` also owns the hold from its claim to its end, so the handle's own getters cannot end it underneath, and a settle that throws before its POST hands the hold back, voidable again.

- **An expired TigerBeetle hold no longer leaks an engine entry.** TigerBeetle ends a pending transfer itself at its timeout and returns the funds; a void sent after that answers `pending_transfer_expired`. Both `createTBEngine` factories threw it, so the hold's in-memory entry stayed until the governor was destroyed: one per expired hold, and at the default lives nearly every swept hold. It now counts as done, as `exists` already does. `TrustTBClient.voidTransfer` itself still throws it.

- **Headless settle-side records named the caller's `actor`.** `llm_call`, `llm_call_failed`, `settlement_ambiguous`, `settlement_shortfall` and the rotated receipt hard-coded `actor: "local"`, so an integration's `actor` survived only on denials. They now record the actor captured at `authorize()`.

- **Every package's tests are typechecked (#193).** The packages' tsconfigs include `src` only, so a test could assert on the wrong shape and still pass. `tsconfig.tests.json` now typechecks `packages/*/tests`, run by `npm run typecheck` under a ratchet: the 414 existing errors (outside the openclaw host contract, which its own job typechecks) are frozen per file and error code in `tsconfig.tests.baseline.json`; a new or grown one fails, and a fixed one fails until the baseline is tightened (`npm run typecheck:tests -- --update`). openshell's tests start at zero.

- **`TrustTBClient.immediateTransfer` range-checks a caller-supplied id like its siblings** (#183). An id outside (0, 2^128 − 1) — 0, 2^128 − 1, a negative, or wider — now throws `RangeError` before any client call, as `createPendingTransfer`, `postTransfer` and `voidTransfer` already did. It previously failed later (TigerBeetle refuses 0 and 2^128 − 1, and a negative or wider value throws at serialisation); no transfer was ever created.

- **Two spellings of one vault could fork its audit chain.** The audit writer's in-process lock registry was keyed on the vault path as written, so a second writer opening the same vault through a relative path or a symlink (including macOS's `/tmp` → `/private/tmp`) missed the first writer's entry, found the lock file, and "reclaimed" that LIVE same-process lock as stale. That left two live writers on one chain, which forks it silently. Every lock key now uses the directory's real path (`realpathSync`), on both `createAuditWriter` and `withAuditWriterLock`, so the second writer gets `AuditWriterLockHeldError` and the first writer's lock is untouched. The lock-held message now names the lock file by its real path. (Present since the in-process registry was added; reachable by integrators now that `createAuditWriter` is exported.)

### Security

- **usertrust-claude-code no longer auto-approves tool calls; permission prompts return to Claude Code's normal flow.** Its PreToolUse hook answered `allow` on every call it let through (a reservation, a shadow answer, and a call let through by `UT_FAIL_OPEN=1`), and a hook's `allow` skips the permission prompt Claude Code would otherwise show (deny and ask rules still apply), so installing a budget plugin silently approved every call no permission rule covered. The plugin now never grants permission. The only decision it makes is `deny`; every call it does not block gets no decision and goes through the user's own permission settings. Users who installed v1.3.0 (or earlier) will see the permission prompts it had been silently skipping.

### Changed

- **Headless: calls that overlap `destroy()`** (addresses #243). The calls that would race `destroy()` for a hold are refused before they claim anything:
  - an `authorize()` still reserving when `destroy()` begins registers no hold. One could finish afterwards and hand back a live hold on the destroyed governor, which a later terminal could end after the audit writer was released. It now gives back its in-memory session accounting and throws `Governor has been destroyed`, as an `authorize()` called after `destroy()` already did. Its reservation is released by the ledger within 300 s of its reserve (the pending timeout every hold carries), unless `destroy()`'s engine sweep, which voids every reservation that landed before it, voided it first. The governor sends no void of its own: that void would reach a ledger client `destroy()` may already have closed (#249). It writes no record: a granted authorize writes none, and this one never became a hold the governor owned;
  - a `release()`, `abort()` or `settle()` called once `destroy()` has taken the remaining holds at its deadline is refused: `release()` and `abort()` answer `{ released: false }` / `{ aborted: false }`, with no void and no record, and `settle()` throws `Governor has been destroyed`. `destroy()` voids and records those holds itself. While `destroy()` waits for terminals, these calls run as before and are waited for: a settle started then still posts its charge, once.

- **`Governor.abort()` answers what it did, as `release()` does: a breaking change for `Governor` implementers** (addresses #240). It returns an `AbortOutcome` (exported from `usertrust` and `usertrust/headless`): `{ aborted: true }` only when that call ended the hold, and `{ aborted: false }` when the governor no longer held it (its settle in flight, or already settled, aborted, released or destroyed). A void the ledger refused still ends the hold and is named in `voidError` by `release()`'s fixed codes, on the answer and on the `llm_call_failed` record, never by the error's text; usertrust-verify prints it under FAILED as it does a release's. Callers that ignore the result are unaffected. An implementation of `Governor` must return an `AbortOutcome`.

- **Billing: an empty Claude Code plugin hold no longer posts a 1-unit charge.** A tool call whose transcript window is empty (a parallel call in the same response, say) gave its hold back by settling it at zero usage, and the server's 1-unit floor posted a real charge, with an `llm_call` record, for a call that used nothing. Against a server that publishes `release`, the 1.4.0 plugin releases such a hold instead: a void and a `hold_released` record, no charge. Those zero settles also stop counting as circuit-breaker SUCCESSES: they used to reset the consecutive-failure count between real failures, so a tenant mixing plugin traffic with SDK callers that `/v1/abort` failed calls sees that reset less often. That is the right meaning, since those rows were never model calls. No minted receipt is affected: only the proxy mints (receipt-spec §15.2 and §15.5, scoped by R2-7), and a release is a void.

- **usertrust-server's shutdown announces `released`, not `aborted`.** `close()` releases every remaining hold with the reason `server shutdown`, and the event a subscriber receives for each is now `released`. The TTL sweep keeps its `pending_expired` event.

- **Published usertrust-verify 3.4.0 and earlier read a released hold as PENDING.** It does not know `hold_released`, so it renders that record PENDING and does not treat it as conclusive. Verify chains from a server with this change with the usertrust-verify that ships alongside it.

- **usertrust-claude-code is watch-only by default.** Installed, the Claude Code plugin never blocks a tool call and makes no permission decision. A call the server refuses (402/403/429) is written down as a `would_block` record, and a call it could not meter as a `gap` record, in `watch.jsonl` in its state dir, and each session opens with a message naming the mode. `UT_CC_MODE=enforce` blocks, as the plugin did by default before: set it to keep that behaviour. `UT_CC_UNIT` / `UT_CC_ROLE` add an optional `unit` / `role` to the principal it sends to a server that records one, on the transcript and the estimate path alike.

- **A held audit-writer lock throws `AuditWriterLockHeldError`** (minor, additive). It used to be a plain `Error`. It is now a subclass of `Error` with the **same message**, so existing `catch` blocks and message checks behave as before, and a caller can now tell "held" apart from other failures with `instanceof`.

- **`TrustTBClient.immediateTransfer` verifies a caller-supplied id like the other transfer paths** (#178). With a `transferId` supplied: an `exists` answer is verified against the stored transfer (a mismatch throws `TransferReplayMismatchError`), and an id whose first attempt failed throws `TransferIdRetiredError` (still a `TBTransferError` with code `id_already_failed`), as `createPendingTransfer`, `postTransfer` and `voidTransfer` already did. A minted id (no `transferId`) is unchanged.

- **`TrustTBClient.voidTransfer` throws `TBTransferError` on failure** (minor, additive). It used to throw a plain `Error`; it now throws the same `TBTransferError` every other transfer path throws, carrying the TigerBeetle status as `code`. That lets a caller tell an already-expired hold (`pending_transfer_expired`) from a real failure. The message is unchanged ("Void transfer failed: …"), and `TBTransferError` extends `Error`, so existing `catch`, `instanceof Error` and message-matching callers behave exactly as before.

## [3.4.0] - 2026-08-29

### Added

- **`usertrust-verify receipt <file> --trust <snapshot.json>` — the offline
  half of the trust story.** A zero-dependency, zero-network CLI mode that
  reads a signed ut1 receipt plus a PINNED `receipt-spec` §8 trust snapshot
  and runs §7 steps 1–9 entirely offline: the strict byte reader (canonical
  base64, fatal UTF-8 with `ignoreBOM: true`, pre-parse duplicate-key
  rejection, frozen numeric rules — non-integer / `-0` / non-safe-integer /
  `Infinity`/`NaN` refused on the numeric LITERAL during that same pre-parse
  scan, never as a thrown `canonicalize`; checking the parsed VALUE instead
  would be too late, because `JSON.parse` rounds `1.00000000000000001` to
  exactly `1` and the receipt then verifies against a canonical preimage its
  own bytes do not spell),
  the nine event-hash equalities, the mint signature (including the retired
  MINT-key boundary evaluated through the mint event's own segment, not
  merely "state permitting"), Merkle inclusion topology derived from
  `(leafIndex, treeSize)`, the checkpoint signature and lineage pin, §2's
  semantic constraints, the `transferSetRoot`/`amountUsd` derivation, and —
  with `--envelope` — the full history walk back to the registered
  `genesisSegmentId` with every checkpoint's signature re-verified under the
  §8 lineage. `--trust` is required and never fetched: an implicit fetch
  would silently unpin the verifier, so absent key material reports
  UNVERIFIABLE rather than reaching out for it. `--envelope` reads the
  receipt from the resolver envelope's byte-authoritative `receiptBytes`
  member (never its `receipt` convenience copy) and runs the R4 agreement
  check between the two — a STRUCTURAL comparison (`Object.is` on numbers,
  key order ignored), not a canonical-string one, since a serializer erases
  exactly the distinctions the check exists to find (`-0` renders as `0`). `--expect-id` binds arrival context (a bare
  `ut1_…`, a resolution URL, or a `Usertrust-Receipt:` trailer line).
  `--json` puts the machine-readable report on stdout ONLY — every
  diagnostic goes to stderr, so `| jq` is safe — with every field nullable
  on the failure path that cannot produce it, `delegationPosture` labels
  travelling with `amountUsd` (an unlabelled or unrecognized posture fails
  the semantic check rather than rendering an ambiguous total), and every
  untrusted string (keyIds, snapshot version/predecessor, failure detail,
  receipt IDs) control-character sanitized before truncation. Exit codes are
  0 (`VERIFIED_CHECKPOINT` or higher — the rung itself is in the report, not
  the code), 1 (FAILED, step + code named), 2 (UNVERIFIABLE, required
  material missing), 3 (usage error, receipt mode's own handler — never the
  shared vault `usage()`, which exits 1 and would misreport a typo as
  FAILED). `--help`/`-h` is recognized at any argv position, same as vault
  mode's own loop, and also exits 3: no verdict was reached, so it must
  never share 0 with `VERIFIED_CHECKPOINT` — an unsanitized `<file>`
  argument of literally `--help` must not be able to read as verified to a
  scripted caller keying on exit status alone. This is what the
  `/r/<receiptId>` verify page's download affordance points at, closing the
  loop that entry above left open.

  **Deliberately incomplete, and says so out loud rather than guessing.**
  Anchor (Rekor) evidence is reported OUT OF BAND, never as a §7 value: if
  absent the check is `notApplicable`; if present it is omitted from
  `checks` and named in a top-level `unimplemented: ["anchorEvidence"]`,
  because none of §7's four verdict values means "the verifier declined to
  look" and claiming one would misstate why the check didn't run. The
  verdict ladder is capped below `VERIFIED_ANCHORED` accordingly — no input
  can upgrade past it — pending a normative artifact-hash rule binding
  Rekor evidence to a `SegmentCheckpoint`'s signed payload, which belongs to
  whoever mints anchors. Trust-snapshot signature verification is likewise
  deferred to when receipt-spec §8's signing scheme ships; until then the
  snapshot's structural rules (unique/resolvable keys, one-lineage-one-vault,
  role/kind consistency, acyclic rotation, `activationSequence` bound to
  `state`) are the only defense, and any violation is UNVERIFIABLE, never a
  pass. `registryBinding` and `predecessorLinkage` report `notApplicable` —
  offline has no registry to check against — though both stay in the
  `--json` vocabulary for resolver-side consumers replaying a report.

  **`packages/verify/src/canonical.ts` is left non-conformant with
  receipt-spec §13 on this ship, deliberately.** §13's 79-case differential
  found `core/src/audit/canonical.ts` and `verify/src/canonical.ts`
  code-identical and bug-compatible with each other (`undefined` → the JS
  value rather than `null`; `[1,undefined,2]` → `[1,,2]`; and two SILENT
  divergences that stay valid, parseable JSON at a different digest —
  `[undefined]` → `[]` and `{a:[undefined]}` → `{"a":[]}`) — and states
  plainly that **"Core and verify MUST be corrected together; fixing verify
  alone splits ut1's two implementations against each other, which is worse
  than the status quo."** Correcting only this package's copy would do
  exactly that split, so the fix is deferred to a follow-up that lands both
  sides at once. The divergence is unreachable from parsed wire data (every
  key in a ut1 document is a concrete JSON value, never `undefined`), so
  this is an honesty gap, not a soundness one — but it means this ship's
  verifier is bug-compatible with the SDK minter, not §13-conformant.

  **Every field the specs give a FORMAT is checked against it, and the check
  is a table rather than a list of fixes.** Two review rounds found nine
  soundness holes that were one hole nine times: the verifier checked
  STRUCTURE (present? a string?) and never FORMAT (the thing §2 declares) —
  a sibling hash of `<64 hex>zz` folded to the SAME root, because Node's hex
  decoder stops at the first non-hex pair and drops the tail, so the proof
  verified here and would FAIL under any decoder that refuses trailing junk;
  `startedAt: "not-a-date"` verified; `sourceReservationReceiptId:
  "not-an-id"` named no receipt and verified. The fix is not nine checks:
  the key set and the declared format are now ONE declaration per member of
  §5's document — RFC 3339 UTC "Z" with ms precision for every timestamp,
  64-lowercase-hex for every digest, the FULL git OID at the length its
  `oidAlg` selects, §12 canonical decode for every receipt ID, the keyed
  `r1_`/`c1_` forms as the 32-byte MACs the resolver defines — walked once
  for both purposes, with the owning §7 step recorded per field so step 1
  never pre-empts a condition a normative equality names. A member cannot
  enter the schema without saying what it is, which is what makes this a
  closed class rather than nine patches; the corpus drives a sweep off that
  table, so a member declared and then not enforced fails a test. The same
  formats bind a SERVED history member at step 6, which is the only place
  they can bind — those never pass through step 1's reader at all.

  **A rotated-away key can no longer sign forever (§8).** The snapshot
  loader refused an `activationSequence` on an `active` key and a `retired`
  key without one, but both rules read a single entry; read across the
  rotation LINK, a key that a successor names as its predecessor plainly
  HAS a successor, so `active` is a contradiction — and one that pays,
  because an active key has no upper bound, so the predecessor stayed in the
  pinned lineage and kept verifying new material in a snapshot that looked
  like a clean rotation. `retired` (boundary evaluable) and `revoked` (the
  compromise path) remain legal predecessors; `active` does not. Relatedly,
  `--expect-id` supplied on a run that failed before step 3 now reports
  `unavailable` rather than `notApplicable`: §7 reserves the latter for an
  input that could not exist in this context, and an arrival context the
  operator typed plainly exists.

  Built against a from-scratch mint harness (Ed25519 keygen/sign, sha256,
  canonical JSON — node builtins only) that reaches canonical bytes by a
  path independent of the verifier's own `canonicalize`, so a shared
  preimage bug can't hide from the corpus; pinned first against
  receipt-spec §13's byte-for-byte canonicalization golden vectors — modulo
  the non-conformant cases above, which the corpus does not exercise. Vault
  mode (`--tx`, `--bundle`, the differential anchor suites) is unchanged —
  same flags, same byte-for-byte behavior.

### Fixed

- **The offline receipt verifier's field table declared `__proto__` (regression).**
  The previous round closed a nine-instance format class by making the key set
  and the declared format one declaration, walked once — and closed it with
  `table[key] !== undefined`. The key comes from the document and the table was
  an object literal, so `Object.prototype` answered on its behalf: a signed
  member named `__proto__`, `constructor`, `toString`, `valueOf`,
  `hasOwnProperty` (or any other prototype name) read as DECLARED, was then
  skipped by the declared pass too (`Object.keys` yields no inherited name), and
  so was checked by nobody. `JSON.parse` creates `__proto__` as an own data
  property, so the member survives the wire and the canonical preimage covers
  it: the mint signature verified over it and the receipt reached
  `VERIFIED_CHECKPOINT` for a document §2 makes a hard FAIL. Fixed with
  `Object.hasOwn` at the lookup AND null-prototype tables, so the defect is now
  inexpressible rather than merely absent.

- **Agreement is not conformance — three soundness holes with one root.** The
  verifier decided three spec LITERALS by checking that the receipt agreed with
  the pinned trust snapshot. Both are inputs, and two inputs agreeing proves
  only that one party wrote both. (1) `receipt-spec` §4a fixes proxy-v1's
  `event.actor` to exactly `{type:"system", id:"receipt-minter",
  name:"receipt-minter"}`; a receipt carrying the string form, `null`, an
  array, or that object plus a `tenant` member verified whenever the registered
  `mintActor` was malformed identically. (2) §4a/§8 give v1 no SDK mint keys at
  all, so `minter.kind` is the literal `proxy`; a snapshot registering
  `minterKind: "sdk"` and a receipt claiming `"sdk"` agreed and verified. (3)
  §8 hangs every rule it has — role, state, rotation boundary, lineage, vault
  ownership — off a globally unique `keyId`, but identical key MATERIAL under
  two keyIds was accepted: that let a revoked mint key be re-registered as
  active under a second name and keep signing, and let one checkpoint lineage
  be pinned by two vaults through two disjoint ID sets. Each literal is now
  checked against the spec first, with the agreement kept as a second fence;
  key material is unique across the snapshot.

- **`proof`/`inclusion`/`checkpoint` present-but-malformed is FAILED, not
  UNVERIFIABLE.** All three were read through a helper that answers `undefined`
  for both "absent" and "not an object", so `"proof": null` reported missing
  material and exit 2 — "we could not check" — for a receipt that made a claim
  and got it wrong. §7 reserves UNVERIFIABLE for material that is not there;
  present-and-malformed is `SCHEMA_INVALID` and exit 1. The two exit codes are
  the CI contract.

- **The `--envelope` R4 agreement check no longer depends on the receipt being
  valid.** It ran only when the decoded bytes passed the full ut1 schema, so a
  resolver holding bytes that parsed but failed §5 could omit or rewrite the
  convenience copy and the envelope `receiptId` for free: the run reported
  `SCHEMA_INVALID` — a statement about the receipt — and never mentioned that
  the framing had lied about which receipt this was. R4 now runs on any bytes
  that are JSON at all, which is also the symmetric comparison (neither side
  runs the frozen numeric rules).

- **A failed checkpoint-history walk prints WHY in the human report.** Step 9 is
  upgrade-only, so a broken history leaves the base verdict — and
  `report.failure` — untouched, and the human renderer's only detail line
  belongs to that field. The reader saw `Checkpoint history: failed` and
  nothing that distinguishes a short history from a broken lineage edge from a
  checkpoint signed by the wrong key, with `--json` as the only way to find out.
  The nested detail is now printed for every named §7 check that failed.

## [3.3.1] - 2026-08-12

### Added

- **`/r/<receiptId>` — the public verify page a `Usertrust-Receipt` trailer
  resolves to (ships DARK, not yet live).** A read-only, unauthenticated
  page and two JSON siblings (`receipt.json`, `envelope.json`) that render
  the resolver's answer as an honest verdict: chain-committed claims,
  minter-asserted claims, and merely-displayed fields kept visually and
  textually distinct, every non-green outcome (202/404/409/410/503/429,
  plus a fail-closed protocol-error shell for anything the resolver's
  contract doesn't name) rendered loud rather than swallowed. The page never
  computes a verdict — every rung was already decided upstream by
  `api.usertools.ai/v1/receipts/*` — and does no cryptography beyond the R4
  byte-identity pipeline (canonical base64, fatal UTF-8, pre-parse
  duplicate-key rejection, frozen numeric rules) that checks the served
  receipt bytes against the signed envelope. Built fixture-first against a
  40-fixture conformance matrix (28 conforming shapes, 11 rejection vectors,
  2 vector modules) with every rendered claim string asserted verbatim
  against the frozen spec. **Merges dark**: unlinked, `noindex`, and pointed
  at the real (not-yet-serving) resolver endpoint — going DNS-visible still
  needs the resolver live in production and `usertrust-verify receipt`
  released from `packages/verify`, both tracked separately. See
  `site/app/r/README.md`.

## [3.3.0] - 2026-08-10

### Added

- **Chain events for governance denials, and a correlation handle on the error.**
  A denied call previously wrote NOTHING to the audit chain: invisible to
  `usertrust verify`, to the ledger UI, to exports, and to the entropy signal
  behind `usertrust health`, with no handle a caller could quote back. Two new
  kinds close that gap. `policy_denied` records a decision the GOVERNOR made —
  `denialClass` is one of `policy`, `budget_gate`, `pii`, `injection`,
  `unknown_model` — and carries the hard rules that fired (id + name), PII
  TYPE names, injection PATTERN names, the two budget numbers the gate
  compared, a `promptHash` that joins to pattern memory, plus model /
  action / cost-center / endpoint / transferId. `ledger_rejected` records the
  ledger's own atomic refusal of a hold, where a `transferId` genuinely exists
  and `usertrust verify --tx` can join on it. Both carry `schemaVersion: 1` and
  `decision: "deny"`; every field is PII-safe, and the error text is redacted
  before it is truncated.

  `PolicyDeniedError` and `InsufficientBalanceError` now expose
  `auditEventHash` — the appended event's hash — and `auditDegraded`, which
  distinguishes "the append was attempted, failed, and was dead-lettered" from
  "no append was ever attempted" (an error built by hand, or thrown by an
  older version). Both errors gained an optional trailing metadata argument
  (third and **fifth** respectively, behind their existing `hint`), so every
  existing construction compiles unchanged.

  Appends happen at a FLOW BOUNDARY — a `catch` wrapped around the try/finally
  that releases the budget mutex, ending lexically before the provider call —
  so a denial storm never stalls allowed calls behind an fsync, and a provider
  that throws a same-typed error is never audited as a governor decision. A
  failed denial-append never changes the error the caller receives, `failClosed`
  included: the call is already refused and no money moved. The circuit breaker
  remains deliberately un-wired for denials; a refusal never contacted a
  provider, and counting it would let a policy storm suppress healthy traffic.

  Downstream: `usertrust health` counts both kinds, `verifyTransaction()`
  renders **DENIED** instead of a false PENDING receipt, and the visual ledger
  labels denials as denials rather than as zero-cost failed transactions.

  **Caveat for indirect callers:** `usertrust-server` and the ACS adapter do
  not yet forward `auditEventHash` on the wire, so an HTTP caller receives the
  denial without the handle. The event itself is written either way — the
  server converts the error only after `governor.authorize()` has returned its
  decision, so an `evaluate_only` (`would_deny`) deployment records the denial
  too. Richer UI rendering of `denialClass`/rules, export columns, and an
  `inspect` kind column are also follow-ups.

### Fixed

- **`usertrust-verify --tx` scrubs control characters out of every untrusted
  receipt field.** The receipt renders strings read from `events.jsonl` — a file
  the party under audit owns — onto the terminal of the auditor checking it, so
  an escape sequence could erase the line the verdict prints on and forge a
  passing verification. The unknown-model denial made this reachable with a
  caller-supplied `model`, which the governor also copies into the event's
  `error` text. `model`, `error`, `transferId`, the timestamp, both chain hashes
  and the `renderNotFound` txId now go through the stronger `forDisplay`
  sanitizer (C1 range included) before rendering. This also closes the same
  pre-existing exposure on the `llm_call_failed` error line.

- **A denial whose audit append fails only at the `.meta` sidecar now keeps its
  correlation handle.** `appendEvent` fsyncs `events.jsonl` before writing the
  sidecar, so a sidecar failure rejected for an event that was already durably
  on the chain — and the caller was told `auditDegraded` with no hash, losing
  the handle for a record an auditor could still read. The writer now reports
  that event's hash on the rejection and the denial boundary surfaces
  `auditEventHash` **and** `auditDegraded: true` together, meaning "on-chain at
  this hash, and the write reported failure".

- **`ledger_rejected` carries `actionName`,** mirroring `policy_denied`. Without
  it, every rejected action sharing a broad `kind` (`"tool"`) was
  indistinguishable in the chain — the question a rejected-hold investigation
  starts from.

- **Four-tier cache pricing: rates, receipts, and public schemas (correctness fix).**
  Cache traffic was billed at **zero**: `ModelRates` was two-tier, core's extraction read
  `usage.input_tokens ?? prompt_tokens` while providers report cache read/write as separate
  counters, and openclaw's accumulator dropped the cache fields it did extract. A
  1.14B-cache-read day was under-recorded roughly 7-8x — understatement is the dangerous
  direction, since it makes budgets deplete an order of magnitude slower than the real invoice
  and every scarcity number read falsely high. `ModelRates` gains optional `cacheReadPer1k` /
  `cacheWritePer1k`; every `PRICING_TABLE` entry was re-derived from providers' current published
  rates (`PRICING_TABLE_VERSION = "2026-08-08"`, recorded on receipts), correcting a stale
  `o4-mini` base rate along the way. **An absent cache rate now prices at `inputPer1k`, never
  zero** — overstatement is the fail-safe direction, and this resolution happens in exactly one
  place (`costFromRates`). Core's Anthropic/OpenAI-completions/Responses/Gemini extraction,
  openclaw's accumulator and settle paths, the server wire schema, and the ACS adapter's
  `token_count` all carry the four disjoint tiers end-to-end now, normalized per-source (pi-ai's
  pinned adapters are already disjoint and pass through; core-direct OpenAI/Gemini subtract the
  cache tiers back out of an inclusive prompt count, clamped at 0). The PENDING hold now reserves
  the input leg at `max(inputPer1k, effective cacheWritePer1k)` so a cache-write premium (Anthropic
  1.25x/2x) can't exceed an input-only hold — holds on cache-writing workloads run ~25% fatter;
  warm workloads settle well below and release the difference. `TrustReceipt.usage` (the four-tier
  split) and `TrustReceipt.pricing` (`appliedRates` + `tableVersion` — the resolved rates,
  published even when they came from the fallback) make a settled cost independently recomputable
  from the record alone: `ceil(sum(counts x rates / 1000))`, multiply-then-divide, floored at 1.
  Both are ROOT-level additions because v1 froze `meter` with `additionalProperties: false`, so v1
  validators accept v2 receipts unchanged. `appliedRates` is frozen and copied per record surface.
  `receipt.v2.schema.json` publishes both (v1 stays frozen). Anomaly velocity
  tracking now sees cached traffic instead of losing it once `inputTokens` stopped including it.
  Documented approximations (per-TTL write premium collapsed to the 5-minute rate; long-context,
  service-tier, regional, modality, and cache-storage charges not modeled) are in `AGENTS.md`'s
  Money invariants and `/docs/api/pricing`. See the design spec and the D1-D9 sections it links
  for the full boundary inventory.

### Fixed

- `TrustedClient` types: governed `messages.create` / `beta.messages.create` now
  type as `Promise<{ response, receipt }>`, matching the runtime envelope — the
  documented `const { response, receipt } = await client.messages.create(...)`
  pattern now compiles, per-overload. On the streaming overload
  (`stream: true`, and the streaming half of the base-overload union),
  `response` is the governed stream wrapper — `GovernedStream<T>`, an async
  iterable with a settled-`.receipt` promise — not the SDK's raw `Stream`
  (which the runtime never returns from governed `create`; the envelope's own
  `receipt` is the pre-settlement estimate). Types-only; no runtime change.

- `TrustedClient` types: the same envelope now covers the remaining governed
  surfaces — OpenAI `chat.completions.create` and `responses.create`, and Google
  `models.generateContent`. All three resolved to the provider SDK's raw return
  type while the runtime had been returning `{ response, receipt }` since the
  proxies were written, so an OpenAI or Google consumer had no typed path to
  `.receipt` at all and had to cast through `as unknown as`. Streaming calls on
  either OpenAI surface resolve `response` to `GovernedStream<T>`, matching the
  generic async-iterable branch of `interceptCall` that actually wraps them.
  `TrustedClient<T>` now mirrors `detectClientKind`'s ORDER and BOTH halves of
  its shape test, as exclusive branches — Anthropic, else OpenAI, else Google —
  so a hybrid client is typed as governed on exactly the one provider surface
  `trust()` proxies at runtime. Both halves means the governed method must be
  callable AND its namespace must be a non-callable object: every namespace walk
  in the runtime is gated on `typeof ns === "object"`, which a function object
  fails, so a client whose `chat`, `messages`, `models`, `responses` or `beta` is
  a callable carrying properties is skipped by the runtime and is now skipped by
  the type too (falling through to the next provider where one applies).
  Namespaces are re-added through homomorphic mapped types rather than plain
  intersections, so `readonly` — which real `@google/genai` declares on `models`
  — and `?` both survive, and a namespace the client never declared does not
  become a phantom property. The ungoverned inventory stays raw and
  is pinned by type tests: `chat.completions.parse` / `.stream` / `.runTools`,
  `responses.stream` / `.parse` / `.retrieve` / `.cancel` / `.delete` /
  `.compact`, the OpenAI `beta.*` namespace, legacy `completions.create`, and
  Google `models.generateContentStream`. The OpenAI assertions run against the
  real installed `openai@^7.3.0` types; the Google mapper is asserted against a
  structural mock only — no `@google/genai` devDependency exists yet, so real
  `@google/genai` compatibility is unverified. Types-only; no runtime change.

### Security

- **Merkle inclusion proofs now validate PATH TOPOLOGY against
  `(leafIndex, treeSize)`.** `verifyInclusionProof` previously folded whatever
  siblings it was handed and compared the result to the published root. It
  never derived what the path *should* look like for the claimed position, so
  a proof could assert any `leafIndex` it liked and still verify — a forged
  index rode an otherwise-valid fold, and where two sibling hashes are equal
  (identical leaves) flipping a sibling's side refolded to the very same root,
  which no amount of hashing can catch. The verifier now derives the expected
  per-level orientation from `(leafIndex, treeSize)` under the tree's
  odd-node-promotion semantics, requires the supplied sibling count and every
  `position` to match it exactly, and rejects non-safe-integer or
  out-of-range indices and sizes before hashing. `packages/core` and
  `usertrust-verify` changed in lockstep and are covered by a differential
  suite that drives both verifiers directly. Every field of the proof is read
  exactly once and the fold walks a materialized array plus the derived
  orientation, so a hand-built object with a re-reading `position` getter or an
  overridden array iterator cannot pass validation on one path and fold
  another.

  **Compatibility.** Every proof `generateInclusionProof` produces still
  verifies — exhaustively pinned for all leaves of every tree sized 1..33.
  `leafIndex` is ZERO-BASED and is now authenticated: a caller that treated
  it as informational, dropped it during (de)serialization, or stored a
  one-based sequence number will start failing verification. That is the fix
  working, not a regression.

## [3.2.0] - 2026-08-08

### Added

- **`usertrust-openclaw`: operator-declared tool→envelope attribution and
  per-turn scarcity injection.** A new `costCenters` plugin config
  (`parentUserId`, `tools`, `default`, `envelopes`, `scarcityContext`) routes
  each governed call's spend to a named, operator-capped budget envelope,
  selected STATELESSLY per call from the caller-supplied context's trailing,
  correlated, non-error tool-result run (`deriveAttribution`,
  `src/attribution.ts`) — structured-field matching only, never message text.
  Validated once at plugin construction through core's own
  `parentUserIdRefusal` and `withCostCenter` doors, normalized into a
  deep-frozen config every wrapper reads. When enabled, a
  `[usertrust scarcity] research: 34% left (~2.1h runway) · …` block is
  appended to each call's system prompt from a live batched read of the
  configured envelopes (`Governor.budgetContext`, core), on a copy of the
  caller's context — never gating, delaying, or throwing into the money path
  on a read failure. Fixes a pre-existing money bug in the same pass: the
  stream wrapper now guarantees exactly one settle/abort on every terminal
  mode (completion, thrown error, error event, consumer break/return,
  close-without-`done`), where it previously leaked the PENDING hold on an
  early consumer `break`. See `packages/openclaw/README.md` for the full
  attribution rule and the security-model carve-out.

## [3.1.0] - 2026-08-06

### Added

- **Budget envelopes: spend routing, per-envelope caps, and scarcity visibility
  (#79, previously unlisted).** `withCostCenter(costCenter, fn, opts?)`
  (`budget/attribution.ts`) attributes a governed call's spend to a
  `(parentUserId, costCenter)` envelope by CODE STRUCTURE — an
  `AsyncLocalStorage` scope, never anything a request body can carry. An
  attributed hold debits the envelope's own ledger-derived account
  (`allocateBudget` / `reclaimBudget`), so TigerBeetle's atomic
  `debits_must_not_exceed_credits` enforces the per-envelope cap the same way
  it already enforced the session wallet's. `getBudgetStatus` and the batched
  `budgetContext()` read the envelope's live balance; the gate's
  `budgetFractionRemaining` / `budgetRunwayHours` turn that into pre-spend
  policy tiers, and settled receipts carry the same numbers under
  `receipt.budget` as a post-settle snapshot. Both surfaces are OBSERVATIONS,
  never authority — see the Money invariants in `AGENTS.md`.

- **Settle-shortfall hardening.** The PENDING hold's size is a heuristic
  estimate (chars/4 tokens × a 1.5x safety margin), so real usage can price
  above the reserve. TigerBeetle rejects — never caps — a settle POST above
  its pending transfer's amount, which previously left the call reporting
  `settled: false` with the hold stranded PENDING until `destroy()` or the
  300s TigerBeetle timeout, and the wallet ultimately charged nothing for a
  call that succeeded. Both `createTBEngine` factories (`govern.ts`,
  `headless.ts`) now cap the post at the reserved amount themselves and audit
  the truncation as a `settlement_shortfall` event; `ledger/engine.ts` reaches
  the same outcome reactively (catches `exceeds_pending_transfer_amount`,
  re-posts with the amount omitted so TigerBeetle posts the full hold).
  `TrustReceipt.postedCost` is now populated whenever the post was capped
  (`receipt.cost − receipt.postedCost` is the shortfall); `receipt.cost` stays
  the true metered cost, and `settled` stays `true`.

- **Class-aware denial hints.** A hard policy denial whose triggering rule
  conditions any budget-scoped field (`budget_remaining`,
  `budget_remaining_after`, `budgetFractionRemaining`, `budgetRunwayHours`,
  `estimated_cost`) now surfaces a budget-specific remedy pointing at
  `allocateBudget` and the fraction/runway tiers (`derivePolicyHint`), instead
  of the rule's generic description.

### Fixed

- A policy rule with no `description` no longer renders its identifier twice
  in the denial reason (`[scarcity-brake] scarcity-brake` is now
  `[scarcity-brake]`).

## [3.0.0] - 2026-08-03

**Loopback/local endpoints now settle at nominal local rates instead of silently
billing frontier fallback.** Before, a free `llama3.3:70b` call against
`http://localhost:11434/v1` was priced like an unknown cloud model at
sonnet-class `FALLBACK_RATE` — and a streamed call settled on the pre-call
estimate (~615 usertokens of fake dollars per $0 stream). Local endpoints are
now classified as their own settlement scope and meter at `local.defaultRate`
(default `{0,0}` + the per-call `>=1` floor = exactly 1 nominal usertoken per
call), so free inference stays **inside** budget, anomaly, and audit governance
instead of being exempted from it.

### Added

- **First-class local-model governance (M2).** `classifyEndpoint()` labels every
  governed call `local` or `cloud` from the client's `baseURL` (explicit
  `endpoints[]` matchers, loopback autodetect, per-call override), and the
  scoped `resolveRates()` resolver prices every costing site accordingly. Local
  scope structurally cannot reach `FALLBACK_RATE`.
- New config surface (all keys zod-defaulted — existing configs parse
  unchanged): `endpoints[]` matchers (origin URL, `*.host` suffix, or bare
  hostname), `local` block (`autoDetectLoopback`, `defaultRate`, `rateClass`
  `"nominal" | "amortized-usd"` for GPU-amortized showback, per-model `models`
  with trailing-`*` globs, `injectUsageOptions`), and `unknownModelPolicy`
  (`"fallback" | "warn" | "deny"`, default `"warn"`) for cloud-scope models
  missing from the pricing table — `"warn"` is cost-identical to the old silent
  behavior but logs once per model and stamps the receipt.
- Receipts carry `endpoint` (`class`/`runtime`) and `meter` (`costBasis`
  `"usd-proxy" | "nominal"`, `rateSource`, optional `computeMs`) so the
  settlement regime and rate provenance of every call are auditable.
- Server-truth streaming usage for local endpoints:
  `stream_options: { include_usage: true }` is auto-injected into local
  OpenAI-compatible streams (gated by `local.injectUsageOptions`; the usage
  chunk is forwarded to the consumer unmodified; one retry without the
  injection if a server rejects it).
- Local-calibrated anomaly governance: `tokenRate.localThresholdTokPerSec`
  (default 5000), `tokenRate.perModel` glob overrides,
  `spendVelocity.localThresholdUsertokensPerMin` (default 10000) — local
  velocity verdicts are denominated in usertokens, never fake dollars; the
  detector now prices events with the same scoped resolver as settlement.
- Headless governor endpoint scope: `TrustOpts.endpoint` (governor default),
  `AuthorizeParams.endpoint` (per-call override, captured at authorize),
  `SettleParams.computeMs` → `receipt.meter.computeMs`.
- OpenClaw: Ollama-native chunk extraction (`prompt_eval_count`/`eval_count`,
  `eval_duration` → `computeMs`) alongside the OpenAI-compatible family.
- OpenClaw: `UsertrustPluginConfig.endpoint` (`class`, optional `runtime`/
  `baseURL`) declares the runtime's settlement scope — the headless path has no
  client baseURL to classify, so operators set `{ class: "local" }` to meter
  local models at local rates instead of cloud frontier fallback.
- `usertrust init` "Local inference" wizard step: Ollama/LM Studio/vLLM
  presets, optional `GET /v1/models` probe, writes `endpoints[]` +
  `local.models` entries.
- `examples/ollama-local-governance`: runnable before/after demo (`npx tsx
  run.ts`), falls back to an inline mock OpenAI-compatible server when Ollama
  is absent.
- **Governed surfaces expanded — previously-ungoverned SDK entry points now run
  inside the two-phase spend lifecycle (authorize → PENDING hold → settle/void),
  audit, and budget enforcement.** All wraps are feature-detected: a client on an
  older peer-range SDK that lacks a surface falls through to a raw pass-through
  and nothing throws at wrap time.
  - Anthropic `client.messages.stream()` is now governed. The original
    `MessageStream` is returned unchanged (all of `.on()` / `.finalMessage()` /
    `.abort()` / async iteration preserved) with a `.receipt` promise attached;
    settlement is driven by non-consuming emitter listeners so it never competes
    with the caller's own consumption. The governed `stream()` authorizes before
    forwarding, so callers `await` the returned handle. A clean stream close with no
    `finalMessage` settles at estimate (the hold never dangles), and a consumer
    `abort()` settles the partial usage as an early exit rather than voiding or
    tripping the circuit breaker. Governance never silently swallows a stream
    failure: a genuine stream error rejects `.receipt`, so any consumer that
    `await`s `.receipt` (or the stream's own `done()`/`finalMessage()`) observes it.
    The one exception is a pure fire-and-forget consumer that never awaits
    `.receipt`, registers no `error` handler, and never awaits the stream — for that
    caller the error is not surfaced; await `.receipt` or attach an error handler.
  - Anthropic `client.messages.parse()` and `client.beta.messages.parse()` are
    governed: the underlying create runs through the two-phase lifecycle exactly
    once, then the SDK's parse transform is applied and the parsed message is
    returned with a `.receipt` attached.
  - Anthropic `client.beta.messages.create()` and `client.beta.messages.stream()`
    are governed identically to the stable surface. `beta.models`, `beta.files`,
    and `beta.messages.batches` remain documented pass-throughs.
  - OpenAI `client.responses.create()` (Responses API) is governed, non-stream
    and streaming, when present (feature-detected against the `openai >=4.70.0`
    peer floor, which predates the Responses API). Prompt/PII/injection/estimation
    coverage reads Responses `input`/`instructions`; streaming usage is read from
    the terminal event — `response.completed`, and equally the terminal
    `response.incomplete` / `response.failed` events, at
    `event.response.usage.{input_tokens,output_tokens}`. The chat-completions-only
    `stream_options.include_usage` opt-in is never injected into Responses params.
    The `client.responses.stream()` and `client.responses.parse()` convenience
    helpers are **not** governed — they drive the SDK's raw client internally and so
    bypass the governed `create`; use `responses.create({ stream: true })` for a
    governed stream.
- **Real-TigerBeetle CI validation.** A new non-gating `tb-integration` CI job
  stands up a real single-node TigerBeetle cluster (pinned to the
  `tigerbeetle-node` version) and runs the two-phase hard-budget invariant
  end-to-end against the live ledger. The integration test self-skips
  (`describe.skipIf(!process.env.USERTRUST_TB_ADDRESS)`) so the normal test job
  stays green with no cluster.

### Changed

- **BREAKING: cost-center account ids now derive from the `(parentUserId,
  costCenter)` tuple** — a domain-separated, length-prefixed SHA-256 — instead
  of hashing the joined `parent::costCenter` string. This removes the reserved
  `::` separator and lets parent wallet ids contain `:` (#64), but it changes
  where cost-center money lives: a cost center funded on v2.x sits in an
  account this version no longer derives, so `getBudgetStatus` reports it as
  balance 0 (reading as fully spent) and `reclaimBudget` moves nothing —
  silently, on both paths. **Reclaim every live cost center with
  `reclaimBudget` on v2.x before upgrading.** If you have already upgraded with
  balances stranded: downgrade to 2.x, reclaim, then upgrade again. There is
  deliberately no read-time fallback to the legacy account: reading it would
  collide with an ordinary wallet literally named `parent::costCenter`, which
  is the exact ambiguity this change removes. For the same reason v3 continues
  to refuse `::` in wallet ids, escrow labels, and parent ids — a quarantine of
  the legacy namespace, so that a stranded pre-v3 cost-center account (including
  one re-funded by a pending hold voided after the upgrade) cannot be silently
  adopted by a new wallet name that hashes onto it; a single `:` remains legal
  (#64).
- OpenAI and Google streaming usage accumulation is now replace-with-latest
  (usage-bearing chunks carry cumulative snapshots — e.g. vLLM
  `continuous_usage_stats` — which summing would multiply-count). Anthropic
  stays additive (`message_start` + `message_delta` are genuinely incremental).

### Security

- Endpoint classification (config matchers, overrides, loopback autodetect) is
  a **trusted-operator decision** — never wire it to end-user or request input.
  In server/multi-tenant deployments set `local.autoDetectLoopback: false` and
  classify via explicit `endpoints[]` config: loopback inside a container can
  be a forwarding sidecar to a paid API. This is the same trust boundary as
  `budget`/`customRates` — the config author already controls billing entirely.
  Note that a compromised local server can under-report usage; receipts expose
  `usageSource` and `meter.rateSource` precisely so that this is auditable.
- `endpoints[]` matching never uses raw string prefixing: scheme entries match
  by URL origin equality, killing `http://gpu-box:8000.evil.com` /
  `...@evil.com` bypass shapes; malformed `baseURL`s classify as cloud
  (fail-expensive).

### Dependencies

- Adopted major upgrades across the toolchain and runtime deps. **Governance
  behavior is unchanged** — verified by the full suite (1957 passing, 4
  TigerBeetle-integration tests self-skipping without a live server) plus
  `tsc -b`, type-tests, and `biome check` all clean:
  - `tigerbeetle-node` 0.16 → **0.17.9**. Ledger client migrated to the 0.17
    API: `CreateAccountError`/`CreateTransferError` enums → `CreateAccountStatus`/
    `CreateTransferStatus`, and the per-event result shape is now
    `{ timestamp, status }` (success is `status === created`). Two-phase
    pending/post/void and `debits_must_not_exceed_credits` hard-budget
    enforcement are byte-for-byte unchanged. CI TigerBeetle server pinned to
    0.17.9 (sha256 recomputed).
  - `zod` 3 → **4.4.3**. Config object schemas migrated from `.default({})` to
    `.prefault({})` to preserve zod 3's re-parse-inner-defaults behavior (zod 4's
    `.default({})` skips inner defaults); parsed config output is identical.
  - `@anthropic-ai/sdk` → **0.115** and `openai` → **6.49**. SDK majors verified
    safe against the governance surface (streaming usage accumulation, tool-call
    and responses paths); no adapter changes required.
  - `@biomejs/biome` 1.9 → **2.5.5**. `biome.json` migrated to the v2 schema
    (`linter.rules.preset: "recommended"` — the migrator's silent
    `preset: "none"` downgrade was caught and corrected; `files.includes` with
    negated globs; CSS/SVG excluded, since Biome 2 cannot parse Tailwind v4
    `@theme`). Formatting reflow is purely mechanical (import sorting, JSON).
  - `@types/node` → **26**. One types-only regression fixed in money-path Ed25519
    signing (`createPublicKey` dropped `KeyObject` from its input union in v26,
    though Node still derives a public key from a private `KeyObject` at runtime);
    resolved with a types-only assertion — the runtime call is unchanged.

## [1.0.0] - 2026-03-29

First stable release.

## [0.2.6] - 2026-03-29

### Added
- Shell completions for bash, zsh, and fish (`usertrust completions`)

## [0.2.5] - 2026-03-29

### Added
- `--json` output flag for all CLI commands for machine-readable output
- Semantic colors in CLI output for improved readability
- Did-you-mean suggestions for misspelled CLI commands
- `--before` and `--after` date filters for `usertrust inspect`

## [0.2.4] - 2026-03-29

### Added
- Actionable error messages with fix suggestions across all error classes
- Site badges (npm version, CI status, license)
- Call-to-action section on marketing site
- Governance receipt display on site with real examples
- 1-hour soak test (`gate1-soak`) for sustained SDK validation
- DX research synthesis and pipeline plan documentation

### Fixed
- JetBrains Mono Bold rendering, typewriter animation, and hero layout cleanup on site

## [0.2.3] - 2026-03-28

### Added
- `/ship`, `/deploy`, `/promote` autonomous delivery pipeline and CI/CD scripts
- Gate 1 test harness for SDK validation
- Marketing site ported to Next.js 15 with Framer Motion
- Agent workflow documentation in CLAUDE.md

### Fixed
- 24 audit findings addressed: budget race condition, crypto integrity, governance hardening
- Site typography: keep `trust()` headline in `font-mono` (parentheses too round in sans)
- Site typography: entire site switched to Usertools Sans with `font-mono` removed

## [0.2.1] - 2026-03-28

### Added
- Single-transaction receipt verification in `usertrust-verify` with dotted leaders and USD conversion

### Changed
- Renamed governance types to `trust`/`receipt` in public API (breaking rename from internal `governance` naming)
- Publish workflow updated for version bump PR flow (replaces direct push)

### Fixed
- NPM publish token restored after OIDC trusted publishing migration
- Version bump PR merge uses `--auto` instead of `--admin`

## [0.1.1] - 2026-03-28

### Added
- Rebranded from `@usertools/govern` to `usertrust`
- npm publish metadata for both packages
- SPDX license headers and legal files (Apache 2.0)

### Changed
- IP audit remediation: stripped provenance metadata, added SPDX headers

### Fixed
- `usertrust-verify` CLI bin path corrected
- Publish workflow references renamed from `govern` to `usertrust`

## [0.1.0] - 2026-03-16

Initial release of the usertrust SDK.

### Added
- **Core SDK (`usertrust`)**
  - `trust()` async factory wrapping any LLM client (Anthropic, OpenAI, Google) via JS Proxy
  - Two-phase spend lifecycle: PENDING hold -> LLM call -> POST (success) or VOID (failure)
  - Duck-typed LLM client detection for Anthropic, OpenAI, and Google SDKs
  - Streaming support with per-provider token accumulation (`GovernedStream`)
  - `client.destroy()` cleanup lifecycle (idempotent)
  - Dry-run mode (`dryRun: true` or `USERTRUST_DRY_RUN`) for audit-only operation without TigerBeetle
  - Proxy mode stub for remote governance connection
  - Failure mode handling for all 5 scenarios per spec Section 15
- **Ledger**
  - TigerBeetle client wrapper with reconnect logic
  - Two-phase spend engine (PENDING -> POST/VOID) with dead-letter queue fallback
  - 20-model pricing table with cost estimation in usertokens
- **Audit**
  - SHA-256 hash-chained JSONL audit trail with advisory lock and async mutex
  - Deterministic canonicalization for hash computation
  - RFC 6962 Merkle tree with inclusion and consistency proofs
  - Daily-rotated audit receipts with bounded index
  - Audit chain verifier
  - 6 entropy signals for governance health diagnostics
- **Policy**
  - Policy gate with 12 field operators, soft/hard enforcement, dot-notation field resolution
  - YAML and JSON rule loading with glob-based scope matching via minimatch
  - Time-window constraints
  - PII detector (email, phone, SSN, credit card with Luhn validation, IPv4)
  - Exponential decay rate calculator for time-weighted budgets
- **Board of Directors**
  - Two directors (Alpha and Beta) with complementary focus areas
  - 6 heuristic concern detectors (hallucination, bias, safety, scope creep, resource abuse, policy violation)
  - Democratic decision matrix: unanimous veto, escalation, approval
- **Resilience**
  - Circuit breaker with per-provider failure isolation and registry
  - Scope locking with minimatch-based overlap detection for parallel workers
- **Memory**
  - Pattern memory: prompt hash -> model -> cost -> success routing (SHA-256 hashes only, no raw prompts)
- **Snapshot**
  - Checkpoint/restore for vault state
- **CLI**
  - `usertrust init` -- create `.usertrust/` vault with default config
  - `usertrust inspect` -- vault bank statement
  - `usertrust health` -- entropy diagnostics (6 signals, 0-100 score)
  - `usertrust verify` -- audit chain integrity check
  - `usertrust snapshot` -- checkpoint/restore vault state
  - `usertrust tb` -- TigerBeetle process management
  - Barrel exports, config loader, and `defineConfig()` type-checking helper
- **Standalone verifier (`usertrust-verify`)**
  - Zero-dependency vault verification (Node built-ins only)
  - CLI entry point for standalone verification
- **Infrastructure**
  - Monorepo scaffold with npm workspaces (`usertrust` + `usertrust-verify`)
  - Shared primitives: types, IDs (`tbId`, `trustId`, `fnv1a32`), 7 domain errors, constants
  - GitHub Actions CI: lint, test with coverage, publish workflows
  - Blacksmith runners with parallel job matrix
  - Codex review workflow
  - Branch protection, dependabot, CODEOWNERS
  - Apache 2.0 license
  - 979 tests across 38 files with coverage thresholds (92%+ lines, 85%+ branches)

### Fixed
- 9 Codex findings addressed: production wiring, security, receipts
- TigerBeetle connection when `dryRun` is false
- CLI entry moved to `src/cli/main.ts` for tsconfig inclusion
- `loadConfig()` accepts optional `vaultBase` parameter
- Pattern cache made instance-scoped by vault path
- Codex CI input name corrected with fallback to ubuntu-latest
- Biome lint errors resolved
- `tbId` test flake fixed by separating uniqueness from time-ordering assertions

[1.0.0]: https://github.com/usertools-ai/usertrust/compare/v0.2.6...v1.0.0
[0.2.5]: https://github.com/usertools-ai/usertrust/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/usertools-ai/usertrust/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/usertools-ai/usertrust/compare/v0.2.1...v0.2.3
[0.2.1]: https://github.com/usertools-ai/usertrust/compare/v0.1.1...v0.2.1
[0.1.1]: https://github.com/usertools-ai/usertrust/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/usertools-ai/usertrust/commits/v0.1.0
