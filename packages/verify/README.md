# usertrust-verify

Standalone, **zero-dependency** verifier for a [`usertrust`](https://usertrust.ai) audit vault. It recomputes the SHA-256 hash chain and checks it against the vault's tamper-evident head anchor — without trusting (or importing) the usertrust SDK. Anyone can audit a vault with it.

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

## What it checks

- **Hash chain** — every event links to the previous event's SHA-256 hash; any mutated, reordered, or inserted event breaks verification.
- **Head anchor** — the fsync'd `events.jsonl.meta` sidecar records the last hash and the total event count. The verifier fails if the log has been **truncated or deleted** (a shorter-but-internally-consistent chain no longer passes).
- **Segment continuity** — a rotated vault (multiple `*.jsonl` segments) is verified as one continuous chain by sequence number; a missing whole segment is detected as a sequence gap.
- **Merkle root** — recomputes the RFC 6962 root over the event hashes.

## Exit codes (CI-safe)

The CLI sets a **non-zero exit code** on any failed verification, so it works as a gate:

```bash
usertrust-verify .usertrust || echo "TAMPERED — do not deploy"
```

| Code | Meaning |
|------|---------|
| `0`  | Vault verified |
| `1`  | Verification failed (tamper, truncation, or corrupt anchor) |
| `2`  | Transaction not found (`--tx` mode) |

## Verify a single transaction

```bash
usertrust-verify .usertrust --tx tx_m4k7p2_a1b2c3
```

## Programmatic API

```typescript
import { verifyVault, exitCodeFor } from "usertrust-verify";

const result = verifyVault(".usertrust");
if (!result.valid) {
  console.error(result.errors);
  process.exit(exitCodeFor(result)); // 1
}
```

`verifyVault` re-implements canonicalization and hashing independently of `usertrust` and must stay byte-for-byte identical to the writer — a differential test in the repo pins that invariant.

## License

Apache 2.0 · UserTrust™ is a trademark of Usertools, Inc.
