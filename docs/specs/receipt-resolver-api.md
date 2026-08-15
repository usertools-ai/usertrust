# Receipt Resolver API — DRAFT v0.1 (stealth drafts, usertrust instance reviews)

Status: **DRAFT — awaiting review by the usertrust instance before verify-page
work starts.** Interface owner: stealth (`apps/api`). Consumer: the public
verify page at `usertrust.ai/r/<id>` (usertrust instance) and any third-party
verifier. Companion interface: the **receipt spec** (usertrust drafts, stealth
reviews) — this document treats the receipt ID as opaque and defers its format,
canonical field set, and signature scheme to that spec. Conflicts resolve in
the spec's favor.

## Purpose

A receipt trailer on a commit/PR/issue replaces `Co-Authored-By` (Cam's
universal rule, 2026-08-08). The trailer is only as good as what the ID
resolves to. This API is the resolution: public, unauthenticated, cacheable
proof that the proxy executed and billed the work — model, timestamps, **$
amounts (public by directive — the flex is deliberate)**, and a Merkle proof
against the audit chain.

## Endpoint

```
GET https://api.usertools.ai/v1/receipts/{receiptId}
```

- **Public, no auth.** CORS `*` (page is on a different origin).
- The pretty URL `usertrust.ai/r/{receiptId}` is the PAGE (usertrust side),
  which calls this API. The trailer cites the pretty URL, never this endpoint.
- Rate-limited per IP (generous — it's a public verifier, but it sits in front
  of the ledger).
- **Caching (Codex F3, tightened by round-2 F1):** 200 → `Cache-Control:
  public, no-cache` plus a strong `ETag`; clients revalidate every render.
  **Verification precedes conditional-request evaluation**: the resolver
  re-derives the proof FIRST, and only then considers `If-None-Match` — a 304
  is only ever emitted after a *current* verification succeeded, because a 304
  is a successful revalidation and would otherwise instruct the client to keep
  rendering a cached green check that an unconditional request would now 409.
  On verification failure the conditional request is answered 409 `no-store`
  like any other. 409 → `Cache-Control: no-store`. 404 → `public,
  no-cache` (round-16 — a cached negative could mask this ID's later
  allocation). A CDN layer, if ever added, fronts only the
  post-verification 304 path.

## Response — 200 (verified)

```jsonc
{
  "apiVersion": "1",
  "receiptId": "<opaque — format owned by the receipt spec>",
  "status": "verified",                  // the ONLY status a 200 carries
  "mintedAt": "2026-08-09T02:11:04.512Z",

  "work": {                              // what this receipt attests
    "kind": "commit",                    // commit | pr | issue | session
    "repoId": "github.com:R_kgDOK1x2Yw",  // NORMATIVE scope: immutable provider-scoped ID
                                         // (keyed r1_… form for private repos) — round-12
    "repo": "github.com/usertools-ai/usertools-stealth",  // OPTIONAL display-at-mint metadata —
                                         // for undisclosed private repos, a stable KEYED
                                         // `repoId` replaces it (round-4 F3, input fixed round-9
                                         // F4): `"r1_" + base64url(HMAC-SHA-256(repoIdKeyV1,
                                         // providerHost || 0x00 || immutableRepositoryId))` —
                                         // keyed off the provider's IMMUTABLE repo ID, because a
                                         // canonical URL is mutable AND reusable (rename, then a
                                         // new repo at the old path collides). Plain SHA-256 is
                                         // dictionary-guessable; the HMAC key is never exposed.
                                         // The canonical URL is display-at-mint metadata only.
                                         // Scope is NEVER simply dropped (round-3 F4).
    "oid": "37df16d3…<full 40/64-hex>",  // FULL git object ID — a display may truncate, the
                                         // receipt never does (32-bit prefixes are transplantable)
    "oidAlg": "sha1",                    // sha1 | sha256 (repo object format)
    "objectSha256": "…",                 // REQUIRED (round-18 F1; encoding round-26):
                                         // lowercaseHex(SHA-256(gitPreimage)) where gitPreimage
                                         // = ASCII("commit " + byteLength(content)) ‖ 0x00 ‖
                                         // content — ONE defined representation everywhere
                                         // (provider APIs often return content WITHOUT the git
                                         // header; minter and promotion gate must hash the same
                                         // bytes). Verifiers reject absence or short digests
    "repositoryMembership": {            // REQUIRED on artifact variants (round-15) — the
      "status": "providerVerified",      // chain-committed proof that this OID was observed
      "proofId": "…"                     // in the bound repository (provider event/fetch id)
    }
    // Normative discriminated union (round-4 F4, scope normalized round-11
    // F2): EVERY variant carries `repoId` — the immutable provider ID (or
    // its keyed private form) — as the NORMATIVE scope, bound in claimsHash
    // and the membership audit event and equality-checked at verification;
    // `repo` (the URL/name) is OPTIONAL display-at-mint metadata, because
    // names are mutable and reusable (rename + recreate collides):
    //   type ProviderBound = { repositoryMembership: {
    //     status: "providerVerified", proofId: string } }   // REQUIRED and
    //                                             // claimsHash-covered in every
    //                                             // artifact variant (round-14 F1)
    //                                             // — verifiers REJECT absence
    //   type Work =
    //     | ({ kind: "commit", repoId, repo?, oid, oidAlg,
    //          objectSha256 }                     & ProviderBound)  // SHA-256 of the
    //                                             // provider-FETCHED object, claimsHash-covered
    //                                             // (round-17 F3) — the promotion gate hashes the
    //                                             // raw fetched merge candidate and compares;
    //                                             // without it, chosen-prefix SHA-1 twins are
    //                                             // indistinguishable to every public check
    //     | ({ kind: "pr",     repoId, repo?, number,
    //          providerArtifactId, observedRevision,
    //          contentBinding }                   & ProviderBound)  // round-18 F2: the
    //     | ({ kind: "issue",  repoId, repo?, number,               // finalization evidence
    //          providerArtifactId, observedRevision,                // (immutable artifact id,
    //          contentBinding }                   & ProviderBound)  // revision, content binding)
    //   type ContentBinding =                     // EXACTLY-ONE union (round-34): the server
    //     | { kind: "publicSha256",  sha256 }     // selects the variant from PROVIDER-VERIFIED
    //     | { kind: "privateHmacSha256V1",        // visibility, never caller input; both/neither
    //         commitment: "c1_…" }                // rejected; the HMAC variant is REQUIRED for
    //                                             // every provider-private artifact even when the
    //                                             // repo name is disclosed
    //                                             // PUBLIC artifacts: plain contentSha256.
    //                                             // PRIVATE artifacts (round-25): keyed
    //                                             // commitment — bodies are low-entropy and
    //                                             // dictionary-confirmable through a bare hash:
    //                                             // contentCommitment = "c1_" + base64url(
    //                                             //   HMAC-SHA-256(privateContentKeyV1,
    //                                             //     providerHost ‖ 0x00 ‖
    //                                             //     immutableRepositoryId ‖ 0x00 ‖
    //                                             //     providerArtifactId ‖ 0x00 ‖
    //                                             //     observedRevision ‖ 0x00 ‖
    //                                             //     canonicalContent))
    //                                             // — key distinct from repoIdKeyV1, never
    //                                             // exposed; claims-hashed; the resolver
    //                                             // recomputes it from provider-fetched evidence.
    //                                             // `canonicalContent` is OWNED AND VERSIONED by
    //                                             // the receipt spec (round-28) — it must pin the
    //                                             // exact byte representation (which fields, UTF-8
    //                                             // encoding, Unicode normalization, line endings,
    //                                             // null-body handling) or adapters and verifiers
    //                                             // derive different commitments for the same
    //                                             // revision. Bodies are MUTABLE (round-33 F4):
    //                                             // finalization retains an immutable canonical
    //                                             // evidence snapshot (or a provider-signed,
    //                                             // revision-addressable equivalent) and ALL
    //                                             // recomputation runs against that frozen
    //                                             // revision, never current provider state — an
    //                                             // ordinary edit must not 409 a valid receipt.
    //                                             // Where retention is prohibited AND the provider
    //                                             // cannot serve immutable revisions, that receipt
    //                                             // mode is REJECTED at reserve.
    //                                             // lives IN work, claimsHash-covered, equality-
    //                                             // checked against provider evidence — else a
    //                                             // green receipt can't bind to the exact
    //                                             // revision where the trailer was observed
    //     | { kind: "session", repoId, repo?,
    //          origin: { kind: "billedUnfinalized",
    //                    sourceReservationReceiptId } }   // fallback session: origin REQUIRED
    //                                             // (round-19 — optional origin lets a fallback
    //                                             // conform without its source link, defeating
    //                                             // the bidirectional check)
    //     | { kind: "session", repoId, repo?,
    //          origin?: never }                   // ordinary session: origin PROHIBITED —
    //                                             // the two variants must not overlap; claims NO
    //                                             // artifact
    //                                             // membership — scope retained so
    //                                             // it cannot be transplanted, but
    //                                             // it is never a green artifact
    //                                             // association
  },

  "execution": {
    "agent": "minidev",                  // billing identity class, from the proxy key
    "interactive": false,                // interactive vs autonomous — ledger metadata per Cam
    "models": ["claude-fable-5"],        // distinct models across the session's transfers
    "providers": ["anthropic"],
    "startedAt": "2026-08-09T01:02:11.000Z",
    "endedAt": "2026-08-09T02:10:58.101Z"
  },

  "spend": {
    "amountUsd": "4.8224",               // string decimal — no float drift in a money field.
                                         // WORKED EXAMPLE (round-4 F1 — the numbers below
                                         // actually satisfy the normative equation):
                                         // raw products 24373.23 + 22842.63 + 993.15 = 48209.01;
                                         // ceil → 48210; + roundingAdjustment 14 = 48224.
    "usertokens": 48224,                 // 1 usertoken = $0.0001
    "transferCount": 122,
    "pricingPosture": "exact",           // exact | conservative — see "Amount fidelity" below
    "pricingTables": [                   // round-23: claims-hashed binding to the SIGNED table
                                         // registry — one entry per referenced version; every
                                         // breakdown row must resolve to exactly one entry and
                                         // its tuple/rate verify against that signed table
      { "pricingTableVersion": "2026-08-08", "pricingTableSha256": "…" }
    ],
    "breakdown": [                       // REQUIRED (round-2 F4) — the recompute basis. One row
                                         // per (provider, model, usageTier, pricedAsTier,
                                         // pricingDeployment, adapterPolicy?, ratePer1k) —
                                         // round-29/34/35: the key carries both tier fields AND
                                         // the deployment/policy references, matching the
                                         // signed-table rule below. A session that spans a
                                         // pricing-table
                                         // deployment gets TWO rows for the same tuple, each at
                                         // the rate actually applied (round-4 F5) — never a
                                         // blended rate that exists in no published table.
      { "provider": "anthropic", "model": "claude-fable-5",
        "usageTier": "input", "pricedAsTier": "input",
        "pricingTableVersion": "2026-08-08", "pricingTableSha256": "…",
        "pricingDeployment": { "deploymentId": "deploy_…",
          "registryVersion": "2026-08-08", "registrySha256": "…" },
        "tokens": 812441, "ratePer1k": "30", "usertokens": 24373 },
      // Row→table→deployment binding is a TRIPLE cross-check (final round):
      // each row's table reference must equal exactly one
      // spend.pricingTables[] entry AND the table referenced by the signed
      // deployment record; ratePer1k validates ONLY against that one table
      // — matching a row to a table by its claimed rate would be circular.
      { "provider": "anthropic", "model": "claude-fable-5",
        "usageTier": "cacheRead", "pricedAsTier": "cacheRead",
        "pricingTableVersion": "2026-08-08", "pricingTableSha256": "…",
        "pricingDeployment": { "deploymentId": "deploy_…",
          "registryVersion": "2026-08-08", "registrySha256": "…" },
        "tokens": 7614210, "ratePer1k": "3", "usertokens": 22843 },
      { "provider": "anthropic", "model": "claude-fable-5",
        "usageTier": "output", "pricedAsTier": "output",
        "pricingTableVersion": "2026-08-08", "pricingTableSha256": "…",
        "pricingDeployment": { "deploymentId": "deploy_…",
          "registryVersion": "2026-08-08", "registrySha256": "…" },
        "tokens": 6621, "ratePer1k": "150", "usertokens": 993 }
      // Every row REQUIRES `pricingDeployment` (round-34/35) — validated
      // against the signed activation-range registry; the deployment↔
      // admission binding is verified by the MINTER (persisted with the
      // intent pre-PENDING) and is a mint-time attestation to offline
      // verifiers, stated as such. Fallback rows additionally carry
      // `adapterPolicy: { adapterId, adapterRevision,
      // adapterRegistryVersion, adapterRegistrySha256 }`,
      // `candidateTiers`, and `fallbackReason` — all claims-hashed, all
      // part of the aggregation key.
      // Tier DOMAINS are explicit (round-35): PricedTier = input | output
      // | cacheRead | cacheWrite; UsageTier = PricedTier | "unknown";
      // `pricedAsTier` and `candidateTiers` draw from PricedTier ONLY —
      // "unknown" is legal solely in `usageTier` on conservative fallback
      // rows.
      // tier ∈ input | output | cacheRead | cacheWrite — and each row
      // carries BOTH `usageTier` (what the tokens WERE) and `pricedAsTier`
      // (what rate class was APPLIED) (round-28: a conservative-fallback
      // cacheRead row priced at the input rate would otherwise fail the
      // signed-table tuple check, and weakening that check reopens
      // self-declared rates). `ratePer1k` validates against the signed
      // table's `pricedAsTier` entry AND must satisfy
      // `appliedRate ≥ nativeUsageTierRate` from the SAME signed table
      // (round-30: without the floor, output-priced-as-input passes every
      // check while understating — "conservative" must mean can-only-
      // round-UP). `"exact"` posture requires usageTier === pricedAsTier
      // on EVERY row plus persisted exact adapter posture; conservative
      // mappings come from an allowlist. Unknown tiers are REPRESENTABLE
      // (round-31, candidate sets round-32): `usageTier: "unknown"` is a
      // fifth legal value; the row carries `candidateTiers` — the SIGNED,
      // adapter-registry-declared set of tiers the tokens could have been
      // (e.g. {input, cacheRead} for an adapter that discards the prompt
      // cache split) — and `pricedAsTier` must be the MAXIMUM-rate member
      // of that set, with pricingPosture === "conservative" and a
      // row-level `fallbackReason`. The set is per-adapter and signed
      // because a global maximum would demand the output rate for prompt
      // tokens (round-32: the OpenAI/Gemini fallback truthfully bills
      // unknown prompt splits at the input rate — the max over
      // {input, cacheRead}, not over all tiers). Fallback rows carry the
      // claims-hashed adapter-policy reference — {adapterId,
      // adapterRevision, adapterRegistryVersion, adapterRegistrySha256}
      // — which also joins the aggregation key (round-33 F2: without it a
      // self-declared narrowed candidate set passes every check); the
      // candidate set and mapping must exactly match that signed
      // registry entry.
      // `ratePer1k` is
      // USERTOKENS PER 1,000 TOKENS. Rates are NOT self-authenticating
      // (round-22 F3): each (provider, model, tier, pricingTableVersion)
      // row must match the SIGNED, immutable pricing-table registry —
      // published alongside the key registry — and the claims commit the
      // table's content hash (`pricingTableSha256`); verifiers reject
      // unknown versions or tuple/rate mismatches, else a lowered
      // self-declared rate POSTs an understated amount through every
      // ledger and offline check. Table versions carry SIGNED ACTIVATION
      // RANGES and each intent persists the active deployment reference
      // BEFORE PENDING (round-33 F3: matching any historical signed table
      // lets a pre-increase cheaper version pass after a price change);
      // each breakdown row includes that claims-hashed deployment
      // reference, rows split by deployment, and the resolver verifies
      // every constituent used the deployment active at its admission. A row's `usertokens` is informational
      // display only — round-half-even(tokens × ratePer1k / 1000) — and is
      // NOT a term in the normative equation, which uses the rows' raw
      // products. Conservative-fallback rows carry the rate actually APPLIED
      // (e.g. cache tokens at the input rate) so the recompute works without
      // knowing provider discounts.
    ],
    "roundingAdjustment": 14             // usertokens (round-3 F3). The ledger rounds PER
                                         // TRANSFER — Σ max(1, ceil(per-transfer cost)) — and
                                         // ceiling is not distributive, so the tier-aggregate
                                         // recompute alone can understate the posted total (two
                                         // 0.4-usertoken transfers post 1+1=2, aggregate says 1).
                                         // This field is the exact non-negative difference; it is
                                         // committed inside claimsHash, so it cannot be tuned
                                         // post-hoc.
  },

  "proof": {                             // binds to apps/api's EXISTING audit machinery (Codex F1)
    "chain": "usertools-prod-audit",
    "sessionDigest": {                   // the ONE leaf this receipt attests (resolves former OQ2)
      "event": {                         // FULL canonical preimage (round-2 F2) — without it a
                                         // verifier proves inclusion of an opaque hash, not that
                                         // the receipt's work/spend are what the leaf committed to
        "version": 1,
        "previousHash": "…",             // linear-chain predecessor — ties the leaf into the chain
        "sequence": 8123421,
        "occurredAt": "2026-08-09T02:11:03.980Z",
        "payload": {
          "receiptId": "…",              // binds leaf ↔ receipt (no leaf reuse across receipts)
          "claimsHash": "…",             // SHA-256(canonical({ mintedAt, work, execution,
                                         // spend })) — ONE hash committing EVERY material claim
                                         // the receipt displays (round-3 F1); the verifier
                                         // reconstructs exactly that claims object from this
                                         // response and compares hashes before checking inclusion
          "transferSetRoot": "…"         // stable commitment to the reconciled transfer set —
                                         // per-transfer detail stays private; the COMMITMENT is
                                         // public and fixed at mint
        }
      },
      "eventHash": "…"                   // = SHA-256 over the receipt spec's canonical JSON
                                         // serialization of `event` (spec owns canonicalization);
                                         // leafHash = SHA-256(0x00 ‖ eventHash) per RFC 6962 §2.1
    },
    "inclusion": {                       // = governance/audit MerkleInclusionProof, verbatim.
                                         // Example kept internally VALID (round-4 F6): a 2-leaf
                                         // tree needs exactly one sibling. Verifiers MUST reject
                                         // a proof whose path length is inconsistent with
                                         // (leafIndex, treeSize).
      "version": 1,
      "leafHash": "…",
      "leafIndex": 1,
      "treeSize": 2,
      "root": "…",
      "siblings": [{ "hash": "…", "position": "left" }],
      "segmentId": "…"
    },
    "publishedRoot": {                   // = governance/audit PublishedMerkleRoot + keyId
      "root": "…",
      "treeSize": 2,
      "segmentId": "…",
      "publishedAt": "2026-08-09T02:11:04.000Z",
      "anchors": [                       // round-11 F4, sole normative source (round-12): each
                                         // kind has its own locator and trusted timestamp; the
                                         // verifier ITERATES every declared entry against the
                                         // same signed root tuple — non-empty required on 200.
                                         // publishedTo and the legacy singular reference are
                                         // display-only derivations (reference must equal the
                                         // sole entry when anchors.length === 1).
        { "kind": "s3-object-lock", "reference": "…" }
      ],
      "publishedTo": "s3-object-lock",   // derived display — NEVER "pending" on a
                                         // 200 (round-2 F3): an unanchored root cannot support
                                         // offline chain-membership, so mint completion DEFERS
                                         // until the root is externally published; a known ID
                                         // whose root is still anchoring answers 202
                                         // {status:"anchoring"} with Cache-Control: no-store
      "reference": "…",                  // external anchor locator — MUST be inside the
                                         // configured UserTools anchor namespaces; verifiers
                                         // reject references outside them (round-4 F2)
      "keyId": "usertools-audit-root-2026a",  // names the key in the PINNED registry — the
                                         // verifier's trust anchor (round-4 F2)
      "signature": "…",                  // Ed25519 over the published root
      "publicKey": "…"                   // display convenience ONLY — NEVER a verification
                                         // input: a co-supplied key authenticates nothing but
                                         // itself. Verifiers resolve keyId against the pinned
                                         // registry and reject unknown keys.
    }
  },

  "signature": {                          // scheme owned by the receipt spec — placeholder shape
    "alg": "ed25519",
    "keyId": "usertrust-mint-2026a",
    "sig": "base64…"                     // over the canonical receipt payload, per spec
  }
}
```

Design intents behind the shape:

- **The proof construction is the audit layer's existing one, not a new
  invention (Codex F1).** `governance/audit` already maintains RFC 6962-style
  per-segment Merkle trees over the linear SHA-256 hash chain: domain-separated
  hashing (`0x00` leaf / `0x01` interior prefixes, RFC 6962 §2.1), odd-leaf
  promotion (CVE-2012-2459), one tree per JSONL segment, and Ed25519-signed
  roots published to external anchors (S3 Object Lock / Rekor). The receipt
  attests exactly ONE leaf — the canonical **session-digest event** — so the
  proof is a standard `MerkleInclusionProof` (leafIndex, treeSize, oriented
  siblings, segmentId) against a `PublishedMerkleRoot`. Offline verification:
  (0) IDENTITY BINDING FIRST (round-8 F3): require
  `requestedReceiptId === receipt.receiptId ===
  event.payload.receiptId` — without this, an untrusted resolver can
  answer a request for receipt B with intact, fully-valid receipt A and
  every cryptographic check below still passes; then verify the top-level
  mint signature per the receipt spec, (1) reconstruct the canonical claims object `{ mintedAt, work, execution,
  spend }` from this response, hash it, and check it equals
  `event.payload.claimsHash`; then canonically serialize the returned
  `sessionDigest.event` and check SHA-256 equals `eventHash` — every claim
  the page displays is now bound by the leaf, not a chosen subset, (2) derive
  `leafHash = SHA-256(0x00 ‖ eventHash)` and walk the oriented siblings to the
  root with the domain-separation rules, rejecting any proof whose path
  length is inconsistent with `(leafIndex, treeSize)`, and REQUIRE the
  cross-structure equalities before accepting anything (round-9 F2 —
  `inclusion` and `publishedRoot` duplicate fields, and without mandated
  equality an implementation can verify a fabricated tree against
  `inclusion.root` while independently validating an unrelated legitimate
  signed root): `inclusion.leafHash === derivedLeafHash`,
  `inclusion.root === derivedRoot === publishedRoot.root`,
  `inclusion.treeSize === publishedRoot.treeSize`,
  `inclusion.segmentId === publishedRoot.segmentId` — and the signature
  and anchor checks in the next steps operate on THAT same
  `publishedRoot`, (3) resolve
  `publishedRoot.keyId` against the PINNED key registry
  (`/.well-known/usertrust-verify` carries the historical audit-root keys
  with validity windows; the response's co-supplied `publicKey` is display
  only and never a verification input — round-4 F2) and check the root's
  Ed25519 signature — over the bound unit `(root, treeSize, segmentId,
  publishedAt)` — against the registry key, rejecting unknown `keyId`s,
  (4) confirm the root at its external anchors — iterating EVERY entry of the non-empty
  `anchors[]` array, each against the same signed root tuple (round-12; a
  200 never carries an unanchored root), rejecting references outside the
  configured UserTools anchor namespaces, and check the KEY's validity
  window against the ANCHOR's trusted timestamp (Rekor `integratedTime` /
  S3 Object Lock creation time), never against response fields, rejecting
  signed-vs-anchor metadata discrepancies (round-6 F3 — a retired key plus
  a backdated self-reported `publishedAt` must not verify). The chain-membership question ("does this root belong to the real
  chain?") is answered by the external anchoring, not by trusting the
  resolver. The session digest's canonical serialization is owned by the
  receipt spec. What is NOT independently verifiable from this response (round-32 —
  stated explicitly rather than implied otherwise): (1) per-transfer
  detail behind `transferSetRoot` (a fixed commitment, not an
  enumeration) — a verifier proves the receipt's totals are what the
  chain committed to, not how they decompose transfer-by-transfer;
  (2) repository-membership PROVENANCE — `repositoryMembership.proofId`
  and the observation evidence are chain-committed CLAIMS whose
  provider-side verification is an internal mint/resolver check; an
  offline verifier proves the minter committed to having observed
  membership, not the observation itself (folding a linked membership
  event with its own inclusion proof into the response is a ledgered
  future upgrade).
- **`status: "verified"` is recomputed, not stored.** The resolver re-derives
  and verifies the proof on every resolution, including conditional requests,
  before deciding whether to return 200 or 304. A receipt that fails
  recomputation NEVER returns 200 or 304 (see 409 below) — the page must not
  be able to render a green check from stale state.
- **"Verified" means BILLED, not merely logged (Codex F2).** The proxy's core
  invariants are two-phase settlement (PENDING → POST/VOID) and triple
  verification (TigerBeetle + SurrealDB + audit chain joined on `transferId`).
  A receipt is mintable — and a 200 returnable — only for a **reconciled
  transfer set** of POSTed LOGICAL members —
  `{authorizationTransferId, settlementTransferId}` pairs (round-34/35:
  TB transfers are immutable; the authorization KEEPS its pending flag
  forever, and settlement is a SECOND transfer) — the authorization
  carrying the pending flag and authorized amount, the settlement
  carrying `post_pending_transfer`, `pending_id ===
  authorizationTransferId`, and the actual amount, with the same pair
  present in SurrealDB and the audit event. ONLY POST pairs enter the
  billable `transferSetRoot` and count in `transferCount`;
  VOID/REJECTED/ABORTED outcomes live in a SEPARATE terminal-intent
  commitment, never the receipt set (round-35: mixing them would break
  `notMinted` and unmoor `spend` from the root). `spend.amountUsd`, `spend.usertokens`, and
  `spend.transferCount` are derived from that reconciled set and no other.
  If a SurrealDB write is sitting in the dead-letter queue for any constituent
  transfer, minting DEFERS until reconciliation drains — a receipt never
  fronts an unreconciled ledger.
- **Amounts as string decimals.** `4.8210` not `4.821`; public money fields
  don't get float representation.
- **Amount fidelity (validated 2026-08-08 against the SDK's cache-tier
  pricing work, `usertrust` repo `docs/superpowers/plans/2026-08-08-cache-tier-pricing.md`).**
  Public amounts must never UNDERSTATE what the work cost — that is the
  embarrassing failure for a governance flex. Proxy reality today: Anthropic
  traffic (the dominant path — Claude Code / minidev) is priced EXACTLY, all
  four token tiers extracted and rated. OpenAI/Gemini adapters zero the cache
  counts and bill the full prompt at the input rate — cached tokens priced at
  full freight, i.e. conservatively HIGH, the same posture as the SDK's D1
  invariant by a different route. `pricingPosture` makes this honest on the
  wire: `"exact"` when every constituent transfer priced with full tier
  extraction, `"conservative"` when any leg used a fallback that can only
  round up. Each breakdown row names its `pricingTableVersion` — per ROW,
  not per receipt, because a session can span a pricing-table deployment and
  the same (provider, model, tier) may then carry two genuinely-applied rates
  (round-4 F5); a blended rate would exist in no published table. (The proxy
  needs a versioned analog of the SDK's `PRICING_TABLE_VERSION` — ledgered
  follow-up.) A skeptic recomputes the amount from published rates, mirroring
  the SDK receipt.v2 recompute pin (`counts × appliedRates` = cost from the
  record alone). The recompute basis is IN the response (round-2 F4, precise
  form fixed by round-3 F3): `spend.breakdown` is required, one row per
  (provider, model, usageTier, pricedAsTier, pricingDeployment,
  adapterPolicy?, ratePer1k) with tokens, and the
  recompute claim is exactly `ceil(Σ tokens × ratePer1k / 1000) +
  roundingAdjustment = spend.usertokens`, AND `amountUsd` must equal the
  canonical integer conversion of that total — quotient/remainder at
  10,000 usertokens per dollar, zero-padded four-decimal string, no
  floating point — enforced by resolver and offline verifier alike
  (round-17 F5: without it a correct-usertokens receipt could display an
  unrelated dollar string through every hash and signature). The adjustment exists because the
  ledger applies `max(1, ceil(…))` PER POSTED TRANSFER and ceiling is not
  distributive over the aggregate; it is committed inside `claimsHash` and
  must satisfy `0 ≤ roundingAdjustment ≤ transferCount` — the algebraic
  bound `Σ max(1, ceil(cᵢ)) − ceil(Σ cᵢ) ≤ N` (round-30: without the
  upper bound, omitted usage hides behind an arbitrarily large
  "rounding" adjustment while the recompute equation still balances);
  the resolver derives it exactly from reconciled POST amounts and
  offline verifiers reject out-of-range values. It is also non-negative (a negative adjustment would mean the aggregate
  OVERSTATES the ledger — structurally impossible with per-transfer minimum
  charging, and a mint-time assertion). What the recompute proves: the
  published total is consistent with the published counts, rates, and
  committed adjustment. What it does not prove: the per-transfer
  decomposition, which stays behind `transferSetRoot` (per-transfer sanitized
  rows remain a receipt-spec option if full independence is ever wanted).
  Conservative-fallback rows carry the applied rate, so the recompute needs
  no knowledge of provider discounts. The cache-read split this exposes is
  the 7-8× story made visible. Field vocabulary stays aligned with
  receipt.v2's `usage`/`meter`.
- **Offline verifiability.** `proof` + the published keys
  (`GET /.well-known/usertrust-verify` → mint key, root-signing key, current
  chain heads and anchor references) must be sufficient to verify WITHOUT
  trusting this API — that's what makes the flex credible to a skeptic. The
  page gets a "verify it yourself" affordance for free.
- **No PII, no prompt content, no repo file paths.** The receipt attests that
  governed work happened and what it cost — never what was said to the model.

## Mint lifecycle — normative constraints on the resolver's semantics

The mint endpoint gets its own spec, but three of its properties are
load-bearing for what a resolver response MEANS, so they are normative here
(round-6 F1/F2).

**Reserve → work → finalize (breaks the OID circularity, round-6 F1).** A
commit receipt binds the commit's full OID, but the receipt trailer lives IN
the commit message — writing it changes the OID. The lifecycle is therefore
two-step: (1) **reserve** an opaque `receiptId` (authenticated proxy call,
before the commit exists) — the trailer is written with this ID and the
commit is created; (2) **finalize** the reservation — one-time, permitted
only to the same authenticated proxy identity that reserved, and the caller
does not merely ASSERT the OID: finalization submits the **exact uncompressed
commit-content bytes** (from which the canonical `gitPreimage` is formed —
round-26: one defined representation, no "raw bytes" ambiguity) (round-7 F3); the proxy recomputes the OID under `oidAlg`,
requires it to equal the claimed OID, parses the commit message, and
requires the reserved receipt ID to appear in the exact approved trailer
grammar EXACTLY once. Finalization is PER-KIND (round-17 F2 — `repoId + number +
providerVerified` alone would green-receipt any EXISTING pr/issue):
`commit` verifies the trailer in the byte-compared object as below; `pr`
and `issue` require the proxy to fetch the artifact body from the
provider and find the reserved ID in the approved trailer grammar EXACTLY
once, claims-hashing the immutable provider artifact ID plus the observed
revision/content digest and proof identifier. A finalize whose commit
bytes lack the trailer, carry
a different ID, or carry it twice is rejected — an audit proof must never
faithfully authenticate a false commit association. Commit bytes alone
prove only the hash, never residence (a git commit carries no repository
identity — review-gate R2), so repository membership is OBSERVED:
reservations bind a provider-scoped IMMUTABLE repository ID, and
finalization completes only after the proxy FETCHES the canonical commit
object from the accepted provider ref and compares it BYTE-FOR-BYTE with
the submitted object — a webhook only ever triggers that fetch, never
substitutes for it (round-16: with SHA-1 repositories a chosen-prefix
collision could otherwise pass trailer checks on submitted object A while
object B with the same OID sits in the repo). The chain commits
{repoId, oid, oidAlg, sha256 of the fetched object's canonical git
preimage (the same `gitPreimage` form the promotion gate hashes), provider
proof identifier} — the SHA-256 binds an unambiguous object even under a
SHA-1 OID. v1 FAILS CLOSED unless membership is
provider-verified (round-13 F2 — an optional posture field outside the
union is ignorable by v1 consumers, which re-greens unverified
associations): every ARTIFACT-BEARING `work` variant (`commit`, `pr`,
`issue`) REQUIRES the chain-committed discriminator `repositoryMembership: { status: "providerVerified",
proofId }` inside it — `session` is explicitly
exempt: it claims no artifact membership at all; any future unverified
association ships as a distinct non-green status under a new
`apiVersion`, never as an optional field old consumers may drop
(round-8 F2 superseded accordingly). A reservation finalizes at
most once — idempotently, via a PER-KIND canonical command digest
(round-8 F5, per-kind round-23): commit digests cover {owner, kind,
repoId, oid, oidAlg, objectSha256}; pr/issue digests cover {owner, kind,
repoId, number, providerArtifactId} plus the originally accepted
revision/content evidence. An IDENTICAL replay returns the frozen first
result WITHOUT re-fetching (a mutable artifact must not change the
accepted revision after finalization); ANY differing digest is rejected
and audit-alerted. (Resolver states for
every phase of this lifecycle: see the Errors table, round-7 F4.)

**The transfer set is derived server-side, never chosen by the caller
(round-6 F2, exclusivity + settlement rules round-7 F1/F2).** "Never
understates" dies if the minter selects which transfers count — omit the
expensive ones, or mint many receipts over one cheap set, or shop between
parallel sessions (cheap work under reservation A, expensive under B,
finalize A for the commit). Therefore:

- **Exclusive automatic binding — per billing identity, full stop
  (round-8 F1):** at most ONE active reservation per billing identity; a
  second reserve while one is open is rejected. Keying exclusivity by
  (identity, scope) would reopen the shopping attack — the caller picks
  the scope. Every transfer the identity executes while the reservation is
  open is stamped with it AUTOMATICALLY, atomically at request admission
  under the same lock that closes the session — there is no unstamped
  execution path and no caller-visible stamping choice. Callers never
  submit transfer lists.
- **Intents precede money movement (review-gate R2):** before ANY
  TigerBeetle side effect, the proxy transactionally verifies the session
  is OPEN and durably inserts a session-transfer INTENT carrying the
  preallocated `transferId` — the finalizer enumerates INTENTS, not
  SurrealDB rows whose write may have dead-lettered after TB succeeded
  (that failure previously made a transfer invisible and minted an
  underreported receipt validly).
- **Two-phase settlement is respected (round-7 F1 — Blocking):** PENDING is
  not terminal. Closure is linearizable: OPEN → CLOSING transitions
  atomically, serialized against intent insertion, rejecting new
  executions; finalization then WAITS until every INTENT — journal and
  DLQ entries included — reaches a TERMINAL state:
  `terminalIntent = POST | VOID | REJECTED | ABORTED_NOT_SUBMITTED`
  (round-11 F3 — POST/VOID exist only for intents whose TigerBeetle
  transfer exists; pre-ledger terminals settle the rest, else a definitive
  TB rejection would block finalization forever). Minting draws from
  POSTed transfers alone; all-terminal with zero POSTs resolves
  `notMinted` —
  it defers while any is PENDING, because an in-flight expensive transfer
  could otherwise POST after the receipt anchors, silently understating an
  already-immutable public amount. The final set includes ALL POSTed
  stamped transfers and excludes only terminal VOIDs. A POSTed member
  missing SurrealDB or audit reconciliation (DLQ) keeps the receipt in the
  `reconciling` state — never a 200.
- **No vacuous receipts:** finalization requires at least one reconciled
  POSTed transfer; an empty session cannot mint.
- **What the receipt claims — stated precisely (round-9 F3):** the
  receipt's spend claim is the COMPLETE, never-understated cost of THIS
  governed session; the session↔work association is the observed/attested
  part. Cross-identity shopping (expensive work under identity A's
  abandoned reservation, one cheap call under B, finalize B) cannot be
  made impossible for an adversary who controls multiple identities — so
  the claim is scoped to the session, and three enforcements make the
  association trustworthy for the fleet's own identities: (a)
  receipt-enabled identities REQUIRE an open reservation at every model-
  request admission — no unreserved execution path exists for them; (b)
  reservations are created by the job orchestration under a trusted job
  capability, not freely by the caller — one job, one identity, one
  reservation; (c) a reservation holding ANY intent never expires to
  `unknown` — it auto-closes, reconciles, and remains `reconciling` until
  terminal, so abandoning work does not erase its record. Pages render
  "produced under this governed session — $X" — never "total cost of
  producing this artifact".
- **Provider execution is durably claimed too (round-17 F1):** the
  ledger-side machinery below is mirrored on the provider side —
  `PENDING --worker CAS--> PROVIDER_SUBMITTING(clientOperationId,
  idempotencyKey) --send/recover--> USAGE_RECORDED(providerRequestId,
  usage) --CAS--> POST_SUBMITTING(settlementTransferId,
  immutablePostCommand) --TB lookup/replay--> POST` — and symmetrically
  `VOID_SUBMITTING(settlementTransferId, immutableVoidCommand)`
  (round-24: posting or voiding a pending transfer IS a transfer with its
  own unique ID; the settlement ID is preallocated/deterministically
  derived and the complete command persists BEFORE any TigerBeetle call,
  else a crash between TB acceptance and the Surreal terminal write
  leaves recovery unable to identify the accepted settlement — a fresh ID
  yields only "already posted" without saying WHICH). Both pre-send
  provider fields are
  CLIENT-generated and persist before any network I/O — ALONGSIDE the
  immutable provider command itself: `{clientOperationId, idempotencyKey,
  commandRef, commandSha256, adapterRevision}` persist atomically
  pre-send (round-27: replay-based adapters cannot reproduce the exact
  model/prompt/tools from a key alone after a crash; a different replay
  double-bills or rejects). Where retaining request content is
  prohibited, receipt-enabled mode is restricted to providers whose
  query-by-client-token returns status AND usage without replay; the
  provider-assigned request ID attaches only at USAGE_RECORDED, after a
  response exists (round-23: a provider-generated ID in the pre-send CAS
  is an impossibility that would reopen the crash window), with
  `PENDING --closer CAS (only before the provider claim)--> VOID_SUBMITTING
  --> VOID` (round-19: EVERY void routes through the durable
  claimed-submission state — a SurrealDB CAS cannot atomically perform the
  TigerBeetle void, so a direct-to-terminal transition could mark the
  intent VOID while the TB transfer stays pending, breaking two-phase
  settlement) and the
  authoritative-rejection path
  `PROVIDER_SUBMITTING --> PROVIDER_REJECTED_NO_BILL --> VOID_SUBMITTING
  --> VOID` (round-18 F4 — a definitive provider no-bill, e.g. request
  validation, performs a REAL TigerBeetle void then reconciles Surreal +
  audit; without it an ordinary rejection leaves PENDING and the identity
  in `reconciling` forever). A CLIENT-generated
  operation/idempotency key persists BEFORE sending (round-20/22 —
  provider request IDs are unknowable until a response arrives): every
  receipt-enabled provider adapter MUST expose provider-backed idempotent
  replay or query-by-client-token semantics enabling CONCLUSIVE recovery,
  and providers without that capability are REJECTED before PENDING is
  created in receipt-enabled mode. Receipt-bound TigerBeetle PENDING
  transfers MUST use `timeout = 0` (round-20/22) and may be resolved ONLY
  through POST_SUBMITTING or VOID_SUBMITTING — an automatic ledger
  expiration after the provider claim is an integrity incident, never an
  ordinary VOID. Once provider
  submission is claimed, a timeout or ambiguous outcome alone never VOIDs — the reservation
  stays `reconciling` until the provider result is recovered (else
  recovery VOIDs work the provider already billed, or replays and
  duplicates it); usage lands in a durable outbox before completion is
  acknowledged.
- **Intent lifecycle has pre-ledger terminals and a claimed-submission
  state (review-gate R5 + R7):**
  `INTENT --worker CAS--> SUBMITTING --TB--> PENDING → POST | VOID`, with
  `INTENT --closer CAS--> ABORTED_NOT_SUBMITTED` permitted ONLY if the
  closer wins before submission is claimed, and `SUBMITTING → REJECTED`
  only on a DEFINITIVE TigerBeetle refusal — a transport failure never
  becomes REJECTED; `SUBMITTING` is never aborted, only resolved by
  querying/idempotently replaying the immutable command by `transferId`
  until TB answers (without the CAS, a paused worker races closure:
  closure aborts the intent, mints, then the worker resumes and creates
  the transfer — silent underreport) —
  without them an intent with no ledger transfer can never reach POST/VOID
  and finalization waits forever, or an implementation fake-VOIDs in
  SurrealDB alone, violating triple verification. The intent persists the
  complete immutable TigerBeetle command (or a mandatory reference to it)
  so an uncertain submission replays idempotently by `transferId`. Only
  actual TigerBeetle transfers enter the transfer set; rejected/aborted
  intents are separately audit-committed so closure stays complete.
- **Reservations can terminate without minting ONLY when empty
  (review-gate R5, corrected round-11 F1):** authenticated cancellation
  and server-enforced expiration run through the SAME admission lock, but
  `CANCELLED | EXPIRED` is reachable ONLY when NO intent was ever
  admitted. Once intents exist, termination forces settlement instead:
  every intent reconciles to terminal, and if ANY transfer POSTed, the
  ORIGINAL reservation's receipt mints and anchors — whether or not the
  caller still wants it. Anything else would strand paid transfers
  outside every receipt (violating one-transfer-one-receipt) and reopen
  shopping (do expensive work, cancel, mint cheap under a new
  reservation). The identity is not released until the terminal public
  record exists. Exhaustive transition table (round-21 — the earlier
  one-line rule conflicted with the fallback and covered only commits):
  `no intents → original ID: CANCELLED | EXPIRED ·
  intents, zero POSTs → original ID: notMinted ·
  ≥1 POST, session reservation → mint the original ID ·
  ≥1 POST, artifact reservation (commit/pr/issue) successfully finalized →
  mint the original artifact ID ·
  ≥1 POST, artifact reservation NOT successfully finalized → original ID:
  billedUnfinalized + mint the separate linked session receipt`. **Billed but never
  finalized (round-13 F1):** a commit-kind reservation whose caller
  crashes before finalization (or whose membership verification fails)
  can never supply commit bytes — yet POSTed transfers demand a public
  record and the identity must not lock forever. After the reservation
  TTL the server FORCES the terminal path itself: reconcile → mint a
  spend-only SESSION-variant receipt under a SEPARATE, linked receipt ID →
  anchor → release the identity — while the ORIGINAL (possibly already
  trailered) ID resolves to the non-green terminal 410
  `billedUnfinalized`, whose link is CRYPTOGRAPHICALLY bidirectional
  (round-17 F4): the fallback receipt claims-hashes
  `sourceReservationReceiptId`, an audit-committed terminal event for the
  original ID records `linkedReceiptId` + the transfer-set commitment,
  the 410 body is fully specified (round-18 F3, discriminator round-31):
  `{ status: "billedUnfinalized", receiptId, linkedReceiptId,
  transferSetRoot, terminalEvent: { event, inclusion, publishedRoot } }`
  — the status discriminator IS part of the normative body, matching the
  Errors table. Request binding applies to THIS response type too
  (round-32): `requestedReceiptId === body.receiptId ===
  terminalEvent.event.payload.receiptId ===
  linkedReceipt.work.origin.sourceReservationReceiptId` and
  `body.linkedReceiptId === linkedReceipt.receiptId` before following or
  rendering the link — else an untrusted resolver answers a request for
  ID B with a fully valid terminal bundle for ID A — and verifiers compare both IDs AND the transfer-set
  root across the terminal event, the fallback receipt's
  `origin.sourceReservationReceiptId`, and the linked receipt — an
  untrusted resolver cannot point at an arbitrary
  valid session receipt
  (round-14 F2: minting green under the original ID would let a caller
  trailer arbitrary commits, POST one cheap transfer, skip finalization,
  and harvest verified receipts). The money always gets its receipt; the
  trailered ID never turns green without finalization. Consequently the
  PROMOTION gate requires `kind === "commit"` and exact `repoId`, `oid`,
  `oidAlg` equality against the merge candidate AND
  `work.objectSha256 === sha256(gitPreimage(candidate))` where
  `gitPreimage = ASCII("commit " + byteLength(content)) ‖ 0x00 ‖ content`
  over the exact uncompressed commit-content bytes — ONE representation,
  used identically by minter and gate (round-20: "raw bytes" spanned
  three plausible encodings, letting the two ends hash different things) (round-18 F1 — without the digest
  comparison the gate promotes SHA-1 twin B after minting against A) —
  never merely a 200.
- **Workflow-closure attribution (review-gate R5):** per-workload
  reservations reopen shopping via cross-workload artifacts (expensive
  workload B emits a patch; cheap workload A imports it, commits, and A's
  `workflowAttested` receipt underreports). Reservations therefore bind
  the workflow's PROVENANCE CLOSURE: one parent reservation per
  orchestrated pipeline, all contributing jobs stamping into it — or a
  chain-committed dependency DAG whose transitive contributors' transfer
  sets aggregate before minting. A workflow that imports ungoverned or
  cross-reservation inputs cannot claim `workflowAttested`.
- **Every logical transfer is an ID PAIR (round-33 F1 — TigerBeetle
  transfers are immutable; posting a pending transfer creates a SECOND
  transfer whose `pending_id` references the authorization):** the
  reconciled set holds `{authorizationTransferId, settlementTransferId}`
  per member; the TB settlement must have `pending_id ===
  authorizationTransferId`, `id === settlementTransferId`, the expected
  POST (or VOID) flag and amount; SurrealDB and the audit event carry the
  same pair; and `transferSetRoot` commits the PAIRS, not bare IDs.
- Each POSTed logical transfer belongs to exactly one MINTED receipt,
  ever (one-time consumption); non-POST outcomes belong to the
  terminal-intent commitment instead. `transferSetRoot` commits the server-derived set, and
  `spend` is computed from it and nothing else.

## Errors

Every lifecycle phase has a defined response (round-7 F4) — consumers get
deterministic rendering/retry behavior, and no cacheable state can mask a
transition:

| Code | Body `status` | Meaning |
|---|---|---|
| 202 | `"reserved"` | ID reserved, not yet finalized, TTL not expired. `Cache-Control: no-store`. Page renders "receipt pending…", never an error — a fresh commit legitimately sits here for minutes. |
| 202 | `"reconciling"` | ANY closing-but-nonterminal reservation, finalized or not (round-16): some intent is INTENT/SUBMITTING/PENDING, or a terminal outcome is not fully SurrealDB/audit-reconciled, or a forced-fallback session receipt has not finished anchoring. An uncertain SUBMITTING intent is nonterminal by definition — it may yet surface in TigerBeetle. No cacheable 410 until every condition resolves. `no-store`. |
| 202 | `"anchoring"` | Mint event appended and checkpointed locally; root not yet externally published (round-2 F3). `no-store`; the page renders "verifying…", never a green check. Expected to clear within one segment-publication cycle. |
| 410 | `"cancelled"` / `"expired"` | Terminal: the reservation was cancelled by its owner or expired server-side — reachable ONLY for reservations with zero admitted intents (round-11 F1); an expiration tombstone persists, so an allocated ID answers 410 forever (round-12). Cacheable ≤1h. Renders as "reservation ended without a receipt" — loud on a commit, expected on abandoned work. Cancellation authorizes against the reservation owner / billing principal (or a delegated orchestrator capability) in the same transaction as the state CAS — reservation IDs are public by design (trailers), and an unauthorized caller receives the 404 shape (review-gate R7). |
| 410 | `"billedUnfinalized"` | Terminal, NON-GREEN: the reservation billed (≥1 POST) but never finalized; a spend-only session receipt exists under a SEPARATE linked ID referenced in the body (round-14 F2). Loud on a commit — the trailer's claim was never proven. Cacheable ≤1h. |
| 410 | `"notMinted"` | Terminal: at least one intent was admitted, ALL intents are terminal, and ZERO TigerBeetle transfers POSTed — actual transfers VOIDed; pre-ledger intents may be REJECTED or ABORTED_NOT_SUBMITTED (round-12 definition). Nothing billable settled, nothing to prove, and this can never change (round-8 F4). Cacheable ≤1h. The page renders "no billable work settled under this receipt ID" — distinct from both an error and a green check. |
| 404 | `"unknown"` | ID never allocated (round-12: allocated IDs that expire answer 410 via the tombstone — the two have opposite integrity semantics). `Cache-Control: public, no-cache, max-age=0, must-revalidate` — storage is acceptable ONLY when every reuse revalidates at the origin; NO freshness allowance (round-21: a fresh cached 404 is served without contacting the origin, so it can never observe the 202 that follows allocation). The receipt-ID spec MUST mandate cryptographically unpredictable server-side allocation and reserve-before-publication. The page renders this LOUDLY — an unknown receipt on a commit is an integrity red flag, per the fail-closed convention. |
| 409 | `"unverifiable"` | ID known, but proof recomputation failed against the chain. Never cached. Alerts internally — this should be impossible. |
| 503 | `"verificationUnavailable"` | A transient dependency (anchor endpoint, key registry, storage) prevented verification — an OPERATIONAL condition, not a cryptographic mismatch (round-32: rendering it 409 fakes an integrity incident; an unspecified 500 breaks deterministic retry). `Cache-Control: no-store` + `Retry-After`; never a 304, never a fallback to any cached green response. |
| 429 | — | Rate limited. |

(OPEN QUESTION 3: is 410 `"revoked"` needed? I lean NO — an immutable ledger
has no revocation; a mistaken mint is an incident, not a lifecycle state.)

## Non-goals (v1)

- No list/search endpoints (enumeration of receipts is a different product
  decision — amounts are public per-receipt, not necessarily as a browsable
  firehose).
- No per-transfer breakdown endpoint. `spend` is session-aggregate; the
  transfer-level drill-down can come later behind the same ID if wanted.
- No auth'd variants. One public shape, one trust story.

## Open questions for the spec (usertrust instance)

1. ~~Private-repo receipts~~ **RESOLVED (round-3 F4, construction fixed
   round-4 F3):** `work` always carries scope — canonical host-scoped repo
   identity, or for undisclosed private repos a stable keyed `repoId`:
   `"r1_" + base64url(HMAC-SHA-256(repoIdKeyV1, providerHost || 0x00 ||
   immutableRepositoryId))` — keyed off the immutable provider ID, never the
   mutable, reusable URL (round-10: this line previously contradicted the
   normative work-block construction); the HMAC key is never exposed and the
   canonical URL is display-at-mint metadata only; the git object ID is
   always the FULL oid + algorithm.
   Whether stealth commits use the name or the `repoId` remains Cam's call,
   but scope is never dropped and prefixes are never committed.
2. ~~Proof size bound~~ **RESOLVED (Codex F1 remediation):** the receipt
   attests exactly one leaf — the canonical session-digest event. The spec
   owns the digest's canonical form (it must commit to the reconciled
   transfer set and spend totals); the proof structures are the audit layer's
   existing `MerkleInclusionProof` / `PublishedMerkleRoot`, verbatim.
3. **Revocation:** see above — spec should confirm "no revocation" so the page
   never needs the state.
4. **ID ergonomics:** trailer real estate matters. Something like
   `ut1_<base58…>` (~24-30 chars) keeps `UserTrust-Receipt: usertrust.ai/r/ut1_…`
   on one line. Spec owns this; flagging the constraint.
5. **Trailer grammar:** exact trailer key (`UserTrust-Receipt:`?) and whether
   the value is the bare ID or the full URL. Spec owns; page and swap both
   need it fixed early.
6. **receipt.v2 alignment:** the SDK's cache-tier work adds `receipt.usage`
   (four sanitized tiers), `meter.appliedRates`, and `meter.pricingTableVersion`
   with a record-local recompute pin. If SDK receipts ever resolve under the
   same `/r/` namespace, the spec should define one `spend`/`usage` vocabulary
   both receipt families share — this draft's `pricingTableVersion` /
   `pricingPosture` fields are named to be compatible, not final.

## Sequencing / gating (from Cam's plan)

**Prerequisite migration (round-13 F3):** per-transfer pricing metadata —
`pricingTableVersion`, the applied tier rates, and the sanitized usage
snapshot — is NOT currently ledgered, and inferring it at mint time from
the then-current table assigns wrong rates into an immutable, anchored
receipt. Durability splits at two points, respecting two-phase spend
(round-14 F3 — usage is unknowable before the provider responds, and
PENDING must precede provider work): (1) the pricing-table version and
applicable tier rates persist with the initial intent BEFORE the PENDING
authorization; (2) after the provider response, the sanitized actual
usage, the computed amount, AND the per-transfer pricing method — its
`pricingPosture` (exact tier extraction vs conservative fallback) plus
the adapter revision that produced it — attach durably to the intent
(round-24: zeroed cache counters cannot distinguish "no cache usage"
from "adapter discarded cache usage", so posture is never inferable
later; the receipt's `pricingPosture` derives conservatively —
`exact` iff EVERY constituent transfer's persisted posture is exact); (3) only then is
POST submitted — crash recovery and DLQ replay cover the
usage-recorded-to-POST window. The hold itself is a CEILING (round-26):
before PENDING is created, `authorizedMaxUsertokens =
conservativeMaxCost(requestLimits, pricingSnapshot)` — request limits ×
the maximum applicable snapshotted tier rates — persists with the intent,
receipt-enabled execution is REJECTED when no finite upper bound exists,
and the invariants assert in order (round-27: actualAmount is unknowable
pre-response): (1) BEFORE the provider call —
`pendingAmount === authorizedMaxUsertokens`, STRICT equality, no
oversized-hold exception (round-30: one conformance rule, not three); (2) AFTER usage and
actualAmount are durably recorded — the FULL chain
`actualAmount ≤ authorizedMaxUsertokens ≤ pendingAmount` (round-28: the
two separate checks allowed actual > authorizedMax under a fat hold),
with an actual above authorizedMax entering the integrity-incident path
BEFORE any POST submission; (3) only then POST_SUBMITTING with
`immutablePostCommand.amount === actualAmount` — settlement can never
diverge from the durably recorded usage. TigerBeetle
cannot POST above the immutable pending amount, so a provider response
exceeding the bound is an integrity incident, never a normal VOID — without the ceiling, over-hold usage
leaves an intent that can neither POST nor VOID, reconciling forever. All of it flows through SurrealDB, the
audit record, and DLQ replay. Order: pricing-snapshot ledger migration → mint
endpoint → resolver API → verify page → the swap.


spec+IDs (usertrust) → **mint endpoint (stealth)** → **this API (stealth)** →
verify page (usertrust) → the swap (stealth). The swap is additionally gated
on this API being live in prod: a trailer that 404s is worse than
`Co-Authored-By`. Publication is two-stage (round-9 F1 — "no receipt, no
push" deadlocks against observed membership, since a webhook cannot see an
unpushed commit): the BRANCH push is the quarantine stage — the commit
becomes provider-observable there, membership verifies against the branch
ref, the receipt mints and anchors — and the fail-closed gate is
PROMOTION: no receipt, no merge to the destination branch. A failed mint
leaves an unmerged branch whose trailer never reaches master; cleanup is
amend-or-abandon on the branch, never a trailer on the mainline that
cannot resolve.
