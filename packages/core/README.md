# usertrust™

Financial governance for AI agents. Every LLM call becomes an immutable, auditable transaction.

```typescript
import { trust } from "usertrust";
import Anthropic from "@anthropic-ai/sdk";

// dryRun: true — skips TigerBeetle so you can try instantly.
// Audit chain and policy engine still run.
const client = await trust(new Anthropic(), { dryRun: true, budget: 50_000 });

const { response, receipt } = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Analyze this contract" }],
});

console.log(receipt);

// REQUIRED — process hangs without this
await client.destroy();
```

That's it. One function wraps any supported LLM client. Every call is metered, audited, and policy-checked.

### Expected Output

The `receipt` returned from every call:

```
{
  cost: 42,
  budgetRemaining: 49958,
  transferId: "tx_m4k7p2_a1b2c3",
  auditHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  settled: true,
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  inputTokens: 12,
  outputTokens: 28
}
```

## Install

```bash
npx usertrust init
```

This creates a `.usertrust/` vault in your project root with default config, policies, and an empty audit chain.

## Integration

Works with Anthropic, OpenAI, and Google AI SDKs:

```typescript
import { trust } from "usertrust";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// Anthropic
const anthropic = await trust(new Anthropic());
const { response, receipt } = await anthropic.messages.create({ ... });

// OpenAI
const openai = await trust(new OpenAI());
const { response, receipt } = await openai.chat.completions.create({ ... });

// With options (full mode — requires TigerBeetle)
const client = await trust(new Anthropic(), {
  budget: 100_000,
});
```

Every call returns `{ response, receipt }`:

```typescript
{
  transferId: "tx_m4k7r2_a1b2c3",
  cost: 142,
  budgetRemaining: 49_858,
  auditHash: "a3f8...",
  settled: true,
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  timestamp: "2026-03-16T12:00:00.000Z"
}
```

## Inspect

```bash
npx usertrust inspect
```

```
=== Vault Report ===
Chain:    847 events · 12 segments
Budget:   38,420 / 50,000 UT remaining
Models:   claude-sonnet-4-6 (412) · gpt-4o (289) · gemini-2.0-flash (146)
Policy:   3 rules active · 0 violations
PII:      2 warnings · 0 blocks
Merkle:   a3f8c1...d92b (root)
```

## CLI

All commands support `--json` for machine-readable output.

```bash
usertrust init          # Create .usertrust/ vault
usertrust inspect       # Vault bank statement
usertrust health        # Entropy diagnostics (6 signals, 0-100 score)
usertrust verify        # Verify audit chain integrity (+ external anchors)
usertrust anchor        # External anchoring: init|now|status|doctor|export|export-bundle|rotate|resume
usertrust snapshot      # Checkpoint/restore vault state
usertrust tb            # TigerBeetle process management
usertrust completions   # Shell completions (bash, zsh, fish)
```

### JSON output

Every command supports `--json` for scripting and CI:

```bash
usertrust inspect --json | jq '.data.remaining'
```

### Shell completions

```bash
# Bash
usertrust completions bash > ~/.local/share/bash-completion/completions/usertrust

# Zsh
usertrust completions zsh > "${fpath[1]}/_usertrust"

# Fish
usertrust completions fish > ~/.config/fish/completions/usertrust.fish
```

### Error messages

All errors include fix suggestions and documentation links:

```
Ledger unavailable: connection refused

  Hint: Start TigerBeetle with "npx usertrust tb start" or use { dryRun: true } to skip the ledger.
  Docs: https://usertrust.ai/docs/errors/ledger-unavailable
```

## Config

Create `.usertrust/usertrust.config.json`:

```json
{
  "budget": 50000,
  "tier": "pro",
  "pii": "block",
  "circuitBreaker": { "failureThreshold": 5, "resetTimeout": 60000 },
  "patterns": { "enabled": true },
  "audit": { "rotation": "daily", "indexLimit": 10000 }
}
```

`defineConfig` is available as a TypeScript type-checking helper for validating config objects in your code. The actual config file must be `usertrust.config.json` (JSON format):

```typescript
import { defineConfig } from "usertrust";

// Type-check your config object — useful for programmatic overrides
const config = defineConfig({
  budget: 50_000,
  tier: "pro",
  pii: "block",
  circuitBreaker: { failureThreshold: 5, resetTimeout: 60_000 },
  patterns: { enabled: true },
  audit: { rotation: "daily", indexLimit: 10_000 },
});
```

## Features

**Double-entry ledger** — TigerBeetle-backed financial transactions with two-phase lifecycle (PENDING, POST, VOID). Not a counter.

**SHA-256 hash-chained audit** — Every event links to the previous event's hash. Tamper-evident by construction. Append-only JSONL.

**Merkle proofs (RFC 6962)** — Inclusion and consistency proofs for public verifiability. Any third party can verify a specific event existed in the chain.

**External anchoring** — Ed25519-signed chain-head checkpoints pushed to an append-only store the vault operator cannot rewrite (S3 Object Lock, protected git branch, SIEM). Even a fully re-hashed, internally-consistent rewrite fails verification against the externally-held root. Ships a native SigV4 S3 sink (no AWS SDK), an experimental [Rekor](https://docs.sigstore.dev/logging/overview/) transparency-log witness that publishes digests only, `anchor doctor` to probe whether the writer identity can actually delete or overwrite in the store, and `anchor export-bundle` to hand an auditor the records and receipts in one file. See the [anchoring guide](https://github.com/usertools-ai/usertrust/blob/master/docs/anchoring.md).

**Policy engine** — 12 field operators (`eq`, `gt`, `in`, `regex`, etc.) with soft/hard enforcement. Block specific models, cap costs, require approvals.

**PII detection** — Luhn-validated credit card numbers, SSN patterns, email addresses, phone numbers, IPv4 addresses. Block or warn before data leaves your network.

**Circuit breakers** — Per-provider failure isolation. When a provider starts failing, the breaker opens and requests fail fast instead of cascading.

**Pattern memory** — Learns optimal model routing from historical prompt-cost-success data.

## Why this exists

AI agents operate with financial authority. Every LLM call costs money. Without governance:

- There is no audit trail when an agent spends $500 on a hallucinated loop
- There is no budget enforcement across multiple concurrent agents
- There is no way to prove what happened after the fact
- A race condition between two agents can double-spend the same budget

A counter in a database is not a financial ledger. `usertrust` uses the same double-entry, two-phase commit pattern that banks use. PENDING holds reserve the budget atomically. POST settles. VOID releases. The audit chain is hash-linked and Merkle-provable.

## Comparison

| Feature | usertrust | LiteLLM | Portkey | Langfuse |
|---------|-----------|---------|---------|----------|
| Financial ledger | TigerBeetle | Counter | Counter | Observation |
| Two-phase spend | PENDING/POST/VOID | No | No | No |
| Hash-chained audit | SHA-256 | No | No | No |
| Merkle proofs | RFC 6962 | No | No | No |
| Policy engine | 12 operators | Basic rules | Basic rules | No |
| PII detection | Luhn + regex | No | No | No |
| Circuit breakers | Per-provider | Global | Per-provider | No |
| Offline-first | Local vault | Proxy required | Proxy required | Proxy required |
| Open source | Apache 2.0 | Apache 2.0 | Proprietary | Apache 2.0 |

## Enforcement

Budget enforcement is local. Connect a TigerBeetle instance for production, or pass `dryRun: true` to skip the ledger (audit and policy still run). Remote proxy mode is not implemented — passing `proxy` to `trust()` or `createGovernor()` throws.

## Verify

Standalone verification with zero dependencies:

```bash
npx usertrust-verify .usertrust
```

```
Vault integrity: VERIFIED
Chain length: 847 events
Merkle root: a3f8c1...d92b
Hash algorithm: SHA-256
First event: 2026-03-01T08:12:44.000Z
Last event: 2026-03-16T14:33:21.000Z
All hashes: valid (847/847)
```

The verify package has zero runtime dependencies. It reads JSONL, recomputes SHA-256 hashes, and checks the chain. Anyone can verify a vault without trusting the usertrust SDK.

With [external anchoring](https://github.com/usertools-ai/usertrust/blob/master/docs/anchoring.md) enabled, verification goes further: the auditor fetches signed checkpoints from an append-only store the operator cannot rewrite and pins the public key out-of-band — so even a fully re-hashed rewrite of the vault fails:

```bash
usertrust anchor init                                     # once: mint identity, pin the key
usertrust anchor now --sink-file /mnt/worm/anchors.jsonl  # from cron/CI, or in-process

# or publish straight to S3, after checking the store really refuses deletes
usertrust anchor doctor --sink-s3 bucket=audit-anchors,region=us-east-1
usertrust anchor now    --sink-s3 bucket=audit-anchors,region=us-east-1

npx usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem --require-external-anchor
```

## License

Apache 2.0

---

UserTrust™ is a trademark of Usertools, Inc.
