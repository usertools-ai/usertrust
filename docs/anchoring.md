# External audit anchoring

The audit chain is tamper-evident on its own — but only *if you trust the operator's files*.
Hashing has no secret input, so anyone with write access to the vault can rewrite an event,
recompute every hash, and present a perfectly consistent chain. External anchoring closes that
gap: the writer periodically emits a **signed checkpoint** of the chain head (Merkle root + size
+ last hash, Ed25519-signed, hash-chained to the previous checkpoint) to an **append-only store
the vault operator cannot silently rewrite**. An auditor then verifies the vault against a
checkpoint they fetched themselves, with a public key they pinned out-of-band — using only the
zero-dependency [`usertrust-verify`](../packages/verify/README.md) package.

Tamper-**evident**, not tamper-proof: detection produces a hard FAIL verdict, not restored data.

## Quick start

```bash
# 1. Mint the vault's anchor identity (Ed25519 key — stored OUTSIDE the vault)
usertrust anchor init
# → prints the public key PEM + keyId. PIN THESE OUT-OF-BAND (see "Key ceremony").

# 2. Anchor the current chain head to your append-only store
usertrust anchor now --sink-file /mnt/worm/anchors.jsonl

# 3. Anyone verifies — fetching the checkpoint themselves, never from the vault
aws s3 cp s3://audit-anchors/vault-a/anchors.jsonl - \
  | npx usertrust-verify .usertrust --anchors - --pubkey pinned-root.pem
```

Run `usertrust anchor now` from cron/CI (it exits non-zero if the record was not delivered), or
start the in-process scheduler via the SDK. Defaults: an anchor every **1000 events** or **60
seconds**, whichever comes first — the gap to the live head (the *unanchored tail*) is protected
only by internal chain consistency and is always reported, never hidden.

## The deployment invariant

> **The identity that can write the vault must have append-only — not delete, not overwrite —
> access to the anchor store.**

That single asymmetry is the entire security argument: an attacker who owns the vault host can
rewrite the vault, but cannot un-publish the checkpoints that contradict the rewrite. A store
without this property silently degrades to "the attacker can rewrite the anchors too."

### Store recipes

**S3 with Object Lock (compliance mode)** — the same WORM control SEC 17a-4 / FINRA buyers
already run. The writer role gets `PutObject` only:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AnchorAppendOnly",
    "Effect": "Allow",
    "Action": ["s3:PutObject"],
    "Resource": "arn:aws:s3:::audit-anchors/anchors/*"
  }]
}
```

No `s3:DeleteObject*`, no `s3:PutBucketPolicy`, no `s3:BypassGovernanceRetention`. Create the
bucket with Object Lock enabled (compliance mode + retention period). Ship records with the
command sink:

```bash
usertrust anchor now --sink-file /tmp/latest.json && \
  aws s3 cp /tmp/latest.json "s3://audit-anchors/anchors/$VAULT_ID/$(printf %012d $SEQ).json"
```

(or wire `aws s3 cp -` directly as a `command` sink via the SDK config). Immutable object names
mean an overwrite attempt of a past anchor is a denied write, never a silent replace — and a
bucket listing exposes the true anchor high-water mark in one command.

**Protected git branch** — push each record to a branch with force-push and deletion disabled
(GitHub/GitLab branch protection). History rewrites are loud by construction.

**SIEM (Splunk HEC / Datadog logs)** — `--sink-url https://…` POSTs each record; SIEM ingest
credentials are inherently append-only.

**File on a different mount/principal** (`--sink-file`) — weakest option; acceptable only when
the path is owned by a different principal with append-only ACLs. Prefer the others.

## Monitor the cadence (do not skip this)

An attacker's cheapest move is to *stop anchoring* and tamper later. The absence of expected
anchors in the store is the alarm, and it fires on the **customer side**, where the attacker
can't suppress it. One rule:

> Alert when no new object/record has arrived in the anchor store for longer than 2× your
> anchoring interval.

That is a two-line CloudWatch metric filter on `PutObject` events, or a scheduled SIEM search on
the ingest index. Writer-side, `usertrust anchor status` reports the unanchored tail, outbox
depth, and a `degraded` flag; scheduled emitters also surface `lastEmitError`.

## Pull mode (zero-egress runtimes)

Configure **no sinks**: the emitter writes only the vault-local mirror, and a customer job ships
records on its own schedule:

```bash
usertrust anchor export --since 41 >> /mnt/worm/anchors.jsonl
```

Honest caveat: pull mode bounds detection *latency*, not detectability. Tampering that happens
*and is anchored over* between exports is caught at the next export diff — provided at least one
honest export of an earlier head exists. Push mode with the monitor rule above is stronger.

## Key ceremony

- `anchor init` prints the public key PEM + keyId. Give them to whoever will audit the vault —
  their records, an engagement letter, a compliance portal. **Never** distribute the key via the
  vault itself; the verifier deliberately refuses to read trust material from the directory
  under audit.
- Also drop `pubkey.pem` into the anchor store (object-locked) as a belt-and-braces copy.
- The **private key never lives inside the vault**. Default: `~/.usertrust/keys/<vaultId>.anchor.pem`
  (mode 0600), or `USERTRUST_ANCHOR_KEY` (PEM or path) injected from a secret manager, or an
  external signer callback (KMS/HSM/PKCS#11) via the SDK — the key never touches disk at all.
- **Rotation**: `usertrust anchor rotate` emits a rotation record cross-signed by the outgoing
  key, then prints the new fingerprint. Auditors keep pinning the *original* root key and add the
  new fingerprint as `--successor-pin` — a hijacked rotation to an attacker key then fails
  verification outright. Without pins, an unpinned rotation still verifies but is flagged with a
  prominent `rotation-unpinned` warning: confirm the fingerprint out-of-band before relying on
  post-rotation records.
- **Compromise**: a stolen key can sign forks — it cannot rewrite stored anchors. Competing
  records at the same position in the append-only store are cryptographic fork evidence. Rotate
  immediately, re-pin out-of-band, re-anchor from a trusted snapshot.

## Verifying (the auditor side)

The contract is **caller fetches, verifier checks**: you fetch the checkpoint(s) from the store
with your own credentials (`aws s3 cp`, `git show`, a SIEM export) and pass them as files or
stdin. The verifier never talks to S3/git/SIEM and works fully offline (air-gapped audits).

```bash
# Full history (strongest — linkage + append-only consistency between all checkpoints)
usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem

# Single latest checkpoint
usertrust-verify .usertrust --anchor latest.json --pubkey root.pem

# Per-transaction receipt, inclusion proven against the anchored root
usertrust-verify .usertrust --tx tr_123 --anchor latest.json --pubkey root.pem

# CI gate: must be externally anchored, fresh, and verified — or exit 1
usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem \
  --require-anchor --require-external-anchor --max-unanchored-events 5000
```

| State | Meaning | Exit (default / strict) |
|---|---|---|
| `ANCHORED_VERIFIED` | chain valid; checkpoints verify against your pinned key and bind to the vault content | 0 / 0 |
| `UNANCHORED` | valid chain, no anchors — internal consistency only (legacy vaults) | 0 / 1 |
| `ANCHOR_UNVERIFIABLE` | anchors exist but no key supplied, or the requested witness URL was unreachable | 0 + warning / 1 |
| `ANCHOR_STALE` | verified prefix, but the tail exceeds your `--max-*` freshness policy | 0 + warning / 1 |
| `ANCHOR_INVALID` | malformed record or signature fails against your pinned key | **1** |
| `ANCHOR_MISMATCH` | valid signature, content contradicts the vault: rewrite, rollback, deletion, fork | **1** |

Prefer `--max-unanchored-events` over `--max-anchor-age` for freshness policy: record timestamps
are operator-claimed, event counts are not.

The core CLI (`usertrust verify`) accepts the same flags. `usertrust anchor` subcommands:
`init`, `now`, `status`, `export`, `rotate`, `resume` (re-seed a lost local mirror from the
store's newest record).

## What each attack looks like

| Attack (attacker has full vault write access) | Verdict |
|---|---|
| Mutate an anchored event, recompute **every** hash + the `.meta` sidecar | `ANCHOR_MISMATCH` — recomputed Merkle root ≠ the signed, externally-held root |
| Delete the entire audit directory | `ANCHOR_MISMATCH` — the store's checkpoint attests N events; the vault presents 0 |
| Roll back to an older, internally-valid snapshot | `ANCHOR_MISMATCH` — anchored size exceeds observed size |
| Re-sign history with a substituted keypair dropped into the vault | `ANCHOR_INVALID` — your pinned key governs; vault-resident keys are ignored |
| Stop anchoring, tamper later | the unanchored tail is reported on every verify, and the store-side monitor fires |

The full adversarial matrix (30+ scenarios) is pinned as CI tests under
`packages/core/tests/harden/anchoring/`.
