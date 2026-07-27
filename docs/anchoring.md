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
native S3 sink (next section), or shell out:

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

### S3 sink (native SigV4)

Publish straight to S3 — no AWS SDK, no CLI on the box, no shell hop. Requests are signed with
SigV4 built on `node:crypto`:

```bash
usertrust anchor now --sink-s3 bucket=audit-anchors,region=us-east-1
usertrust anchor now --sink-s3 bucket=audit-anchors,region=us-east-1,prefix=anchors
```

`--sink-s3` takes a `k=v` CSV. `bucket` and `region` are required (either missing is a hard
error); `prefix` defaults to `anchors`; `endpoint` targets an S3-compatible store. The SDK form
is the same shape:

```ts
sinks: [{ type: "s3", bucket: "audit-anchors", region: "us-east-1", prefix: "anchors" }]
```

- **One object per record**, key `<prefix>/<vaultId>/<anchorSeq padded to 12>.json`, body = the
  canonical record JSON. Anchor records are a few hundred bytes — a single `PUT`, never a
  multipart upload.
- **Credentials come from the environment**: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, plus
  `AWS_SESSION_TOKEN` when you are on temporary credentials (it is signed as
  `x-amz-security-token`). Missing credentials fail the publish, which keeps the record in the
  outbox for redelivery rather than dropping it. Use the `PutObject`-only policy above.
- **Addressing**: virtual-host style (`<bucket>.s3.<region>.amazonaws.com`) against AWS;
  path-style (`<endpoint>/<bucket>/<key>`) when `endpoint=` is set, since S3-compatible stores
  rarely serve bucket subdomains.
- **Endpoint scheme rules**: `endpoint` must include a scheme, and it must be `https:` — SigV4
  authenticates a request but does not encrypt it, so plaintext would put credential-bearing
  headers on the wire. The one exception is `http://localhost` / `http://127.0.0.1`, for dev
  MinIO and LocalStack.
- Any 2xx is success. Anything else throws with the status and a ≤120-character body snippet;
  request headers are never included in an error, so a failure is safe to paste into a ticket.

### `anchor doctor` — permission probes

```bash
usertrust anchor doctor --sink-s3 bucket=audit-anchors,region=us-east-1
usertrust anchor doctor --sink-file /mnt/worm/anchors.jsonl --json
```

Doctor writes a throwaway **probe object** to the store and reports whether *this identity, with
the credentials in this environment, could delete or overwrite that probe object right now*. It
exits 1 if any check fails.

Read that sentence literally, because it is the whole claim. Doctor is a **permission probe, not
proof of immutability**. A store can deny these operations today and allow them tomorrow, deny
them for this identity and allow them for an admin one, or accept an overwrite as a new object
version. WORM guarantees come from the store's own configuration — S3 Object Lock compliance-mode
retention, POSIX ownership, an appliance's WORM mode. What doctor catches is the failure worth
catching before an audit: a configuration that is not doing anything at all.

| Sink | Probe |
|---|---|
| `--sink-file` | creates `.doctor-probe-<pid>` in the store's directory, then attempts `unlink` (`delete-denied`) and in-place truncation (`overwrite-denied`). Denied ⇒ pass, succeeded ⇒ fail, could not even create the probe ⇒ `info`. |
| `--sink-s3` | `PUT`s `<prefix>/doctor-probe/<pid>-<timestamp>.json`, then attempts `DELETE` and an overwrite `PUT` of that key. `403` ⇒ pass, 2xx ⇒ fail, other statuses ⇒ `info` (inconclusive). |
| `--sink-url`, `--sink-rekor`, `command` | `info` — no probe is possible from here; verify the append-only property at the receiving system. |

Two caveats that change how you read the output:

- **POSIX directory semantics.** Deletion is governed by write permission on the *directory*;
  in-place truncation is governed by permission on the *file*. A store can deny one and allow the
  other, so the two checks are independent and are reported independently. A `--sink-file` path in
  a directory the vault writer owns will (correctly) fail `delete-denied` — that is the deployment
  invariant telling you a local file sink is the weakest option.
- **Versioned buckets.** An overwrite that returns 2xx with `x-amz-version-id` is neither a
  refusal nor a true overwrite, so it reports as `info`: the new version does not remove the
  previous one, but you must confirm Object Lock retention denies deletion of *individual
  versions*.

When the store denies deletion, the probe object is left behind — that is the store working as
intended. Its key is named in every check detail, so it can be reconciled or aged out by a
lifecycle rule.

## Monitor the cadence (do not skip this)

An attacker's cheapest move is to *stop anchoring* and tamper later. The absence of expected
anchors in the store is the alarm, and it fires on the **customer side**, where the attacker
can't suppress it. One rule:

> Alert when no new object/record has arrived in the anchor store for longer than 2× your
> anchoring interval.

That is a two-line CloudWatch metric filter on `PutObject` events, or a scheduled SIEM search on
the ingest index. Writer-side, `usertrust anchor status` reports the unanchored tail, outbox
depth, and a `degraded` flag; scheduled emitters also surface `lastEmitError`.

## Rekor transparency-log witness (EXPERIMENTAL)

> **EXPERIMENTAL — does not yet work against the public `rekor.sigstore.dev`.** The sink is
> exercised against synthetic responses only (the live API is untested in CI), the entry
> `apiVersion` is pinned to `0.0.1`, and there is a **known incompatibility**: anchor records are
> signed with pure Ed25519, while a `hashedrekord` entry asks the log to verify a signature given
> only the artifact's sha256 digest — something pure Ed25519 cannot do (the log expects `ed25519ph`
> or an algorithm that signs a prehash). Proposals to the public log are therefore rejected today.
> Closing this needs signing-algorithm agility in the anchor record schema, which is deliberately
> out of scope here. What ships now is the complete, tested verification path — receipt schema,
> signed-note checkpoints, RFC 9162 inclusion, SET-verified attested time — plus a sink that works
> against any log accepting these entries. Treat Rekor as an additional witness alongside an
> append-only store, never as a replacement for one.

A public transparency log is the strongest form of "the operator cannot un-publish it": the
witness is a third party with its own Merkle tree, its own signing key, and its own monitors.

```bash
usertrust anchor now --sink-rekor                          # https://rekor.sigstore.dev
usertrust anchor now --sink-rekor=https://rekor.internal   # self-hosted; SINGLE token, "=" form
```

`--sink-rekor` never consumes the next argv token — pass a custom URL as `--sink-rekor=<url>`, not
as a separate argument. The SDK form is `{ type: "rekor", url?: string }`.

### What actually goes public

The entry is a `hashedrekord` carrying exactly three things: **sha256 of the anchor's signing
pre-image, the record's Ed25519 signature, and the vault's public key**. Nothing else is
transmitted.

That is safe by construction rather than by policy: anchor records carry digests and counters
only (spec §3) — a Merkle root, a tree size, a previous-record hash, a sequence number, a
timestamp. There is no event data, no payload, no transaction content in a record, so there is
none in the entry either, and the log receives no business data even in principle. Anchor keys are
**per vault**, which bounds public correlation: an observer of the log sees one key per vault, not
one identity across your whole estate.

### Receipts

A successful publish writes an inclusion receipt to
`<vault>/audit/anchors/rekor/<anchorSeq padded to 12>.json` (fsync'd, mode 0600). Receipts live in
their own files because the anchor record schema is **frozen** — a transparency log must not
become a field inside the thing it witnesses. Any non-201, `409` included, fails the publish and
leaves the record in the outbox; no receipt is written from a response that was not fully
validated first.

### Verifying receipts

```bash
usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem \
  --rekor-receipts .usertrust/audit/anchors/rekor/000000000042.json
```

`--rekor-receipts` is repeatable and takes a file (one receipt JSON, or JSONL of receipts) or `-`
for stdin. Verification is offline and zero-dependency: the signed-note checkpoint is parsed and
its ECDSA P-256 signature checked, inclusion is proven by an RFC 9162 index-based path walk, and
the stored entry is bound to *your* record by payload hash and by decoded signature bytes.

It is **fail-closed**: every receipt you supply must verify. Any failure produces
`ANCHOR_INVALID` with reason `rekor-receipt-invalid` and exit 1 — supplying evidence that does not
check out is a worse signal than supplying none.

**Key pinning.** With no `--rekor-pubkey`, the embedded rekor.sigstore.dev v1 log key is used —
and *only* when the receipt's log host is exactly `rekor.sigstore.dev`. Any other log without an
explicit key is refused with `rekor-receipt-invalid: custom log requires --rekor-pubkey`, because
an unpinned receipt from an operator-chosen log is self-certifying. `--rekor-pubkey` is repeatable
and forms a keyring — any pinned key that verifies the checkpoint passes — so a self-hosted or
witnessed log uses the same verifier with no code change:

```bash
usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem \
  --rekor-receipts receipts.jsonl --rekor-pubkey rekor-internal.pem
```

**Keyring scope.** The keyring is flat: any pinned key may vouch for any log host appearing in the
receipt set, and a checkpoint carrying several signatures (a log plus its witnesses) passes as soon
as *one* of them verifies under *one* pinned key. So pin only keys you would trust to attest
inclusion for any receipt in the run — pinning a partner's internal log key alongside
rekor.sigstore.dev lets either key speak for either host. Host-scoped pinning (`--rekor-pubkey
host=file`) is a possible future refinement; today, split the runs instead if the distinction
matters. Supplying `--rekor-pubkey` material that turns out to be empty or unusable is an error,
never a silent fall back to the embedded key.

**Attested time.** Staleness is measured against the log's **signed entry timestamp** (SET) — the
log's own signature over `{body, integratedTime, logID, logIndex}`, and the only signature that
covers `integratedTime` at all. When a receipt carries a SET that verifies under the same pinned
log key as the checkpoint, `--max-anchor-age` is measured against that time instead of the
operator-claimed `timestamp` field, so backdating records no longer buys freshness. Receipts
*without* a SET still prove inclusion, but fall back to operator-claimed time for freshness: an
unsigned `integratedTime` is a number the party under audit could have chosen. A SET that is
present and does **not** verify fails the receipt closed — supplied evidence has to verify. A
forward-dated operator `timestamp` still raises the `future-timestamp` warning whether or not a
witness also attested the anchor. Without receipts, keep preferring `--max-unanchored-events`:
event counts are not clock-dependent.

**Checkpoint-replay caveat.** Offline verification proves the entry was included in the log — *at
`integratedTime`* only when a SET vouches for that time — under a checkpoint signed by the pinned
key. It does **not** prove that
checkpoint is consistent with the log's current head — a forked or rewound log would need a
consistency proof against a checkpoint you fetched yourself. Read a receipt as "the log attested
this at time T", not "the log is honest today"; for the public instance, the witness and monitor
network is what closes that gap.

## Auditor bundles

`export-bundle` packages the anchor records and their Rekor receipts into one file for handoff:

```bash
usertrust anchor export-bundle > audit-bundle.json
usertrust anchor export-bundle --since 41 > incremental.json

usertrust-verify .usertrust --bundle audit-bundle.json --pubkey root.pem
usertrust anchor export-bundle | usertrust-verify .usertrust --bundle - --pubkey root.pem
```

The shape is `{"v":1,"records":[…],"rekorReceipts":[…]}`; `--since <anchorSeq>` filters both lists
to entries after that sequence. Parsing on the verify side is strict — unknown top-level fields, a
version other than 1, non-array members, or more than 10 000 records or receipts are all errors
that exit 1.

Both ends **fail closed**. If any receipt in the vault fails to parse, `export-bundle` writes
diagnostics to stderr and exits 1 with **empty stdout** — a bundle on stdout is always a complete,
valid bundle, never a partial one. On the verify side, every record and every receipt in the
bundle must verify.

A bundle is convenience packaging, not a trust upgrade: it is operator-supplied evidence, so
signatures still verify against your out-of-band `--pubkey`, but only checkpoints *you* fetch from
the append-only store prove the operator did not omit the ones that contradict them. The strongest
posture is unchanged — fetch checkpoints yourself with `--anchors`, and use the bundle for the
receipts.

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

## External signers (KMS/HSM)

The `external` signer keeps the private key off the vault host entirely: usertrust hands the
backend the record's signing pre-image and gets a signature back. The key never touches disk, and
`anchor init`'s PEM file is never created.

```ts
import { createAnchorEmitter, type AnchoringConfig } from "usertrust";

const config: AnchoringConfig = {
  signer: {
    type: "external",
    // sha256:<hex of the SPKI DER> — the same keyId `anchor init` prints.
    keyId: "sha256:9f2c…",
    publicKeySpki: "MCowBQYDK2VwAyEA…",   // base64 SPKI DER of the Ed25519 public key
    async sign(preimage: Uint8Array): Promise<Uint8Array> {
      const res = await fetch(`${process.env.VAULT_ADDR}/v1/transit/sign/usertrust-anchor`, {
        method: "POST",
        headers: { "X-Vault-Token": token, "content-type": "application/json" },
        body: JSON.stringify({ input: Buffer.from(preimage).toString("base64") }),
      });
      if (!res.ok) throw new Error(`vault transit: HTTP ${res.status}`);
      const { data } = (await res.json()) as { data: { signature: string } };
      // "vault:v1:<base64 signature>"
      return Buffer.from(data.signature.split(":").pop() as string, "base64");
    },
  },
  sinks: [{ type: "s3", bucket: "audit-anchors", region: "us-east-1" }],
};

const emitter = createAnchorEmitter(process.cwd(), config);
```

Create the transit key as `ed25519` (`vault write -f transit/keys/usertrust-anchor type=ed25519`)
and give the vault-writer role `update` on `transit/sign/usertrust-anchor` only — never `export`.
`keyId` must be the fingerprint of `publicKeySpki`; a mismatch is refused when the signer is
resolved, so a misconfigured backend fails at startup rather than producing records no auditor can
attribute.

**Hosted-KMS adapters are deferred.** There is no AWS KMS or GCP KMS adapter here: neither service
signs Ed25519 for this shape, and supporting them requires algorithm agility in the record schema
(an algorithm identifier plus verifier dispatch) — a future phase, not a flag. Any backend that
*can* sign Ed25519 — Vault transit, a PKCS#11 HSM, a YubiHSM — works through the interface above
today, unchanged.

Scope it honestly: an external signer bounds key **exfiltration**. It does not defeat an attacker
who can drive the backend as a signing oracle — they can still sign a forked history. The
append-only witness, not the key custody, is the control for that.

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

# With transparency-log receipts (freshness measured against the log's clock)
usertrust-verify .usertrust --anchors anchors.jsonl --pubkey root.pem \
  --rekor-receipts receipts.jsonl --max-anchor-age 24h

# One operator-supplied handoff file
usertrust-verify .usertrust --bundle audit-bundle.json --pubkey root.pem
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
`init`, `now`, `status`, `doctor` (probe a sink's delete/overwrite permissions), `export`,
`export-bundle` (records + receipts for an auditor), `rotate`, `resume` (re-seed a lost local
mirror from the store's newest record).

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
