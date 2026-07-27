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
- **External anchors** (optional) — binds the vault to Ed25519-signed checkpoints held in an append-only store the vault operator cannot rewrite. This upgrades the guarantee from *tamper-evident if you trust the operator's files* to **independently verifiable**: even a fully re-hashed, internally-consistent rewrite fails against the externally-held root.

## Verify against external anchors

You fetch the checkpoint(s) from the operator's append-only store yourself (`aws s3 cp`, `git show`, a SIEM export) and pin the vault's public key **out-of-band** — the verifier deliberately never reads trust material from the vault under audit, and works fully offline.

```bash
# Full checkpoint history (strongest)
usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem

# Single checkpoint via stdin
aws s3 cp s3://…/000000000042.json - | usertrust-verify .usertrust --anchor - --pubkey root.pem

# CI gate: externally anchored, fresh, verified — or exit 1
usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem \
  --require-anchor --require-external-anchor --max-unanchored-events 5000

# Transparency-log receipts (repeatable; JSON or JSONL; - = stdin)
usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem \
  --rekor-receipts .usertrust/audit/anchors/rekor/000000000042.json

# A self-hosted log needs its key pinned too (repeatable — any pinned key may verify)
usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem \
  --rekor-receipts receipts.jsonl --rekor-pubkey rekor-internal.pem

# One operator-supplied handoff file: usertrust anchor export-bundle
usertrust-verify .usertrust --bundle audit-bundle.json --pubkey root.pem
```

`--rekor-receipts` verification is offline and fail-closed: the signed-note checkpoint and its ECDSA P-256 signature, an RFC 9162 inclusion proof, and the binding of the log entry to your record all have to check out, or you get `ANCHOR_INVALID` (reason `rekor-receipt-invalid`) and exit 1. A verified receipt also makes `--max-anchor-age` measure against the log's attested `integratedTime` instead of the operator's own timestamp. Without `--rekor-pubkey`, the embedded rekor.sigstore.dev key is used **only** for receipts whose log host is `rekor.sigstore.dev`; any other log must be pinned explicitly. `--bundle` takes `{v:1, records, rekorReceipts}` and is parsed strictly — unknown fields, a version other than 1, or oversized lists are errors.

Result states: `ANCHORED_VERIFIED`, `UNANCHORED` (legacy vaults — valid, weaker, labeled), `ANCHOR_UNVERIFIABLE`, `ANCHOR_STALE`, and the hard failures `ANCHOR_INVALID` / `ANCHOR_MISMATCH` (rewrite, rollback, deletion, or fork against the signed checkpoints — always exit 1). After a key rotation, keep pinning the original root key and pass the announced successor fingerprints with `--successor-pin`. See the [anchoring guide](https://github.com/usertools-ai/usertrust/blob/master/docs/anchoring.md) for the operator side.

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

With external anchors:

```typescript
import { verifyVaultWithAnchors, exitCodeForAnchored } from "usertrust-verify";

const result = verifyVaultWithAnchors(".usertrust", {
  externalAnchorsRaw: [anchorsJsonl],        // fetched by YOU, not by the verifier
  trust: { rootPem: pinnedPublicKeyPem },    // pinned out-of-band, never from the vault
});
process.exit(exitCodeForAnchored(result, { requireExternalAnchor: true }));
```

`verifyVault` re-implements canonicalization and hashing independently of `usertrust` and must stay byte-for-byte identical to the writer — a differential test in the repo pins that invariant.

## License

Apache 2.0 · UserTrust™ is a trademark of Usertools, Inc.
