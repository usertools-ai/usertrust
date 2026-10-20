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
- Google: `client.models.generateContent()` and `client.models.generateContentStream()`

Streaming through any governed method is governed end to end, including
mid-stream anomaly cutoff and settle-or-void on completion.

On every client, every other SDK method is **refused**, not
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
The Google specifics are in the Google paragraph below. The exact, current boundary is enumerated at the source in
`packages/core/src/detect.ts` and `packages/core/src/default-deny.ts`.

**Threat model.** Default-deny prevents ACCIDENTAL unmetered spend through the
governed client: a call to a method usertrust does not govern, a helper that
drives the SDK's raw client, a `withOptions()` copy. It is not a sandbox against
code that sets out to spend. A caller that keeps the raw client it constructed,
builds a new one through `client.constructor`, through the governed client's own
`trusted.constructor`, or through the prototype path
`Object.getPrototypeOf(trusted).constructor` (closing that path would break
`trusted instanceof Anthropic` / `OpenAI` / `GoogleGenAI`), or reads the API key off the
client (`client.apiKey` is a plain value and passes) is outside it, as with any
wrapper. On Google, a Stream returned by a free or listed call
(`interactions.get` with `stream`) exposes the SDK's raw next-gen client as a
public `client` property, unlike the Anthropic and OpenAI SDKs, which keep theirs
private. Calling a method on it is deliberate bypass, out of scope like
`constructor` and reading `apiKey`. Deliberate bypass from your own code is out of scope: code that holds a
provider key can always reach the provider. `usertrust-server` does not change
that, because it authorizes and settles spend but does not make or forward the
provider calls; enforcing against deliberate bypass needs the provider key held
outside that code. Writes through the governed client are refused (assignment,
`Object.defineProperty` and `delete` on the client, its resources and `_client`,
and on its transport objects `middleware`, `fetchOptions`, `_options` and
`_authState`), but two SDK objects are still handed back as they are: the
client's `logger`, which is the caller's own, and Anthropic's per-request
auth-flag `WeakMap`, which a proxy cannot wrap. On a Google client, plain data
objects (`httpOptions`) are handed back as they are too.

The boundary covers the governed client object. It does not cover the original
client you passed to `trust()`, a client you construct separately, or transports
that take a client and open their own connection (OpenAI's Realtime and
Responses WebSocket classes read the client's API key and talk to the provider
directly). Governed calls price tokens only: server-side tool fees (web search,
code execution, file search, containers) are not metered.

A Google client (`@google/genai` 1.52.0 or later) has the same default-deny
boundary. Its free methods are the reads, lists and deletes (`models.list`,
`caches.get`, `files.download`, `interactions.get` and the like), plus
`models.update` (metadata), `models.countTokens` / `computeTokens`, the cancels and
the operation polls. Everything else is refused: the billable methods
(`models.embedContent`, the image and video methods, `chats.create`,
`live.connect`, `batches.create`, `interactions.create`, `tunings.tune`,
`caches.create` / `update`, the `fileSearchStores` uploads, imports and creates),
every `*Internal` method (`models.generateContentInternal` sends the request
behind `generateContent`), `authTokens.create` (it mints Live keys charged to
your project), `files.upload`, and the SDK's raw transport by name: `apiClient` on
the client and on every namespace, `getNextGenClient()` and its cached
`_nextGenClient`, a next-gen resource's `_client`, and `live.auth` /
`live.webSocketFactory`. A method is decided by the path it is reached at, so
`chats.modelsModule.generateContent`, the SDK's raw `Models` under another name,
is refused. **`files.upload` sends the file's bytes with no PII scan.** It is
refused for that reason; listing it in `allowUngoverned` runs it audited as
`ungoverned_call` but unredacted, as does uploading on the original client. A
duck-typed Google client is guarded by shape: any object on it with a function
member or an accessor is treated as a namespace. **The shape check is
member-level.** An object with methods (an SDK resource, or a duck-typed
namespace) nested inside plain data, meaning an object or array with no function
member or accessor of its own, is returned as data, and its methods run raw. On the
real `@google/genai` the classification pin test fails on that shape for the
classified version; on a duck-typed client, nothing catches it.
**`models.generateContentStream` is refused** when it would run automatic
function calling (a streamed loop of provider rounds, which usertrust does not
yet meter round by round); `models.generateContent` with it is metered per round
instead, each round its own governed call. Use `generateContent`, or disable AFC with
`config.automaticFunctionCalling.disable: true`, to have the stream governed.
Whether a call would run that loop is the SDK's own decision. Before anything is
checked, charged or sent, usertrust runs the SDK's request pipeline over the
request, against a stand-in for its transport that sends nothing. The pipeline is
the installed `@google/genai`'s `Models` class, accepted after a short behavioural
check; a client's own `Models` class is never run (for the SDK's own client it is
that same class). With no installed SDK, the call is refused. "Installed" means
resolvable by Node's module resolution from usertrust's own install location, not
just present somewhere in the app: in an isolated or strict package layout where
usertrust cannot see the app's copy, or in a bundle that inlined or dropped one of
the two, Google calls are refused. Install `@google/genai` as a direct dependency
beside usertrust and keep both external to the bundle; the import uses a variable
specifier on purpose, so that bundlers do not inline it. Keep the `@google/genai`
that usertrust resolves at the same version as the one your client was created
from: a request field that only your client's version reads is not sent.
In that run every getter, `toJSON` hook and Proxy trap in the request runs as
often, and in the same order, as when the SDK sends it, apart from what the
per-call request-option check refuses before the run (a request, `config` or
`httpOptions` given as a Proxy, an option off the list held as data). The SDK's own writes
(moving a `$schema` `responseSchema`, rewriting a declaration's `parameters`) land
on your objects as they would natively, once per call. What the SDK read becomes
a plain-data copy, and that copy is what the PII scan, redaction, the meter and
the SDK then use. A callable tool and an `AbortSignal` go by reference. Fields
beside `model`, `contents` and `config` (a `metadata` a policy rule matches), which
the SDK neither reads nor sends, are read for the policy rules only, never placed
on the copy that is serialized, held for and sent. Per call,
usertrust runs the SDK again over a second copy. It must make exactly the requests
it made over yours (path, method, body bytes, `httpOptions`) and reach the same
automatic-function-calling decision, or the call is refused. This costs two extra
runs of the SDK's request conversion per call, with no I/O: about 7 ms for a
request carrying 1 MB of inline data. Where a governed call differs from the SDK's
own:
- **A value that answers differently on two reads is refused.** If the change
  would alter what is sent (a getter, a hook or a Proxy trap), the copy cannot hold
  both answers, so the call is refused rather than sent. The same goes for an
  object the SDK both reads field by field and serializes through `toJSON`, and for
  a cycle.
- **Some request shapes are refused rather than copied.** These are a header value
  that is not a string, a function of yours in the request that the SDK calls (a
  built-in method such as an array's `map` is fine), and a callable tool the
  request also holds outside `config.tools`, and a boxed `Number` or `String`
  converted by a `toString` or `valueOf` of yours. The copy cannot reproduce what the
  transport or that code would make of them. A function of yours that the SDK
  calls is never run: the call is refused instead. Your own iterator on
  `config.tools` counts as one.
- **An array whose class is not `Array` is refused where the SDK maps it.** When
  the SDK's own array methods (`map`, `filter`) build their result from an array
  of yours, natively they construct its class, and that class's constructor
  decides what is sent (it can give each instance a `toJSON`). usertrust does not
  run your code to find out, so such an array, a subclass from any realm, inside
  `contents` or in a config field other than `config.tools`, is refused: pass a
  plain array. (At `config.tools` the SDK maps the array but never serializes
  what it builds, so a subclass there is built as a plain `Array`, its
  constructor never run.) Another realm's own `Array` is mapped as natively when
  that realm's `Array[Symbol.species]` is its default; when it was replaced, the
  call is refused, and so is one whose realm's `Array.prototype.toJSON` was
  replaced (the per-call self-check cannot reproduce it). The previous release
  sent all of these.
- **Policy fields are read once, when the request is checked.** A field beside
  `model`, `contents` and `config` is read then (a getter there run once, as
  before) and kept beside the request for the policy rules, never sent,
  serialized or held for. A rule reads anything below it when the rule is
  evaluated, as before. These fields are not forwarded:
  a Google-shaped client that is not the SDK no longer receives them. They were
  never scanned for PII, held for or metered, so only what was is forwarded.
- **`config.httpOptions` is read at the start of the call**, as per-call request
  options are. The SDK is given that copy (only the allowed keys) wherever it
  later reads `params.config.httpOptions`, even through a `config` added or
  replaced after the call started; with none at the start, none is given. Your
  own `httpOptions` is never read again. It is read as the SDK finds it, through
  the prototype chain, so one the config inherits is governed the same way: its
  allowed keys are sent, and any other key held as data is refused at the start.
  That copy is made only when the whole path to it is plain data. At every
  level, what is refused and what is sent is what the per-call request-option
  check refused and sent before the SDK's pipeline read the request:
  - a `config` held by a getter, or a getter `httpOptions` (own or inherited),
    whose option keys are data, is read when the SDK reads it, not at the start,
    and is sent; a later change to an allowed key, such as a header, is sent as
    the SDK reads it. Before, such a getter was run, and its options fixed, at the
    start of the call;
  - a getter option key is refused whatever holds it, before its getter runs: at
    the start of the call inside a data `httpOptions`, and, past a getter `config`
    or `httpOptions`, when the SDK reaches the `httpOptions` holding it;
  - a Proxy anywhere on the path (as `config` or `httpOptions`, on their prototype
    chains, or answered by a getter), or a chain longer than 64 objects, cannot be
    read without running your code, and the call is refused;
  - a key off the list is refused, at the start of the call when the path is data,
    and when the SDK reaches it past a getter.

  A table in the tests pins this, 104 cases (each shape of the path holding an
  allowed option or `extraBody`, on both methods and both backends), each
  asserting the outcome and the number of requests; any change to this path
  keeps every case equal.
- **Every other field is read when the SDK reads it, not when the call starts.**
  The SDK reads the request after its own first `await`, so a field you change
  right after calling (a `systemInstruction`, `contents`) is sent as it is then,
  as without usertrust, and is what the PII scan, redaction and the meter see.
  Before this, the request's top-level fields, and its `config`'s, were copied at
  the start of the call.
- **A callable tool reaches the SDK as a wrapper.** Its `tool()` runs inside the
  first governed round, and `callTool()` is passed through; nothing else of the
  tool object is reachable from the request. A call the SDK sends without its own
  function-calling loop carries `automaticFunctionCalling.disable: true`, which the
  SDK never sends to the provider.
- **Later AFC rounds reuse the copy.** With automatic function calling on
  `generateContent`, rounds after the first reuse the copy instead of re-reading
  your objects. Every round is still its own governed, metered call.
- **A callable tool's `tool()` runs later.** It runs after authorization, once per
  call; the SDK runs it before its first request. A denied call never runs it, and
  a `tool()` that changes your config does not change what is sent.
- **A local SDK rejection is the SDK's own error.** For a request the SDK rejects
  locally (incompatible tools, empty `contents`, a getter that throws), the call
  throws the SDK's own error after a `policy_denied` audit event, with nothing sent
  or charged. The audit event names the error's class, never its message, which
  can carry your content (a getter can throw anything).

**Only request options that change neither the body nor where it is sent are allowed.**
A governed call is scanned, held and priced from its request parameters. But each SDK
takes per-call request options too: the second argument on Anthropic and OpenAI, and
`config.httpOptions` on Google. Some of them replace what those parameters describe, so
they are governed by a list, as default-deny governs methods.

**Allowed, because they were measured to change neither the body nor the host:**
- `timeout`, `maxRetries`, `signal`, `idempotencyKey`;
- `stream`, which the SDK sets itself after reading the options;
- `headers`: a beta header, such as Anthropic's long-context one, is priced from the
  usage the provider reports;
- `query`, which changes only the URL's query string;
- `method`;
- on Google, `httpOptions` `apiVersion`, `headers`, `timeout` and `retryOptions`.

**Every other option is refused** before anything is held or sent, with a
`policy_denied` event. An option an SDK adds later is refused until it is measured and
listed. Among the refused ones, as measured:
- `body`;
- `fetchOptions`, which is spread over the request last, so its `body` wins;
- Anthropic's per-call `middleware`, which rewrites the built request;
- `path`, which can name an endpoint default-deny refuses as a method;
- `defaultBaseURL`;
- Anthropic's beta-only `fallbackState`, which is not measured;
- every internal `__` option, named as such: `__binaryResponse` returns the raw body, so
  usage would never be read and the call would settle at its estimate;
- on Google, `httpOptions.extraBody` (merged into the body), `baseUrl` and
  `baseUrlResourceScope`.

A key counts when it is present, even as `undefined` (the SDK copies that too). Request
options must be a plain object: a function, an array, a class instance or a Proxy is
refused whole, and an option held by an accessor (a getter), allowed or not, is refused
and never called. Nothing in these checks runs caller code. Anything on the way that could
only be read that way, whether an accessor or a Proxy at any step from a resource's
`_client` to a client's `fetchOptions`, `middleware` or Google `httpOptions`, is refused,
never read as absent. Each of these is read where the SDK reads it, along its prototype
chain, since the SDK's plain property access finds an inherited value: a client wrapped as
`Object.create(client)`, a resource whose `_client` is inherited, or an inherited `config` or
`httpOptions` is checked like an own one, and a Proxy anywhere on that chain is refused,
and none of its traps runs. A chain longer than 64 objects is refused too. **What is forwarded is a copy:** a new options object
(on Google, a new `httpOptions` in a shallow copy of the request) holding only the allowed
keys, each read once. A key the caller adds, or a value it changes, after the call starts
cannot reach the SDK.

**A request that cannot be serialized to JSON is refused.** A governed call is scanned, held
and sent as one JSON serialization of its request. A request that has none (a cycle, a BigInt,
a `toJSON` or getter that throws, a text too long to build) is refused with
`request_unserializable` and a `policy_denied` event, before anything is held or sent:
otherwise the SDK would serialize it on its own, and a hook that throws once and then answers
would send what nothing checked. With the provider SDKs such a request also fails inside the
SDK, so an honest one loses nothing: it was never sent. A client of another kind that never
serializes its request (a stand-in, a test double) would have taken it, and is refused too. A Google request reaches this check as the request gate's
plain-data mirror: a callable tool in it serializes as `{}`, and a real `AbortSignal` at
`config.abortSignal`, the one value the mirror keeps by reference for the transport, is left out
of the check (an object there that is not a signal is the request's, and is checked). The gate
refuses most requests the SDK cannot serialize before they get here.

**A client that rewrites every request** is refused by `trust()`, before the ledger client
is built, and every call refuses too if one is changed later on the raw client the caller
kept:
- an Anthropic client constructed with `middleware`, including the SDK's own
  `betaRefusalFallbackMiddleware`, which re-sends a refused call to a fallback model
  after it was priced;
- an Anthropic or OpenAI client constructed with `fetchOptions` carrying `body` or
  `method`. The SDK spreads a client's `fetchOptions` over every request after the body.
  Its transport keys, such as a proxy `dispatcher`, stay allowed;
- a Google client whose `httpOptions` carry `extraBody`, own or inherited, or a `toJSON`
  (the SDK merges a call's own `httpOptions` into a `JSON.stringify` copy of the client's).
  The SDK reads `extraBody` by property access, so the client's `httpOptions` must be a
  plain object of this realm, or have no prototype; another realm's is refused.

A default client has no middleware. A cloud-provider subclass's `backendMiddleware()`,
which signs requests, is never read. **A client handed to `trust()` inside a Proxy is trusted
as transport, and is not refused.** Observability wrappers return the SDK client inside a
forwarding Proxy. A Proxy's traps can show these checks one value and the SDK another, so
nothing is read through it, and a Proxy built to do that is deliberate bypass, out of scope
as above. To have the checks read the client itself, wrap the raw client with `trust()`
first, then instrument the trusted client. Only the Proxy itself is trusted: the per-call
checks still read the SDK resource each call runs on, and its client, so a body-moving
option reached through a Proxy client is refused all the same. The checks hold every
object they read to being plain: request options and client `fetchOptions` must be plain
objects, and a client's `middleware` must be a plain array (no own iterator or other own
key, no accessor index), so the check and the SDK read the same thing. **A client constructed with its own `fetch` is
trusted transport and is not refused.** That `fetch` can rewrite any request, body
included; proxies, test harnesses and instrumentation use it legitimately. It is the
transport `trust()` wraps, so what it does to a request is the caller's own code, out of
scope as above. The row that pins this uses a stand-in subclass that
overrides `backendMiddleware()`, not a published cloud SDK, which this package does not
install. A change made to the raw client between a call's check and its send, from the
caller's own code, is deliberate bypass, out of scope as above.

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

**The hold is an estimate, made before the call.** Its input leg is the larger of two
figures, both read from the one serialized snapshot of the request, never the live
object:
- the prompt parts' estimate;
- an estimate of the whole request body: the UTF-8 bytes of every key and value, / 4 × 1.5.

Its output leg is the request's own cap, per candidate:
- Anthropic `max_tokens`;
- OpenAI chat `max_completion_tokens`, else `max_tokens`, times `n`;
- Responses `max_output_tokens`;
- Google `maxOutputTokens`, times `candidateCount`. Google bills its thoughts apart from its
  candidates, but documents `maxOutputTokens` as a hard cutoff on everything a response
  generates, thought tokens included
  (https://ai.google.dev/gemini-api/docs/thinking, "Token limits and max_output_tokens"), so the
  thinking budget is not added to it. With no cap: never below 4096 per candidate, nor below
  `thinkingConfig.thinkingBudget`.

A request with no cap holds 4096 output tokens.

A call whose real cost turns out above its hold is posted capped at the hold, and the
truncation is recorded as a `settlement_shortfall` event: visible, never silent. These
are known to land there:
- **content passed by reference:** Anthropic `url`/`file_id` sources, OpenAI image URLs
  and `file_id` inputs, Google `fileData.fileUri`. A document by URL is a few dozen bytes
  of body and can bill tens of thousands of tokens;
- **a Google callable or MCP tool:** its declarations are resolved after authorization;
- **an uncapped output** above 4096, and Google dynamic thinking with no `maxOutputTokens`.

The estimate's byte heuristic is **not calibrated against any provider's tokenizer**
(Anthropic, OpenAI and Google are all unmeasured), so a dense input such as a JSON schema
can bill above it. The calibration corpus and the format for recorded counts are in
`packages/core/tests/fixtures/token-calibration/`.

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
`usertrust-server` do not enforce `audit.failClosed`. Such a process's budget is
not visible to vault readers either: the enforced-budget record
(`effective-budget.json`) is replaced only by the process that holds the lock, so
the ledger UI, `inspect`, `health` and `report` show the lock holder's budget while
the degraded process goes on enforcing its own. The exception is a vault with no
record: a governor publishes its budget when it starts if none stands, so until the
lock holder's first append they show the budget of whichever process started
first.

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
- **A lock from another PID namespace is reclaimed only once its lease has
  expired.** One container cannot probe another container's processes, and a
  differing boot id proves nothing across namespaces (systemd-nspawn gives a
  container a private boot id on the host's kernel). So a lock written in a
  different PID namespace on the same kernel is held while its writer renews
  its lease: a writer on Linux renews the lock file's modification time every
  5 seconds. Once a lease has gone unrenewed for more than 60 seconds, and the
  process that finds it has itself seen it unrenewed for 30 seconds, the lock
  is reclaimed. So a writer that restarts into a NEW PID namespace (a container
  restarted after a crash, or WSL2 after every restart) recovers its vault on
  its own, about a minute after the old writer's last renewal. The appends it
  makes until then are refused and dead-lettered, as for a second process.
  A writer whose renewals fail for 20 seconds (a full file-descriptor table,
  an I/O error) stops writing under its lease: the append that finds it is
  refused and dead-lettered, and the lock is given up. That is before any
  writer in another namespace could reclaim it (30 seconds at the earliest),
  so the chain cannot fork under a write. The next append takes the lock
  again, and re-reads the chain's tail.
  Three cases still need a hand:
  - A lock written by a usertrust version that does not renew a lease (5.1.0
    and earlier) is never reclaimed from another namespace. Such a lock left
    behind by an upgrade needs one removal by hand.
  - A writer whose filesystem cannot set a file's modification time writes a
    lock with no lease. So do a snapshot restore and `usertrust audit
    quarantine-tail`, which change the audit files in ways an append's own
    check does not guard: a lock either leaves behind after a crash is removed
    by hand.
  - A writer that is frozen (SIGSTOP, a paused container) or blocked for more
    than a minute loses its lock to a writer in another namespace. Its next
    append is refused. Only a writer frozen in the middle of an append can add
    one more event, and `usertrust verify` then reports the chain broken there.

  Every refusal prints the safe recovery steps: confirm that no process can
  still be writing the vault, from every host, WSL distribution and container
  that can reach it; then remove exactly `.usertrust/audit/.audit-writer.lock`;
  then run `usertrust verify`. To avoid the wait entirely, run the writer in a
  PID namespace that survives its restarts (for example the host's).
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

**Known issue, present in current releases (first documented in 4.1.0) — deleting the most recent records.**

An audit log whose newest events were removed can read as verified. Without anchors the chain is checked only against itself, so a vault whose newest events were cut, and whose `.meta` file was deleted or rewritten to match, passes `usertrust verify` and `usertrust-verify` (exit 0, `UNANCHORED`). The usertrust-ui dashboard does not check anchors (its Anchor file cell says only whether the file exists): a dashboard opened after the cut reads Integrity `verified` for such a vault, and for an anchored vault rolled back below its anchor, while one already running when the events are removed reports the removal. To detect a removal, enable anchoring and run `usertrust verify` or `usertrust-verify` with `--anchors <file>` (the anchor history, fetched from your anchor sink) and `--pubkey <pem>` (your pinned genesis key): a rollback below an anchor then fails with `ANCHOR_MISMATCH`. Without `--pubkey` the anchors are not checked, and the vault still passes as `ANCHOR_UNVERIFIABLE`. `usertrust verify --receipts <file>` also fails (exit 1, `INCOMPLETE`) when a receipt you kept names an event the log no longer holds.

More detail. The `.meta` sidecar that records the chain's head lives in the vault beside the log, which is why rewriting it defeats it. If only the events were deleted and the sidecar was left alone, verification fails, but only until the next governed call from a freshly started process: that call appends after whatever tail it finds and rewrites the vault's sidecar, after which verification passes over the shortened chain. An anchor catches the deletion of the records it covers (those up to the tree size it recorded); records appended after the last anchor are still unanchored. Editing a record, deleting a record from the middle of the chain, and re-hashing the whole chain against a published anchor are all detected. Emptying `events.jsonl` while its `.meta` sidecar remains is not a silent tail deletion: the next append continues from the sidecar's hash and verification reports the gap. The bypass applies to a tail deletion that also deletes or rewrites the sidecar, or that is followed by an append from a new process.

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

Fixed in 5.0.1: a governed stream the caller aborts with its own `AbortSignal` now settles
the usage it consumed, as an early `break` does, instead of voiding its hold. 5.0.0 still has
the gap, on OpenAI and Anthropic `create({ stream: true })`.

## 13. A ledger-backed server refuses authorizes while its ledger is unreachable, health can read `unknown` rather than the outage, and a hold it releases on SIGINT or SIGTERM may not be audited

A ledger-backed `usertrust-server` waits at most `ledgerTimeoutMs` (default 5 seconds) for
its ledger on `POST /v1/authorize`, including the wait behind the tenant's earlier
authorizes (the governor serves them one at a time), then answers `503 ledger_unavailable`:
nothing was authorized. `retryAfterMs` is a suggested wait, not a promise that a retry succeeds: a
client that can wait backs off with jitter, and one with a hard time budget, such as the Claude Code
plugin's PreToolUse, may make one short retry instead (the server README's *Retrying*). The
TigerBeetle client has no
timeout or cancel, so the refused request stays queued and executes when the ledger
returns; the hold it then creates is voided at once, never registered as pending. While
such a request is outstanding, every authorize on that tenant gets the same 503 at once. If
it never completes, they keep failing fast until it does: the fail-closed direction.

- A tenant's governor is created on its first authorize, inside the deadline, so the first
  authorize after boot on a slow ledger can get the 503, which is retryable.
- While that creation itself hangs, fast-fail does not engage: each authorize waits one
  deadline before its 503.
- A tenant's authorizes are served one at a time, so a burst counts against the deadline
  too. Measured on an Apple M4 Pro against a local single-node TigerBeetle, each took about
  14 ms, and the default 5 s deadline was reached at roughly 350 concurrent authorizes for
  one tenant (300 were all served; 400 drew 503s). A slower or remote ledger reaches it
  sooner. A tenant that issues many concurrent authorizes should raise `ledgerTimeoutMs`.
- `GET /v1/health` reports the ledger as `ledger` (`ok` is `false` when it is `unreachable`)
  only where a health child observes it: the CLI's default, but not `createUsertrustServer()`'s,
  which answers `ledger: "unknown"` and `ok: true` through an outage unless `ledgerHealth` is
  `"child"`. Health also reads `unknown` while a tenant's governor is still being created, after
  a tenant's config changed since start (until a restart), and while an observer child that died
  waits out its cooldown (five minutes by default). If its replacements keep failing, `unknown`
  lasts as long as they do. Each child holds one TigerBeetle session, per distinct configured
  ledger target, for the life of the server.
- `/v1/settle`, `/v1/abort` and `/v1/release` still wait for the ledger without a bound,
  and complete when it returns.
- A client that hangs up after the server has written its `200` cannot be detected: that
  hold is registered as pending and swept as any other.
- An authorize that ends without a ledger reply (an evicted client session) may still have
  reserved, and that reservation expires at the hold timeout.
- An authorize still outstanding at shutdown whose reserve lands after `destroy()` began
  expires at the hold timeout.
- The `hold_released` record of a late hold's give-back is best-effort. The operational
  record is `voidsOwed` on the authenticated `GET /v1/budget` and the server's log line. The
  record carries `releaseClass: "unused"` (the client never received the transferId), or
  `"call-unconfirmed"` when writing the `200` itself failed, since that answer may have reached
  the client.

A ledger-backed server stopped by SIGINT or SIGTERM ends each pending hold through
`destroy()`, which the process can exit before finishing. A hold whose void had not
reached the ledger stays reserved until the ledger's 300-second hold timeout, and a
release can be missing from the chain.

## 14. A ledger client the cluster evicted cannot be released, and keeps its process from exiting on its own

A TigerBeetle cluster evicts a client's session when it has more sessions than it keeps
(a shared cluster past its session limit, or churn), or when the client's release does not
match. tigerbeetle-node 0.17.9 aborts the whole process (SIGABRT) when `destroy()` is called
on an evicted client, and nothing in JavaScript can catch that. usertrust therefore never
destroys a client it knows was evicted, and it knows in two ways:

- **A request is refused with an eviction code** (`ERR_CLIENT_EVICTED`, or a release the
  cluster does not take).
- **A request fails "closed" on a client usertrust never destroyed.** A client whose session
  was pushed out while it was idle learns of that from its own traffic (measured: about 25 s
  later), and from then on fails every request `ERR_CLIENT_CLOSED`, never with an eviction
  code. tigerbeetle-node raises "closed" otherwise only for a client that was destroyed.

Either way the request is retried on a fresh client, and the evicted client is dropped and
left open. At shutdown a governor asks its client first: its `destroy()` makes one empty
request (bounded at 2 s) after its voids, its audit flush and its audit lock release, and
leaves the client open if that request shows an eviction. So neither a governor nor
`usertrust-server`, whose shutdown tears every tenant's governor down at once, aborts on an
evicted client.

An evicted client left open holds no thread, file descriptor or memory that grows with
repeated evictions (measured over 20 evictions in one process, against a real cluster: threads
stayed at 13 and open file descriptors at 18; resident memory rose 1.7 MiB from the first
eviction to the twentieth and levelled off). But it keeps the process from exiting on
its own: after `destroy()` the event loop stays alive, with nothing in JavaScript
holding it. `destroy()` says so (through `onAlert`, or a `console.warn`) whenever an evicted
client was dropped. A process that relies on exiting when its work is done, such as a script,
should end with `process.exit()` after `destroy()`. `usertrust-server` already ends with
`process.exit()` when it is stopped (SIGINT or SIGTERM), and `usertrust budget` ends the process
itself, once its output has drained and with its own exit code, when it left an evicted client
open. This lasts until a tigerbeetle-node release can release an evicted client.

What is still open:

- **`TrustTBClient.destroy()` called directly** on a client whose session was pushed out
  while it was idle, with no request since, cannot know the client is evicted, and aborts the
  process. A program that uses `TrustTBClient` directly and may sit idle should make one ledger
  request before `destroy()` (it marks an evicted client, which `destroy()` then leaves), or
  end with `process.exit()` without calling `destroy()`.
- **An eviction learned in the instant between a governor's shutdown request and the destroy
  that follows it** (no `await` between them) still aborts. The client learns of an eviction
  from its own traffic about 25 s after the cluster pushed the session out, so this needs that
  moment to fall inside one synchronous step. By then the governor has finished its voids, its
  audit flush and its lock release, so what is lost is the exit status (134, which a supervisor
  reads as a crash) and anything the process does after `destroy()`.

## 15. `usertrust snapshot restore` overwrites the live vault without warning or backup, and its exit code does not say whether it worked

`usertrust snapshot restore <name>` writes the files the snapshot holds (the audit log and its `.meta` file, the spend ledger, `leases.json`, policies, patterns and config) over the live ones and deletes nothing, so events appended to the log after the snapshot was taken are dropped, with no warning and no backup, and the command exits 0. Files the snapshot lacks are left in place, so the restored vault verifies only if they are consistent with it. A refused restore also exits 0. `usertrust snapshot create <name>` takes no writer lock, so a snapshot taken while a usertrust process writes the vault can be inconsistent, and it overwrites a snapshot that already has that name. Stop every usertrust process that writes the vault before you create or restore a snapshot; before a restore, take a snapshot under a new name or copy `.usertrust/`; check `usertrust snapshot list` before creating one; and in a script, read the `Snapshot restored:` line, or `"success":true` under `--json`, not the exit code.

Why: a snapshot is one file, `.usertrust/snapshots/<name>.json`, holding the whole `audit/` tree (the log and its `.meta` sidecar) plus `policies/`, `patterns/`, `usertrust.config.json`, `leases.json` and `spend-ledger.json`. A restore stages each of those files beside its target and renames it into place. It asks nothing and takes no copy of what it replaces. It does not compare the snapshot with the live vault: the snapshot records the audit head it was taken at, and restore never reads it, so a snapshot older than the live log simply wins. A restore does take the audit-writer lock; a snapshot does not. Creating a snapshot writes the file with no existence check, so the name of an older snapshot silently replaces it.

What a snapshot never holds, and so a restore never brings back: `tigerbeetle/`, `snapshots/`, `dlq/`, `effective-budget.json`, `audit/anchors/` and the audit-writer lock. Anchoring state is monotonic and is never rolled back. The ledger is the same: a restore rolls the audit chain and the spend ledger back and leaves TigerBeetle where it is.

A restore refuses in these cases, among others, each printed as `Restore refused: <message>` (or `"success":false` under `--json`) and each with exit code 0, because the command sets no exit code for them: the snapshot rolls back the audit chain but has no `spend-ledger.json`; a live TigerBeetle ledger is present (`--force` acknowledges that it cannot be rolled back, and is the only thing it bypasses); the audit writer lock is held; the snapshot name is invalid (a path separator or `..`); and the snapshot file does not exist or cannot be read. A restore or create with no name prints a usage line and also exits 0. There is no `--yes` and no prompt.

Detecting a rollback after the fact needs evidence held outside the vault, an anchor or receipts you kept (section 8): a restore that takes the log below an anchor shows as `ANCHOR_MISMATCH` when you verify with the anchors and your pinned key (see [docs/anchoring.md](docs/anchoring.md)). Without either, the restored vault is checked only against itself. Verification reads every audit segment in the directory, so a segment the snapshot lacked can make the restored vault fail with duplicate sequences or a count mismatch.

## 16. A model id written the way a gateway or cloud platform writes it is priced at the fallback rate

On an endpoint classified as cloud (the default for an endpoint that is not loopback and that no `endpoints` entry classifies), a model id written the way a gateway or cloud platform writes it is priced at the fallback rate, the table's dearest ($25 in and $125 out per million tokens), so its hold is larger too and a small budget can refuse the call. This covers Bedrock ids (`anthropic.claude-...-v1:0`), Vertex ids (`claude-...@<date>`, `publishers/google/models/...`), OpenRouter ids (`anthropic/claude-sonnet-4.5`), `-latest` aliases without a row of their own, and ids in another case (`GPT-4o`). To price such an id, set `pricing` to `"custom"` and add the exact id to `customRates`; to refuse such a call instead, set `unknownModelPolicy` to `"deny"` (the default, `"warn"`, prices it at the fallback rate and warns once per id in each process). A gateway reached over loopback is classified as local by default and priced by `local.models` or `local.defaultRate` instead, where `customRates` does not apply. Separately, reports, exports, the dashboard and rendered receipts name the provider from how the id begins (`claude`, `gpt`, `gemini` and a few others, in lower case), so an id that begins otherwise (`anthropic.claude-...`, `anthropic/claude-...`, `publishers/...`, `GPT-4o`) shows the provider as `unknown`; `customRates` does not change that.

Why: the pricing table is keyed by the ids the providers' own APIs use. A lookup tries the exact id, then the id with one trailing `-YYYYMMDD` or `-YYYY-MM-DD` removed, and nothing else: it is case-sensitive and does not strip a namespace, a `@<date>` or a `:0` suffix. A miss is metered at the fallback rate rather than at zero, because an id that cannot be priced is more safely over-counted than under-counted; the receipt marks it `rateSource: "fallback"`. The larger hold follows from the larger rate, and the ledger refuses a hold the budget cannot cover.

For a local endpoint the call is also never marked unknown. Section 2 warns about a loopback address that is really a forwarding sidecar to a paid API: set `local.autoDetectLoopback: false` and classify by `endpoints` entries there, or such a gateway is priced as local.

What to do, for an endpoint classified as cloud: put the exact id in `customRates`, with `pricing: "custom"`, at the rates your gateway actually bills. Keys match exactly: there is no date stripping and no wildcard. A cache-read or ordinary cache-write rate you leave out is priced at `inputPer1k`; an omitted `cacheWrite1hPer1k` is priced at the dearer of the ordinary cache-write rate and twice `inputPer1k`. Or set `unknownModelPolicy: "deny"`, which refuses the call before any hold with `unknown_model: <id> not in pricing table`.

The provider label is a separate prefix check on the model id, not part of pricing. The `provider` field of an SDK receipt is the client's kind (`anthropic`, `openai`, `google`), and a headless receipt's is `headless`, whatever the model id says. Because the check reads only the first characters, an id can be labelled and still be priced at the fallback: `mistralai/mistral-small` reads `mistral`, and a Vertex `claude-...@<date>` reads `anthropic`. Pricing details are on the [pricing page](https://usertrust.ai/docs/api/pricing).

---

Found a boundary we haven't documented? That is a bug in this file — open an
issue, or see [SECURITY.md](SECURITY.md) if it has security impact.
