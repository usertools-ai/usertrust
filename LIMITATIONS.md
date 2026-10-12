# Limitations

usertrust is a trust layer. A trust layer that overstates itself is worse than none,
so this document is part of the product: what usertrust deliberately does not do,
where its boundaries sit, and why each boundary is where it is.

Every statement below is true of the code in this repository. When a limitation
moves, this document moves with it.

## 1. The governance surface is the wrapped SDK methods — nothing else

`trust()` governs a specific set of SDK methods, not "the network." Governed
today:

- Anthropic: `client.messages.create()`, `client.messages.stream()`, and
  `client.beta.messages.{create,stream,parse}()`
- OpenAI: `client.chat.completions.create()` and `client.responses.create()`
- Google: `client.models.generateContent()`

Streaming through any governed method is governed end to end, including
mid-stream anomaly cutoff and settle-or-void on completion.

On an Anthropic or OpenAI client, every other SDK method is **refused**, not
passed through: batches, embeddings, images, audio, fine-tuning, assistant runs,
vector stores, realtime, videos, legacy `completions.create()`, OpenAI's
`beta.responses`, and the helpers that drive the SDK's raw client internally
(`chat.completions.parse/stream/runTools`, `responses.parse/stream`,
`beta.messages.toolRunner`). A refused call rejects with a `PolicyDeniedError`
and leaves a `policy_denied` audit event; the provider is never called. Methods
that cannot start work run unaudited: every method whose requests are all GET or
DELETE (reads, lists, deletes), and a few POSTs named with a reason (token counts,
moderations, cancels, pauses, metadata updates). A method you list in
`trust({ allowUngoverned })` runs **unmetered**: it reaches the provider without
a budget hold or a cost, and its only record is an `ungoverned_call` audit event.
On a Google client, the alternative methods still pass through ungoverned. The
exact, current boundary is enumerated at the source in
`packages/core/src/detect.ts` and `packages/core/src/default-deny.ts`.

**Threat model.** Default-deny prevents ACCIDENTAL unmetered spend through the
governed client: a call to a method usertrust does not govern, a helper that
drives the SDK's raw client, a `withOptions()` copy. It is not a sandbox against
code that sets out to spend. A caller that keeps the raw client it constructed,
builds a new one through `client.constructor`, through the governed client's own
`trusted.constructor`, or through the prototype path
`Object.getPrototypeOf(trusted).constructor` (closing that path would break
`trusted instanceof Anthropic` / `OpenAI`), or reads the API key off the
client (`client.apiKey` is a plain value and passes) is outside it, as with any
wrapper. Deliberate bypass from your own code is out of scope: code that holds a
provider key can always reach the provider. `usertrust-server` does not change
that, because it authorizes and settles spend but does not make or forward the
provider calls; enforcing against deliberate bypass needs the provider key held
outside that code. Writes through the governed client are refused (assignment,
`Object.defineProperty` and `delete` on the client, its resources and `_client`,
and on its transport objects `middleware`, `fetchOptions`, `_options` and
`_authState`), but two SDK objects are still handed back as they are: the
client's `logger`, which is the caller's own, and Anthropic's per-request
auth-flag `WeakMap`, which a proxy cannot wrap.

The boundary covers the governed client object. It does not cover the original
client you passed to `trust()`, a client you construct separately, or transports
that take a client and open their own connection (OpenAI's Realtime and
Responses WebSocket classes read the client's API key and talk to the provider
directly). Governed calls price tokens only: server-side tool fees (web search,
code execution, file search, containers) are not metered.

**Why:** usertrust detects clients by duck typing and wraps them with a JS Proxy.
That is what makes it a one-line integration with zero SDK dependencies across
SDK versions — and it means the governed surface is a set of methods we
explicitly cover, not an interception of all traffic. A method we do not cover
is refused rather than trusted, so a new SDK method fails closed until it is
governed, freed, or listed in `allowUngoverned`.

## 2. Endpoint classification is a trusted-operator decision

`classifyEndpoint()` decides whether a call settles at local or cloud rates from
`endpoints[]` matchers, per-call overrides, and loopback autodetect. All three
inputs belong to the operator. If any of them is plumbed from end-user or
request input, an attacker chooses their own settlement regime — the same trust
boundary as `budget` and `customRates`, where the config author already controls
billing entirely.

Two specifics worth knowing:

- **Loopback autodetect is workstation mode.** On servers and in containers, set
  `local.autoDetectLoopback: false` and classify via explicit `endpoints[]` —
  loopback inside a container can be a forwarding sidecar to a paid API.
- **Classification happens once, at wrap time,** from the client's `baseURL`.
  Per-request baseURL overrides are not re-classified. Absent or malformed
  baseURLs classify as cloud — fail-expensive, because over-charging at cloud
  rates is recoverable and under-charging a paid endpoint is not.

## 3. Local-server usage reports are trusted for settlement

For local endpoints, usertrust prefers server-reported usage (it auto-injects
`stream_options: { include_usage: true }` into local OpenAI-compatible streams).
A compromised or lying local server can under-report its own usage, and
usertrust does not independently re-count tokens for arbitrary local runtimes.

**Why receipts still hold up:** every receipt stamps `usageSource`
(`"provider"` or `"estimated"`) and `meter.rateSource`, so the provenance of
every settled number is explicit and auditable. usertrust does not pretend to
verify what it cannot; it makes the trust relationship visible in the ledger
instead.

## 4. Hard budget atomicity applies to full mode, not `dryRun`

`dryRun: true` (or `USERTRUST_DRY_RUN=true`) skips TigerBeetle entirely and runs
audit-chain-only. It exists as the explicit, honest way to bypass financial
enforcement — in tests, in evaluation. Every claim about atomic budget
enforcement (an over-budget PENDING hold rejected by the ledger before the
provider is called) applies to full mode with a live TigerBeetle instance.

One caveat from our own release history: the unit suite validates live-ledger enforcement against a stateful `tigerbeetle-node` fake that implements real double-entry balance math and `debits_must_not_exceed_credits` (see `packages/core/tests/harden/ledger-funded-wallet.test.ts`) — a behavioral test against real ledger semantics, not a mock asserting a mock. CI also runs a separate job (`tb-integration`) against a real single-node TigerBeetle cluster. Neither is your deployment: validate against your own TigerBeetle cluster before relying on enforcement in production.

## 5. One audit writer per vault, one process at a time

The audit chain is a linear SHA-256 hash chain. Two concurrent writers would
fork it, which is precisely the tampering the chain exists to make evident — so
usertrust enforces single-writer semantics with an advisory file lock plus an
in-process mutex. Stale locks from crashed processes are reclaimed; live ones are
never stolen.

**Within one process, every client shares the vault's writer.** Any number of
`trust()` clients and `createGovernor()` governors on one vault (an Anthropic and
an OpenAI client, say) append through ONE writer, so all their events land on one
chain. A vault is recognised by its directories' identity on disk, resolved when
the client is created, so every spelling of it shares the writer. Not covered: a
vault directory replaced while a client is open on it (the writer keeps writing at
the path it resolved), and filesystems whose inode numbers are not stable (some
network and FUSE mounts), where two clients may get two writers and the second
one's events are refused and dead-lettered, loudly, as for a second process. Two
vaults whose `audit` directories are one directory (a symlink) are two writers on
one log, refused the same way.

**A second process on the same vault cannot write to it.** Each of its audit
appends fails; it never forks the chain. Its calls still settle, and every event that
misses the chain is reported: the receipt carries `auditDegraded` (a failed warn-mode `injection_detected` append is the exception: it is dead-lettered but leaves the receipt unmarked), the event goes to
`.usertrust/dlq/dead-letters.jsonl` (when that write succeeds), the process gets a `USERTRUST_AUDIT_DEGRADED`
warning (at the first failure, and with the count when the client is destroyed), and
`usertrust verify` reports the vault INCOMPLETE and exits 1 for a dead-lettered event (if the dead-letter write itself fails and leaves no bytes, for instance on a full disk, neither `verify` nor `health` sees the gap; a partial line left by a short write counts as an unreadable entry, so the vault reads INCOMPLETE). A `trust()` client with
`audit.failClosed: true` refuses such calls instead; `createGovernor()` and
`usertrust-server` do not enforce `audit.failClosed`.

**Load ONE copy of usertrust per process, and use a vault from one thread.** The
shared writer, and the registry that tells a live writer in this process from a
crashed earlier one, live in the module. Two installed copies of usertrust (two
versions in `node_modules`), or worker threads, each have their own: a lock taken
by the other copy carries this process's PID, is not in this copy's registry, and
is judged a crashed instance and reclaimed — the fork this section exists to
prevent.

The lock's liveness check works on one kernel, and it fails toward "held":

- **The audit directory must be on a filesystem with hard links.** The lock is
  created by hard-linking a fully written temp file into place, so it is never
  seen half-written. On a filesystem without `link()` (FAT/exFAT, some network
  and FUSE mounts) the writer refuses to start rather than fall back to a lock
  that can be.
- **A vault shared between kernels is unsupported.** A lock is judged by its
  PID, which means nothing on another host or VM, and by its boot id, which
  differs there. Share a vault only between processes on one machine.
- **A lock from another PID namespace is never reclaimed automatically.** One
  container cannot probe another container's processes, so a lock written in a
  different PID namespace on the same kernel is treated as held, even when that
  writer is gone, and whatever its boot id says: systemd-nspawn gives a
  container a private boot id on the host's kernel, so a differing boot id does
  not prove a previous boot across namespaces. A container that crashed without
  releasing its lock and was restarted into a NEW PID namespace therefore finds
  that lock held, even after a reboot. Remove
  `.usertrust/audit/.audit-writer.lock` by hand once you know that writer is
  gone, or run the writer in a PID namespace that survives its restarts (for
  example the host's).
- **Off Linux, and without a readable boot id,** a lock left by a crash before a
  reboot is reclaimed only if its PID is free now. (On Linux, a lock from this
  PID namespace, or one that names none, is reclaimed when its boot id differs.) If an unrelated live process
  has taken that PID, the lock stays held until it is removed by hand.

If you need multiple concurrent workers, give each its own vault. Merging or
centralizing chains is a control-plane concern, not something the core SDK
pretends to solve today.

**A torn tail halts appends until an operator repairs it.** An append that never
completed (a crash, a full disk) can leave bytes after the log's last newline. The
writer then refuses every append (`AuditTornTailError`) rather than bury those bytes
mid-file — so with `audit.failClosed` (`trust()` only), governed calls stop too. The repair is
`usertrust audit quarantine-tail`, and it repairs exactly ONE state: unparseable bytes
after the last newline, on a single `events.jsonl` that otherwise verifies from
genesis, with an agreeing `.meta` anchor. Every other unverifiable state, including an
unterminated last line that parses, is refused: repairing it would mean choosing which
evidence is true, which is an operator's decision. A run that died between cutting the
log and recording the cut is finished by the next run.

One case is recorded once although it was cut twice. Suppose a run cuts a torn tail at
offset X and dies before recording it, and the log then gets byte-identical torn bytes
at the same offset X again before any run records the first cut. On disk that looks
exactly like a single run that died between saving the evidence and cutting the log. So
the next run makes one cut and writes one record, which names those bytes and that
offset. The evidence is kept byte for byte. What is lost is only that the cut happened
twice.

## 6. Anomaly governance ships conservative defaults and expects calibration

Anomaly detection is opt-in (`anomaly.enabled: true`) and tuned to catch
sustained runaway behavior, not brief spikes: 500 tok/s over three consecutive
2-second windows, $1.00/min spend velocity over a 10-second rolling window,
3 injection signals in 60 seconds. Local endpoints get local-calibrated
thresholds (5,000 tok/s; 10,000 nominal usertokens/min) because fast local GPU
inference legitimately exceeds cloud rates.

One behavior is by design, not a gap: with the default local rate of `{0,0}`,
per-call nominal cost floors at 1 usertoken, so spend velocity cannot trip on
default local config — **token rate is the primary local signal**. Velocity
becomes meaningful on local endpoints when you set nonzero amortized rates.
Whatever your workload looks like, the defaults are a starting point; calibrate
them against your own traffic before trusting the trip wire.

## 7. The Board of Directors is heuristic, not an LLM

The board's two directors review decisions with six pattern-matching concern
detectors (hallucination, bias, safety, scope creep, resource abuse, policy
violation). No LLM calls are made.

**Why:** deterministic review is auditable, free, adds no latency, and cannot be
prompt-injected. The trade is real — heuristics will not catch what a model
reviewer might. Treat board verdicts as a cheap tripwire layered under your
policy rules, not as semantic judgment.

## 8. No third-party certification

usertrust has no SOC 2 report, no ISO 27001 certificate, no third-party
attestation of any kind. The audit chain — hash-chained events, RFC 6962 Merkle
proofs, a zero-dependency offline verifier — is designed to produce evidence an
auditor can check without trusting us or this codebase. That is the deliberate
division of labor: usertrust generates the receipts; certifying a deployment
that uses them is the deployer's work with their own auditors.

**Known issue in 4.1.0 — deleting the most recent records.** On a vault with no external anchor (the default), deleting the most recent audit records is reported by `usertrust verify` only until the next governed call from a freshly started process: that call appends after whatever tail it finds and rewrites the vault's sidecar, after which verification passes over the shortened chain. An anchor catches the deletion of the records it covers (those up to the tree size it recorded); records appended after the last anchor are still unanchored. Editing a record, deleting a record from the middle of the chain, and re-hashing the whole chain against a published anchor are all detected. Emptying `events.jsonl` while its `.meta` sidecar remains is not a silent tail deletion: the next append continues from the sidecar's hash and verification reports the gap. The bypass applies to a tail deletion that also rewrites the sidecar, or that keeps some earlier lines.

**What holds regardless of version.** Anyone who can rewrite both the vault file and its sidecar can produce a chain that verifies on its own. Only evidence held outside the vault catches that: an external anchor, or receipts you retained (a caller holding an ordinary receipt finds a rewrite of its event, since `usertrust verify --receipts` reports it unaudited and exits 1 even when the rewritten chain and its sidecar agree). If you rely on the audit chain as evidence, enable external anchoring and keep the anchors and the public key with your auditor.

## 9. Proxy mode was deleted rather than shipped as theater

Early versions carried a proxy-mode stub for remote governance that returned
hardcoded success for every spend, settle, and void — which made the entire
two-phase lifecycle theater and was, in effect, a governance bypass. So
we removed it: `connectProxy()` now throws, and passing `proxy` to
`trust()` fails fast with the reason. If proxy mode ships in the future it will
ship with real financial enforcement behind it. Until then: `dryRun` for
explicit bypass in testing, a real TigerBeetle for production.

## 10. Vault permissions stop at the vault's parent directory, and at Windows

On Linux and macOS every directory usertrust creates in a vault is `0700` and
every file `0600`, whatever the umask. A governor closes an existing `.usertrust/`
that other users can read, and refuses one that another user owns: it compares
the owner with the process's effective uid, and running as root is no exception.
A governor creates an absent `.usertrust/` itself, exclusively, and then checks
it like an existing one, so a `.usertrust/` that another user creates first is
refused, not adopted. That holds in a shared parent directory that is sticky, such
as `/tmp`, where only an entry's owner can rename or remove it. It cannot hold in
a parent directory other users can write to that is NOT sticky: any of them can
rename the vault away and put their own in its place after it was checked, and no
check on a path prevents that. Keep vaults out of such parents; usertrust does
not check a vault's parent directories.

On Windows usertrust does not set or check permissions. POSIX modes do not map
to Windows ACLs, and a mode check there would misreport who can read the vault.
The vault folder inherits its ACL from the folder it is created in, and that ACL
governs who can read the audit trail, the spend ledger and, with content capture
on, prompts and tool inputs. Keep the vault (and a usertrust-server's `stateDir`)
under your own user profile, which by default only you, administrators and SYSTEM
can read, or give the folder an owner-only ACL yourself. usertrust does not manage
Windows ACLs.

## 11. PII detection is a pattern scan of the prompt, not data-loss prevention

`pii: "block"`, `"redact"` and `"warn"` act on what a pattern scan finds in the
request's **prompt text**: `messages` (and a string `system`) for Anthropic,
`messages` for OpenAI chat, `input` and a string `instructions` for OpenAI
Responses, `contents` for Google. Everything else in the request is not read:
tool and function definitions (including Google's callable tool declarations),
an array-form `system` prompt, Google's `config` (including `systemInstruction`),
`metadata`, and every other field. The model's response is never scanned. A secret
in one of those fields goes to the provider as written, and when the prompt scan
finds nothing, `"redact"` changes nothing.

The patterns cover email, phone, US SSN, credit card (Luhn), IPv4 and seven
secret and token formats. They do not cover names, postal addresses, dates of
birth, IPv6, non-US identifiers, bank account numbers or health data, and a string
is checked as written (no decoding, no object keys, no non-string values). When
`"redact"` does fire, it replaces every matching string in the whole request body
in full, not only the matched characters. `createGovernor()` and `usertrust-server`
scan the `messages` the caller passes and can block, but never redact egress.
The full scope, per provider, is on the [PII Detection](https://usertrust.ai/docs/policy/pii) page.

## 12. A stream aborted by the caller's own signal is not charged for what it consumed

A governed `create({ stream: true })` call on an OpenAI or Anthropic client that the
caller aborts with its own `AbortSignal` has its hold voided, so the usage the stream
had already consumed goes uncharged. A stream the caller ends with an early `break` is
charged for what it consumed; the abort path is the gap. A provider error mid-stream
voids the hold, as intended. This is a known gap, fixed in the next release. Until
then, do not rely on an aborted stream to have been charged.

## 13. A ledger-backed server can hang when its ledger is unreachable, and may not audit a hold it releases on SIGINT or SIGTERM

A ledger-backed `usertrust-server` answers `POST /v1/authorize` only when its ledger
answers. If the ledger becomes unreachable, authorize calls hang without an answer, and
`GET /v1/health` still reports `ok`. A request the client abandons can leave its hold
reserved for up to 300 seconds after the ledger returns. These are known defects in
5.0.0. Until a later release fixes them, set a client timeout on every call to the server.

A ledger-backed server stopped by SIGINT or SIGTERM ends each pending hold through
`destroy()`, which the process can exit before finishing. A hold whose void had not
reached the ledger stays reserved until the ledger's 300-second hold timeout, and a
release can be missing from the chain.

---

Found a boundary we haven't documented? That is a bug in this file — open an
issue, or see [SECURITY.md](SECURITY.md) if it has security impact.
