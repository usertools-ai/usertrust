# AGENTS.md

Instructions for coding agents and human contributors working in this repository.

This file is the single source of truth for architecture, invariants, and conventions. Read it
before changing anything under `packages/`. Everything here is verifiable against the code; where a
rule exists to prevent a specific failure, the failure is stated.

---

## What usertrust is

usertrust is a financial-governance SDK for AI agents. A single call — `trust(client)` — wraps a
provider SDK client (Anthropic, OpenAI, Google) in a JavaScript `Proxy` so that every governed LLM
call becomes a two-phase, double-entry ledger transaction plus an entry in a tamper-evident,
hash-chained audit log. A separate zero-dependency package, `usertrust-verify`, lets an auditor
recompute and verify that log without trusting the SDK that produced it.

The product claim is *independent verifiability*. Most of the invariants below exist to keep that
claim true.

Two entry points:

- `trust(client, opts)` — wraps a provider SDK. Full governance: policy, PII, prompt-injection
  detection, ledger, audit, receipts.
- `createGovernor(opts)` (`usertrust/headless`) — SDK-free `authorize` / `settle` / `abort` for
  callers who own their own HTTP path. Deliberately thinner: **no injection detection, no
  redact-on-egress, no `audit.failClosed` enforcement**, and settlement **re-resolves** rates from
  the authorize-captured model and endpoint instead of carrying the authorize-time resolution.

---

## Repository layout

Monorepo, npm workspaces (`packages/*`). `site/` is a Next.js app and is **not** a workspace.

| Directory | npm name | Notes |
|---|---|---|
| `packages/core` | `usertrust` | The SDK. `bin: usertrust`. Exports exactly `.`, `./headless`, `./pricing`. |
| `packages/verify` | `usertrust-verify` | Zero-dependency standalone verifier. `bin: usertrust-verify`. |
| `packages/openclaw` | `usertrust-openclaw` | OpenClaw plugin integration. |
| `packages/server` | `usertrust-server` | HTTP server surface. |
| `packages/acs-adapter` | `usertrust-acs-adapter` | ACS adapter. |
| `packages/ui` | `usertrust-ui` | Visual ledger (bundled front end; `build` = `tsc && vite build`). |
| `packages/monte-cristo` | `usertrust-monte-cristo` | Simulation engine. Not in the release lockstep. |
| `packages/claude-code-plugin` | `usertrust-claude-code` | `private: true`. Ships `hooks/*.mjs`; no `src/`. |

The first six are version-locked and released together. `monte-cristo` and `claude-code-plugin`
are not.

### `packages/core/src` map

| Area | Files |
|---|---|
| Governance | `govern.ts`, `headless.ts`, `streaming.ts`, `detect.ts`, `config.ts`, `proxy.ts` |
| Ledger | `ledger/{client,engine,pricing}.ts` |
| Audit | `audit/{chain,canonical,merkle,verify,read,rotation,entropy}.ts` |
| Anchoring | `audit/{anchor,anchor-verify,anchor-doctor,rekor,rekor-verify,sigv4}.ts` |
| Policy | `policy/{gate,default-rules,pii,injection,canary,decay}.ts` |
| Board | `board/{board,director,concerns}.ts` |
| Budget | `budget/{allocation,attribution,context,runway}.ts` |
| Runtime | `resilience/{circuit,scope}.ts`, `memory/patterns.ts`, `snapshot/checkpoint.ts` |
| Other | `anomaly/`, `export/`, `supply-chain/`, `vault/`, `shared/`, `cli/` |

---

## How a governed call flows

`client.messages.create(...)` on a client returned by `trust()`:

1. **Classify the endpoint.** `classifyEndpoint()` resolves `{ class: "cloud" | "local", runtime }`
   from an explicit override, then `client.baseURL`, then `config.endpoints[]`, then loopback
   autodetect. It never throws; the default is `{ class: "cloud", runtime: "unknown" }`.
2. **Price once — for settlement.** The single `rateResolution` taken at authorize is the only one
   that touches money: it prices the hold, both settlement paths, and every `receipt.meter`, and
   settle never re-resolves it. Note the precise claim, because `resolveRates` itself is *not*
   called once: the anomaly detector's `costCalculator` re-invokes it per streamed event to price
   the velocity signal, and `createGovernor` re-invokes it inside `settle()`. Neither of those
   results may reach a hold or a posted amount.
3. **Authorize under a mutex.** `AsyncMutex` serializes budget check + hold so concurrent calls
   cannot both pass a budget check.
4. **Policy gate.** `evaluatePolicy(mergePolicies(DEFAULT_RULES, userRules), context)`. Then PII
   (`warn` / `redact` / `block`), then injection detection.
5. **PENDING hold.** `engine.spendPending({ transferId, amount: estimatedCost })` creates a
   TigerBeetle pending transfer debiting a funded, `debits_must_not_exceed_credits` wallet and
   crediting the treasury. Which wallet is `params.debitAccountId ?? holdingId`: the per-session
   holding wallet by default, the `(parent, cost center)` **envelope** wallet on an attributed call
   (see the attribution invariant below). Both carry that same flag, so the enforcement claim is
   identical either way. Over-budget is rejected *by the ledger*, atomically, and surfaces as
   `InsufficientBalanceError`. Mutex released.
6. **Forward** to the provider.
7. **Extract usage**, compute the actual cost via `costFromRates`.
8. **Audit first.** The `llm_call` event is appended to the hash chain **before** the budget commit
   and before the ledger POST, so a `failClosed` deployment never settles an unaudited spend.
9. **Settle.** `finalizeOnce("settle")` claims the single terminal outcome, then the budget commits
   and `engine.postPendingSpend(transferId, actualCost)` posts `min(actual, reserved)` — TigerBeetle
   REJECTS (never caps) a post above the pending amount, so the factories cap it and return the
   truncation, which the governor audits as `settlement_shortfall` and reports as
   `receipt.postedCost`. `receipt.cost` stays the true metered cost.
10. **Or void.** Any failure path routes to `finalizeOnce("void")` → `voidPendingSpend`.

`destroy()` waits up to 5s for in-flight work, voids all remaining pending transfers, flushes and
releases the audit writer. **Callers must call it** or the process hangs on the TigerBeetle client.
A `process.on("beforeExit")` handler calls it too, but that is a net, not a substitute: `beforeExit`
fires only once the event loop drains, and an open TigerBeetle client is precisely what keeps it
from draining. The net catches a governor whose client is already closed; it cannot catch the case
the rule exists for.

Streams: settlement runs in a `finally`, so a consumer breaking out of `for await` settles the
consumed cost exactly like a clean end. Only a *thrown* error voids. For Anthropic `MessageStream`,
governance taps the multicast emitter (`streamEvent` / `finalMessage` / `error` / `abort` / `end`) —
it never iterates the stream, because that would steal the caller's single-owner iterator.

---

## Invariants

Each rule states the failure it prevents. Do not weaken any of these without understanding the
failure it encodes.

### Money

**Exactly one ledger mutation per hold, claimed synchronously.**
`finalizeOnce("settle" | "void")` is a one-shot gate. The first terminal signal wins; every later
signal returns `false` and must not touch the ledger. Every new stream surface's emitter, iterator,
error and abort listener must route through it.
*Prevents:* six stream consumption modes plus abort/error/end paths double-settling, or
settle-then-void leaving the ledger holding a debit its accounting does not.

**The settle/void asymmetry is deliberate. Do not "make it consistent."**
- Usage-extraction failure *after a successful provider call* settles at the estimate, never voids.
- A clean SSE close with no `message_stop` settles at the estimate rather than dangling.
- A consumer-initiated abort settles the partial; it does **not** void, and must **not** record a
  circuit-breaker failure.
- A governance anomaly cutoff voids.
- A post-commit `failClosed` throw must **not** void an already-posted transfer.

**Settle never exceeds the hold — and never silently fails because of it.** The hold's input side
is a chars/4 × 1.5 heuristic (`pricing.ts`), so real usage CAN price above the reserve. Both
`createTBEngine` factories cap the post at the reserved amount (`pendingMap` carries
`heldAmount`) and return `{ posted, shortfall }`; `ledger/engine.ts` reaches the same semantics
reactively (status-31 → re-post via `amount_max`). A shortfall is recorded as a
`settlement_shortfall` audit event and `receipt.postedCost`; `settled` stays true.
*Prevents:* the pre-hardening behavior — TigerBeetle rejecting the post, the call reporting
`settled:false` with the hold stranded PENDING until destroy/300s timeout, and the wallet
ultimately charged ZERO for a successful call while receipt and chain recorded the full cost.

**TigerBeetle `exists` IS SUCCESS.**
On `createTransfers`/`createAccounts`, `CreateTransferStatus.exists` / `CreateAccountStatus.exists`
means the operation committed. Every `exists_with_different_*` status and every other status remains
a hard failure. This holds only because transfer ids are minted *outside* the `withReconnect`
closure, so a reconnect retry resubmits the same id and TigerBeetle deduplicates on it.
*Prevents:* a socket reset mid-`postTransfer` reporting a failed settlement for money that already
moved — then voiding an already-posted transfer. The converse is the likelier mistake: mint the
transfer id *inside* the `withReconnect` closure and a retry submits a **fresh** id, TigerBeetle has
nothing to deduplicate against, and the caller double-spends.
*Two exceptions, both requiring `created`:* `createTreasury`, and `createFundedBudgetWallet`. The
latter's id comes from `tbId()` — **random, not derived** — so the precondition above does not hold
for it: an `exists` there is a genuine id collision, not a retry. Accepting it would return someone
else's account and then re-run the seeding `immediateTransfer`, double-funding a balance-enforced
wallet.
*Corollary:* never wrap `createUserWallet` in a blanket `try/catch` "to handle already exists" — a
broad catch swallows `exists_with_different_flags`, i.e. an account missing its
`debits_must_not_exceed_credits` enforcement. No catch is strictly better than a broad one.

**Ordinary wallet ids and escrow labels share one namespace, and collide only safely.**
`deriveAccountId(userId)` is `SHA-256("wallet:" + userId)`, read as a u128 from the digest's first 16
bytes. Two kinds of name hash into that one namespace: ordinary wallet ids and **escrow labels** —
`ensureEscrowAccount` derives from the raw label, so `ensureEscrowAccount("alice")` and
`createUserWallet("alice")` compute the same account id, and collide *safely* only because their
differing flags (escrow carries no `debits_must_not_exceed_credits`) make TigerBeetle answer
`exists_with_different_flags` rather than silently sharing a balance.

Cost-center ids are **no longer** a third member of this namespace, which is why `createUserWallet`
no longer takes a `{ derived: true }` opt-in: it takes one argument. See the next invariant for what
replaced that reservation — and the one after it for why `::` is still refused anyway, on entirely
different grounds.

**`::` is QUARANTINED out of the `wallet:` namespace — a legacy-name refusal, not a derivation
reservation.** Every id that hashes through `deriveAccountId` refuses it: `createUserWallet`,
`ensureEscrowAccount`, and (via the shared `parentUserIdRefusal` in `shared/ids.ts`) every
`parentUserId` reaching `createCostCenterWallet` or `costCenterUserId`. A **single** `:` stays legal
everywhere a parent id is — `acct:123`, `acme:eu:prod` — which is what issue #64 actually asked for.
Only the doubled separator is quarantined.
*Prevents:* on a cluster upgraded from v2.x, an unreclaimed cost center still occupies
`deriveAccountId("parent::cc")` — the account the retired joined-string derivation funded — carrying
`CODE_USER_WALLET` and **exactly** an ordinary wallet's flags. Without the refusal, v3
`createUserWallet("parent::cc")` hashes straight onto it and TigerBeetle answers bare `exists`, not
`exists_with_different_flags`; the door reads that as success per the `exists` IS SUCCESS invariant
above, and a brand-new wallet silently **adopts** the stranded legacy balance under a different
owner's name. Nothing errors on either side. The documented reclaim-before-upgrade migration does
not close this on its own: a hold that was pending at upgrade time and is voided afterwards returns
its funds to the legacy account, re-stranding a balance in an account a clean migration had already
emptied.
*Why refusal rather than a read-fallback or a migration framework:* a legacy read-fallback would
have to resolve `parent::cc` in two namespaces at once, reintroducing exactly the ambiguity the tuple
hash removed; a migration framework is heavyweight for names that were **never legal** — `::` was
refused at these same doors on every released version before v3, so quarantining it costs no
existing caller anything.
*Escrow's flags differ from a wallet's today*, so `ensureEscrowAccount("parent::cc")` would in fact
hit `exists_with_different_flags` and throw. The refusal is there anyway, because that is a property
of the current account codes and not of the names: an escrow account created with wallet flags — or
a legacy one predating the current escrow flags — turns the mismatch back into a bare `exists`. The
quarantine holds at *every* door into the namespace, not only where a flag mismatch happens to save
us.
*The CLI mirrors it.* `cli/budget.ts` carries `LEGACY_COST_CENTER_SEPARATOR` beside its
`PARENT_USER_ID` charset mirror, both held byte-identical to `shared/ids.ts` by the source-parity
test. The charset alone is **not** the rule: `::` matches `PARENT_USER_ID_PATTERN` and is refused
anyway, so a CLI mirroring only the regex would admit parent ids the ledger rejects. Both refusal
messages are deliberately distinct for the same reason — quoting the charset at an operator who
passed `acme::billing` describes a rule that plainly admits their id.

**Cost-center account ids hash the `(parent, costCenter)` TUPLE, in a domain of their own.**
`TrustTBClient.deriveCostCenterAccountId(parentUserId, costCenter)` is

```
sha256( "usertrust:cost-center:v1" ‖ u32be(byteLen(parent)) ‖ parent ‖ u32be(byteLen(cc)) ‖ cc )
```

read big-endian as a u128 from the digest's **first 16 BYTES**. Bytes, not hex characters: the
implementation spells that as `digest("hex").slice(0, 32)`, and 32 hex chars *are* the first 16
bytes — a reimplementation that sliced 16 hex characters would build every account id out of 8 bytes
of entropy. Nothing joins the pair into a string, and no cost-center account is the hash of any
single name. The known answers in `packages/core/tests/ledger/client.test.ts` are spelled out rather
than recomputed from the static, so an edit to the tag, the prefix width, or the truncation point
breaks that suite instead of being silently absorbed by it.

*The domain tag is the entire separation mechanism, and it must stay prefix-disjoint from
`"wallet:"`.* Cost-center wallets and ordinary wallets carry identical flags and the same
`CODE_USER_WALLET`, so TigerBeetle cannot tell them apart; `exists_with_different_flags` protects
nothing here. Neither tag being a prefix of the other is what makes the two preimage sets disjoint.
*Prevents:* a `"wallet:"`-prefixed cost-center tag, under which a caller-chosen `userId` could
reproduce a cost center's preimage exactly — `createUserWallet` would be answered `exists`, not
`exists_with_different_flags`, and two owners would share one balance-enforced wallet in silence.
*Policy for any future tag* (a `v2` encoding, or a second derived namespace): it must be prefix-free
against every existing tag, or two domains can share preimages.

*Length prefixes count UTF-8 BYTES.* The prefixes are what make `("ab","c")` and `("a","bc")`
distinct regardless of charset — which is exactly why `PARENT_USER_ID_PATTERN` may now admit `:`
(issue #64) where the retired joined-string derivation could not. Code-unit counts would be
injective too, so this is not a correctness choice *within* one implementation; it is an interop one.
*Prevents:* a second implementation — another-language SDK, an external auditor's tool — reading
"length" as code units, and deriving a different account for every multibyte parent: silent
cross-implementation divergence, money in two places, no error anywhere. The multibyte known answer
pins the byte reading shut.

*The derivation is pure and total over strings; validation lives at the doors.* It never validates
and never normalizes: NFC `"é"` and NFD `"é"` are canonically equivalent, byte-different, and derive
different ids on purpose — normalizing here would alias two byte strings onto one account. ASCII is
*door* policy, not a property of the hash: `createCostCenterWallet` and `costCenterUserId` each
enforce `parentUserIdRefusal` / `COST_CENTER_PATTERN` from `shared/ids.ts` (authoritative), which is
what keeps a control character out of a wallet the audit trail then quotes. `parentUserIdRefusal` is
the *single* parent rule — `PARENT_USER_ID_PATTERN` **and** no `::` — and it returns the reason
rather than a boolean so each door can prefix its own wording without re-deciding the rule.
`cli/budget.ts` carries a display-side mirror of **both** halves, held byte-identical by a
source-parity test — widen the charset in `shared/ids.ts` and copy it across, or the CLI refuses ids
the ledger accepts. That drift was introduced once already during the issue-#64 work, which is why
the parity test exists.

*One static, five call sites.* Creation (`createCostCenterWallet`), the transfer path
(`resolveAccounts`, for `allocateBudget` and `reclaimBudget`), the per-envelope read path
(`getBudgetStatus`, which bypasses `resolveAccounts` because a read has no parent account to
resolve and no self-transfer to refuse), the batched read path (`budgetContext`, same reasoning),
and the spend path (`resolveEnvelope` in `govern.ts`, shared by both governors) must all go through
`deriveCostCenterAccountId`. `createCostCenterWallet` deliberately writes no `accountMap` entry: the
id is derived, never looked up, and a cache would only be a second source of truth that a client in
another process does not share.
*Prevents:* one of the five drifting from the others — a hand-rolled join, a second hash, a cached
id — so allocation funds an account that reclaim, status and the hold never read: every cost center
reporting a zero balance forever, a governance read that fails open, and — now that
`resolveEnvelope` is on the list — a PENDING hold debiting an account nobody allocated to.

*The `parent::costCenter` string is a display and audit label, never an account id.*
`costCenterUserId` builds it and `data.costCenterUserId` carries it into the audit chain; no money is
derived from it. What it must still be is **injective** over legal pairs, and it is because
`COST_CENTER_PATTERN` stays colon-free and non-empty: the cost center is exactly the label's maximal
colon-free suffix, so the pair reads back uniquely. That is the only reason the parent may now carry
`:` and the cost center may not — do not widen `COST_CENTER_PATTERN`.
*Prevents:* parent `a` + cost center `:b` and parent `a:` + cost center `b` both rendering as
`a:::b` — two cost centers, different accounts, different money, one label, so the chain cannot say
whose budget moved. (Under the retired joined-string derivation the same ambiguity was worse: it put
both pairs on one *account*.)

*128-bit truncation is a ~64-bit birthday bound*, the same bound `deriveAccountId` already accepts:
a collision needs on the order of 2^64 distinct cost centers, which no plausible deployment reaches.

**Cost-center attribution comes from CODE STRUCTURE, never from request content.** A governed call
debits a cost-center envelope only because it executed inside a `withCostCenter(cc, fn, opts?)`
scope (`budget/attribution.ts`), carried by the repo's one `AsyncLocalStorage`. That scope is
*dynamic, not lexical* — a helper the callback calls, and any continuation awaited inside it, is
attributed too, which is the whole reason attribution rides ALS rather than a threaded parameter.
Both halves of the envelope id are structural, never caller text: `cc` comes from the scope and is
validated against `COST_CENTER_PATTERN` at scope entry, pre-I/O; `parentUserId` is declared once, on
`TrustConfigSchema` and `TrustOpts` (`GovernorOpts` inherits it), is validated by
`parentUserIdRefusal` at parse time, and is **operator-trusted** on the same boundary as `budget`
and `customRates` — whoever constructs a governor already holds the TigerBeetle client. Never derive
either half from end-user or request data, and never add a request-body path into `cost_center`: all
three policy sites re-assert it *after* the caller-params spread, `undefined` included (see the
re-assertion table below). An active scope with no `parentUserId` **throws** in `resolveEnvelope`,
at the governor's entry point, before the circuit breaker and before any I/O. There is deliberately
no fallback to the session holding wallet.
*Prevents:* an agent relabelling its own calls onto the fattest envelope and draining a budget that
was never delegated to it — which is the entire reason to attribute spend at all. The
silent-fallback variant is quieter and no better: the caller believes the spend came out of the
envelope, the envelope's balance never moves, `getBudgetStatus` keeps reporting a full allocation,
and every policy tier keyed on `budgetFractionRemaining` fails open. Nothing in the system reports
that; only the throw does.

*One ALS read per call, at the governor's synchronous entry point — closure or handle capture
everywhere after.* The storage is module-private, and there are exactly **three** legitimate
`getCurrentCostCenter()` call sites: `interceptCall` and `governActionImpl` in `govern.ts`, and
`authorize` in `headless.ts`. Each is the top of an entry point the caller invokes synchronously
from inside its own scope, so the caller's async context is still the current one there. Everything
downstream reads that single capture — `trust()` by closure (the five `MessageStream` emitter
listeners, `createGovernedStream`'s completion/error/chunk callbacks, the non-stream settle, the
outer-catch void), `createGovernor()` off its own internal per-call record. Same propagation shape as
`rateResolution` under "price once", for the same reason.
*Prevents:* a read from inside a terminal silently answering with a *later, unrelated* call's scope,
or with nothing — never loudly. `AsyncLocalStorage` follows a chain of async continuations; it does
**not** follow an `EventEmitter` listener from its `on()`-time context into its `emit()`-time
context, because `emit()` runs listeners synchronously in whatever context called `emit()`, and the
SDK's SSE-pump ticks fire strictly after the entry point has returned.
`tests/budget/attribution.test.ts` pins exactly that as a negative case. Headless is the starker
version of the same rule: `settle()` routinely runs on a different task, after the scope has exited,
so there is no store to read at all — `authorize` stores an immutable capture in `activeAuths`,
keyed by `transferId`, and `settle`/`abort` read the attribution from **that**, which is what
guarantees an attributed hold gets an attributed settle.
*Not from the `Authorization` handle*, which is the caller's own object: `activeAuths` holds that
same reference, so establishing `has(transferId)` and then reading `auth.costCenter`/`auth.envelope`
let a caller relabel the settle/abort audit record and the receipt between the two phases — and,
since the receipt's balance snapshot reads whatever account the envelope names, put an arbitrary
account's balance on a receipt. `Authorization.costCenter` / `.envelope` remain on the handle as
reporting, frozen, and the governor never reads them back.

*The session's own accounting tracks SESSION-WALLET money only.* `budgetSpent` and the in-flight
hold total describe the per-session holding wallet — they gate every unattributed call, they are
what `receipt.budgetRemaining` reports, and `budgetSpent` is persisted and re-seeds that wallet as
`max(0, budget − budgetSpent)` on the next run. An attributed hold debits the envelope and never
touches the holding wallet, so both governors skip those counters (and the persist) for it, on the
increment and the matching release alike.
*Prevents:* charging the session for money it never paid — unattributed calls hard-denied against a
wallet TigerBeetle would still have held against, attributed receipts reporting a session remaining
decremented by envelope money, and the shortfall surviving the restart. Fail-closed, so it is a
silent over-deny rather than a loss, which is exactly why nothing else reports it. The flag is
recorded where the hold actually lands, not inferred from the scope: a dry-run or engine-less
attributed call places no envelope hold at all, and the session numbers stay its only — and honest —
accounting, matching the numbers its policy gate saw.

*Every audit record an attributed call emits carries `costCenter`, from that same capture* — not
from params, and on the failure terminals as well as the settle ones (`llm_call`, `<action.kind>`,
`llm_call_failed`, `<action.kind>_failed`, `stream_partial_delivery`, `settlement_ambiguous`,
`settlement_shortfall`, `injection_detected`, `anomaly_detected`). An attributed hold must leave an
attributed forensic trail whichever way it ends. Unattributed calls spread an empty object, so their
records stay byte-identical to what they were before envelopes existed.

*One field, two spellings, deliberately.* The policy context spells it `cost_center` — snake_case,
beside `estimated_cost`, `budget_remaining` and `action_kind`, because a rule file is what reads it
— while every TypeScript surface spells the same thing `costCenter`: the audit data above,
`TrustReceipt.budget.costCenter`, `EnvelopeStatus.costCenter`, and `withCostCenter`'s own argument.
`policy/gate.ts` states this where the field is declared. Do not "unify" them.

*The two visibility surfaces are OBSERVATIONS, never authority.* `receipt.budget` (push, on settled
receipts only) and `budgetContext()`'s `EnvelopeStatus` (pull, batched) both report the envelope's
ledger `available` **read at call time**, so both race every concurrent settlement against the same
envelope — by design, exactly as any balance read races the ledger it reads from. Neither says what
*this* call cost (that is `receipt.cost`), and neither is verifier-derivable: `TrustReceipt` is
never persisted into the vault and `packages/verify` never sees either shape, so nothing recomputes
these numbers from the chain. The attribution *label* is in the chain (the `costCenter` field on the
records above); the balance snapshot is not, and must never be presented as if it were.
`EnvelopeStatus.remaining` is the **raw ledger balance**, not `allocated − spent`: `spent` is
derived back out of it as `max(0, allocated − remaining)`, so the two agree only under the ledger
invariant that a cost-center wallet is funded solely via `allocateBudget`. Fund one any other way
and `remaining` stays honest while `spent`, `fraction` and `runwayHours` silently do not.
`receipt.budget` is also allowed to be simply ABSENT — unattributed call, unsettled (estimated)
stream handle, or a post-settle read that did not answer. That read failing is deliberately silent:
a receipt is a report, and degrading a report must never unwind or re-decide committed money.

**The `withCostCenter` scope itself stays operator-authored even where the `cc` string is
selected by agent activity.** `packages/openclaw`'s `deriveAttribution` (`src/attribution.ts`)
picks *which* operator-declared cost center a call's `withCostCenter` scope opens by reading the
trailing, correlated, non-error tool-result run out of the caller-supplied context — never from
message text — but the only strings it can ever return are values already present in the
plugin's frozen `tools`/`default` config, both validated at construction through this same
`withCostCenter` door (§ above) before any call runs. The scope-opens-from-code-structure
invariant is intact: what changed is that the code choosing the argument now reads agent
activity instead of being hardcoded, and that choice is bounded to envelopes the operator
explicitly delegated. Full security-model treatment — the bounded-delegation argument, the
plugin-vs-programmatic evidence-trust boundary, and the documented residual — lives in
`packages/openclaw/README.md`'s "Security model" section (verbatim from the ship's design spec),
not duplicated here.

**1 usertoken = $0.0001 USD, everywhere.** All pricing rates are usertokens per 1,000 LLM tokens.
This constant is duplicated in `packages/verify` on purpose.

**Cost is floored at 1 usertoken and clamped against non-finite input.**
`costFromRates` treats any token count that is not a finite number `> 0` as `0`, then returns
`Math.max(1, Math.ceil(...))`.
*Prevents:* a `NaN` permanently poisoning budget state; and zero-amount TigerBeetle transfers, which
are invalid. The floor is what makes a `{0,0}`-rate local call settle at exactly 1 nominal
usertoken.

**Budget account ids are derived, never looked up.** `resolveAccounts` derives *both* with pure
statics — `TrustTBClient.deriveAccountId` for the parent, `TrustTBClient.deriveCostCenterAccountId`
for the child. Never route a money path through `getAccountId`.
*Prevents:* `getAccountId` reads an in-process map populated only by a `createUserWallet` call in
the *same* process, so it rejects on a freshly constructed client even when the wallet exists in
TigerBeetle. A child id colliding with its own parent is still refused — it would debit and credit
one account and report a no-op as a funded allocation. Now that the two ids live in disjoint hash
domains that takes a truncated-hash collision rather than a punctuation trick; the guard stays
because it costs one comparison.
*Deliberate consequence, worth stating out loud:* `setAccountMapping` is a public setter that the
budget path **ignores** — both ids are derived, and `createCostCenterWallet` never reads or writes
`accountMap` at all — while `ledger/engine.ts` still **honours** it through `getAccountId`. One
setter, honoured on one money path and ignored on the other, and on the parent id that divergence is
silent.
*What the allocation cross-check is, honestly:* `allocateBudget` compares `createCostCenterWallet`'s
returned id against `resolveAccounts`' derived child id and throws on a mismatch. Both sides now call
the same static, so it cannot fire against the real client — its residual value is against a
substituted or subclassed `tb` whose creation path answers with some other id, which is exactly what
the mocked-client test for it does. Keep it; do not read it as a live guard against
`setAccountMapping`.

**No check-then-act on the allocation path.** Allocation never reads the parent balance before
transferring; TigerBeetle's atomic `debits_must_not_exceed_credits` rejection *is* the check.
Reclaim must know how much to move, so it reads first and treats a stale read as a benign race.
**Neither `allocateBudget` nor `reclaimBudget` is idempotent** — read the ledger balance before
retrying an ambiguous transport failure. A cost-center wallet must be funded *only* via
`allocateBudget`, or spent/burn/runway are silently wrong.

**Money-path numeric coercions are asymmetric, and both directions fail closed.**
`allocated`: non-finite or negative → `0`. `spent`: non-finite → `allocated` (fully consumed),
negative → `0`. `periodStartMs` / `nowMs`: non-finite → **throw**, never substitute.
*Prevents:* an unusable allocation fabricating headroom; an unusable spend coerced to `0` being
byte-identical to a cost center that has spent nothing, so a `budgetFractionRemaining lt 0.3` tier
never fires; and a non-finite threshold silently making every `lt`/`lte`/`gte` comparison false,
which reads as "no limit tripped" and quietly disables governance. No field of `Runway` is ever
`NaN` or `Infinity`.

**Endpoint classification fails expensive.** Unknown, absent, or malformed `baseURL` → cloud. The
*endpoint class*, not the model string, picks the metering regime. Matchers are origin-equality,
`*.`-prefixed hostname *suffix*, or bare hostname equality — never raw string prefixing.
*Prevents:* under-charging a paid endpoint (unrecoverable, unlike over-charging); model-name
spoofing (`ollama cp llama3.2 gpt-4o`) changing the regime; and
`http://gpu-box:8000.evil.com` matching a `gpu-box:8000` entry. Never wire classification to
end-user or request input; set `local.autoDetectLoopback: false` in multi-tenant deployments, since
loopback inside a container may be a forwarding sidecar to a paid API.

**Absent cache rates price at `inputPer1k` — never zero, and never a silent discount (D1).**
`ModelRates.cacheReadPer1k` / `cacheWritePer1k` are optional; an entry that omits either means the
provider publishes no rate for that tier, not that the tier is free. `costFromRates` resolves an
absent (or non-finite/negative) cache rate to the model's `inputPer1k`, and that resolution happens
in exactly one place — `effectiveCacheRate` in `ledger/pricing.ts`. Never inline
`rate ?? rates.inputPer1k` (or equivalent) anywhere else; a second resolution site is exactly how a
silent discount gets introduced. `resolveAppliedRates` (published on `receipt.pricing.appliedRates`)
goes through the same function, so the rates an auditor sees are the rates the cost was computed
with. It returns a FROZEN snapshot and each record surface gets its own copy: one resolved object
reaches the caller's receipt, the chain event and (for streams) the pre-settle handle, so a shared
mutable object would let a caller rewrite the rates the chain records without touching the cost.

**New receipt fields go at the ROOT, never inside `meter`.** `receipt.v1.schema.json` is frozen
and declares `meter` with `additionalProperties: false` while leaving the receipt root open. A
field added inside `meter` therefore makes every v1 validator reject every receipt usertrust
emits — a compatibility break with no error message. This is why the D5 rate surface is
`receipt.pricing`, a sibling of `meter`, and it binds anything added later.
*Prevents:* the failure this whole ship exists to kill — a 1.14B-cache-read day billed at zero
because a two-tier `ModelRates`/extractor pair had nowhere to price cache tokens, understating spend
~7-8x. Overstatement is the fail-safe direction: a mispriced call costs too much, never too little,
so budgets can only deplete faster than the true invoice, never slower.

**Hold sizing reserves the write-premium case, not just the input case (D3).**
A cache WRITE (Anthropic 1.25x/2x; provider-specific elsewhere) can price above a plain
input-priced hold, so "cold-cache worst case" was false wherever a write premium applies — a
headless caller supplying an exact `estimatedInputTokens` had no margin, and the capped-settle
machinery (above) would then post `min(actual, held)`, silently under-debiting the envelope and
leaving scarcity numbers falsely high. Both hold-sizing sites — the govern-path authorize estimate
and the headless authorize estimate — reserve the input leg at
`max(inputPer1k, effectiveCacheWriteRate(rates))` instead of `inputPer1k` alone.
*Documented consequence:* holds on cache-writing workloads run ~25% fatter than before; warm
(cache-hit-heavy) workloads settle far below the hold and release the difference back, so this is
conservative, not a leak. A warm-but-cold-held call can see `budget_remaining_after` over-deny —
the fail-safe trade the invariant above already accepts.

**Documented pricing approximations — verbatim, also published at `/docs/api/pricing`:**
Per-TTL write premium collapsed (1h = 2× billed as 1.25×; `customRates` override for 1h-heavy
workloads); long-context, service-tier, regional, modality, and cache-STORAGE charges (Gemini
hourly storage, prompt-size-dependent rates; GPT-5.4 long-context uplifts) not modeled — fixed
per-model rates by design; per-call `ceil` + 1-UT floor differs from provider-side aggregation.
Estimates never model cache state.

### Audit

**Persist the canonical bytes, not `JSON.stringify` output.** The hash pre-image is
`canonicalize(event)`; the verifier recomputes `sha256(canonicalize(persisted − hash))`.
`canonicalize` is idempotent over its own output.
*Prevents:* for any value with a `toJSON` (e.g. `Buffer`), `JSON.stringify` diverges from
`canonicalize` and an untampered event verifies as TAMPERED.

**Canonicalization order is load-bearing.** Keys sorted alphabetically at every nesting level;
`undefined` stripped; `null` preserved; array order preserved; `Date` → ISO string; `NaN` and
`±Infinity` **throw**.
*Prevents:* `JSON.stringify` silently coercing `NaN`/`Infinity` to `null`, breaking the hash
pre-image.

**Merkle hashing is RFC 6962 domain-separated.** Leaves `SHA-256(0x00 ‖ data)`, internal nodes
`SHA-256(0x01 ‖ left ‖ right)`. **Odd nodes are promoted, not duplicated** — this avoids
CVE-2012-2459.

**Audit-write failure degrades; it never unwinds committed money.** The writer dead-letters to
`.usertrust/dlq/dead-letters.jsonl` (dir `0700`, file `0600`, fsync'd) and **re-throws**; governance
call sites catch it and mark the call audit-degraded. A failed append must not unwind the transfer,
must not retry it, and must not surface as a rejection a caller could read as "the money did not
move." The only escalation is opt-in `config.audit.failClosed` (default `false`), which aborts the
call *before* money moves.
*Prevents:* lying to a caller about a spend that happened, in either direction.

**The budget money path degrades under a different contract — keep both.** `appendBudgetEvent` does
**not** re-throw. It warns and returns `{ audited: false, auditFailed: true, auditFailureReason }`,
which rides out on the `allocateBudget` / `reclaimBudget` result. `auditWriter` is *optional* on
both, which is why `audited: false` alone is ambiguous and `auditFailed` exists to separate "no
writer was supplied" from "the writer threw" — and why the reason string is carried rather than
dropped.
*Prevents:* `.catch(() => {})` — the dominant idiom in `govern.ts`, a dozen occurrences — being
tidied onto this path in the name of house style. That reintroduces the exact silent drop already
fixed once: a committed transfer with no record of which allocation lost its event, and no reason
for the loss.

**The DLQ checksum is corruption detection, NOT tamper-evidence.** Do not "upgrade" it to a keyed
MAC: the previous path-derived HMAC key was forgeable from public inputs and implied an integrity
guarantee it could not provide. When `canonicalize` throws on `NaN`, the DLQ falls back to
`JSON.stringify` — a `NaN` payload is exactly why the operation failed and must still be persisted.
Note what a dead letter *contains*: `payload` is the entire `AppendEventInput`, verbatim. The DLQ is
therefore the one place where "no prompt or response body lands on disk" (below) could be broken by
a change made somewhere else — add a prompt-bearing field to any audit event and the DLQ writes it
in the clear, with no hash chain over it. `0600` is the only thing protecting it.

**Single-writer audit semantics.** In-process `AsyncMutex` + an `O_WRONLY|O_CREAT|O_EXCL` advisory
lock file + an owner registry that distinguishes a crashed same-PID writer (reclaimable) from a live
sibling (refused). Every append is `writeSync` + `fsyncSync` + `closeSync`, and the `.meta` sidecar
is fsync'd too. Reclaiming a *live* sibling's lock forks the chain, because each writer caches its
own tail. There is **no** cross-process protection beyond this advisory lock.

**Readers and verifiers never write to the vault.** `packages/verify/src`,
`packages/core/src/audit/read.ts`, and `packages/core/src/audit/verify.ts` contain zero filesystem
write calls. Keep it that way — a verifier that mutates its subject is not a verifier.

**`vaultPath` means two different directories.** `createAuditWriter(vaultPath)` joins
`vaultPath/.usertrust/audit` — it takes the **project root**. `verifyVault`, `readLedgerEvents`,
`verifyVaultWithAnchors`, and `gatherOrderedEventHashes` join `vaultPath/audit` — they take the
**`.usertrust` directory**. CLI commands pass `join(root, VAULT_DIR)`. Easy to get wrong; check
which convention a function uses before calling it.

**A `.meta` sidecar that exists but is unparseable fails closed.** It is reported as corrupt, never
silently ignored. `verifyVault` walks one continuous chain across `events.jsonl` and every rotated
segment, ordered by global `sequence`, so whole-segment deletion surfaces as a sequence gap rather
than an indistinguishable hash mismatch.

**Anchoring state is monotonic and is never rolled back.** `audit/anchors/` is neither captured nor
restored by snapshots — not even from snapshots taken before the exclusion existed. Durability order
is: fsync'd outbox entry **first**, then the mirror append, then the high-water bump.
*Prevents:* rolling back the `anchorSeq` high-water re-mints occupied positions in an append-only
external store — permanent, unrewritable fork evidence. The reverse write order strands a
mirrored-but-never-published record, i.e. a permanent anchor-chain gap that verifies as tampering. A
crash after only the outbox write self-heals; the reverse does not. The mirror is a *cache*; trust
comes from the external store. A missing or corrupt mirror means refuse to emit and tell the
operator to resume — never re-mint.

**A scheduler-driven anchor emit must never reject into the void.** An unhandled rejection (KMS
outage, ENOSPC, a self-check throw) would crash the host process the emitter is embedded in.
Failures are captured as a degraded signal. The timer is `unref()`'d.

**Anchor trust never comes from the vault under audit.** The caller pins the genesis root PEM
out-of-band. A Rekor log other than `rekor.sigstore.dev` without a caller-supplied pin is refused,
not trusted. A supplied-but-failing Rekor receipt fails the vault **closed** (`ANCHOR_INVALID`); it
is never dropped as advisory.

### Policy and safety

**Deny wins; there is no `allow` effect.** `PolicyEffect` is `"deny" | "warn"`. `mergePolicies` is a
plain concat `[...defaults, ...userRules]` with **no** id-based override and **no** `enabled: false`
escape hatch. User policy can only *add* rules.
*Prevents:* a user policy file replacing rather than merging with defaults, silently removing
`block-budget-overshoot` — the non-disableable pre-spend hard deny that stops single-call overshoot
before the ledger's `debits_must_not_exceed_credits` ever engages.

**Hard rules fail closed; soft rules stay lenient.** An indeterminate condition (missing or
mistyped guarded field) is treated as *satisfied* for a hard rule, so the guard still fires.

**Trusted policy-context fields are re-asserted AFTER the request-body spread.** Every
`evaluatePolicy` call site builds context as `{ ...callerParams, ...trustedFields }`. The spread
exists *precisely so* trusted fields can be re-asserted after it.

There are exactly three call sites, and **their field sets differ** — check against this list, do
not assume they are the same:

| Call site | Re-asserted after the spread |
|---|---|
| `govern.ts` — LLM path | `model`, `tier`, `estimated_cost`, `budget_remaining`, `budget_remaining_after`, `budgetFractionRemaining`, `budgetRunwayHours`, `cost_center` |
| `govern.ts` — `governAction` | `action_kind`, `action_name`, `estimated_cost`, `budget_remaining`, `budget_remaining_after`, `tier`, `budgetFractionRemaining`, `budgetRunwayHours`, `cost_center` (**no `model`**) |
| `headless.ts` — `authorize` | same set as the LLM path |

The obligation runs in **both** directions. New governance field on `PolicyContext` → re-assert it
at every one of the three sites, **including asserting `undefined` when the honest value is
unknown.** New call site → spread the caller's params *first*, then re-assert the whole set; a site
that spreads last, or that re-asserts a subset, is the failure below.
*Prevents:* a client POSTing `{"model": "...", "budgetFractionRemaining": 0.95}` and walking through
a hard deny rule. Asserting `undefined` means the rule simply does not match — fail closed, rather
than matching a number the caller chose. (An `exists`-guard alone makes this *worse*: only the
attacker's request satisfies it.)

**Four of those fields are ENVELOPE-SCOPED on a call that actually places an envelope hold — the
gate always describes the wallet the hold will debit.** A set `cost_center` is necessary but not
sufficient. On a call inside a `withCostCenter` scope that will actually place a ledger hold,
`budget_remaining` is that envelope's live TigerBeetle `available` (one batched read at
authorize), and `budgetFractionRemaining` / `budgetRunwayHours` are computed from it against the
`{ allocated, periodStartMs }` the scope declared — or are explicitly `undefined` when it declared
none, because there is no cost-center registry and the SDK will not invent an envelope's size.
Every other call keeps the session numbers, unchanged: unattributed, dry-run and no-engine calls
place no envelope hold, so there is no envelope truth to be had.

Two consequences that are easy to "tidy" into bugs:

- **`budget_remaining_after` is UNFLOORED on both paths.** It is `budget_remaining − estimate` and
  it must be allowed to go negative. `block-budget-overshoot` is the non-disableable hard `lt 0`
  deny, so flooring the field at zero would structurally disarm that rule — on attributed calls
  first, and it would fork one field's semantics across the two paths.
- **An attributed call whose envelope balance cannot be read is REFUSED**, with the
  ledger-unavailable classification, *before* the gate: `evaluatePolicy` never runs and no hold is
  attempted. The read now runs INSIDE the budget mutex (see the paragraph below), so the refusal
  releases the lock on its way out — but the gate and the hold are still never reached. Not a fall
  back to the session numbers — the overshoot rule would then clear the call against a wallet its
  money never came from, in the one record an auditor reads. Not "continue with the fields absent"
  either — an indeterminate `budget_remaining_after` makes that same hard rule deny anyway, naming
  the wrong cause. Refusing costs almost no availability: the preflight and the hold share one
  TigerBeetle transport, under the client's own reconnect machinery, so a read that genuinely failed
  means the hold was doomed too.

The preflight is a *report* that feeds the policy tiers, and it is taken INSIDE the budget mutex —
the same lock that serialises the hold. That is what lets the envelope's fractional/runway tiers
(`budgetFractionRemaining`, `budgetRunwayHours`) be enforced under single-governor concurrency: a
concurrent attributed call to the same envelope cannot slip its hold between this read and the gate,
so the second call gates on a balance that already reflects the first hold — exactly as the session
path's budget check reads in-process counters mutated under this same mutex. Cross-governor
(multi-process) concurrency still relies only on TigerBeetle's atomic `debits_must_not_exceed_credits`
rejection of the hold — an OVERSHOOT, never a fractional/runway tier — the same limitation the
session path has, and a stale cross-process read can still only under-deny. Moving the read under the
lock is not check-then-act: the money decision stays the hold's atomic rejection; the read only makes
the policy record consistent with the wallet the hold will debit.

**`budgetFractionRemaining` is computed before the call's own hold, and excludes its estimated
cost** — only `budget_remaining_after` is estimate-inclusive, so the fraction/runway tiers gate on
the balance as it stood before this call, never on where this call's own spend would leave it.
`receipt.budget` and `budgetContext()` are likewise POST-SETTLE snapshots, so any monitoring surface
built on either one reads one call behind the gate. The practical consequence: an `lt` tier denies
starting with the call *after* the one whose settle actually crossed the threshold, not the crossing
call itself — a fraction that lands exactly on the boundary is read by `lt` as still inside it. Use
`lte` where the tier must also catch that edge call.

**Policy regexes are structurally ReDoS-guarded.** Patterns over 200 characters, with adjacent
nested quantifiers (`a+*`), or with a quantified group whose body contains a quantifier or
alternation (`(a+)+`, `(.*)*`, `(a|a)*`) are rejected at compile time. Invalid syntax is treated as
non-matching, never thrown. This eliminates the exponential-backtracking class deterministically
rather than by timeout.
There is a second, blunter layer with a governance consequence of its own: `MAX_REGEX_INPUT = 4096`
truncates the resolved value *before* matching, so a `matches` rule can never see past a field's
first 4096 characters. That is a control that fails **open** on long input — never write a `matches`
rule that has to catch something an attacker can push past that boundary.

**Only SHA-256 hashes of prompts are ever stored.** Audit events, receipts, and pattern memory carry
hashes and metadata only. No prompt or response body lands on disk. Budget audit events carry
`{ costCenter, amount, costCenterUserId }` and nothing else — caller input is never spread into an
audit payload, because the proof must not become a channel for credentials or prompt text. This
invariant is only as strong as the event shapes themselves: the DLQ persists whatever an event
carried, verbatim (see the DLQ note above).

**`redactPII` is pure.** It deep-clones and never mutates the caller's object. That is what makes
`pii: "redact"` safe: the *outbound* request is a redacted clone, so PII never egresses. `"block"`
throws before any egress; `"warn"` forwards verbatim and redacts only the audit copy.

**Signature trust is anchored by the operator's publisher→key registry, never by the embedded key.**
A key embedded in a skill manifest is accepted only if it is in `config.supplyChain.publisherKeys`
for that publisher. An empty registered-key list fails closed **when signature verification runs at
all** — the whole check is nested under `requireSignature || isTrusted`, so with
`requireSignature: false` and an untrusted publisher it is skipped entirely and the manifest goes on
unsigned to the `entryHash` and permission checks. The trusted-publisher permission bypass is
reachable only *after* signature verification.
*Prevents:* a self-signed manifest verifying against its own embedded key.

**Untrusted text echoed to a terminal is control-character sanitized BEFORE truncation.** Sanitize
first, clip second.
*Prevents:* JSON keys from a `--bundle`, or Rekor/anchor record fields, carrying ANSI escapes that
repaint the terminal of the auditor running the command — forging a passing verdict, which is the
entire product for a verification tool.

There are **seven** sanitizers, in two variants. Do not consolidate them onto the weaker one.

- Six identical copies of `CONTROL_CHARS = /[\x00-\x1f\x7f]/g` plus a clip at 80, in
  `core/src/cli/verify.ts`, `verify/src/cli.ts`, and the `rekor-verify.ts` / `anchor-verify.ts`
  pairs. These must move together. The
  `biome-ignore lint/suspicious/noControlCharactersInRegex` on each is intentional — do not "fix" it.
- A seventh, independent and deliberately **stronger**: `forDisplay` in `core/src/cli/budget.ts`. It
  also covers `0x80–0x9f`, the C1 range holding the 8-bit CSI/OSC introducers that the regex above
  does not match; it substitutes `?` rather than stripping; and it clips at 120.

That C1 coverage is not an accident of style. `budget.ts` quotes attacker-controlled argv back to
the operator in every invalid-value message, and its own comment names the attack
(`--allocated $'\x1b]0;pwned\x07\x1b[2J'`). "Unifying" it onto the six-copy regex would silently
drop C1 handling on the one CLI that most needs it.

**Untrusted values reaching a spreadsheet are formula-neutralized.** In CSV export, any free-text
cell beginning with `=`, `+`, `-`, or `@` is prefixed with an apostrophe *and* always quoted (a bare
leading apostrophe parses inconsistently). Cost columns stay unquoted numerics so spreadsheets sum
them without coercion.

**Money-command CLI flags fail closed.** Every flag is validated; nothing that scopes a report has a
silent default. `requireValue` refuses any leading dash after a space-separated flag, so
`--flag=value` is the only way to pass a value that begins with `-` (note `-cc-` is a *legal* parent
id, which is why the escape exists). Dates must be a real ISO-8601 instant with an explicit
timezone — `Date.parse` alone is not enough. The unknown-argument guard is a catch-all, not a
`--`-prefix match. The resolved wallet is echoed in both output modes, and **every echoed value goes
through `forDisplay` first** — an echoed flag value is argv, the caller may be an agent, and
picocolors adds SGR codes without sanitizing anything it wraps.
*Prevents:* `--parent -x` silently reporting on the cost center `-x::research`; `--period-start 0`
passing `Date.parse` as Jan 2000 and turning a one-hour window into 26 years; and a rejected flag
value turning its own error message into a terminal-repaint on the operator who typed it.

### Client detection

**Duck typing only; never import a provider SDK at runtime.** `detect.ts` imports types only.
`@anthropic-ai/sdk` and `openai` are **optional** peer dependencies; Google has no peer entry at
all. This is why provider SDK majors can be bumped with no code change.

**The governance boundary is deliberately partial and is documented in `detect.ts`.** Governed:
Anthropic `messages.create/stream/parse` (and the `beta.messages` equivalents when feature-detected),
OpenAI `chat.completions.create` and `responses.create` when present, Google
`models.generateContent`. Explicitly **ungoverned** — these bypass governance, audit, and budget
enforcement: `messages.batches`, `beta.models`, `beta.files`, OpenAI `responses.retrieve/cancel/
delete`, the `responses.stream()` / `responses.parse()` helpers, the OpenAI `beta.*` namespace, and
legacy `completions.create`. If you add a governed surface, update that doc block.

---

## The `packages/verify` parity contract

`usertrust-verify` is an **independent reimplementation** of the verification path. Core *produces*
the hashes in a vault; verify *recomputes* them without importing core. If the two share code, the
verifier verifies nothing.

**Two rules, both required:**

1. **Zero dependencies, no core import.** `packages/verify/package.json` has `"dependencies": {}`,
   no peer or optional deps, and its `tsconfig.json` has no `references`. Every import specifier in
   `packages/verify/src/*.ts` is `node:crypto`, `node:fs`, `node:path`, or a `./`-relative sibling.
2. **Byte-identical logic.** The duplicated modules must stay indistinguishable — down to error
   strings.

**Never "DRY up" this duplication.** Mirror every change into both packages.

### Mirrored files

| Core | Verify | Enforced by |
|---|---|---|
| `core/src/audit/anchor-verify.ts` | `verify/src/anchor-verify.ts` | file-diff test (differs in exactly 2 lines per side: the `GENESIS_HASH` import, and `./merkle.js` vs `./verify.js`) |
| `core/src/audit/rekor-verify.ts` | `verify/src/rekor-verify.ts` | file-diff test (currently byte-identical) |
| `core/src/cli/verify.ts` → the `--bundle` helpers (`CONTROL_CHARS`, `clipKey`, `parseBundle`, `readArtifact`, `readPinnedPem`, …) | `verify/src/cli.ts` | **behavioral only, and only on the `--bundle` path** — one test drives both CLIs against a hostile bundle key. No file-diff rule covers this pair, and the two files are not whole-file mirrors. |
| `core/src/audit/canonical.ts` | `verify/src/canonical.ts` | behavioral tests only — **weakest link; hand-check it** |
| `core/src/audit/verify.ts` → `verifyChain` | `verify/src/verify.ts` | differential tests |
| `core/src/audit/verify.ts` → `verifyVault`, `verifyVaultWithAnchors`, `exitCodeForAnchored` | `verify/src/index.ts` | differential tests |
| `core/src/audit/merkle.ts` → all 7 Merkle functions | `verify/src/verify.ts` (there is **no** `merkle.ts` in verify) | differential tests |
| `verify/src/receipt.ts` → `detectProvider` | mirrored *into* `core/src/export/markdown.ts` and `ui/src/shared/rows.ts` | comment only (verify is the source here) |

Note the trap: `verify.ts` exists in **both** packages but they are different files with different
contents.

### The exact file-diff rule

```ts
const strip = (s: string): string =>
    s.split("\n").filter((l) => !l.includes('from "')).join("\n");
expect(strip(coreCopy)).toBe(strip(pkgCopy));
```

Drop every line whose raw text contains `from "`, then require exact string equality. Consequences:

- It is a **line filter, not an import parser**. A doc comment containing `from "` would be silently
  exempted. Do not introduce one.
- Everything not dropped must match byte-for-byte — comments, blank lines, ordering included.
- For a multi-line import, only the closing `} from "./x.js";` line is dropped. The named-binding
  lines **are** compared, so both packages must import the same names in the same order and may
  differ only in the module path.

Additional mechanical guards: `packages/verify/src/*.ts` total line count must stay under 4200 (a
vendoring tripwire — raising it should prompt "what was added?"), and the differential suites assert
that core and verify produce identical verdicts *and identical error strings* on clean,
tail-truncated, segment-deleted, rotated, `toJSON`-bearing, and hand-tampered vaults.

**Why this is CVE-class.** If verify accepts what core would reject, the standalone auditor tool
blesses a tampered vault — a silent authenticity bypass on the one artifact the whole trust story
rests on. If verify rejects what core accepts, false alarms destroy the signal and break operator
CI pipelines on good data.

---

## Conventions

### TypeScript

ESM-only, strict, TypeScript 5.9. `tsconfig.base.json` sets exactly:

```
target ES2022 | module NodeNext | moduleResolution NodeNext
strict | noUncheckedIndexedAccess | exactOptionalPropertyTypes | isolatedModules
declaration | declarationMap | sourceMap | esModuleInterop | skipLibCheck
forceConsistentCasingInFileNames | resolveJsonModule
```

- **`.js` extensions on every relative import.** `NodeNext` requires it.
- **No `require()`.** Every package is `"type": "module"`.
- Under `exactOptionalPropertyTypes`, an optional field declared without `| undefined` breaks
  assignability across package boundaries — and local incremental build state masks it. Verify
  against a clean `npm ci` before concluding it compiles.
- `core`, `verify`, `ui`, and `monte-cristo` are `composite: true`. `server`, `acs-adapter`, and
  `ui` all reference `core`; `ui` also references `verify`. **Project references forbid
  `--noEmit`**: `npx tsc -b --noEmit` fails with `TS6310: Referenced project ... may not disable
  emit`. Use `npm run typecheck`.
- Not enabled (deliberately, or at least currently): `noImplicitOverride`, `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`,
  `verbatimModuleSyntax`. Unused code is surfaced by Biome as a warning instead.

**A public API is dead unless its argument types are reachable from a declared export.**
`packages/core` exposes exactly `.`, `./headless`, and `./pricing`. Anything a consumer needs in
order to *construct* an exported function's arguments must itself be exported from one of them.
*Prevents:* the budget write API once shipped fully exported while `TrustTBClient` — its required
first argument — was exported from no entry point, so consumers could import the functions but could
not name or construct the argument.

### Formatting and linting — Biome 2

`biome.json` configures only two formatter options: `indentStyle: "tab"` and `lineWidth: 100`.
Everything else is Biome 2.5 defaults. Linter preset is `recommended`; assist (import sorting) is on
by default, so `biome check` also sorts imports.

The repo currently carries 39 pre-existing warnings: 22 unused imports, 9 unused suppressions, 7
unused variables, 1 unused function parameter. **CI fails on errors only** — warnings do not fail
the build. Do not bulk-"fix" unrelated warnings in a feature PR. This is the one place that count
lives; the rest of this file refers back here.

### Tests — Vitest 4

- `globals: false`. **Import `describe` / `it` / `expect` / `vi` explicitly from `"vitest"`** in
  every test file.
- Test files live at `packages/<pkg>/tests/**/*.test.ts` — mirroring the `src/` subdirectory layout
  (`tests/ledger/`, `tests/audit/`, `tests/policy/`, …). `tests/harden/` holds the security and
  parity regression suites; `tests/e2e/` and `tests/integration/` hold the wider ones.
- **Mock `tigerbeetle-node` at module level**, before imports resolve:
  ```ts
  vi.mock("tigerbeetle-node", () => ({ /* createClient, AccountFlags, TransferFlags, … */ }));
  ```
- Type-surface guards are `*.test-d.ts` under `packages/core/tests/` and are compiled by a
  **separate** tsconfig (`packages/core/tsconfig.type-tests.json`). A bare `tsc -b` never compiles
  them. They are deliberately excluded from the vitest `include` glob.
- Coverage thresholds are a **hard CI gate**: lines 92, branches 84, functions 90, **statements 92**.
  The `statements` threshold is asserted in CI only — `vitest.config.ts` carries the other three —
  so a local `--coverage` run can pass while CI fails. Headroom on statements is thin.
- Coverage excludes `packages/*/src/cli/**`, `packages/verify/src/cli.ts`,
  `packages/ui/src/app/**`, and `packages/ui/src/server/main.ts`.
- Vitest aliases `usertrust`, `usertrust/headless`, and `usertrust-verify` to **source**, not
  `dist`, because `dist/` may not exist in CI.

### Source headers

New files under `packages/*/src` open with:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.
```

In the four executable entry points that begin with `#!/usr/bin/env node`, the shebang stays on line
1 and the header follows on lines 2-3. Check the first three lines, not the first one, before
concluding a file is missing its header.

This is convention, not machine-enforced, and it is not yet universal: 113 of the 118 files under
`packages/*/src` carry it — and all 113 carry both lines, never one alone. The five that carry
neither are all of `packages/acs-adapter/src/`. That is a gap to close when you next touch those
files — not a header to strip elsewhere for consistency.

### Comment style

The house style is to explain the constraint and the failure it prevents — not what the code does.
Where a line is load-bearing, say why, and name the concrete thing that broke. Most of the
invariants above survive only because someone wrote them down next to the code.

---

## Commands

```bash
npm ci                 # install (CI uses npm; the repo is npm-lockfile-based)

npm run typecheck      # tsc -b && tsc -p packages/core/tsconfig.type-tests.json
npm run lint           # biome check .
npm run lint:fix       # biome check --write .
npm test               # vitest run
npm run test:watch     # vitest

npx vitest run --coverage
npx vitest run packages/core/tests/audit/chain.test.ts   # single file
```

`npm run typecheck` is the real command. `npx tsc -b --noEmit` **fails** (TS6310) and a bare
`npx tsc -b` silently skips the `.test-d.ts` type-surface guards.

**`npm test` is load-sensitive locally.** Vitest saturates every core, and parts of the vault and
CLI suites are CPU-bound on scrypt at `N = 2^17` against the 5s default timeout — `secret.test.ts`'s
`rotate + get` runs ~1.3s idle and ~2.8s under moderate contention on an 8-core machine, so a busy
one can push it past 5s. A timeout that passes when you re-run the file alone is that, not a
regression: re-run it in isolation, or `npx vitest run --retry=3`. Do not "fix" it by raising the
timeout in the test — the number is not the problem. CI runs on a dedicated runner and does not see
this.

There is no root `build` script; each package builds itself (`npm run build -w usertrust`, etc.).

**CI** (`.github/workflows/ci.yml`) runs four jobs on Node 22, on every push to `master` and every
**non-draft** PR: `lint`, `typecheck`, `test` (coverage, with the thresholds above), and
`tb-integration` (a real single-node TigerBeetle cluster, sha256-pinned binary). There is **no path
filter** — every non-draft PR runs all four regardless of what changed. Draft PRs run none of them.

The TigerBeetle server version in CI is pinned to match `tigerbeetle-node` in `packages/core` and
must be bumped in lockstep — **never `latest`**. The client must never be newer than the server. The
downloaded release zip is `sha256sum -c`'d before execution; recompute the hash when the version
moves.

---

## Commits and pull requests

**Every commit must be signed off (DCO).**

```bash
git commit -s -m "feat(ledger): ..."
git commit --amend -s          # fix a commit that is missing it
```

The `dco` workflow checks **every commit on the PR** against
`Signed-off-by: .+ <.+>` — a single missing line fails the branch and requires a history rewrite.
See `CONTRIBUTING.md`.

**Conventional commits:** `type(scope): lowercase subject`. Types in use, by frequency: `feat`,
`fix`, `release`, `chore`, `ci`, `test`, `docs`, `refactor`, `deps` — the last two have one commit
each. Scopes are area names (`site`, `core`, `ci`, `cli`, `verify`, `ui`, `audit`, `budget`,
`ledger`, `anchor`, `release`, `repo`, …). Not machine-enforced beyond the Dependabot prefixes.

Commit bodies are long-form and explanatory: state *why*, name the concrete failure mode, and record
deliberate deviations from the plan. This is the house style, not an accident — it is where most of
this document's content came from.

**Branching:** single-branch flow. `master` is the only long-lived branch. Branch from
`origin/master`, open a PR against `master`, squash-merge. Stage specific files (`git add <path>`);
avoid `git add -A` / `git add .`.

All changes require review (`.github/CODEOWNERS`).

---

## What NOT to flag in code review

These look like defects and are not. Flagging them wastes review cycles.

| Pattern | Why it is correct |
|---|---|
| **Duplicated logic between `packages/core` and `packages/verify`** | Deliberate and mechanically enforced. `usertrust-verify` must be an independent, zero-dependency reimplementation; sharing code would void the verification guarantee. Do not propose extracting a shared module. |
| **The two-phase PENDING → POST/VOID lifecycle as "unnecessary complexity"** | It is the product. A hold that is neither posted nor voided is an accounting hole; the ledger is what enforces the budget, atomically. |
| **`finalizeOnce` and the "redundant" idempotence checks around it** | Six stream consumption modes plus abort/error/end can all reach a terminal path. The gate is what makes exactly one of them win. |
| **The Board of Directors being heuristic pattern-matching rather than LLM-backed** | Intentional. `board/` makes **no** model calls. Do not "improve" it by adding one. |
| **TigerBeetle status handling that treats `exists` as success** | Correct — see the invariant above. Changing it to throw reports a failed settlement for money that already moved. |
| **`allocateBudget` comparing `createCostCenterWallet`'s id against `resolveAccounts`' derived id** | Not "comparing a function to itself". Both sides call `deriveCostCenterAccountId`, so the throw is unreachable in this repo *by design*; it is the assertion that keeps them on one static, and it fires against a substituted or subclassed `tb`. Deleting it lets allocation fund an account reclaim and status never read. |
| **`biome-ignore lint/suspicious/noControlCharactersInRegex`** | The control-character strip is a terminal-injection defense; the regex must match control characters. |
| **Asserting `undefined` for policy-context fields "that could just be omitted"** | Explicit `undefined` after the spread is what stops a request body from supplying the value. Omitting the assertion reintroduces the shadow. |
| **The settle-vs-void asymmetry on streams** | Enumerated above. Each branch is a separate, deliberate decision. |
| **`ledger/engine.ts` appearing unused** | Accurate observation, not a bug to fix silently — see Known drift. |
| **The pre-existing Biome warnings** | Counted and characterised under *Formatting and linting* above. CI fails on errors only. |

Automated review tools do not have this context by default. Treat their findings on the rows above
as noise unless they identify a *specific* concrete failure.

---

## Known drift and hazards

Real, verified, and worth knowing before you touch the surrounding code.

- **`ledger/engine.ts` has no production importer.** Only `packages/core/tests/` imports it. Its
  `TrustEngine` **class** collides by name with the `TrustEngine` **interface** in `govern.ts`,
  which is what the runtime actually uses. The live engine is built by a `createTBEngine` factory
  that is **duplicated** between `govern.ts` and `headless.ts` — change both in lockstep.
  `createLedgerEngine`, promised in comments in both files, does not exist anywhere in the repo.
  That lockstep is now mechanically pinned: `tests/harden/engine-factory-parity.test.ts` extracts
  `createTBEngine`, `isTBInsufficientBalance` and `isTBDebitAccountNotFound` from both files, strips
  comments and blank lines (the two copies carry deliberately different prose), and requires the
  code to be identical. Fix a failure there by copying the edit across, never by relaxing the test.
- **`packages/core/bin/govern.ts` is dead code** — outside `include: ["src"]` and outside
  `files: ["dist"]`. The live CLI is `src/cli/main.ts`.
- **Remote-governance ("proxy") mode is removed.** `connectProxy()` always throws and `TrustOpts.proxy`
  throws at construction. The `ProxyConnection` interface survives only so dead branches typecheck.
- **Anchoring is not self-driving.** There is no `anchoring` key in `TrustConfigSchema`, and neither
  `trust()` nor `createGovernor()` starts an emitter. Anchoring is a CLI/cron surface
  (`usertrust anchor init|now|status|export|export-bundle|doctor|rotate|resume`).
- **`headless.ts` is a thinner governor than `trust()`** — no injection detection, no
  redact-on-egress, no `failClosed` enforcement. It also meters differently in shape: `settle()`
  calls `resolveRates` a second time — from the authorize-captured model and endpoint — instead of
  carrying the authorize-time resolution the way `trust()` does. Same inputs, so the same answer
  today; but the guarantee rests on `resolveRates` staying a pure function of
  `(model, endpointClass, config)`, whereas on the `trust()` path it rests on nothing at all.
- **The `core/src/budget/` primitives now have a consumer, but only for ATTRIBUTED traffic.** A
  governed call made inside a `withCostCenter(cc, fn)` scope places its PENDING hold against the
  very wallet `allocateBudget` funds, so `getBudgetStatus` and `budgetContext` report that cost
  center's real `spent`, and a policy tier keyed on `budgetFractionRemaining` trips on real burn —
  the gap this bullet used to record is closed for that traffic. A call made outside every scope
  still spends from the per-session funded holding wallet, unchanged and deliberately so, which
  means an agent that never opens a scope still reads as `spent: 0` while it burns the session
  budget. That residue is an INSTRUMENTATION gap, not an enforcement one: the session wallet's own
  `debits_must_not_exceed_credits` bounds that spend either way.
- **`packages/openclaw/src` is still not typechecked by CI.** The package is absent from the root
  `tsconfig.json` references and is not `composite`, so `tsc -b` does not cover it. What *is*
  covered: `npm run typecheck` now also runs `tsc -p packages/openclaw/tsconfig.type-tests.json`,
  which compiles the host-contract type assertions and, through them, `src/types.ts`. Errors
  anywhere else under `src/` still surface only at release time (`cd packages/openclaw && npx tsc`).
- **The openclaw host contract is split across two CI jobs, because openclaw is not installed.**
  `openclaw` is an OPTIONAL PEER of `packages/openclaw`, never a devDependency, and `npm ci` does
  not install optional peers — so no ordinary job has it on disk. The pi-ai half of the contract
  (`tests/contract.test-d.ts`) compiles in `typecheck` on every push. The openclaw half
  (`tests/contract-openclaw.test-d.ts` + the `contract.test.ts` host smoke) runs only in the
  required `openclaw-contract` job, which installs the pinned version out-of-tree and sets
  `USERTRUST_OPENCLAW_CONTRACT=1` — the flag that turns an absent or mismatched openclaw from a
  loud skip into a hard failure. **The pin lives in exactly one file,
  `packages/openclaw/openclaw-contract.env`; never inline the version anywhere else.** The split is
  two tsconfigs rather than one conditional include because `tsc` cannot skip a file whose import
  does not resolve.
- **`site/` is not typechecked or built by CI** — only linted. Its `tsconfig.json` is standalone and
  has neither `noUncheckedIndexedAccess` nor `exactOptionalPropertyTypes`.
  **A green CI run says nothing about whether the site builds.** `site/` is not a workspace and
  carries its own `package-lock.json`, so a root `npm ci` leaves `site/node_modules` empty and
  nothing in the pipeline ever compiles it. Any change under `site/` — a dependency bump above all —
  must be verified with `cd site && npm ci && npx next build` before merge. This is not theoretical:
  a Dependabot PR raised `fumadocs-mdx` to a version whose peer range demands a **major** bump of
  `fumadocs-core`, passed all four CI jobs, merged, and broke the production deploy. The failure
  surfaced at `vercel --prod`, after the release had shipped.
- **`packages/claude-code-plugin` is typechecked by nothing** (no tsconfig, no `src/`).
- **`package-lock.json` lags the package versions.** The release workflow commits only
  `packages/*/package.json`, so the lockfile records the previous version numbers. Harmless in
  practice; do not "fix" it by hand mid-PR.
- **`packageManager` is npm — keep it npm.** The *name* is what matters: Dependabot selects its
  updater from this field, and while it declared pnpm (with no root `pnpm-lock.yaml`) it produced
  manifest-only bumps whose stale `package-lock.json` failed `npm ci` in every CI job (#60, #69).
  The pinned version+hash is regenerated with `corepack use npm@<version>` — bump it freely, just
  never change the name back. `dependabot.yml` also ignores TypeScript semver-majors — a TS major
  is a deliberate compiler migration, never a weekly bump. That ignore is updater-wide (evaluated
  before grouping), and it also mutes the security-update PR in the one case where a fix ships
  only in an ignored major (the Dependabot alert still fires; in-major fixes are unaffected).
- **Vercel builds `site/` with npm.** `site/` carries exactly one lockfile — `package-lock.json` —
  so Vercel's lockfile detection falls through to npm, and production installs the same tree the
  pre-merge gate above tests. The preview that made the flip logged `Skipping build cache since
  Package Manager changed from "pnpm" to "npm"` → `Running "npm run build"`; the production build
  before it logged `Detected pnpm-lock.yaml` → `Running "pnpm run build"`. That history is why the
  alert backlog looks the way it does: until 2026-08 `site/` carried both lockfiles and production
  installed from the pnpm one the gate never tested — `autoInstallPeers: true` let unmet peers pass
  silently there that the npm tree hard-fails on, and the dependency graph read the pnpm file as
  authoritative, attributing 29 of the repo's 40 open Dependabot alerts to a tree nothing shipped.
  Two differences from the gate survive the flip: Vercel installs with `npm install`, not `npm ci`,
  so a lockfile that has drifted from `package.json` is repaired in production where the gate
  hard-fails on it; and the linux builder resolves a few more platform-specific optional deps than a
  macOS `npm ci` (290 packages vs 285). Note also that the Vercel project's Root Directory is
  `site`, so a CLI deploy runs from the **repo root** — `vercel deploy` from inside `site/` fails
  looking for `site/site`.
- **`biome.json` has a `**/scripts/**` lint override for a directory that no longer exists.** Nine
  of the pre-existing warnings are `suppressions/unused` — inline `biome-ignore` comments for rules
  the config already disables. Three sit in two `site/app/components/` files (`before-after.tsx`
  twice, `governance-receipt.tsx` once); the other six are in tests, under `packages/core/tests/`
  and `packages/claude-code-plugin/tests/`. It is not a `site/`-only artifact.
