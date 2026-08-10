# usertrust × OpenClaw — runaway agent demo

A runnable demo showing usertrust governance cutting off a buggy agent
loop the moment the budget is exhausted.

## Run

```sh
pnpm --filter usertrust-openclaw demo
```

Or directly:

```sh
npx tsx packages/openclaw/demo/runaway-agent.ts
```

## What it shows

- A `createUsertrustPlugin` instance is built with a tiny $0.40 budget
  (4,000 usertokens, at the repo-wide 1 usertoken = $0.0001).
- A mock `streamFn` simulates a runaway agent burning 800 usertokens per call —
  priced by the same table governance uses, not by hand.
- The plugin's `wrapStreamFn` middleware authorizes → forwards → settles each call.
- After 3 settled calls, the `block-budget-overshoot` policy gate denies call #4
  *before* it spends — the pre-spend estimate (a conservative max-output hold)
  would drive the remaining budget below zero. So the loop stops with budget
  still unspent, and the audit ledger reflects every settled call.

Expected output (truncated):

```
  budget:        4,000 usertokens ($0.40)
  agent model:   claude-fable-5
  agent:         buggy loop, 800 usertokens per call

  call # 1  OK     chunks=29  → call settled
  call # 2  OK     chunks=29  → call settled
  call # 3  OK     chunks=29  → call settled
  call # 4  BLOCK  Policy denied: [block-budget-overshoot] Deny pre-spend when estimated cost would drive remaining budget below zero; [WARN] [warn-high-cost] Emit a warning when estimated cost exceeds 1000 tokens

  --- final ledger ----------------------------------------
  successful calls:  3
  cut off at:        call #4
  settled spend:     2,400 usertokens
  stopped by:        the gate, before the spend
  ---------------------------------------------------------
```

## How OpenClaw users wire this

```sh
openclaw plugin add usertrust
```

Then in `openclaw.json`:

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

That's it — every LLM call routed through OpenClaw's `pi-ai` layer is
now governed: budget, audit, policy gates.
