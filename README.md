# usertrust™

Financial governance for AI agents. Every governed LLM call becomes a tamper-evident, auditable transaction.

```typescript
import { trust } from "usertrust";
import Anthropic from "@anthropic-ai/sdk";

// dryRun: true — skips TigerBeetle so you can try instantly.
// Audit chain and policy engine still run.
// You still need a provider API key — dryRun skips the ledger, not the provider call.
const client = await trust(new Anthropic(), { dryRun: true, budget: 50_000 });

const { response, receipt } = await client.messages.create({
  model: "claude-fable-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Analyze this contract" }],
});

console.log(receipt);

// REQUIRED — process hangs without this
await client.destroy();
```

`new Anthropic()` reads your key from `ANTHROPIC_API_KEY`. `usertrust init` saves the key you give it in `.usertrust/.env` but does not export it, so a fresh shell has no key. Run the example with Node's own `.env` loader:

```bash
node --env-file=.usertrust/.env app.mjs
```

or `export ANTHROPIC_API_KEY=...` yourself first.

That's it. One function wraps any supported LLM client. Every call is metered, audited, and policy-checked.

### Expected Output

The `receipt` returned from every governed call:

```jsonc
// A real capture, not an illustration: scripts/capture-evidence.mts runs this
// against a real TigerBeetle and commits what comes back. `usage` and
// `pricing` are the two halves of the reconciliation surface — ceil(sum(counts
// x rates / 1000)), floored at 1, reproduces `cost` from the record alone.
{
  "transferId": "tx_msm19wxa_a107246b",
  "cost": 104,
  "budgetRemaining": 49896,
  "auditHash": "f4a15bc63fc64bcdab2dcca67718d6a89469311e01cb16fa9dd7bb0c31286654",
  "chainPath": ".usertrust/audit",
  "receiptUrl": null,
  "settled": true,
  "model": "claude-fable-5",
  "provider": "anthropic",
  "timestamp": "2026-08-09T16:45:13.634Z",
  "usageSource": "provider",
  "usage": {
    "inputTokens": 317,
    "outputTokens": 131,
    "cacheReadTokens": 87,
    "cacheWriteTokens": 43
  },
  "meter": {
    "costBasis": "usd-proxy",
    "rateSource": "table"
  },
  "pricing": {
    "appliedRates": {
      "inputPer1k": 100,
      "outputPer1k": 500,
      "cacheReadPer1k": 10,
      "cacheWritePer1k": 125
    },
    "tableVersion": "2026-08-09"
  }
}
```

## Install

```bash
npm install usertrust @anthropic-ai/sdk
npx usertrust init
```

`npx usertrust init` does not install the package into your project, so the `npm install` line is required. `import { trust } from "usertrust"` fails until it runs.

usertrust wraps your provider's own client and does not install it. Install the SDK for the provider you use beside it: `@anthropic-ai/sdk` for the example above, `openai`, or `@google/genai` for Google Gemini (`npm install usertrust @google/genai`). `@anthropic-ai/sdk` and `openai` are declared as optional peer dependencies. `@google/genai` is not declared at all: usertrust recognises a Google client by its shape (`models.generateContent`), so nothing in the install names that package, and you install it yourself.

`init` is interactive in a terminal. It asks for your provider API key (Anthropic `sk-ant-`, OpenAI `sk-` and Google `AIza` keys are detected from their prefix; any other provider you name yourself) and writes it to `.usertrust/.env`. A new `.env` is created owner-only (mode 600). `init --reconfigure` rewrites an existing `.env` in place and keeps that file's mode, so if yours is readable by other users, run `chmod 600 .usertrust/.env` before you reconfigure. An Anthropic, OpenAI or Google key is first checked against that provider's models endpoint (unless you pass `--skip-verify`); a key that fails the check is still written, with a warning. A key for a provider you name yourself is not checked at all, even though `init` reports it as valid, so a wrong key there shows up only on the first real call.

Without a terminal (CI, scripts, a container build), run `npx usertrust init --json`: it creates the vault without prompting and without asking for a key.

This creates a `.usertrust/` vault in your project root with default config, policies, and an empty audit chain.

Both module systems work on Node ≥ 22.12:

```js
import { trust } from "usertrust";        // ESM
const { trust } = require("usertrust");   // CJS
```

The package ships a single ESM build; `require()` loads it through Node's built-in `require(esm)` support, which landed unflagged in 22.12. There is no second CJS build, so a process gets exactly one copy of the module graph — and therefore one budget mutex and one set of in-flight hold accounting — whichever way you load it. On Node 22.0–22.11 `require("usertrust")` fails with `ERR_REQUIRE_ESM`; `import` works on any Node ≥ 22.

## Integration

Works with the Anthropic (`@anthropic-ai/sdk`), OpenAI (`openai`) and Google Gemini (`@google/genai`) SDKs:

```typescript
import { trust } from "usertrust";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

// Anthropic
const anthropic = await trust(new Anthropic());
const { response, receipt } = await anthropic.messages.create({ ... });

// OpenAI
const openai = await trust(new OpenAI());
const { response, receipt } = await openai.chat.completions.create({ ... });

// Google Gemini: the client reads GOOGLE_API_KEY, the name `init` stores a Google key under
const google = await trust(new GoogleGenAI({}));
const { response, receipt } = await google.models.generateContent({ model: "gemini-2.5-flash", contents: "..." });

// With options (full mode — requires TigerBeetle)
const client = await trust(new Anthropic(), {
  budget: 100_000,
});
```

On a Google client only `models.generateContent` is governed. `models.generateContentStream` passes through to the SDK untouched: it is not metered, it gets no receipt, and no policy applies to it. Use `generateContent` for calls you need governed.

Every call returns `{ response, receipt }`:

```typescript
{
  transferId: "tx_m4k7r2_a1b2c3",
  cost: 142,
  budgetRemaining: 49_858,
  auditHash: "a3f8...",
  chainPath: ".usertrust/audit",
  receiptUrl: null,
  settled: true,
  model: "gpt-5.6-sol",
  provider: "openai",
  timestamp: "2026-03-16T12:00:00.000Z"
}
```

### Settings, budgets and many agents

- **Settings live in the config file.** Options such as `pii` are read from `.usertrust/usertrust.config.json` (see [Config](#config)). Passing `{ pii: "block" }` as the second argument to `trust()` is not read, and does not enable blocking.
- **A budget belongs to one `trust()` client.** `trust(client, { budget })` gives that client its own budget. Two clients created from the same project each get the full amount; to share one budget across callers, use `usertrust-server`.
- **With TigerBeetle, do not create one `trust()` per agent.** Each ledger-backed client holds its own connection to the ledger. In our testing, the 9th simultaneously open ledger-backed client in one process never finished connecting, and no error was raised; a TigerBeetle replica also holds at most 64 registered clients and evicts the least recently used. For more than a few agents, run `usertrust-server` (see `packages/server/README.md`): agents call it over HTTP, and it keeps one governor and one ledger connection per tenant, shared by every agent of that tenant.

## Inspect

```bash
npx usertrust inspect
```

```
=== Vault Report ===
Chain:    847 events · 12 segments
Budget:   38,420 / 50,000 UT remaining
Models:   claude-fable-5 (412) · gpt-5.6-sol (289) · kimi-k3 (146)
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

  Hint: Start TigerBeetle 0.17.x (tigerbeetle format … then tigerbeetle start --addresses=127.0.0.1:3001) or use { dryRun: true } to skip the ledger.
  Docs: https://usertrust.ai/docs/errors/ledger-unavailable
```

In 4.1.0, `usertrust tb start` only prints the manual steps, so the hint above refers to them. Start TigerBeetle as described in [Running TigerBeetle](#running-tigerbeetle), or use `{ dryRun: true }`.

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

**Pattern memory** — Learns optimal model routing from historical prompt-cost-success data. Feeds routing decisions when connected to proxy.

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

Budget enforcement is local. Connect a replicated TigerBeetle cluster for production (see [Running TigerBeetle](#running-tigerbeetle)), or pass `dryRun: true` to skip the ledger (audit and policy still run). Remote proxy mode is not implemented — passing `proxy` to `trust()` or `createGovernor()` throws.

Try it first with `dryRun: true`, as in the example at the top. For full mode, run TigerBeetle as below.

### Running TigerBeetle

Full mode needs a TigerBeetle replica at `127.0.0.1:3001`, the default address. Run the TigerBeetle release that matches the ledger client your install resolved. usertrust depends on `tigerbeetle-node` `^0.17.9`, so a later install can resolve a newer 0.17.x client, and a replica evicts a client whose release it does not support (`client_release_too_high` for a client newer than the replica). `npm ls tigerbeetle-node` in your project shows the client's version (0.17.9 when this was written); set `TB_VERSION` below to it. These commands were run on Linux on arm64 with the 0.17.9 `tigerbeetle-aarch64-linux.zip` asset; for another platform, take the asset for your platform from the [release with that version](https://github.com/tigerbeetle/tigerbeetle/releases).

```bash
TB_VERSION=0.17.9   # the tigerbeetle-node version `npm ls tigerbeetle-node` shows
curl -sSL -o tigerbeetle.zip "https://github.com/tigerbeetle/tigerbeetle/releases/download/${TB_VERSION}/tigerbeetle-aarch64-linux.zip"
unzip tigerbeetle.zip
./tigerbeetle format --cluster=0 --replica=0 --replica-count=1 --development 0_0.tigerbeetle
./tigerbeetle start --addresses=3001 --development 0_0.tigerbeetle
```

Format the data file once; start the replica each time you need it.

**These commands start ONE replica in `--development` mode: a local full-mode run, not a production deployment.** A single replica has no replication and no high availability: lose its data file and the ledger is gone. For production, deploy a replicated TigerBeetle cluster following TigerBeetle's own guidance ([cluster recommendations](https://docs.tigerbeetle.com/operating/cluster/), [deploying](https://docs.tigerbeetle.com/operating/deploying/)), and give the governor all the replica addresses (`tigerbeetle.addresses`).

TigerBeetle and its client need `io_uring` on Linux, and Docker's default seccomp profile blocks it; with it blocked, the client cannot start. In a container, run with `--security-opt seccomp=unconfined` (or a seccomp profile that allows `io_uring`). On a host where `kernel.io_uring_disabled` is set, it must be `0`.

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

`usertrust-verify` takes the path to the `.usertrust` directory; `usertrust verify` takes the project root that contains it. Giving `usertrust-verify` the project root reports a missing audit directory, not a tampered chain.

**Known issue in 4.1.0:** on a vault with no external anchor, deleting the most recent records is reported only until the next governed call; after that, verification passes over the shortened chain. An anchor catches the deletion of the records it covers (those up to the tree size it recorded); records appended after the last anchor are still unanchored. More generally, someone who can rewrite both the vault file and its sidecar can only be caught by an anchor held outside the vault, so enable [external anchoring](https://github.com/usertools-ai/usertrust/blob/master/docs/anchoring.md) if the chain is your evidence. See `LIMITATIONS.md` section 8.

With [external anchoring](https://github.com/usertools-ai/usertrust/blob/master/docs/anchoring.md) enabled, verification goes further: the auditor fetches signed checkpoints from an append-only store the operator cannot rewrite and pins the public key out-of-band — so even a fully re-hashed rewrite of the vault fails:

```bash
usertrust anchor init                                     # once: mint identity, pin the key
usertrust anchor now --sink-file /mnt/worm/anchors.jsonl  # from cron/CI, or in-process

# or publish straight to S3, after checking the store really refuses deletes
usertrust anchor doctor --sink-s3 bucket=audit-anchors,region=us-east-1
usertrust anchor now    --sink-s3 bucket=audit-anchors,region=us-east-1

npx usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem --require-external-anchor
```

## Uninstall

Removing usertrust is more than `npm uninstall`. What it leaves behind, and where:

- **Per project:** delete `.usertrust/`. It holds the audit chain, receipts, spend ledger, config and, if you gave one to `init`, your provider key in `.usertrust/.env`.
- **Packages:** `npm uninstall usertrust usertrust-server usertrust-verify` (whichever you installed).
- **Anchor signing key:** `usertrust anchor init` writes the private key outside the vault, at `~/.usertrust/keys/<vaultId>.anchor.pem` (mode 600). Deleting `.usertrust/` does not delete it. `usertrust anchor rotate` writes a new key next to it as `<vaultId>.anchor.<timestamp>.pem`, and a path you chose with `--key-file` holds a key wherever you put it; each of these survives removal too. Keep the keys if you want to continue the same anchor chain; delete them securely if you are retiring the vault. Also remove any anchor store you created, such as the file given to `--sink-file`.
- **usertrust-server:** stop the process, then delete its `stateDir` (one vault per tenant) and its config and tenant-key files. Versions up to and including 4.1.0 also wrote a `.usertrust/patterns/` folder in the server's working directory, outside `stateDir`; delete it if it is there.
- **Claude Code plugin:** remove the plugin with Claude Code's plugin commands, then delete the configuration file under `~/.config/usertrust/` (it holds the server key), the plugin's state directory (`~/.claude/usertrust-cc` by default), and `~/.local/state/usertrust/` (per-session pins, which can also hold the server key until they are pruned after 30 days). If the server key may remain on a shared machine, rotate it.

## License

Apache 2.0

---

UserTrust™ is a trademark of Usertools, Inc.
