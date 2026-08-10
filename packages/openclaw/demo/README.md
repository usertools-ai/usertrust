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

- A `createUsertrustPlugin` instance is built with a tiny $0.50 budget.
- A mock `streamFn` simulates a runaway agent burning ~250 usertokens per call.
- The plugin's `wrapStreamFn` middleware authorizes → forwards → settles each call.
- After 3 settled calls, the `block-budget-overshoot` policy gate denies call #4
  *before* it spends — the pre-spend estimate would drive the remaining budget
  below zero. The audit ledger reflects every settled call.

Expected output (truncated):

```
  budget:        1,200 usertokens (~$0.50)
  agent model:   claude-sonnet-4-6
  agent:         buggy loop, ~250 usertokens per call

  call # 1  OK     chunks=29  → call settled
  call # 2  OK     chunks=29  → call settled
  call # 3  OK     chunks=29  → call settled
  call # 4  BLOCK  Policy denied: [block-budget-overshoot] Deny pre-spend when estimated cost would drive remaining budget below zero

  --- final ledger ----------------------------------------
  successful calls:  3
  cut off at:        call #4
  budget exhausted:  yes — governance enforced
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
