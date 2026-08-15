# usertrust-openclaw

[`usertrust`](https://usertrust.ai) governance plugin for **OpenClaw**. Adds budget enforcement, policy gates, PII/injection scanning, and a hash-chained audit trail to streamed LLM calls whose provider id matches this plugin's `id` or `aliases`. OpenClaw has no host-wide stream-wrapper seam — a stock install attaches the wrapper via default `aliases` (`anthropic`, `openai`, `google`), the provider ids live calls actually use. Pass `aliases: []` to wrap only calls routed to `id` (`usertrust`).

## Install

```bash
openclaw plugins install usertrust-openclaw
```

Or configure it manually in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "usertrust": {
        "enabled": true,
        "config": { "budget": 100000, "dryRun": true }
      }
    }
  }
}
```

## Programmatic use

```typescript
import { createUsertrustPlugin } from "usertrust-openclaw";

const plugin = createUsertrustPlugin({
  budget: 100_000,   // usertokens for this session
  dryRun: true,      // try instantly — skips TigerBeetle, keeps policy + audit
});
```

## How it works

The plugin hooks OpenClaw's `wrapStreamFn`, so it sits directly on the stream:

```
agent call → OpenClaw → usertrust wrapStreamFn
  1. Pre-flight budget check — a call whose estimated cost would exceed the
     remaining budget is DENIED before it starts (no single-call overshoot).
  2. PENDING hold reserves the estimate.
  3. Forward to the real stream, accumulating token usage from each chunk.
  4. POST settles the actual cost (or VOID on error); an early consumer
     `break` still settles and releases the hold — no leaked reservation.
  5. Every call is written to the tamper-evident audit chain.
```

## Config

| Field | Type | Description |
|-------|------|-------------|
| `budget` | `number` | Session budget in usertokens (required). |
| `dryRun` | `boolean` | Skip TigerBeetle; policy gate + audit still run. |
| `vaultBase` | `string` | Vault location (defaults to the project root). |
| `proxy` / `proxyKey` | `string` | Not implemented. Setting `proxy` throws (AUD-456). Use a local TigerBeetle or `dryRun` for enforcement. |
| `id` | `string` | ProviderPlugin id. Default: `usertrust`. |
| `aliases` | `string[]` | Provider ids whose `wrapStreamFn` this plugin attaches to. Default: `anthropic`, `openai`, `google` — the `Model.provider` values live OpenClaw/pi-ai calls actually use. Not `openai-completions` / `openai-responses` (those are API transports on `model.api`). Pass `[]` to wrap only calls routed to `id`. |
| `costCenters` | `object` | Operator-declared tool→envelope attribution + scarcity injection. See below. Absent: no attribution, no scarcity block. |

Budget enforcement is **pre-spend**: because a stream's cost isn't known until it finishes, the estimate assumes the model's full output budget, so calls are denied conservatively rather than allowed to overshoot. Size `budget` accordingly.

## Budget envelopes: tool→cost-center attribution

`costCenters` routes a governed call's spend to a named, operator-capped envelope based on
which tools the agent used, and layers an ambient per-turn scarcity signal on top:

```typescript
const plugin = createUsertrustPlugin({
  budget: 100_000,
  costCenters: {
    parentUserId: "acct:123",
    tools: { web_search: "research", run_tests: "verification" },
    default: "general",
    envelopes: {
      research: { allocated: 20_000, periodStartMs: Date.now() },
      verification: { allocated: 30_000, periodStartMs: Date.now() },
      general: { allocated: 10_000, periodStartMs: Date.now() },
    },
    // scarcityContext: true,  // default; set false to opt out of injection
  },
});
```

Validated once, at plugin construction (`createUsertrustPlugin` / `register`), through core's
own doors — `parentUserId`, every envelope's charset + metadata, and the `tools`/`default`
membership checks — never lazily on the first call. The validated config is normalized into a
deep-frozen copy that every wrapper reads; nothing downstream can mutate routing after
construction. A second plugin instance constructed with a **different** config is rejected
loudly (the governor is a module-wide singleton), never silently handed the first instance's
`parentUserId`.

### Attribution rule (stateless, per call)

At each governed call, attribution is derived fresh from the context the caller already handed
the wrapper — there is no cross-call state, so nothing goes stale on an error, a consumer
`break`, or an abandoned stream:

1. Find the most recent contiguous run of host-inserted tool-**result** messages that are the
   **trailing** entries of the context — i.e. the host asking the model to continue right after
   executing tools. Anything after that run (a final answer, a new user turn) resets
   attribution to `default`; a tool call from three turns ago never bills the current one.
2. Each result is correlated to the immediately preceding assistant turn's tool calls by
   `toolCallId`/`toolName`; results with `isError: true` are **excluded** (the host represents
   validation failures as error results without a real execution — the conservative choice,
   under-attributing rather than over-attributing).
3. The first correlated, non-error, mapped tool name wins, in message order → that cost
   center. No mapped name, or no tool-result run at all (including turn 1) → `costCenters.default`
   → else `undefined` (unattributed — the call bills the session wallet, exactly as before this
   feature existed).

Matching is **structured-field equality only** — `toolName`/`toolCallId`/`isError` are
first-class fields on the host's tool-result message shape. Nothing in the attribution path
ever reads message *text*: a model that types the string `web_search` into its prose cannot
produce a `role: "toolResult"` message, and cannot influence which envelope pays.

### Security model — attribution authority vs. labeling (the carve-out)

Reproduced verbatim from the design spec (`docs/superpowers/specs/2026-08-07-ship2-openclaw-envelopes-design.md`,
"Security model — attribution authority vs. labeling"):

> The core invariant stands: **no cc string ever originates outside operator config.** Map
> values and `default` are the only strings that reach `withCostCenter`; they are validated at
> plugin construction through core's canonical door.
>
> What this ship explicitly changes: *which* operator-capped pool pays a given call is selected
> by the agent's own activity (which tools it used). Three properties make that safe and honest:
>
> 1. **Bounded operator-delegated selection** (not "cannot increase spend" — configuring the
>    map DELEGATES access to the mapped envelopes' funds beyond the session wallet, and the
>    selected envelope drives the call's policy inputs: `budget_remaining`, fraction, runway,
>    `cost_center`). The bounds: selection can never exceed any envelope's ledger cap, reach an
>    unmapped envelope, or author a cc; total exposure is exactly the sum of operator
>    allocations the operator delegated by writing the map.
> 2. **Executed evidence, correlated and current.** Attribution derives from host-inserted
>    tool-RESULT blocks — and only a TRAILING run: the run must be the last message(s) of the
>    context (the host asking the model to continue after execution). Anything after the run
>    (assistant final answer, new user message) resets attribution to `default` — no stale
>    carry-over into later turns. Each result is correlated by `toolCallId`/name to the
>    immediately preceding assistant message's tool calls; results with `isError: true` are
>    EXCLUDED (pi represents validation failures as error results without real execution —
>    conservative choice, tested both ways). Matching is structured-field equality per the
>    contract task; never free-text.
> 3. **Evidence boundary, stated honestly:** in plugin mode the context is assembled by the
>    OpenClaw host, so message STRUCTURE (roles, result blocks) is host-written code structure.
>    In programmatic mode (`createGovernedStreamFn`) the caller supplies `messages` directly —
>    attribution there is **caller-trusted labeling** on the same trust boundary as the operator
>    config (the caller already holds the governor). Documented, not hidden.
> 4. **Documented residual:** a prompt-injected agent can still *choose* activity that lands on
>    a mapped envelope — cc labels on openclaw-attributed traffic are model-activity-influenced
>    categorization, bounded per (1). The audit chain records the selected `costCenter` only;
>    the attribution evidence (tool name/id) is NOT in the chain today — documented limitation,
>    future audit seam if operators need it. Operators who need adversarial-grade attribution
>    wrap phases in host code (`withCostCenter` is public).
>
> The scarcity block reveals envelope levels to the model — that is the feature (planning
> signal) and also financial-metadata egress to the provider; documented, and configuring
> `costCenters` is the opt-in (`scarcityContext: false` opts back out).

**Where governance actually applies.** OpenClaw resolves `wrapStreamFn` per-provider, matching
the call's provider id against the plugin's registered `id`/`aliases` — there is no host-wide
stream-wrapper seam. A stock install sets `aliases` to `anthropic`, `openai`, and `google` so
those live provider ids are wrapped; pass `aliases: []` to wrap only calls routed to `id`
(`usertrust` unless overridden). Attribution and scarcity injection are wired everywhere the
wrapper runs (`createGovernedStreamFn`, and any provider whose id matches), but a plugin
registered under an id no live call ever routes through wraps nothing. For a provider outside
the default list, add it to `aliases` or wrap in host code via `createGovernedStreamFn`.

### Scarcity injection

When `costCenters` is configured and `scarcityContext` is not `false`, every governed call gets
a system-prompt block built from the frozen `envelopes`' live ledger balances:

```
[usertrust scarcity] research: 34% left (~2.1h runway) · verification: 89% left
```

The block is appended to the caller's existing `systemPrompt` (never replacing it), on a
**copy** of the context — the caller's own object is never mutated. A read/format failure, or
an empty envelope set, omits the block silently; scarcity context is reporting-only and never
gates, delays, or throws into the money path (AGENTS.md "A8"). The full effective system prompt
(pre-existing plus the scarcity block, when injected) is represented exactly once in the
messages handed to the pre-call budget estimate, so the hold covers what actually egresses to
the provider.

`envelopes` metadata handed to `budgetContext` (`allocated`, `periodStartMs`, `periodEndMs`) is
**reporting-truth only** — it neither creates nor funds an envelope. An envelope is funded
exclusively by `allocateBudget` (`packages/core`); a `costCenters.envelopes` entry with no
matching ledger allocation reports honest-but-empty scarcity, never a shortfall.

### Compatibility

Both hosts are declared as optional peers — `openclaw >=2026.7.1-0` and
`@mariozechner/pi-ai >=0.12.0` — and both are type-only: neither is required to build, ship, or run
the plugin.

The contract is *proven* against an exact version of each, and the two are proven differently
because only one of them is installed:

| Host | Pinned as | Contract gate |
|---|---|---|
| `@mariozechner/pi-ai` | exact `devDependency` (`0.73.1`) | `tests/contract.test-d.ts`, compiled by `npm run typecheck` on **every push** |
| `openclaw` | `openclaw-contract.env` — **the only place the version appears** | `tests/contract-openclaw.test-d.ts` + `tests/contract.test.ts`, run by the `openclaw-contract` CI job after an out-of-tree install |

openclaw is not a `devDependency` because it is a full agent CLI: pulling its tree into every
`npm ci`, for four type-only imports in two test files, cost far more than proving the contract once
per run in a job of its own. `npm ci` does not install optional peers, so no other job sees it. Run
that job's gates locally with:

```bash
source packages/openclaw/openclaw-contract.env
npm install --no-save --ignore-scripts openclaw@"$OPENCLAW_CONTRACT_VERSION"
USERTRUST_OPENCLAW_CONTRACT=1 npx tsc -p packages/openclaw/tsconfig.contract-openclaw.json
USERTRUST_OPENCLAW_CONTRACT=1 npx vitest run packages/openclaw/tests/contract.test.ts
```

`USERTRUST_OPENCLAW_CONTRACT=1` is what makes an absent or mismatched openclaw a hard failure;
without it the host-smoke suite skips itself with a notice naming that job.

**Cache-tier normalization is guaranteed only under the pinned `@mariozechner/pi-ai` (contract
suite pins the pinned adapters' behavior; the peer floor stays `>=0.12.0`).** On an older runtime
`pi-ai` that doesn't yet surface the cache-read/cache-write fields, this plugin degrades
predictably rather than losing money: the absent cache tiers ride inside `inputTokens` and price
at `inputPer1k`, the same conservative-overstatement fallback the SDK applies to any absent cache
rate (see the Money invariants in the root `AGENTS.md`). Cache tokens are never dropped and never
billed at zero — the worst case on an older host is paying the plain input rate for what would
otherwise be a cheaper cache-read.

The `-0` on the openclaw peer floor is load-bearing, not a typo. OpenClaw ships its releases with
a numeric build suffix, which node-semver treats as a *prerelease*; a prerelease version never
satisfies a release-only range, so `>=2026.7.1` would exclude the very build this package pins.
`>=2026.7.1-0` admits it. The separate
`openclaw.compat.pluginApi` range deliberately keeps the plain `>=2026.7.1` form: the host strips
the `-N` suffix before comparing, so that check is unaffected.

## License

Apache 2.0 · UserTrust™ is a trademark of Usertools, Inc.
