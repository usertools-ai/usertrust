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

`new Anthropic()` reads your key from `ANTHROPIC_API_KEY`. `usertrust init` saves the key you give it in `.usertrust/.env` but does not export it, so a fresh shell has no key. Run the example with Node's own `.env` loader:

```bash
node --env-file=.usertrust/.env app.mjs
```

or `export ANTHROPIC_API_KEY=...` yourself first.

That's it. One function wraps any supported LLM client. Every governed call is metered, policy-checked and recorded on the audit chain; a call whose record could not be written says so on its receipt (`auditDegraded`, see [LIMITATIONS.md, section 5](https://github.com/usertools-ai/usertrust/blob/master/LIMITATIONS.md#5-one-audit-writer-per-vault-one-process-at-a-time)).

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
npm install usertrust @anthropic-ai/sdk
npx usertrust init
```

This creates a `.usertrust/` vault in your project root with default config, policies, and an empty audit chain.

`npx usertrust init` does not install the package into your project, so the `npm install` line is required.

usertrust wraps your provider's own client and does not install it. Install the SDK for the provider you use beside it: `@anthropic-ai/sdk` for the example above, `openai`, or `@google/genai` for Google Gemini (`npm install usertrust @google/genai`). `@anthropic-ai/sdk` (0.116.0 or newer) and `openai` (7.4.0 or newer) are declared as optional peer dependencies. `@google/genai` is not declared at all: usertrust recognises a Google client by its shape (`models.generateContent`), so nothing in the install names that package, and you install it yourself.

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

On a Google client `models.generateContent` and `models.generateContentStream` are governed. `generateContentStream` resolves to the stream itself, as the SDK's does, with the settled receipt on it: `const stream = await google.models.generateContentStream({ ... })`, then `for await (const chunk of stream)` and `await stream.receipt`. Every other Google method is refused unless it is free, as on the other providers (below): the billable ones (`models.embedContent`, the image and video methods, `chats.create`, `live.connect`, `batches.create`, `interactions.create`, `tunings.tune`, `caches.create` / `update`, the `fileSearchStores` uploads, imports and creates), every `*Internal` method, `authTokens.create`, `files.upload`, and the SDK's raw transport (`apiClient`, `getNextGenClient()`, a next-gen resource's `_client`, `live.auth`, `live.webSocketFactory`) reject with a `PolicyDeniedError` naming the method, and record a `policy_denied` audit event, before the SDK is called. `files.upload` sends the file's bytes with no PII scan: to upload a file and then pass it to `generateContent`, list it, `allowUngoverned: ["files.upload"]` (audited as `ungoverned_call`, and unredacted), or upload on the original client. With automatic function calling (a callable tool in `config.tools`, AFC not disabled), `generateContent` is metered per round: usertrust runs the loop itself, each round its own governed call, and the envelope carries `receipts`, one per round. `generateContentStream` with automatic function calling is refused the same way for now, because a streamed loop is not yet metered round by round: use `generateContent`, or set `config.automaticFunctionCalling.disable: true` and run the tool calls yourself. Reads, lists, deletes, `models.countTokens` and cancels run free (`@google/genai` 1.52.0 or later).

On every client, every SDK method usertrust does not govern is refused unless it cannot start work: `embeddings.create`, `messages.batches.create`, `chat.completions.parse` and the like return a promise that rejects with a `PolicyDeniedError` (`ungoverned_method: <path>`) and write a `policy_denied` audit event, and the SDK is never called. Methods that cannot start work run as before: reads, lists and deletes (every GET or DELETE request) and a few named POSTs such as `messages.countTokens`, `moderations.create` and cancels. To run a refused method unmetered, list it: `trust(client, { allowUngoverned: ["embeddings.create"] })`; each such call is audited as `ungoverned_call`. `client.withOptions(...)` returns a client governed by the same governor, unless it changes where or how calls are sent (`baseURL`, `fetch`, `fetchOptions`, …), which is refused.

Clients in one process share their vault's audit writer. Separate processes cannot write to one vault: give each process its own vault (`vaultBase`), or send their calls through one `usertrust-server`.

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
usertrust verify        # Verify audit chain integrity and completeness (+ external anchors, --receipts)
usertrust anchor        # External anchoring: init|now|status|doctor|export|export-bundle|rotate|resume
usertrust snapshot      # Checkpoint/restore vault state
usertrust audit quarantine-tail [--dry-run]  # Move a TORN final log line aside, recorded on the chain
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

`budget`, `pii`, `parentUserId` and `scope` can also be passed to `trust()` (and to `createGovernor()`), and override the file: `trust(client, { pii: "block" })` blocks PII whatever the file says. Every other setting (`circuitBreaker`, `patterns`, `audit`, …) is read from the file only. Besides these, its own options (`configPath`, `dryRun`, `vaultBase`, `endpoint`, `allowUngoverned`) and `tier` (accepted, but currently not applied), any key passed to `trust()` is refused by name: it throws a `TypeError` such as `trust(): unknown option "circuitBreaker" (set it in .usertrust/usertrust.config.json)` instead of being ignored. So does a `pii` value the config does not allow. `allowUngoverned` is for `trust()` only: `createGovernor()` refuses it by name.

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

**External anchoring** — Ed25519-signed chain-head checkpoints pushed to an append-only store the vault operator cannot rewrite (S3 Object Lock, protected git branch, SIEM). Even a fully re-hashed, internally-consistent rewrite of the events an anchor covers fails verification against the externally-held root; events appended after the last anchor are covered only by the next one. Ships a native SigV4 S3 sink (no AWS SDK), an experimental [Rekor](https://docs.sigstore.dev/logging/overview/) transparency-log witness that publishes digests only, `anchor doctor` to probe whether the writer identity can actually delete or overwrite in the store, and `anchor export-bundle` to hand an auditor the records and receipts in one file. See the [anchoring guide](https://github.com/usertools-ai/usertrust/blob/master/docs/anchoring.md).

**Policy engine** — 12 field operators (`eq`, `gt`, `in`, `regex`, etc.) with soft/hard enforcement. Block specific models, cap costs, require approvals.

**PII detection** — a pattern scan of each request's prompt text for email, phone, SSN, Luhn-validated credit card, IPv4 and common secret formats (API keys, cloud and GitHub tokens, JWTs, private keys). Block, redact or warn before the prompt leaves your process. It reads the prompt (messages, input, contents), not tool definitions or other request fields, and never the response; see [what it does and does not cover](https://usertrust.ai/docs/policy/pii).

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
Vault integrity: VERIFIED (UNANCHORED — internal consistency only)
Chain length: 847 events
Merkle root: a3f8c1...d92b
Hash algorithm: SHA-256
First event: 2026-03-01T08:12:44.000Z
Last event: 2026-03-16T14:33:21.000Z
All hashes: valid (847/847)
```

The verify package has zero runtime dependencies. It reads JSONL, recomputes SHA-256 hashes, and checks the chain. Anyone can verify a vault without trusting the usertrust SDK.

With [external anchoring](https://github.com/usertools-ai/usertrust/blob/master/docs/anchoring.md) enabled, verification goes further: the auditor fetches signed checkpoints from an append-only store the operator cannot rewrite and pins the public key out-of-band — so even a fully re-hashed rewrite of the events an anchor covers fails:

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

usertrust™ is a trademark of Usertools, Inc.
