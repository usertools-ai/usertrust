# usertrust-openclaw

[`usertrust`](https://usertrust.ai) governance plugin for **OpenClaw**. Adds budget enforcement, policy gates, PII/injection scanning, and a hash-chained audit trail to every LLM call — with zero changes to your agent code. Install the plugin and every streamed call is governed.

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
| `proxy` / `proxyKey` | `string` | Point at the hosted proxy for cross-agent budget enforcement. |
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
stream-wrapper seam. Attribution and scarcity injection are wired everywhere the wrapper runs
(`createGovernedStreamFn`, and any provider whose id the operator maps to `usertrust`), but a
plugin registered under an id no live call ever routes through wraps nothing. This is a
pre-existing gap in "zero code changes, every call governed," not something this feature
introduces — register under the real provider ids in use, or wrap in host code via
`createGovernedStreamFn`.

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

Pinned against `openclaw@2026.7.1-2` and `@mariozechner/pi-ai@0.73.1` (exact `devDependencies`);
declared as optional peers at `openclaw >=2026.7.1` / `@mariozechner/pi-ai >=0.12.0`. Both are
type-only at runtime — neither is required to build or ship the plugin.

## License

Apache 2.0 · UserTrust™ is a trademark of Usertools, Inc.
