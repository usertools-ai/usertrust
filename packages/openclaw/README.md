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

Budget enforcement is **pre-spend**: because a stream's cost isn't known until it finishes, the estimate assumes the model's full output budget, so calls are denied conservatively rather than allowed to overshoot. Size `budget` accordingly.

## License

Apache 2.0 · UserTrust™ is a trademark of Usertools, Inc.
