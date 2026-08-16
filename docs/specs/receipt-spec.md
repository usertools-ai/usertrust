# Receipt Spec + ID Format — DRAFT v0.6 (usertrust drafts, stealth reviews)

Status: **DRAFT v0.6 (post fresh-eyes round) — the stealth v0.3 review's
rulings applied to the v0.5 text (the handoff's "v0.4 actions", executed
post-v0.5), then the 2026-08-10 fresh-eyes review's rulings (6 Blocking /
12 Important / 12 Minor), then **Codex round-4's REVISE rulings (7 P1 /
7 P2 / 4 P3)** — sealed segments, vault+profile in the signed checkpoint,
the `work`-mirror equality, `posted === assessed`, the hash-pinned
companion adoption, the per-kind transplant rule, and a representable key
rotation model — all applied in place at the interface owner's direction;
version deliberately held at v0.6. B1 RESOLVED by Cam's
ratification (2026-08-10): ut1 binds to the PROXY's formats — this REVERSES
v0.5's §4a headline (ut-chain profile), which was flagged for exactly this
veto. B2 resolved by adopting the resolver spec's reserve→finalize lifecycle
as normative (§6), which retires §6a's mint-first ID derivation and demotes
§3 to a registry rule. H1 (EC2 custody), H2 (breakdown in the unsigned
envelope), and the §9-A confirmations are folded. Codex round-4 runs on this
text; the resolver spec (#811) updates AFTER this lands so it churns once.**

**ERRATA (2026-08-11, transcription-surfaced, editorial only — no semantic
movement, no verdict round):** §10.15's binding path corrected to
`terminalEvent.event.hash`; §10.14's anchored trigger phrased as jointly
cumulative; §10.1's binding-qualifier list completed with the
`billedUnfinalized` exception. Surfaced by the resolver transcription gate
(stealth PR #823), which adopted the correct readings from §4/§7.

**v0.9.1 (2026-08-12): §13 CORRECTED — do not build against v0.8/v0.9's §13.**
A 79-case differential across all three real implementations proved the
appendix wrong in three ways: it named only `packages/verify` as
non-conformant when **`packages/core` is code-identical and is the SDK
MINTER**; it argued the divergences announce themselves when the worst ones
(`[undefined]` → `[]`, `{a:[undefined]}` → `{"a":[]}`) are **valid JSON that
parses clean** with a different digest; and it named the proxy normative when
the proxy shares two defects of its own (sparse arrays, function values), so
v0.8's clause 4 actually MANDATED one of them. §13 now defines the ALGORITHM as
the normative artifact with a per-implementation conformance table, pins error
identity for invalid `Date`, notes the `Object.hasOwn` "guard" is a no-op,
lists the three existing tests that PIN the bug, and records the downstream
consequence: `chain.ts` persists canonical bytes as the audit line, so a hole
or function in `event.data` writes an unparseable line that the reader silently
skips — the event is accepted, fsync'd, reported durable, then vanishes, and
the chain reports TAMPERED forever, indistinguishable from real tampering.
**Scope consequence: correcting canonicalization is its own change across core
+ verify (+ a proxy fix stealth owns), not a task inside the CLI ship.**

**v0.9 (2026-08-12): `delegationPosture` RULED and normative (§2a, §7); §14
naming boundary.** The delegated-work gap is closed by a REQUIRED
chain-committed posture on the §2 projection rather than by page copy, because
the offline verifier has no page. Four values (not two — two conflate distinct
coverage states and cannot express partial rollout); **v1 conformant minting
emits ONLY `selfDebitsOnly`**, the rest being verifier vocabulary; and
`includesAllDelegated` additionally requires SIGNED evidence an offline
verifier can validate — the posture is a claim, not a label. Parent-stamping
(billing separated from attribution) is ledgered as the milestone that unlocks
it, additively. §14 freezes the `kind` casing boundary: `event.kind` is the
CHAIN's snake_case vocabulary, every ut1-document discriminator is camelCase or
bare — verified across the corpus with zero exceptions, so it is a namespace
rule, not drift.

**v0.8 (2026-08-12): §13 normative canonicalization appendix + two recorded
rulings; no verdict round.** (1) §13 closes §11's open canonicalization
ship-gate item: the PROXY's `canonical.ts` frozen as the normative algorithm,
UTF-16 code-unit key order pinned, a 13-row golden-vector corpus, and a KNOWN
NON-CONFORMANCE in `packages/verify/src/canonical.ts` recorded (it renders
`[1, undefined, 2]` as `[1,,2]` — not valid JSON — where normative is
`[1,null,2]`; both verified by executing the real modules). Correcting the
verify copy ships with the `usertrust-verify receipt` CLI, its first ut1
consumer. (2) §8 records Cam's `genesisChoice: "newVault"` ruling with its
evidence. **RESOLVED in v0.9 (see below).** Delegated-work posture — since a2a
delegation holds are always-released (stealth #829), delegated cost debits the
DELEGATE, so a parent session's receipt EXCLUDES it. Cam ruled "the page states
it" for now; the offline verifier has no page, so unless the posture is
chain-committed the CLI prints an understated total with no caveat available to
it. Proposed minimal fix pending ratification: a REQUIRED `delegationPosture:
"selfOnly" | "includesDelegated"` on the §2 projection.

**v0.7 (2026-08-11): one vocabulary defect correction + the sanctioned
re-pin; no verdict round.** (1) §7's closed failure-code vocabulary gains
**`PREDECESSOR_MISMATCH`**, legal only on the named `predecessorLinkage`
check — the union previously assigned codes to steps 1–9 and to the two
extension checks but none to `predecessorLinkage`, so a
generation-predecessor contradiction (which §9-A.c answers 409) could not
be schema-validly reported anywhere a `failed` result requires a code.
Surfaced by the PR #823 transcription gate (round 2), same mechanical
class as the errata above; the gate independently corroborated the
verify-page v0.4 registryBinding rule in the same round. (2) §6a's pinned
companion adoption is RE-PINNED after applying the three deferred in-pin
corrections recorded in the resolver doc's "Deferred: pinned-section
collisions" section (§10.13 anchor-clock paragraph retired; §10.16
billing-identities sentence retired; the two stale in-pin `claimsHash`
mentions removed) — new digest in §6a. No hold-ceiling/§6a lifecycle
invariant moves.

**§4a HEADLINE (B1 RATIFIED — proxy profile):** receipts prove against the
**proxy profile** — the stealth proxy's real envelope, per-segment Merkle
trees, and a VERSIONED, fully-signed checkpoint that extends
`PublishedMerkleRoot`. Chosen over v0.5's ut-chain profile because it is the
smaller change that ships sooner: the proxy's leaf/interior/odd-promotion and
event-hash rules already match the SDK verbatim, so the delta is envelope
shape, segment-relative indexing, and the checkpoint statement — NOT a
production audit-layer migration carried as a rider on the mint feature
(stealth's recommendation; Cam ratified). The ut-chain convergence (v0.5's
choice) is LEDGERED as a deliberate future project, not abandoned. Trade-off
recorded (§11 ship gate): the zero-dep verifier gains a second profile
(`profile: "proxy-v1"`) instead of validating proxy receipts unchanged — the
cost B1-(1) accepts for not blocking mint on a chain migration.
Interface owner: usertrust (`packages/core` + `packages/verify`). Consumers:
the stealth proxy mint endpoint (`apps/api`), the resolver API
(`docs/specs/receipt-resolver-api.md`, this repo's copy — the normative
companion, pinned by §6a; stealth owns the interface), the public
verify page at `usertrust.ai/r/<id>`, and the commit-trailer convention.
Conflicts resolve in THIS document's favor. Companion updates required: §10.

**v1 scope decision (R2-7):** only the **proxy mints** in v1. SDK receipts
(`TrustReceipt`) remain local artifacts with `receiptUrl: null`; SDK-side
minting needs a key-custody design a distributed npm package cannot satisfy
(it must never embed the trust domain's mint key) and is deferred to `ut2`.
Everything below binds the proxy path; the projection is designed so SDK
minting can adopt it unchanged later.

## 1. What a receipt is

A **receipt** is a signed attestation that governed work happened, was
**settled** (billed), and what it cost. Its authority comes from the chain,
not the signature: every ledger-derived claim IS the canonical payload of one
chain event (the *mint event*, §4), proven included under a signed
checkpoint, optionally with independent anchor evidence. The mint signature
adds *who minted*; it never protects the numbers by itself.

**Mintability.** A receipt may be minted only for a **reconciled, POSTed
transfer set**: every constituent LOGICAL transfer — the
`{authorizationTransferId, settlementTransferId}` pair of §6a's adopted
model — exists in TigerBeetle in POSTed
state (PENDING/VOIDed/failed excluded), reconciliation across
TB/Surreal/audit has drained (companion's "verified means BILLED"), and a
real ledger post occurred — dryRun, engine-less, and merely
boolean-`settled` paths are **not mintable**. The audit-first `llm_call`
event is unchanged and is NOT the mint event — it predates settlement
(R1-F2).

## 2. The projection (the mint event's payload)

The **projection** is the value of the mint event's `data` field. Every
field is chain-committed and Merkle-provable (R1-F1/F3). The block below
ENUMERATES what v0.6 commits — including the fields §6a/§6 introduced
(`work`, `sessionAssociation`, `workloadId`, `prevGenerationEventHash`) —
because the
strict schema stays: any unknown field anywhere in a `ut1` document is FAIL,
so what is not enumerated here cannot be sent.

```jsonc
{
  "spec": "ut1",
  "scope": "session",            // "call" reserved for ut2 SDK minting
  "sessionId": "…",              // stealth-defined (§9-A.c)
  "generation": 1,               // integer ≥ 1 — generation 1 attests the COMPLETE
                                 // session; >1 exists only as explicit addenda
                                 // (§6, R3-5) carrying prevGenerationEventHash;
                                 // a (sessionId, generation) pair mints at most once.
                                 //
                                 // ADDENDA (generation > 1) additionally carry
                                 // "prevGenerationEventHash" — the previous generation's
                                 // mint event.hash, lowercase hex. It is key-ABSENT
                                 // (never null) at generation 1, as in this example;
                                 // present at generation 1, or absent above it, is FAIL
  "work": {                      // CHAIN-COMMITTED and VERIFIED (§6a, B2) — the
                                 // resolver's discriminated union. COMMIT variant
                                 // inline; pr / issue / session variants by reference
                                 // (enumerated under the block)
    "kind": "commit",
    "repoId": "github.com:R_kgDOK1x2Yw",  // NORMATIVE scope: the provider's IMMUTABLE
                                 // repository ID, or the keyed "r1_…" form for
                                 // undisclosed private repos (resolver Q1)
    "repo": "github.com/org/repo",        // OPTIONAL display-at-mint metadata — names
                                 // are mutable and reusable, so a name is never scope.
                                 // ABSENT unless disclosure is authorized (public
                                 // provider-verified visibility, or an operator-
                                 // authorized disclosure) — public-safety rules below
    "oid": "37df16d3…",          // FULL git object ID — a display may truncate, the
                                 // projection never does
    "oidAlg": "sha1",            // sha1 | sha256 — the bound repository's object format
    "objectSha256": "…",         // lowercaseHex(SHA-256(gitPreimage)) over the
                                 // PROVIDER-FETCHED object, where gitPreimage =
                                 // ASCII("commit " + byteLength(content)) || 0x00
                                 // || content — one representation everywhere
    "repositoryMembership": { "status": "providerVerified", "proofId": "…" }
                                 // REQUIRED on every artifact variant; v1 FAILS CLOSED
                                 // — "unverified" is not a ut1 value (§6a)
  },
  "sessionAssociation": "workflowAttested",  // | "ownerAsserted" — REQUIRED on every
                                 // ut1 projection; a posture, never an inference (§6a)
  "workloadId": "…",             // The SERVER-ASSIGNED attested workload identity (§6a's
                                 // workload model — the orchestrator binds it, never the
                                 // caller). Present IFF sessionAssociation ===
                                 // "workflowAttested"; key-ABSENT (never null) for
                                 // "ownerAsserted". Present-without-attested and
                                 // attested-without-present are BOTH FAIL
  "models": ["…"],               // sorted unique, ASCII-lexicographic; entries are
                                 // PUBLISHED-CATALOG identifiers, or the single fixed
                                 // literal "custom" for any non-catalog/custom-rate
                                 // model (deduped) — public-safety rules below
  "providers": ["…"],            // sorted unique, ASCII-lexicographic; catalog
                                 // identifiers on the same rule
  "startedAt": "…",              // RFC 3339 UTC "Z", ms — chain timestamp of the
  "endedAt": "…",                //   first/last constituent event (clock CLAIMS, §8)
  "spend": {
    "assessedUsertokens": 48224, // integer 0 < n ≤ 2^53-1 — the metered-or-estimated
                                 // assessed cost, summed with the ledger's PER-TRANSFER
                                 // rounding (usagePosture says metered or estimated)
    "postedUsertokens": 48224,   // ledger-POSTed total over the POSTed pairs. In ut1
                                 // this MUST EQUAL assessedUsertokens (P1-4) — the
                                 // adopted lifecycle posts actualAmount under a ceiling,
                                 // so a shortfall cannot occur in conformant minting
    "roundingAdjustment": 14,    // integer, 0 ≤ n ≤ transferCount — adopted from the
                                 // resolver (§10.5); chain-committed here because ut1
                                 // has no claimsHash
    "transferCount": 22,         // integer ≥ 1 — POSTed LOGICAL PAIRS only
                                 // (empty sessions unmintable)
    "usagePosture": "provider" | "mixed" | "estimated",
                                 // R3-10: "provider" = EVERY constituent priced
                                 // from provider-reported usage; "estimated" =
                                 // EVERY constituent used the estimate path;
                                 // "mixed" = both kinds present. (Estimates are
                                 // NOT a guaranteed upper bound — R2-5 — and the
                                 // page must say so for estimated/mixed.)
    "pricingPosture": "exact" | "conservative"   // rate-side posture (companion)
  },
  "delegationPosture": "selfDebitsOnly",   // REQUIRED (v0.9). WHAT THE AMOUNT COVERS with
                                 // respect to DELEGATED work. Since a2a delegation holds are
                                 // always-released (stealth #829), delegated cost debits the
                                 // DELEGATE — so a parent session's amount excludes it unless
                                 // stated. Four values, defined in §2a; v1 conformant minting
                                 // may emit ONLY "selfDebitsOnly" (§2a's minting rule)
  "pricing": { "tableVersions": ["…"] },  // sorted unique — sessions may span versions
  "transferSet": [               // ≤ 32 pairs: the full list in chain order;
                                 // > 32 pairs: ABSENT
    { "authorizationTransferId": "…", "settlementTransferId": "…" }
  ],
  "transferSetRoot": "…"         // ALWAYS: sha256( utf8("usertrust/receipt-transfers/v1\n")
                                 //   || canonicalize(fullOrderedPairList) ), lowercase hex.
                                 // It commits the PAIRS, not bare IDs (resolver's
                                 // round-33 F1 model). When transferSet is absent this is
                                 // a COMMITMENT — checkable against disclosed data, not
                                 // recomputable from the receipt alone
}
```

- **The `work` union's other variants** (normative, per §6a and the
  resolver's discriminated union — every variant carries `repoId` as the
  NORMATIVE scope, and `repo` only under the disclosure rule below):
  - `pr` / `issue`: `{ kind, repoId, repo?, number, providerArtifactId,
    observedRevision, contentBinding } & { repositoryMembership }`, where
    `contentBinding` is the resolver's EXACTLY-ONE union
    (`{ kind: "publicSha256", sha256 }` for provider-public artifacts,
    `{ kind: "privateHmacSha256V1", commitment: "c1_…" }` — REQUIRED for
    every provider-private artifact; both-or-neither is FAIL, and the
    server selects the variant from PROVIDER-VERIFIED visibility, never
    caller input). `canonicalContent`'s exact byte representation is owned
    and versioned by THIS spec (resolver round-28) and is NOT yet written —
    a ship gate for pr/issue minting (§11); v1's commit path does not
    depend on it.
  - `session` (ordinary): `{ kind: "session", repoId, repo? }` — `origin`
    is PROHIBITED; it claims NO artifact membership, and
    `repositoryMembership` is exempt (there is no artifact to observe).
  - `session` (FALLBACK, the resolver's forced `billedUnfinalized` path):
    `{ kind: "session", repoId, repo?, origin: { kind: "billedUnfinalized",
    sourceReservationReceiptId } }` — `origin` is REQUIRED on this variant
    (resolver round-19: an optional `origin` lets a fallback conform without
    its source link, defeating the bidirectional check). The two `session`
    variants MUST NOT overlap: `origin` present ⇒ fallback, absent ⇒
    ordinary.
- `amountUsd` is never stored: derived for display as
  `assessedUsertokens / 10000` by **integer quotient/remainder** (no float),
  rendered with exactly four decimals (`"4.8224"`). It derives from
  *assessed* so `usagePosture: "provider"` receipts can honestly claim
  "never understates"; estimated-posture receipts carry the caveat on the
  wire instead of hiding it (R2-5).
- **Spend arithmetic — and WHERE each part is enforced.** The ledger charges
  `max(1, ceil(cᵢ))` PER POSTED TRANSFER and ceiling is not distributive
  over the aggregate, so the per-transfer sum can only be ≥ the
  aggregate-ceiling figure. Writing `A = ceil(Σ tokens × ratePer1k / 1000)`
  for that aggregate figure:
  - `postedUsertokens === A + roundingAdjustment` is the **RESOLVER's
    display-grade recomputation** over its UNSIGNED breakdown rows (its
    "Amount fidelity" equation, ~lines 486-493; worked example in its
    `spend.amountUsd` comment, ~lines 176-178). It is an ONLINE check
    against material that lives outside the receipt, and it is **never a
    verifier verdict** — the narrowed H2 claim (below) is exactly this: the
    rows are display data, so the equation they feed is display-grade too.
    A `packages/verify` run neither has the rows nor needs them (R2-6: no
    verification step may depend on material outside the receipt).
  - `0 ≤ roundingAdjustment ≤ transferCount` IS offline-enforced (semantic
    validation, below) — the algebraic bound
    `Σ max(1, ceil(cᵢ)) − ceil(Σ cᵢ) ≤ N`. Its chain-committed purpose is
    **bounded honesty, not offline recomputability**: the commitment fixes,
    at mint time, that per-transfer rounding added at most ONE usertoken per
    transfer, so omitted usage cannot hide behind an arbitrarily large
    "rounding" term. It is non-negative because per-transfer minimum
    charging can only round UP.
  - Consequently `postedUsertokens ≥ A` wherever `A` is computable at all.
    The v0.5 phrasing "posted ≤ assessed" must NEVER be read against the
    aggregate-ceiling figure — posted legitimately EXCEEDS it (worked
    example: raw products 48209.01 → `A` = 48210, + adjustment 14 = 48224
    posted).
  - **`postedUsertokens === assessedUsertokens` in ut1 (round-4 P1-4, and
    the whole relation is offline-enforced).** `assessedUsertokens` is the
    PER-TRANSFER assessed sum under the same `max(1, ceil(·))` rounding, and
    the adopted lifecycle (§6a) makes them identical by construction: every
    POST carries `amount === actualAmount`, itself bounded by
    `actualAmount ≤ authorizedMaxUsertokens ≤ pendingAmount`, and an actual
    above the authorized ceiling is an integrity incident rather than a
    capped post. So a conformant ut1 receipt cannot exhibit a settlement
    shortfall, and the v0.5 `<` branch is REMOVED from ut1 semantics — it
    admitted receipts (assessed 100, posted 50) for which the recompute
    equation would need `roundingAdjustment = −50`, which the bound
    forbids. The full chain is therefore
    `A + roundingAdjustment === postedUsertokens === assessedUsertokens`.
    Settlement shortfall remains a coherent idea for a future SDK/`ut2`
    path with a different settlement model; it is that path's problem to
    define, and `ut1` verifiers reject `posted ≠ assessed` outright.
- **Spend breakdown (H2, settled v0.6):** the signed projection commits
  TOTALS + `roundingAdjustment` + `pricing.tableVersions` only — this
  spec's model, accepted by stealth. Per-provider/model/tier breakdown rows
  are DISPLAY data in the resolver's **unsigned envelope**, under its
  `display` member (§10.1), explicitly labeled not-chain-committed (the
  same honesty mechanism as `anchorEvidence`); the resolver's recompute
  claim narrows to §7 step 8's. Stated honestly rather than left implied:
  **the breakdown's former `claimsHash` commitment is deliberately
  DROPPED** — ut1 has no `claimsHash`, so the resolver's reliance on it
  (its `roundingAdjustment` note, ~line 291: "committed inside claimsHash,
  so it cannot be tuned post-hoc") is superseded. What replaces it is
  narrower and stronger where it counts: `roundingAdjustment` and the
  totals are chain-committed in this projection, while the rows themselves
  carry no cryptographic commitment at all and must not be rendered as if
  they did. Vocabulary alignment (resolver
  Q6): the SDK's `receipt.pricing` (`appliedRates`, `tableVersion` — cache-
  tier work, v3.3.0) and this projection's `pricing.tableVersions` /
  `pricingPosture` share one vocabulary; if SDK receipts ever resolve under
  `/r/`, they adopt this projection's field names unchanged.
- Semantic validation (verifier-enforced — this list is EXHAUSTIVE for §7
  step 7; every constraint here is decidable from the receipt alone):
  - `models`/`providers`/`pricing.tableVersions` sorted-unique,
    ASCII-lexicographic.
  - **`transferSet` presence is a RULE, not an option:** present iff
    `transferCount ≤ 32`, ABSENT iff `transferCount > 32` (a ≤32 receipt
    that omits it, or a >32 receipt that includes it, is FAIL);
    `transferSet.length === transferCount` when present; every member an
    object with exactly the two keys, each a canonically-encoded transfer
    ID (lowercase-hex 128-bit TigerBeetle ID, fixed length, no `0x`); no
    transfer ID repeats anywhere in the list, in either position, and no
    pair repeats; the list is in CHAIN ORDER as committed — a verifier
    cannot independently establish that order, so what it enforces is that
    `transferSetRoot` is the digest of the list AS GIVEN (§7 step 8), which
    makes the order itself chain-committed.
  - `transferSetRoot` exactly 64 lowercase hex characters;
    `prevGenerationEventHash`, when present, exactly 64 lowercase hex.
  - `0 < postedUsertokens === assessedUsertokens` (P1-4 — the shortfall
    branch does not exist in ut1) and
    `0 ≤ roundingAdjustment ≤ transferCount`.
  - Presence/exclusion: `prevGenerationEventHash` present iff
    `generation > 1`; `workloadId` present iff `sessionAssociation ===
    "workflowAttested"`; `work` matching exactly one union variant (with
    `origin` present iff the fallback session variant);
    `sessionAssociation` present; scope-forbidden fields absent.
  - **Postures are ATTESTED ENUMS, not verifier-established facts.** The
    verifier checks that `usagePosture` ∈ {provider, mixed, estimated} and
    `pricingPosture` ∈ {exact, conservative}, and that consumers render
    them (§6a's distinct-rendering rule) — it CANNOT confirm them, because
    both are defined over per-constituent facts the projection deliberately
    does not carry. "Posture consistency" in step 7 means enum validity and
    internal agreement (e.g. `usagePosture: "provider"` on a receipt whose
    own fields contradict it), never re-derivation. Anything stronger would
    require committing per-constituent counts — a deliberate non-goal for
    v1 (the projection stays small; §2's H2 model).
  - **Public-safety syntax** (the decidable half of §2's rules below):
    `proofId` and `workloadId` match `[A-Za-z0-9._-]{1,128}`; `repo`, when
    present, is ≤ 256 characters in canonical provider-URL form. Catalog
    MEMBERSHIP of `models[]`/`providers[]` is not decidable from the
    receipt alone — a verifier holding the published pricing catalog checks
    it, and everyone else checks only that entries are well-formed and that
    `"custom"` appears at most once.
  - Strict schema — any unknown field anywhere in a `ut1` document is FAIL.
- The mint event's `actor` field (part of the chain envelope, §4) MUST be
  one of the §4a closed-union values, and for `ut1` it is **exactly the §4a
  system OBJECT** — never a user/tenant identifier (no-PII rule extends to
  the embedded envelope). The string form `"receipt-minter"` belongs to the
  future ut-chain profile and is not emitted by ut1; the closed union
  (R3-1) is defined once in §4a, which is authoritative.

`work` is **CHAIN-COMMITTED inside the projection** (v0.6, B2 — the v0.5
minter-asserted carve-out is removed): at finalize the proxy appends the
VERIFIED `work` variant per §6a, plus `sessionAssociation`. Private repos
use the keyed `repoId` form (resolver Q1 resolution). The §5 body's `work`
is a REQUIRED equality-checked mirror, not an independent assertion
(equality 9).
**Never present anywhere:** prompt content, tool arguments, file paths, PII.

**Operationalizing that rule (round-4 P2-5 — "no PII" is not enforceable as
a slogan).** A receipt is a PUBLIC document, so every string in it needs a
presence rule or a syntax rule, not an intention:

- `work.repo` (the human-readable name) is **ABSENT unless disclosure is
  authorized**: it may appear only when the bound repository's
  provider-verified visibility is PUBLIC, or when an operator-authorized
  disclosure exists for a private repository (recorded mint-side). It is
  never defaulted in. When present it is the CANONICAL PROVIDER URL FORM
  (`<providerHost>/<owner>/<name>`), **≤ 256 characters**, and nothing
  else — no local paths, no remote strings with credentials, no branch or
  worktree decoration. `repoId` — the immutable provider ID, or its keyed
  `r1_…` form for undisclosed private repos — carries scope in every case,
  so dropping the name loses nothing verifiable.
- `models[]` and `providers[]` entries MUST be **published-catalog
  identifiers** — the names in the pricing table's namespace (the same
  namespace `pricing.tableVersions` versions), which are public by
  construction. A session that used a model outside that catalog, or any
  custom-rate model, emits the single fixed literal **`"custom"`** in
  `models[]` (deduplicated, then sorted with the rest, so N custom models
  contribute exactly one entry). Operator- or tenant-chosen model names
  never reach the wire: an internal alias is exactly the kind of string
  that leaks a customer, a project, or an unreleased product.
- `repositoryMembership.proofId` and `workloadId` are **opaque
  server-generated identifiers** matching `[A-Za-z0-9._-]{1,128}`, and MUST
  NOT embed user data — no email, username, display name, branch or file
  path, ticket title, or host-internal path, and no structure a reader
  could decode into one. They are lookup handles for the operator, not
  descriptions.
- The same constraint binds anything the resolver puts in `display` (§10.1)
  and any operator diagnostic surfaced beside a receipt: unsigned does not
  mean unpublished.
- The checkpoint's `reference` field is REMOVED entirely (§4a) rather than
  constrained — publication evidence lives outside the signed statement.

### 2a. `delegationPosture` — what the amount covers (v0.9, RULED)

The problem this closes: a2a delegation holds are always-released (stealth
#829), so delegated cost debits the DELEGATE. A parent session's amount
therefore EXCLUDES work it caused — technically correct and universally
misread. Page copy alone cannot close it, because the OFFLINE verifier has no
page: absent a chain-committed posture, `usertrust-verify receipt` prints an
understated total with no caveat available to it. That is silent understatement
in the one artifact whose value rests on never understating, in exactly the path
we tell skeptics to trust instead of us.

**The four values** (the VERIFIER's vocabulary — see the minting rule below,
which is narrower):

| Value | Meaning |
|---|---|
| `selfDebitsOnly` | The amount is built ONLY from debits charged to the receipt subject. Delegated spend is out of scope, not missing. |
| `includesSomeDelegated` | Some causally attributable delegated debits are included; coverage is NOT established. |
| `includesAllDelegated` | EVERY causally attributable delegated debit, INCLUDING transitive descendants, exactly once. |
| `indeterminate` | The minter cannot establish which of the above applies. |

Two values were rejected as insufficient: they conflate "some delegated debits"
with "all direct children but no transitive descendants" with "all causally
attributable costs exactly once", and cannot express partial rollout or
uncertain coverage — and adding a value later is precisely the compatibility
break a frozen format exists to prevent.

**MINTING RULE (v1, ruled by the interface owner): conformant v1 minting emits
ONLY `selfDebitsOnly`.** The other three are **values a conformant v1 minter
never emits, and which a VERIFIER MUST recognize and render per §7** — widening
minter permission later is then an enum-value change rather than a schema break.

**CORRECTION (v0.9.2): "reject" was the wrong verb and it contradicted §7.**
Earlier text said the verifier "must name states it will reject". It must not
reject them: §7 prescribes rendering COPY for `includesSomeDelegated` and
`indeterminate`, and R39 mirrors it. Two verbs, two actors — **v1 MINTING
refuses to emit these; a VERIFIER handles them.** A verifier that rejected a
value it has normative copy for would be refusing to do what §7 tells it to do.
Concretely: a 200 carrying `includesSomeDelegated` satisfies §4.1's algebra,
`semantics` may legitimately be `passed`, and the consumer renders the caveat.
They therefore need CONFORMING fixtures, not rejection vectors.

- `includesSomeDelegated` is NOT mintable in v1. A receipt that knows it is
  incomplete but cannot say by how much understates by an unquantified amount,
  and the honest alternative is always available and cheaper: mint
  `selfDebitsOnly`, a true statement about a well-defined scope, instead of a
  partial claim about a vague one. Downgrading is strictly more honest than an
  unquantified partial.
- `indeterminate` is NOT mintable in v1, under the same fail-closed rule that
  makes `"unverified"` not a ut1 `repositoryMembership` value (§2): a minter
  that cannot establish what its own number covers must not mint.
- `includesAllDelegated` is not mintable in v1 either, and not merely because
  parent-stamping has not shipped: **the posture is a CLAIM THAT MUST BE
  VERIFIABLE, NOT A LABEL.** Setting the enum is insufficient — a conformant
  `includesAllDelegated` receipt MUST carry enough SIGNED evidence for an
  offline verifier to validate the claim (committed child receipt hashes,
  immutable debit/event identifiers, amounts, and delegation relationships,
  deduplicated by those identifiers, transitive descendants included). No such
  evidence format is specified yet, so the value is unreachable until one is.

**NO MIGRATION POPULATION EXISTS — and this window is closing (v0.9.2).**
There are no pre-v0.9 receipts anywhere: the mint endpoint is NOT STARTED, and
production has zero finalized segments because segment rotation has never run.
**No receipt has ever been minted in production.** So adding this REQUIRED
field breaks nothing, needs no carve-out for old shapes, and has no
compatibility story to design — the only artifacts carrying the pre-v0.9 shape
are test fixtures, which are re-minted rather than migrated.

State this plainly because it stops being true at a specific moment:
**pre-launch is a window in which projection changes are FREE, and it closes on
the first production mint.** Every REQUIRED-field change after that point needs
a migration, a carve-out, or a version bump. Any remaining projection change
under consideration should be made NOW; this is the cheapest it will ever be.

**Ledgered milestone — parent-stamping (deliberately NOT on the v1 critical
path).** The architecturally correct fix separates BILLING from ATTRIBUTION:
keep releasing the parent hold and keep charging the delegate, but ADD those
debits to the parent receipt as attributed NON-BILLING entries, with the signed
evidence above. That satisfies never-understates outright rather than warning
that the number is narrower. It is deferred because ut1-preview is already
12–18 days and this would extend it materially; when it lands it unlocks
`includesAllDelegated` as an enum value, additively.

(Adopted from an adversarial deliberation run by the orchestrator session
against gpt-5.6-sol, 2026-08-12, with "do nothing, the page is enough" live as
a verdict option: ADOPT WITH MODIFICATION, 9/10 — the diagnosis upheld, the
two-value shape rejected. The minting rule and the evidence requirement above
are the interface owner's.)

## 3. ID format and registry rule (v0.6 — reservation-issued, B2)

```
receiptId = "ut1_" + base58btc( random 16 bytes, mint-side namespace )
```

- Issued at RESERVATION time (§6) from the mint side's namespace —
  cryptographically random 16 bytes, raw base58btc (Bitcoin alphabet), no
  multibase; leading zero bytes encode as leading `1`s; result length
  **16–22** chars after `ut1_` (R2-small) — but the length is a
  consequence, never the test: an ID is valid only if it decodes to
  EXACTLY 16 bytes and re-encodes byte-identically (§12). The v0.5 derivation
  `f(event.hash)` is RETIRED: under reserve→finalize the trailer must cite
  the ID before the mint event exists, so derivation-from-event is
  impossible by construction. (Flagged honestly, per the review: this drops
  §3's derivation elegance; nothing security-relevant is lost because the
  integrity load was always carried by the registry equality below —
  R1-F8's own locator framing.)
- **The ID is CLAIMED atomically at reserve time** (round-4): allocation is
  an atomic insert-if-absent of the `receiptId` into the mint-side registry
  in the SAME durable write that creates the reservation — the ID exists,
  unresolvable-but-allocated, before it can be written into any trailer.
  A collision on that insert re-draws; it never returns an existing
  reservation. This is what makes 404-vs-410 meaningful (§10.8): an ID that
  was never claimed is `unknown`, and every claimed ID has a terminal
  answer forever.
- **Locator, not cryptographic identifier** (R1-F8, unchanged in force):
  registries/resolvers key on the full 256-bit `event.hash`; the registry
  binds `receiptId → event.hash` at finalize (§6); every read verifies
  route-ID = registry-bound-ID = body ID; collision of one `receiptId`
  against distinct events is a hard-fail (5xx + alert) — never overwrite,
  never idempotent-retry. §7 step 3 becomes the REGISTRY VERIFICATION rule:
  the verifier checks the document's `receiptId` matches the arrival
  URL/trailer and, when online, the registry's binding for it — offline
  verification proves everything else without the registry.

## 4. Mint event, proof, checkpoint — exact formats (R2-1)

### 4a. The proxy profile (v0.6 — B1 ratified: bind ut1 to proxy formats)

Every claim in this section is defined against ONE chain profile —
**`profile: "proxy-v1"`, the stealth proxy's real machinery**
(`apps/api/src/governance/audit/`) — which the minting chain implements
TODAY, modulo the checkpoint extension below:

- **Event-hash rule:** `hash = sha256(canonicalize(event − hash))` with
  key-absent (not undefined-valued) exclusion. (Identical on both sides —
  writer.ts:289-302 ≡ chain.ts; unchanged by B1.)
- **Proof shape + hashing:** `MerkleInclusionProof` verbatim; raw event hash
  in `leafHash`; leaf = `sha256(0x00 || hexDecode(hash))`; interior =
  `sha256(0x01 || left || right)`; odd nodes promote. (Identical on both
  sides — unchanged by B1.)
- **Tree scope: ONE TREE PER SEGMENT (proxy reality; merkle-types.ts:8).**
  `segmentId` is NORMATIVE and load-bearing; `leafIndex` is
  segment-relative. Equality 4 becomes
  `inclusion.leafIndex === event.sequence − checkpoint.segmentFirstSequence`
  (the checkpoint carries `segmentFirstSequence` for exactly this). The
  SDK's global tree is NOT this profile; ut-chain convergence is the
  ledgered future project (headline).
- **Checkpoint statement: `SegmentCheckpoint` v2** — a VERSIONED extension
  of the proxy's `PublishedMerkleRoot` whose canonical SIGNED payload is:
  `{ v: 2, vaultId, profile, root, treeSize, segmentId,
  segmentFirstSequence, previousSegmentRoot, previousSegmentId, keyId,
  publishedAt }`,
  `sig` = base64 Ed25519 over `canonicalize(unsigned)`. This closes BOTH
  pre-existing holes the stealth review named: the root-only signature
  (treeSize unauthenticated → leaf-hiding) and the unauthenticated lineage
  edge (`previousSegmentRoot` lived in `MerkleTreeState`, outside the signed
  payload — rewritable while every signature verified). **`vaultId` and
  `profile` are SIGNED (round-4 P1-2):** without them the statement says
  nothing about which chain it belongs to, so one checkpoint key trusted by
  two vaults would let the same event/proof/checkpoint be labeled as either
  chain, with `proof.chain`/`proof.profile` — receipt-signed only —
  unable to settle it. Equality 8 now reads those two fields out of the
  CHECKPOINT signature and the registry cross-check becomes a second
  fence, not the only one (belt: §8 also forbids one lineage serving two
  vaults). Genesis:
  `previousSegmentRoot`/`previousSegmentId` are the fixed strings
  `"genesis"` for the first segment; contiguity checks are normative in §7.
  `publishedTo` does not exist in the signed statement (publication is
  evidence, not proof — R3-8 unchanged), and neither does `reference` —
  v0.5 carried an anchor locator here, but publication evidence lives
  outside the signed statement entirely (§5's unsigned attachment), so the
  field is REMOVED rather than constrained (round-4 P2-5: removing beats
  constraining for a public-safety surface). v1 `PublishedMerkleRoot`
  objects never appear in receipts.
- **Segments are SEALED by their checkpoint — exactly ONE checkpoint per
  segment, ever (round-4 P1-1).** Issuing a `SegmentCheckpoint` for a
  `segmentId` SEALS that segment: the act FORCES segment rotation, so no
  event is ever appended to a sealed segment and no checkpoint is ever
  issued over a still-growing one. A second checkpoint bearing an
  already-checkpointed `segmentId` — even validly signed, even with a
  larger `treeSize` — is an integrity incident on the mint side and a hard
  FAIL on the verification side. Signing `treeSize` alone does NOT close
  this: it prevents altering one checkpoint, not SELECTING an earlier valid
  checkpoint over the same growing segment to hide later leaves, and a
  prefix checkpoint and the segment's final checkpoint could never both
  satisfy §7's history walk. Sealing makes "the checkpoint for segment S"
  a function, not a choice. Consequence for §6: the "wait for a checkpoint
  covering the mint event" arrow waits for that segment's SEAL.
- **Mint actor (closed union, R3-1 — proxy form selected):** the proxy
  envelope's `actor` is an OBJECT; the mint event's actor MUST be exactly
  `{ "type": "system", "id": "receipt-minter", "name": "receipt-minter" }`
  with NO extra fields. The string form exists in the union solely for a
  future ut-chain (ut2/SDK) profile; `chains[].mintActor` in the well-known
  doc (§8) selects the form, is immutable for the life of a vault, and can
  never introduce other values. Equality 2 checks canonical equality against
  the selected form (`canonicalize(event.actor)` — for the proxy form this
  means `actor.type === "system" && actor.id === "receipt-minter"` etc., as
  one canonical-bytes comparison, not field plucking). Strict
  duplicate-JSON-key rejection applies to receipts AND well-known documents.
- **Envelope equality is canonical, not lexical (R3-1):** "verbatim from the
  chain" means the embedded envelope canonicalizes to the same bytes as the
  persisted event's canonical form — implementations may persist with plain
  JSON.stringify; lexical byte identity of stored files is neither preserved
  nor required.
- **The profile is NAMED in the receipt (M-12):** the signed receipt carries
  `proof.profile: "proxy-v1"` (§5). The verifier SELECTS this section's
  equality set from that literal — it never infers the profile from the
  shapes it happens to see — and cross-checks it against the `profile` of
  the §8 `chains[]` entry registered for `proof.chain`; disagreement is
  FAIL (equality 8). A future ut-chain profile ships under a DIFFERENT
  literal, never by reinterpreting this one.
- **Inclusion-path topology validation is NORMATIVE (R3-3):** verifying an
  inclusion proof MUST derive the expected path length and each sibling's
  side from `(leafIndex, treeSize)` (odd-node promotions included) and reject
  any proof whose supplied siblings disagree — folding the siblings as given
  is non-conformant. (Status corrected round-4: **core already implements
  it** — `packages/core/src/audit/merkle.ts:193`, PR #86 — so only the
  STEALTH half remains open, `merkle-proofs.ts:84`, tracked as a required
  code fix there; without it, equality 4 is forgeable by altering
  `leafIndex`.)

The receipt embeds the chain's **real** event envelope — **field-complete,
and canonical bytes equal** to the persisted event (the canonical-not-
lexical rule above; "byte-exact as persisted" was the v0.5 wording and
contradicted it) (proxy profile: the audit writer's envelope
`{ id, timestamp, previousHash, kind, actor, data, sequence, hash }`, with
`actor` the §4a system OBJECT):

```jsonc
"event": { "id": "…", "timestamp": "…", "previousHash": "…",
           "kind": "receipt_settled",
           "actor": { "type": "system", "id": "receipt-minter", "name": "receipt-minter" },
           "data": { /* §2 projection */ }, "sequence": 8123421, "hash": "…" }
```

- `event.hash = sha256(canonicalize(event − hash))` — the standard chain
  rule; the verifier recomputes it from the embedded envelope.
- Inclusion proof: `MerkleInclusionProof` verbatim (shape shared by both
  stacks): `{ version: 1, leafHash, leafIndex, treeSize, root,
  siblings: [{hash, position}], segmentId }`.
  **`leafHash` carries the RAW event hash** (hex); verification computes
  `sha256( 0x00 || hexDecode(leafHash) )` for the leaf and
  `sha256( 0x01 || left || right )` over decoded bytes for interior nodes,
  odd nodes promoting (R2-1 double-hash fix). The tree is **per segment**
  (§4a): `segmentId` MUST equal `checkpoint.segmentId`, `leafIndex` is
  segment-relative, and `treeSize` is the SEGMENT's leaf count.
  (To-confirm during mint work, carried from the review: whether the
  proxy's STORED leafHash is the raw event hash or the already-prefixed
  leaf — merkle-tree.ts decides; the wire rule above is normative either
  way and the mint worker adapts.)
- Checkpoint: `SegmentCheckpoint` v2, §4a — `{ v: 2, vaultId, profile, root,
  treeSize, segmentId, segmentFirstSequence, previousSegmentRoot,
  previousSegmentId, keyId, publishedAt, sig }`.
- **Required equalities** (verifier MUST enforce, R2-1 as revised by B1):
  1. `event.hash === proof.mintEventHash === inclusion.leafHash`
  2. `event.kind === "receipt_settled"`; `canonicalize(event.actor)` equals the
     canonical form of the chain's registered `mintActor` (§4a/§8)
  3. `event.data` canonicalizes byte-identically to the §2 projection the
     receipt claims (they are the same object — no duplicate copies)
  4. `inclusion.leafIndex === event.sequence − checkpoint.segmentFirstSequence`,
     and `0 ≤ leafIndex < checkpoint.treeSize`
  5. `inclusion.treeSize === checkpoint.treeSize`
  6. `inclusion.root === checkpoint.root`
  7. `receipt.scope/spec` agree with the projection; `minter.kind` agrees
     with the key's registered minter binding (§8)
  8. `inclusion.segmentId === checkpoint.segmentId`; **`checkpoint.vaultId
     === proof.chain` and `checkpoint.profile === proof.profile`** — read
     out of the CHECKPOINT's own signed payload (§4a), so the statement
     itself says which chain it belongs to; THEN the registry cross-check:
     that `vaultId` is registered, its `checkpointRootKeyId` lineage signed
     this checkpoint, and its registered `profile` matches (the literal
     `"proxy-v1"` for ut1 — §4a); `event.sequence ≥
     checkpoint.segmentFirstSequence` (redundant with eq 4; kept
     defensively)
  9. `canonicalize(receipt.work) === canonicalize(event.data.work)` — the
     §5 body's `work` is a MIRROR, and this is the equality that makes the
     word true. Without it a conflicting top-level `work` passes every
     other check and renders as chain-attested when only the mint signature
     covers it (round-4 P1-3). `receipt.work` is REQUIRED, so an absent
     mirror fails here rather than passing silently.

## 5. Receipt document (wire format)

```jsonc
{
  "spec": "ut1",
  "receiptId": "ut1_…",
  "scope": "session",
  "mintedAt": "…",                       // minter-asserted clock claim
  "minter": { "kind": "proxy", "keyId": "…", "trustDomain": "usertrust.ai" },
  "work": { "kind": "commit", "repoId": "…", "repo": "…",  // `repo` only under §2's
                                         //   disclosure rule
            "oid": "…", "oidAlg": "sha1", "objectSha256": "…",
            "repositoryMembership": { "status": "providerVerified", "proofId": "…" } },
                                         // REQUIRED. Exactly the §2/§6a VERIFIED shape —
                                         // no `ref`, no minter-asserted carve-out — and an
                                         // EQUALITY-CHECKED MIRROR of the projection's
                                         // `work` (canonically identical bytes), never an
                                         // independent assertion. Non-commit variants
                                         // take the §2 union's other shapes, mirrored
                                         // the same way
  "event": { /* §4 envelope, verbatim */ },
  "proof": {
    "profile": "proxy-v1",               // §4a — names the equality set the verifier
                                         // applies; cross-checked against §8
                                         // chains[].profile
    "chain": "…", "mintEventHash": "…",
    "inclusion": { /* §4 */ }, "checkpoint": { /* §4 */ }
  },
  "signature": { "alg": "ed25519", "keyId": "…", "sig": "base64…" }
}
```

- Signature preimage: `utf8("usertrust/receipt-signature/v1\n") ||
  canonicalize(receipt − signature)`. `signature.keyId === minter.keyId`;
  `alg` literal `"ed25519"`; `sig` exactly 64 bytes; RFC 8032 strict.
- **Anchor evidence is an UNSIGNED attachment, not a receipt field**
  (R2-3): the signed receipt is immutable, so evidence that arrives later
  (Rekor publication confirm) must live outside it. Resolver envelope:
  `{ apiVersion, status, receipt, anchorEvidence?, checkpointHistory?,
  display? }` (history field added R3-8; `display` per §10.1 — unsigned,
  explicitly not-chain-committed display data). Evidence formats are
  normative: **Rekor** = the repo's existing `RekorReceipt` shape (stored
  bytes + artifact hash + log inclusion proof + signed log checkpoint +
  pinned log key) — independently verifiable offline. **S3 Object Lock** =
  operator-asserted configuration probes (anchor-doctor output); it is
  labeled as such and can NEVER by itself reach `VERIFIED_ANCHORED`.
- Unknown fields in the signed receipt → FAIL. The unsigned envelope may
  grow (its `apiVersion` governs it).

## 6. Mint lifecycle — exactly-once (R2-4)

State machine; every arrow durable-before-advance; single-writer per vault
(a stated single-host deployment constraint for the writer, or a
distributed lock — §9-B.1; no such lock exists in the chain today), plus:

```
session OPEN
  → CLOSING: one atomic CAS flips the session to CLOSING and, in the same
     durable write, creates the recovery job. From this instant NO new
     transfer may be admitted to the session (admission check is against the
     CAS'd state). (R3-4: closing must precede enumeration, or in-flight
     admissions race the transfer-set freeze.)
  → enumerate the frozen set of admitted transfer intents
  → await terminal states: every admitted intent reaches a RECONCILED
     terminal — POSTed or VOIDed where a TigerBeetle transfer exists,
     REJECTED or ABORTED_NOT_SUBMITTED for pre-ledger intents (§6a, §9-A.c);
     reconciliation (§1 oracle) drains for the set. Only POSTed pairs enter
     the billable set
  → freeze the canonical projection bytes; mint intent: atomic
     insert-if-absent keyed (vaultId, sessionId, generation), carrying the
     frozen projection bytes + a fencing token
  → append receipt_settled — the fencing token is checked AT THE APPEND
     BOUNDARY (the appender proves current ownership at write time; an
     intent-CAS-then-append without an append-time fence lets a stale owner
     append later — R3-6). Recovery scan: search the chain for
     kind=receipt_settled matching (sessionId, generation); ZERO → append;
     ONE → adopt ONLY IF its data canonicalizes byte-identically to the
     intent's frozen projection AND its actor is the registered mintActor —
     any mismatch is a hard-fail integrity incident (R3-6); TWO → hard-fail.
  → record event.hash into the intent; bind the RESERVED receiptId (issued
     at reserve time, §3/§6a — the v0.5 derive-from-event step is retired)
     to event.hash in the intent
  → wait: the mint event's segment is SEALED — i.e. its one and only
     SegmentCheckpoint exists (§4a's sealed-segment rule: issuing the
     checkpoint forces rotation, so this wait is for the seal, and the
     checkpoint it yields can never be superseded for that segment).
     Covering means checkpoint.segmentId === proof segment and
     segmentFirstSequence ≤ event.sequence < segmentFirstSequence + treeSize
  → sign (the §5 body's work mirrors the projection's verified work, §6a —
     equality 9);
     persist signed bytes durably
  → registry write, FIRST-WRITE-WINS, three atomic mappings:
     (sessionId, generation) → event.hash;  event.hash → signed bytes;
     receiptId → event.hash
  → publish; session CLOSED
```

- **Generations are exceptional addenda, not routine (R3-5).** Under the
  closing CAS, a post-CLOSING transfer admission is an invariant violation —
  generation 1 attests the COMPLETE session cost. `generation+1` exists only
  as an explicit addendum flow for operator-acknowledged exceptions; an
  addendum's projection MUST carry `prevGenerationEventHash` (cumulative
  linkage), every POSTed logical transfer (its
  `{authorizationTransferId, settlementTransferId}` pair) is consumed by
  exactly one (sessionId, generation) across all generations
  (double-receipting is an integrity incident), and generation numbers are
  allocated atomically
  with the addendum's own CLOSING CAS.
- Re-mint requests return the original signed bytes, byte-identical.
- Deferred-mint durability: the proxy runs a durable mint worker (queue
  survives restart; takeover states explicit; startup FAILS CLOSED if the
  durable store is unavailable or non-durable — R3-6, §9-A.a).
- Fail-closed: no registry write → no receipt → no push.

### 6a. Reserve → finalize (v0.6 — B2 resolved; supersedes v0.5's mint-first order)

The resolver spec's "Mint lifecycle — normative constraints" section is
**adopted as normative for §6, by reference and in full** — reserve →
work → finalize, with every hardening it carries. The adoption is **PINNED
BY CONTENT HASH (round-4 P1-5)**: it binds that section as of
**`sha256:67e986a99da43e2414d830c56ff09881dd98881387d5ec60e47fabfec693f0df`**
— the COMPLETE digest of `docs/specs/receipt-resolver-api.md`, this
directory's copy: the v0.2 companion-updated resolver spec, adopted as the
normative companion 2026-08-16, whose pinned section carries the three
corrections the v0.7 re-pin took (anchor-clock paragraph retired per §10.13;
"separate billing identities" sentence retired per §10.16; the two stale
in-pin `claimsHash` mentions removed). The pin's chain, oldest first:
`sha256:4c293c35fd9473ba474ff967a2d215e8fa399a43aaa36cb395a9747ca81c04d1`
(v0.1, the round-35 draft) →
`sha256:6260043a360e61f2e138c3d2f7832b3b9d1718f188ea1f56f04c0e9b9f62e18e`
(the v0.7-corrected copy those three corrections produced) → the digest
above, which supersedes it
(verify with `shasum -a 256`; a truncated
prefix is not a pin) — and NOT whatever that file says later. Later companion rounds do
NOT adopt automatically; taking them requires an explicit version bump of
THIS document (v0.x) that re-reads the section and re-pins the hash. v0.6's
"later merged rounds adopt automatically" was unsafe and is retracted: the
pinned text still contains a description this spec must override — it gives
the 410 `billedUnfinalized` bundle as `{ status, receiptId, linkedReceiptId,
transferSetRoot, terminalEvent: { event, inclusion, publishedRoot } }`, bound
through `terminalEvent.event.payload.receiptId`, and §10.15 retires every one
of those terms (the ut1 projection carries no `receiptId`, and
`publishedRoot` is a v1 object that never appears in ut1 responses). The
companion says so itself, in a paragraph OUTSIDE the pin that explicitly
supersedes the pinned description — which is exactly the class of thing
automatic adoption would import silently, in the direction that matters: the
pinned bytes stay stale by design, and only a named re-read catches it.
The round-35 additions are adopted by name so the pin cannot be misread:
**PricedTier/UsageTier domains** (`PricedTier = input | output | cacheRead
| cacheWrite`; `UsageTier = PricedTier | "unknown"`, with `pricedAsTier`
and `candidateTiers` drawing from `PricedTier` ONLY — `"unknown"` legal
solely in `usageTier` on conservative fallback rows); the **logical-transfer
ID-PAIR model** (a logical transfer is `{authorizationTransferId,
settlementTransferId}` — TigerBeetle transfers are immutable, the
authorization keeps its pending flag forever and settlement is a SECOND
transfer whose `pending_id === authorizationTransferId`; §2's
`transferSetRoot` commits the PAIRS); and **POST-only billable-set
membership** (only POST pairs enter the billable set and count in
`transferCount`; VOID/REJECTED/ABORTED outcomes live in a SEPARATE
terminal-intent commitment, never the receipt set). The hardenings carried
in full:
provider-OBSERVED repository membership with byte-compare against the
fetched object and `objectSha256` over the canonical `gitPreimage`;
per-kind finalization (commit/pr/issue) and per-kind idempotent replay
digests; billing-principal exclusivity with automatic stamping and no
caller-chosen transfer sets; INTENT-before-TigerBeetle with the
SUBMITTING/claimed-submission CAS, pre-ledger terminals
(`REJECTED`/`ABORTED_NOT_SUBMITTED`), and provider-side durable claims
(`PROVIDER_SUBMITTING`/`USAGE_RECORDED`/`POST_SUBMITTING` with preallocated
settlement IDs and immutable persisted commands); `timeout = 0` on
receipt-bound PENDING transfers; the hold-as-ceiling invariant chain
(`pendingAmount === authorizedMaxUsertokens`, then
`actualAmount ≤ authorizedMaxUsertokens ≤ pendingAmount`, then
`POST amount === actualAmount`); authenticated-owner-only cancel/expiry
through the same admission lock; and finalize-replay idempotence keyed on
the canonical command digest. Where that section and this one overlap,
THIS spec defines the receipt/verification consequences and the resolver
section defines the mint-side machinery; the two are drafted to agree, and
a discovered disagreement resolves in this document's favor (headline rule).

Consequences fixed here:
- The trailer cites the RESERVED ID (§3); reservation → 202
  `{status: "reserved"}` with `Cache-Control: no-store` — never 404 (a
  cacheable negative could outlive publication; review R4-3). §10.8.
- `work` moves INSIDE the projection at finalize: the proxy appends the
  mint event with the verified
  `work: { kind, repoId, repo?, oid, oidAlg, objectSha256,
  repositoryMembership: { status: "providerVerified", proofId } }`
  (per-kind variants per the resolver's discriminated union) — CHAIN-
  COMMITTED like every other claim. The v0.5 "minter-asserted, visually
  distinct" carve-out for `work` is REMOVED (strictly stronger claim);
  `mintedAt` remains the only minter-asserted clock claim, and the §5
  receipt body's `work` field is now a REQUIRED mirror of the projection's
  (equality-checked, not independently asserted).
- `sessionAssociation: "workflowAttested" | "ownerAsserted"` joins the
  projection (review hardening 5): `workflowAttested` ONLY when a trusted
  execution workflow controlled the reservation, the model traffic, the
  workspace, and the artifact creation (the orchestrated minidev pipeline
  qualifies; a human hand-writing the trailer is `ownerAsserted`). The
  "workload identity is chain-committed" requirement is discharged by a
  NAMED projection field: **`workloadId`** (§2) — the SERVER-ASSIGNED
  attested workload identity from the resolver's workload model, bound by
  the orchestrator before any traffic, never caller-selected, and scoped to
  the provenance CLOSURE (one parent reservation per orchestrated pipeline)
  rather than the leaf job. It is present IFF
  `sessionAssociation === "workflowAttested"` and key-ABSENT otherwise;
  present-without-attested and attested-without-present are both FAIL, so
  the posture can never claim attestation without naming what was
  attested. Pages MUST render the
  postures distinctly — identical rendering is forbidden, on the same
  honesty principle that governs every posture field in this spec: distinct
  postures MUST render distinctly. (The stealth review stated this rule "the
  same as repository membership"; in ut1 that comparison no longer holds —
  membership is `providerVerified`-only and fail-closed, §2/§6a, so there
  are no two membership postures to render.)
- Generations interplay (review ruling adopted): a commit's trailer cites
  generation 1 forever; later addenda are advisory-surfaced by the resolver
  exactly like `receipt_superseded` — never a trailer rewrite.

## 7. Verification procedure and verdicts (offline)

Levels (renamed, R2-2 — names must not overclaim):

- **`VERIFIED_CHECKPOINT`** — the BASE steps 1–8 pass (step 3(b) may be
  not-applicable offline — n/a is not a failure and not a pass; it is
  reported). Step 9 holds only optional EXTENSION checks, which can upgrade
  this verdict but never demote it. Proves: the projection is an
  event included in a Merkle snapshot signed by the checkpoint key.
  **Explicit disclaimer carried in verifier output:** this level does NOT
  prove whole-chain linear consistency, anchor-sequence continuity, or
  external immutability — a checkpoint signer could sign a fork. Floor for
  a resolver 200.
- **`VERIFIED_CHECKPOINT_HISTORY`** (renamed from VERIFIED_CHAIN, R3-8; walk
  revised by B1) — additionally, the verifier was given a COMPLETE
  segment-checkpoint history (`SegmentCheckpoint[]` from the DECLARED
  GENESIS BOUNDARY — §9-B.1: the v2 history's root, which is either a
  verified backfill of all prior segments or a new `vaultId` whose genesis
  is the v2 cutover, and never silently more than was declared —
  to a head at/after the receipt's segment) and: the history's first
  checkpoint is the chain's REGISTERED genesis, i.e. its `segmentId` equals
  the `genesisSegmentId` of the §8 `chains[]` entry for `proof.chain` (a
  short history and an over-claimed one both fail here, and `genesisChoice`
  tells the reader which history they are being offered); every checkpoint's
  signature verifies under the §8 lineage; **exactly ONE checkpoint per
  `segmentId`** — a repeated `segmentId` anywhere in the history is a hard
  FAIL, not a "later revision", because §4a seals each segment with its
  single checkpoint (this is what makes prefix ROLLBACK detectable rather
  than merely unlikely), and `segmentId`s therefore appear once each, in
  strictly increasing `segmentFirstSequence` order; the
  **segment-lineage walk**
  passes — each checkpoint's `previousSegmentRoot`/`previousSegmentId`
  equal the prior checkpoint's `root`/`segmentId`, genesis values exact,
  no gaps, `segmentFirstSequence` strictly increasing and contiguous
  (`next.segmentFirstSequence === prev.segmentFirstSequence + prev.treeSize`);
  every checkpoint's `vaultId`/`profile` equal the receipt's `proof.chain`/
  `proof.profile` (they are signed now — §4a);
  and the receipt's embedded checkpoint appears EXACTLY in the supplied
  history. A partial history, or one accepted with warnings, NEVER earns
  this level. The lineage authenticates because v2 SIGNS the lineage edge
  (§4a — the review's own-gate High). What sealing removed is the
  INTRA-segment question: there are no "successive roots" for one segment
  to choose between, so prefix rollback is now a detectable duplicate
  rather than a plausible-looking alternative.
  **The surviving gap is EQUIVOCATION, and it should be named precisely.**
  Nothing above stops the holder of the checkpoint key from signing TWO
  different sealed-segment histories — each internally perfect, each
  passing every check in this list — and showing one to you and the other
  to someone else. (This is not a "Merkle-prefix consistency" gap; that
  notion does not even apply here, because per-segment trees are
  INDEPENDENT and no root is a prefix of another. Consistency proofs are
  the wrong tool.) Closing equivocation requires a NON-EQUIVOCATION
  mechanism — witness cosigning of checkpoints, or a public append-only
  checkpoint log every verifier can compare against — and that is a
  **named non-goal for v1**, ledgered as future work alongside the key
  document's own non-equivocation story (§8/§11). Rekor anchoring PARTIALLY
  mitigates it: publishing a checkpoint to a public transparency log makes
  one history externally visible, so a second private history has to
  contradict something the world can already see. That is precisely what
  `VERIFIED_ANCHORED` rewards, and precisely why this level's fork
  disclaimer REMAINS.
- **`VERIFIED_ANCHORED`** — additionally, independent anchor evidence
  (usertrust's `RekorReceipt` format, §5) validates offline against a pinned
  log key. S3 Object Lock evidence is operator-asserted configuration and
  upgrades NO cryptographic verdict (it may be displayed as context only).
- External publication by itself upgrades NOTHING (R3-8):
  `VERIFIED_CHECKPOINT` → `VERIFIED_CHECKPOINT_HISTORY` comes from SERVING
  the complete segment-checkpoint history; → `VERIFIED_ANCHORED` comes from
  Rekor evidence. There is no `publishedTo` field anywhere in the proof (it
  does not exist in `SegmentCheckpoint`).
- **Launch ceiling (R3-8):** until the proxy serves a complete bound
  history, its honest ceiling is `VERIFIED_CHECKPOINT` — served as a
  clean 200 with that status, never a 503 and never a partial-history
  history-level verdict.
- Failures are named per step; missing REQUIRED material (unparseable
  receipt, unresolvable keys, absent proof/checkpoint) → **`UNVERIFIABLE`**,
  never a pass. An online check that could not RUN is not missing required
  material — see the one rule below.

**Every check reports a structured result (round-4 P2-3), not a boolean.**
Each numbered step below emits one of
`passed | failed | notApplicable | unavailable`, and the verdict is a
function of those results, not of an exception being thrown somewhere:

- `failed` on a BASE check (steps 1–8) produces that step's named failure
  and no `VERIFIED_*` verdict.
- `notApplicable` means the check's input does not exist in this context
  and never could — step 3(b) offline is the canonical case. It is neither
  a pass nor a failure; it NARROWS the verdict and MUST be reported.
- `unavailable` means the input exists but could not be obtained right now.
  **One rule covers every online check (registry binding, predecessor
  linkage, optional history/anchor material):** the CHECK reports
  `unavailable`, the overall verdict is **the offline verdict**, and the
  check's status is reported alongside it. Unreachability of an online
  input never degrades a receipt that verifies offline, and never becomes a
  503 (§10.4).
- **`UNVERIFIABLE` is reserved for MISSING REQUIRED MATERIAL** — a receipt
  that will not parse, absent or unresolvable trust keys, a proof or
  checkpoint that is not there. It is never the answer to "an optional
  online check could not run".
- `failed` on an EXTENSION check **preserves the base verdict** and is
  reported alongside it. A tampered unsigned anchor attachment yields
  `VERIFIED_CHECKPOINT` + `anchorEvidence: failed`; it MUST NOT turn a
  cryptographically sound receipt red, because unsigned material is exactly
  the material an attacker can freely substitute. Consumers render the
  extension status distinctly and never as a green anchor claim.

**Named online checks** (each carrying the four-valued result above, each
reported by name in verifier output):

| Check | What it asserts | Offline |
|---|---|---|
| `registryBinding` (step 3(b)) | the registry binds this `receiptId` to THIS receipt's `event.hash` | `notApplicable` |
| `predecessorLinkage` (addenda only) | `prevGenerationEventHash` equals the registry's `event.hash` for `(sessionId, generation − 1)` (§9-A.c) — `notApplicable` at generation 1, since there is no predecessor to check | `notApplicable` |
| `checkpointHistory` (step 9) | the served history walks clean and contains this checkpoint | `notApplicable` unless supplied |
| `anchorEvidence` (step 9) | Rekor evidence validates against the pinned log key | `notApplicable` unless supplied |

The first two bind IDENTITY and LINEAGE and are `failed` only on a positive
contradiction (a binding to a different event; a predecessor hash that is
not generation−1's). The last two are extension checks. None of the four
can produce `UNVERIFIABLE`.

Failure codes for the named checks (the closed vocabulary below covers
them exactly): `registryBinding: failed` → `ID_MISMATCH` (it is step
3(b) — one code covers both halves of step 3); `predecessorLinkage:
failed` → **`PREDECESSOR_MISMATCH`** (v0.7 — legal ONLY on this check;
previously the vocabulary assigned no code here, making a
generation-predecessor contradiction unreportable wherever a `failed`
result requires a code); `checkpointHistory: failed` → `HISTORY_INVALID`;
`anchorEvidence: failed` → `ANCHOR_INVALID`.

Steps, given receipt + trust-domain key material (§8):

1. Strict schema + canonicalization validation.
2. Recompute `event.hash`; §4's equalities 1–9. → `EVENT_MISMATCH`
3. **Registry verification (§3's rule — there is NO recomputation).** The
   `receiptId` is random, issued at reservation (§3), so nothing about it
   can be recomputed from the receipt; the v0.5 derivation `f(event.hash)`
   is retired. What the verifier checks:
   (a) ALWAYS, and offline: the document's `receiptId` equals the ID it
   ARRIVED under — the resolution URL, or the commit/PR/issue trailer that
   pointed here (§12); a receipt read from a file with no arrival context
   has nothing to compare and this half is reported as not-applicable, not
   as a pass;
   (b) WHEN ONLINE — the named check `registryBinding`: the registry's
   binding for that ID resolves to THIS
   receipt's `event.hash` (`receiptId → event.hash`, written first-write-wins
   at finalize, §6). A binding to a different event, or a missing binding
   for an ID served as final, is `failed` — not a fallback to (a).
   Offline verification proves everything else in this list without the
   registry; it simply cannot make claim (b). No arrival context →
   (a) is `notApplicable`; registry unreachable → `registryBinding` is
   `unavailable`. Neither is a failure and neither blocks
   `VERIFIED_CHECKPOINT` — they NARROW what the verdict asserts, and the
   verifier's output MUST report which of (a)/(b) it actually checked.
   → `ID_MISMATCH`
4. Verify mint signature; key role `mint`, minter-kind binding, and a
   permitting key `state` (§8 — `revoked` verifies nothing).
   → `SIG_INVALID`
5. Verify inclusion path (leaf rule §4). → `PROOF_INVALID`
6. Verify the checkpoint: `checkpoint.v === 2` (a v1 `PublishedMerkleRoot`
   in a receipt is FAIL — §4a: v1 objects never appear in receipts, and its
   root-only signature leaves `treeSize` and the lineage edge
   unauthenticated), then the checkpoint signature under a key with role
   `checkpoint`, in a permitting `state`, and in the rotation lineage
   pinned by this chain's `checkpointRootKeyId` (§8) — and, when that key
   is `retired`, `checkpoint.segmentFirstSequence <
   key.activationSequence` (§8's offline retirement boundary; a retired key
   signing at or after its successor's activation FAILS here).
   → `CHECKPOINT_INVALID`
7. Semantic validation — exactly §2's enumerated semantic-validation
   constraints (presence/exclusion rules, `0 < posted === assessed`,
   `0 ≤ roundingAdjustment ≤ transferCount`, posture enum validity), all
   decidable from the receipt alone. The resolver's display-grade
   `A + roundingAdjustment` recomputation is NOT part of this step: it needs
   the unsigned breakdown rows (§2, H2). This step owns the OFFLINE half of
   generation linkage (`prevGenerationEventHash` present iff
   `generation > 1`); the online half is the named `predecessorLinkage`
   check above, reported separately. → `SEMANTIC_INVALID`
**REQUIRED verifier behavior for `delegationPosture` (v0.9, normative — this
is the half that closes the offline gap; §2a defines the values).** Every
consumer that renders an amount — the page, the offline CLI, any gate —
MUST apply these, and the offline verifier is the one that makes them load-
bearing, because it has no page to carry a caveat:

- **Missing, or an unrecognized value ⇒ NOT an ordinary successful verdict.**
  The field is REQUIRED, so absence is a step-7 `SEMANTIC_INVALID`; an
  unrecognized value is the same, which is also what makes this forward-safe —
  a v1 verifier meeting a value a later spec adds FAILS CLOSED rather than
  silently rendering a total whose coverage it cannot interpret.
- `selfDebitsOnly` ⇒ label the amount DIRECT / self-account spend, and state
  that delegated spend is out of scope. **(2026-08-15) Render the number
  unqualified, with that scope named beneath it** — not as a floor. See the
  bound clause below.
- `includesSomeDelegated` ⇒ label it an INCOMPLETE attributed subtotal.
- `indeterminate` ⇒ state that end-to-end coverage cannot be verified.
  Unknown coverage supports no bound in either direction.

**THE BOUND CLAUSE (amended 2026-08-15).** The v0.9.4 floor framing
(*"at least $X caused, exactly $X charged"*) was reviewed rendered and
**rejected.** A floor is a vague claim about an undefined quantity; the
unqualified number with its scope named beneath it is an exact claim about a
defined one. Honesty comes from naming the scope, not from hedging the figure.
Do not restore `"at least $"`.

The `indeterminate` rule is unchanged: unknown coverage supports **no bound
in either direction**. It is no longer an exception to a floor, because the
floor is gone. R39 copy carries that sentence.

The earlier argument that a `selfDebitsOnly` amount is a valid lower bound
on caused cost remains *true* and is *not how the page speaks*. Keep it out
of the rendered claim.

**The floor claim is CONDITIONAL, and the precondition is:** *the amount covers
a subset of costs actually caused by the subject, and everything omitted is
non-negative.* It does not hold uniformly.

| posture | floor | why |
|---|---|---|
| `selfDebitsOnly` | **valid** | caused-by-subject subset; omitted delegated spend non-negative; charged figure exact (`posted === assessed`) |
| `includesSomeDelegated` | valid **only** if every included constituent is provably caused by the subject; else degrade | unproven constituents break the subset premise |
| `indeterminate` | **INVALID — a new honesty defect** | **unknown coverage supports no bound in either direction**; the total may include costs NOT caused by the subject, so "at least $X was caused" can be flatly FALSE |
| `includesAllDelegated` | unnecessary (it IS the total) | unreachable pending §2a signed evidence |

**A posture whose precondition fails degrades to its plain label above and MUST
NOT silently inherit a bound.** The default is *no claim*, with the bound as the
named exception — never a global reframe that postures opt out of. **The
mechanical guard is a negative assertion: `indeterminate` renders NO floor
claim.** (Same discipline as §8's inherit-by-default rule, pointed the other
way: nobody has to remember to suppress it.)

Neither the floor claim nor the scope statement may sit behind interaction —
not a `<details>`, tooltip, or accordion. *A disclosure that requires a click is
a defence, not a disclosure.* And the retired unconditional promise must not be
restated anywhere, **including in order to except it**; floor framing is exactly
what lets the strong claim hold without resurrecting that sentence.

**Conformance carve-out, stated so nothing ships silently.** This clause binds
the PAGE now (verify-page design R39/R40 at v0.9). `usertrust-verify receipt` is
in flight and implements posture labelling but NOT floor framing: it is
**non-conformant to this clause on merge**, as a named ledgered follow-up, and
must not be described as conformant.
- **ONLY `includesAllDelegated` may be presented as the total cost of work
  caused by the subject** — and only when its §2a signed evidence validates.
  **Pinned condition (v0.9.2): `includesAllDelegated` WITHOUT validating
  evidence is an integrity FAILURE (409-shaped), NOT the protocol-error
  shell.** The shell is for postures that are missing or unrecognized; this one
  is recognized, and it is a receipt making a claim it cannot substantiate —
  which is what a failed verification step is for. Note this is **permanent in
  v1 by construction**: §2a specifies no evidence format, so a v1 receipt
  carrying this value always fails. It is therefore not fixturable until the
  evidence format exists — recorded here so the gap reads as a consequence,
  not an oversight.

The labels are not optional garnish. An amount rendered without its posture is
an amount whose scope the reader will supply from assumption, and the
assumption is always "this is what the work cost".

**The pattern this fail-closed rule belongs to, named once so it generalizes:
a system that ACCEPTS WHAT IT CANNOT INTERPRET AND REPORTS SUCCESS is the
defect.** It has worn three costumes in this project alone — a SurrealDB
`TYPE array` column returning `status: OK` while silently discarding every
element written to it; a `TextDecoder` accepting a BOM and dropping three
signed bytes from a document it then reports as verified; and a verifier that
would meet an unrecognized posture and render the total anyway. Every one
returns a green answer over material it did not understand. Wherever this spec
gives a verifier a choice between rejecting an input it cannot interpret and
proceeding without it, the answer is reject.

8. Recompute the ONE derivation the receipt can carry: `transferSetRoot`
   over `transferSet` when the ≤ 32 pair list is present (absent list →
   `notApplicable`; the root stays a commitment). → `DERIVATION_MISMATCH`.
   `amountUsd` is not recomputed and cannot mismatch — it is never stored,
   so this step COMPUTES it as a display value from `assessedUsertokens`
   (§2's integer rule) and emits it; there is nothing to compare it
   against, and `DERIVATION_MISMATCH` never refers to it.
   (Session constituent `eventDigest` was REMOVED from the projection — it
   was not recomputable from the receipt and violated the strict schema to
   supply; the transfer-set commitment carries the membership claim, R2-6.)
9. **EXTENSION checks — upgrade-only, never demoting (P2-3).** Complete
   segment-checkpoint history present + all history checks pass + embedded
   checkpoint present in it → upgrade `VERIFIED_CHECKPOINT_HISTORY`; valid
   Rekor anchor evidence → upgrade `VERIFIED_ANCHORED`. Anchor-evidence
   failures (log inclusion proof invalid, log key not the pinned one,
   evidence that does not bind THIS checkpoint's signed payload) report
   `ANCHOR_INVALID` **as this extension's result**, reserved for exactly
   that; history failures report `HISTORY_INVALID` the same way. Neither
   changes the base verdict from step 8 — the receipt stays
   `VERIFIED_CHECKPOINT` with a failed extension named in the output.
   ABSENT optional material is `notApplicable`, unfetchable material is
   `unavailable`; neither is a failure and neither upgrades.

`packages/verify` grows `usertrust-verify receipt <file>` implementing all
steps, zero dependencies, zero core imports (parity contract). `VERIFIED_*`
never implies "not later superseded" (§8).

### Verification consumers (the B2 transplant rule — verification side)

Every verdict above is about the RECEIPT. None of them says the receipt
belongs to the artifact that showed it to you: a trailer copied into a
different artifact still resolves green in a vacuum (stealth review's
own-gate Blocking, second half). The rule is therefore **PER KIND** — v0.6
specified only commits, which left PR and issue trailers transplantable
through the same hole the commit rule closes (round-4 P1-6). An
artifact-aware verifier is any consumer that has a CONTAINING artifact in
hand: CI checks, promotion gates, repo/PR tooling. Each MUST compare that
artifact against the receipt's chain-committed `work` and FAIL on mismatch:

- **`kind: "commit"`** — the containing commit's OID equals `work.oid`
  (FULL OID, under `work.oidAlg`; prefixes never suffice) and its
  repository equals `work.repoId` (the immutable provider-scoped ID, never
  the mutable name). `work.objectSha256` is compared over the canonical
  `gitPreimage` (§2) and is **MANDATORY for a green PROMOTION verdict** —
  a promotion gate that cannot hash the merge candidate's bytes MUST NOT
  pass it, because OID equality alone leaves SHA-1 twins indistinguishable.
  (Elsewhere, when a consumer genuinely has no bytes, the digest check is
  `notApplicable` and the verdict says so; it is never silently skipped.)
- **`kind: "pr"` / `kind: "issue"`** — two comparisons with two different
  consequences. **IDENTITY, fail-on-mismatch:** the containing artifact's
  `providerArtifactId` equals `work.providerArtifactId` (the IMMUTABLE
  provider ID — number and URL are both reusable), AND `work.repoId`
  matches, AND `work.number` matches. A mismatch here is a transplant and
  FAILS. **REVISION/CONTENT, resolved against the FROZEN revision:** at
  `work.observedRevision` the artifact's content satisfies
  `work.contentBinding` (recomputing `publicSha256` directly, or asking the
  resolver to confirm the `privateHmacSha256V1` commitment, whose key is
  server-side) — and if the artifact's CURRENT revision has moved on, that
  is not a mismatch at all but the display state below.
  **Revision mismatch therefore has exactly two meanings, and they are not
  the same event:**
  - AT FINALIZATION, a revision or content mismatch is a MINT-SIDE FAIL
    (unchanged, §6a): the proxy refuses to finalize, and no receipt exists.
    This is the only place a mismatch prevents a receipt.
  - AFTER finalization, an ordinary artifact EDIT is **not a verification
    failure**. The receipt attests the FROZEN revision it names and keeps
    attesting exactly that; bodies are mutable and editing one says nothing
    about the receipt. A consumer that compares against CURRENT provider
    state and finds a newer revision MUST render the defined display state
    **`revisionSuperseded`** — "attests revision `<observedRevision>`; the
    artifact has since changed" — and MUST NOT render it as a failure, a
    downgrade, or (worst) silently as a plain green check. The verdict
    itself is untouched: `revisionSuperseded` is a DISPLAY state, never a
    verification result and never a `status`.
  A DIFFERENT artifact is still a mismatch and still fails; a later
  revision of the SAME artifact is `revisionSuperseded`.
- **`kind: "session"`** — defined NON-ARTIFACT. There is no containing
  artifact to compare, and none may be inferred: a session receipt attests
  a governed session's spend and nothing about any commit, PR, or issue
  that happens to cite it. Consumers MUST NOT treat it as artifact
  attestation, and a promotion gate MUST NOT accept it (the gate requires
  `kind === "commit"`).
- **The standalone page** (which has no containing artifact in any case)
  scopes its rendered claim to what the receipt EMBEDS, never to whatever
  referred the viewer: "attests commit `<oid>` in `<repoId>`" for commits,
  "attests `<repoId>` PR/issue #`<number>` at revision `<observedRevision>`"
  for pr/issue, and — for `session` — "produced under this governed session
  — $X", the resolver's own wording, with no artifact claim at all. It
  never renders "this artifact is verified"; it renders WHAT this receipt
  attests and leaves the reader to compare.

## 8. Trust model, keys, time (R1-F7, R2-7)

**WHO EACH RULE BINDS (v0.9.3 — convention, stated once so no rule has to
restate it).** A conformance rule can bind the PRODUCER (a minter or resolver
must never emit this), the VERIFIER (a consumer meeting this must answer that),
or both — and they are different claims. A spec that conflates them leaves
producers free to emit artifacts every verifier must reject, which on a FROZEN
format gives you two conformant implementations that cannot read each other's
output, permanently.

**Default, applying to every rule in this section unless it says otherwise:
the rule binds BOTH.** A producer must not emit material violating it; a
verifier meeting such material refuses. Where the two diverge — where a
producer is forbidden to emit something a verifier must nonetheless handle
gracefully, or vice versa — **the rule says so explicitly and names both
outcomes.** The `activationSequence` presence rule below is the worked example:
a snapshot violating it is MALFORMED (binding the producer) *and* answers
UNVERIFIABLE at the loader (binding the verifier), and those are two statements,
not one.

A rule that silently binds only one actor is the same latent contradiction as a
restated invariant: two implementers read it, each takes the half addressed to
them, and both cite this document.


- **Trust domain:** `minter.trustDomain`, v1 pinned `usertrust.ai`. Key
  material at `https://<trustDomain>/.well-known/usertrust-verify`:
  `{ keys: [{ keyId, alg, publicKey, role: "mint"|"checkpoint",
  minterKind?: "proxy", predecessorKeyId?, activationSequence?,
  state: "active"|"retired"|"revoked" }],
  chains: [{ vaultId, profile: "proxy-v1",
  genesisSegmentId, genesisChoice: "backfill" | "newVault",
  headSegmentId, headSegmentFirstSequence, mintActor, checkpointRootKeyId,
  mintKeyIds }] }`.
  **Registered genesis (§9-B.1's declaration, made checkable):**
  `genesisSegmentId` names the segment the v2 checkpoint history ROOTS AT
  and `genesisChoice` records which resolution produced it — `"backfill"`
  (v2 statements re-issued over all prior segments) or `"newVault"` (the
  history begins at the v2 cutover). §7's history walk checks the SERVED
  history roots at exactly this segment; a history that starts later
  (short) or claims to start earlier (unregistered) never earns
  `VERIFIED_CHECKPOINT_HISTORY`. Like `mintActor`, the pair is immutable for
  the life of the vault — moving a genesis is a new `vaultId`.
  **RULED for ut1 (Cam, 2026-08-12): `genesisChoice: "newVault"` — genesis IS
  the v2 cutover.** The choice was made against evidence, not preference: the
  receipt-chain sweep found segment rotation has NEVER run in production
  (`rotateSegment` has no DEFINITION and no caller anywhere in source — the
  identifier's only occurrence in the repository is this sentence; `/segments` returns a hardcoded
  `[]`, and prod holds one append-only ~51 MB `audit.jsonl` with no archive
  directory), so there are **zero finalized segments** and `"backfill"` would
  have re-issued v2 statements over nothing. Consequence for §7's history walk:
  the served history roots at the cutover segment, and no history predating it
  exists or can be demanded. Consequence for §9-B.1: the genesis declaration is
  a registration, not a migration.
  **Per-chain authority binding (R3-2):** `checkpointRootKeyId` pins WHICH
  checkpoint key (and its rotation lineage) may sign `SegmentCheckpoint`s for this
  `vaultId`; `mintKeyIds` lists the mint keys permitted over it. A domain-wide
  `role: "checkpoint"` key confers NO authority over chains that don't pin it.
  Duplicate/ambiguous `vaultId` registrations are rejected. **One checkpoint
  lineage serves exactly ONE vault (round-4 P1-2, belt to the signed
  `vaultId`):** a key — or any key in its rotation lineage — that is pinned
  by two `chains[]` entries makes the document invalid, because a lineage
  trusted by two vaults could sign statements attributable to either.
  `mintActor`
  selects the §4a closed-union form and is immutable for the vault's life.
  KeyIds globally unique, never reused, retained forever. The document is
  itself **signed and append-only-versioned** (each snapshot embeds the
  hash of its predecessor); the signing scheme + non-equivocation story is
  a ship-gate item (§11) — until it lands, verifiers pin snapshots and say
  so (HTTPS alone is transport, not history integrity, R2-7).
- **Rotation is representable, not implied (round-4 P1-7).** v0.5 required
  verification "under its rotation lineage" while the schema had no way to
  express one, and a bare `revoked?` boolean forced a false choice between
  invalidating history and letting retired keys sign forever. So:
  - `predecessorKeyId?` names the key this one ROTATED FROM. A **rotation
    lineage** is the transitive predecessor walk WITHIN ONE ROLE (and, for
    checkpoint keys, within one vault): `keyN → … → key0`, acyclic, each
    link declared once, each member globally unique and retained forever.
    `checkpointRootKeyId` pins any member; pinning a member pins its
    lineage.
  - `state` is a three-value model, not a flag:
    **`active`** — verifies, and MAY sign new material.
    **`retired`** — verifies material it signed while active, and MUST NOT
    sign anything new. This is the ordinary end state of a rotation, and it
    is why rotating does not invalidate history. "While active" is a
    SEQUENCE bound, made checkable by `activationSequence` below.
    **`revoked`** — verifies NOTHING, past or present. Revocation is the
    compromise path: it deliberately invalidates everything that key
    signed, because a compromised key's old signatures are exactly what an
    attacker would forge. Revoking is therefore an incident action, never
    routine rotation hygiene.
  - **`activationSequence?` makes the retirement boundary enforceable
    OFFLINE, from the pinned snapshot alone.** On a CHECKPOINT key it is
    set at the moment its successor activates, and equals the successor's
    first sealed segment's `segmentFirstSequence`. The rule is then a
    single comparison any verifier can make with one checkpoint in hand:
    - a `retired` checkpoint key verifies ONLY checkpoints whose
      `segmentFirstSequence < activationSequence`. A checkpoint at or after
      that boundary signed by that key is a FRESH signature from a retired
      key — a base-verification FAILURE at §7 step 6, not a warning, and
      not something only a full-history walk can catch;
    - an `active` key has no upper bound (its `activationSequence` is
      absent — it has no successor yet);
    - a `revoked` key verifies nothing, bounded or not.
    Because segments are sealed and `segmentFirstSequence` is strictly
    increasing (§4a), this boundary is a total order over the chain's own
    sequence space — no clock, and no history required to evaluate it.
    (MINT keys have no segment-indexed material of their own; their
    retirement boundary is the mint event's segment, evaluated the same way
    through the receipt's checkpoint.)
  - **`activationSequence` PRESENCE, INTERPRETATION, AND THE INERT CELL
    (v0.9.3 — three gaps closed 2026-08-14, all surfaced by enumerating the
    predecessor states from this schema rather than from defects).**

    **(a) The presence rule stated earlier in this section — "present iff
    `retired`" — IS WRONG and is corrected here.** The real invariant is
    **present if `retired` OR named as some key's `predecessorKeyId`**, and
    neither condition subsumes the other: a retired key whose successor is not
    registered in THIS snapshot carries a boundary without being named, and a
    key may be named as a predecessor while `revoked` rather than `retired`.
    **Consequence, stated because it decides what a PRODUCER may emit:** a key
    named as some other key's `predecessorKeyId` and carrying no
    `activationSequence` makes the snapshot **MALFORMED**, not merely
    unverifiable. A conformant producer must never emit one. A verifier meeting
    one answers UNVERIFIABLE — it cannot verify — but the two statements are
    different claims and only this one binds the producer.

    **(b) A `revoked` key MAY carry a boundary and MAY be named as a
    predecessor.** This is not an edge case — it is the *most likely*
    revocation sequence in production: rotate normally, then later discover the
    old key was compromised and revoke it. **The boundary exists because the
    rotation happened, and revocation does not retract history.** Refusing it
    would discard the successor's lower bound, which is the property that
    stops a rotated-in key authenticating pre-rotation material. A revoked
    predecessor with NO boundary is a different matter: the successor's lower
    bound is then unevaluable, the snapshot cannot answer a question the
    verifier must ask, and it is refused at the LOADER as `UNVERIFIABLE`.

    **(c) THE INTERPRETIVE RULE, which closes the class rather than the cell:
    `activationSequence` is meaningful ONLY through the lineage edge — as the
    predecessor's upper bound and its successor's lower bound. It is NEVER a
    property of the key that carries it, standing alone.** Consequently a
    `revoked` key that no other key names as its predecessor may carry a
    boundary, that value is **EXPLICITLY IGNORED**, and **no verifier may
    derive anything from it** — not a bound on that key, not a bound on
    anything else. Such a snapshot loads.

    Stated rather than left silent deliberately. "Harmless because nothing
    reads it" is exactly the condition under which a field on a FROZEN format
    becomes harmful: the field is permanent, some later verifier will read it
    uniformly instead of case-by-case, and it will find values written by
    implementations that had no rule to follow — by which time the receipts
    carrying them are signed and unfixable. **Silence is what a later
    implementer resolves by guessing**, and the cells that look harmless are
    the ones closed by guessing, because nobody feels the need to ask.

  - **THE ROTATION LIFECYCLE HAS MORE STATES THAN MOST MODELS OF IT, and every
    implementation that has touched this boundary has been wrong about a state
    it did not enumerate (three independent instances, 2026-08-14, three files
    and three authors).** The states are `active`, `retired`, `revoked` — and
    "is named as some other key's `predecessorKeyId`" is ORTHOGONAL to all
    three, which is where the defects live. Recorded so the next implementation
    enumerates rather than rediscovers:
    - a successor's LOWER bound is the predecessor's `activationSequence`; the
      same number is the predecessor's UPPER bound. **One value, two keys, two
      directions** — wiring one direction leaves the other open, and a key
      rotated in at segment N could otherwise sign material from before N.
    - a predecessor carrying NO `activationSequence` leaves its successor with
      no evaluable lower bound. **The presence rule is stated ONCE, in (a)
      above — this bullet does not restate it** (a bullet that re-derives an
      invariant stated elsewhere is a second source of truth, and it drifts the
      next time the first one changes; that is exactly how this sentence came
      to contradict (a) within hours of both being written). Under (a) such a
      snapshot is **MALFORMED — a conformant producer must never emit one** —
      and the verifier answers **UNVERIFIABLE at the loader**, not a
      per-receipt failure. Refusing it at the verifier instead pushes a
      snapshot defect into a receipt verdict and produces the wrong verdict
      CLASS for every receipt under that lineage.
    - `activationSequence` values along a lineage must be ORDERED; an inversion
      silently widens the OLDEST key's window.
    - chain-history verification scoped to the live segment reports a false
      CRITICAL on any rotated healthy vault.
    **Rule for implementers: derive the cases from this state list, never from
    the incidents.** A test set assembled from bugs tests the past.

  - **Snapshot selection:** verdicts are relative to the verifier's PINNED
    snapshot, and the verifier says which one. A later snapshot may retire
    or revoke a key, so re-verifying the same receipt under a newer
    snapshot can legitimately change a pass to a fail (revocation) while
    never changing it the other way. Consumers that cache verdicts cache
    the snapshot identity with them.
- **Authorization is key-history state, not time windows** (R2-7): a key
  verifies iff present, role-correct, minter-kind-correct, and in a state
  that permits verification for this use (`active`, or `retired` for
  material it signed while active) in the verifier's pinned snapshot. No
  verification step
  consults `mintedAt` or checkpoint `timestamp` for key validity —
  timestamps everywhere are chain-committed clock claims; Rekor integration
  time upper-bounds the *checkpoint's* existence only. Ambiguity →
  `UNVERIFIABLE`.
- **Role + kind separation enforced:** reject if the mint keyId has role
  `checkpoint` (or vice versa), if mint/checkpoint entries share key
  material, or if a `minterKind: "proxy"` key signs a receipt claiming a
  different kind. v1 has no SDK mint keys at all (scope decision).
- **Supersession:** a later `receipt_superseded` chain event is advisory
  and online-discoverable via the resolver; it never alters the original's
  cryptographic verdict; the page SHOULD surface it.

## 9. Stealth items (v0.4: pre-review answered what code can answer)

### 9-A. §9 answers — CONFIRMED by the stealth review (2026-08-08), with rulings

Stealth's review confirmed a–c below and added: **(H1) key custody targets
the EC2 proxy host, never mini2** (the mint worker/registry/chain all live
in `apps/api` on EC2; mini2 is the trading desk and keeps dev/infra off it;
env-file custody consistent with the existing SurrealDB/Clerk secrets, or
KMS if rotation ceremony is wanted; §8's mint-key ≠ checkpoint-key rule
enforced by the key-registry document). Durability (a) is restated by the
review as the INTENT-before-TB rule — the §6a lifecycle carries it;
`sessionId` (c) is the STABLE SCOPE IDENTIFIER, and the reservation handle
is a DISTINCT mint-side object bound to it (one live reservation per
billing principal at a time; each generation reserves its own `receiptId`)
— the handle's definition is owned by the companion, the scope ID's
uniqueness + closure requirements are owned here.

- a. **Not durable today.** A mint-worker queue is buildable on the existing
  WakeManager.rehydrate + desk/store CAS pattern, but session→transfer
  linkage (the ID-pair model, §6a) is
  not currently mintable: no intent precedes the TB side effect, Score and
  passthrough paths write no session linkage, and the one query truncates at
  50 without pagination. Also: SurrealDB durability is configuration-dependent
  (two compose files run it in-memory; unset SURREAL_URL falls back to a
  non-durable in-process store) — the mint worker's crash-survival claim must
  be asserted per deployment, not assumed.
- b. **No second key exists.** One Ed25519 pair serves the whole audit
  subsystem (plaintext `MERKLE_SIGNING_KEY` env, undocumented in both
  .env.example files, ephemeral outside production). A distinct mint key must
  be PROVISIONED; §8 rejects shared material.
- c. **Today's sessionId is a content hash and collides across concurrent
  runs.** Spec requirement (normative): `sessionId` MUST be a unique
  identifier minted at session open (nonce/ULID — the desk-planner nonce
  pattern), never a content hash. Ownership resolved (pre-review conflict 13):
  the companion's reservation-under-exclusive-billing-principal model is
  adopted as the DEFINITION of the reservation; this spec owns the scope
  ID's uniqueness + closure requirements.
  **Scope ID ≠ reservation handle (round-4 P2-2).** Earlier drafts said
  "`sessionId` IS the reservation handle"; that equation is WITHDRAWN,
  because it breaks the moment a generation+1
  addendum is admitted under a SUBSEQUENT reservation: that reservation has
  a new handle, while the registry keys generations by the ORIGINAL
  `sessionId`. So they are two identifiers:
  - `sessionId` (in the projection) is the STABLE SCOPE ID. It is minted at
    the first reserve of a scope — equal to that first reservation's handle
    in the ordinary single-reservation case — and every subsequent
    reservation in the same scope CARRIES IT FORWARD unchanged. It is what
    `(sessionId, generation)` keys, and it never changes across
    generations.
  - the reservation handle (mint-side, NOT in the projection) is per
    reservation and belongs to the companion.
  Each generation gets its OWN reserved `receiptId` (§3) — a receipt ID is
  never reused across generations, and generation 1's trailer keeps
  pointing at generation 1 forever (§6a).
  **Generation linkage is checked, not just present:** offline, a verifier
  enforces `prevGenerationEventHash` present iff `generation > 1` (§2);
  ONLINE, it MUST additionally equal the registry's `event.hash` for
  `(sessionId, generation − 1)`. Offline that second half reports
  `notApplicable` (§7's structured results) — an offline verifier can see
  that an addendum claims a predecessor, not that it claims the RIGHT one.
  **Closure (corrected to match §6 and the review's answer (c)):** the
  session CLOSES at FINALIZE, one-time, through the §6 CLOSING CAS — not at
  mint-intent creation. EVERY intent admitted before that CAS — journal and
  DLQ entries included — stays in the CURRENT generation and MUST reach a
  RECONCILED TERMINAL state before minting (POST or VOID for intents whose
  TigerBeetle transfer exists; `REJECTED` or `ABORTED_NOT_SUBMITTED` for
  pre-ledger intents, audit-committed separately). Delayed pre-close
  settlement is WAITED FOR and NEVER mints `generation+1` — punting a
  pre-close transfer to a later generation would leave the immutable,
  commit-referenced generation-1 receipt permanently underreporting.
  `generation+1` exists ONLY for work admitted under a SUBSEQUENT
  reservation on the same session scope.

### 9-B. Stealth net-new implementation (ship-gate for proxy minting — from
pre-review blocking findings; this is work, not integration)

1. **Checkpoint pipeline** (pre-review 1/2/4/5; SHRUNK by B1, revised
   R3-9): emit `SegmentCheckpoint` v2 statements (§4a) over the EXISTING
   per-segment trees — no global-tree build, no `AnchorRecord` port.
   **The genesis decision stands and is stealth's to make (reinstated):**
   the v2 checkpoint history ROOTS AT A DECLARED GENESIS BOUNDARY, and
   stealth chooses explicitly between (a) **verified backfill** — re-issue
   v2 statements over all prior segments, whose lineage edges must be
   reconstructed from the existing `MerkleTreeState` and are only as good
   as that unsigned state; or (b) **a new `vaultId`** whose genesis IS the
   v2 cutover, leaving pre-cutover segments outside the receipt chain
   entirely. The choice is DECLARED IN THE TRUST DOCUMENT, not just in
   prose: the vault's §8 `chains[]` entry carries `genesisSegmentId` +
   `genesisChoice`, and §7's history walk requires the served history to
   root at exactly that segment. Either way `VERIFIED_CHECKPOINT_HISTORY`
   (§7) reaches back only as far as that declared genesis, the verdict must
   not imply more, and the launch ceiling (§7, R3-8) stands until the
   history is actually SERVED. What remains genuinely net-new:
   extending the signed payload (v2 fields incl. the lineage edge +
   `segmentFirstSequence` + `keyId`), wiring rotation scheduling and the
   publisher (today: no callers, no stored roots, `/segments` is a stub),
   an append-only checkpoint history + outbox with crash recovery, a
   stable public-safe `vaultId`, a checkpoint cadence that cannot
   indefinitely stall low-volume receipt minting, and either a single-host
   deployment constraint stated for the writer or a distributed lock.
   **Cadence note (round-4 P1-1): sealing cadence IS checkpoint cadence.**
   Because a checkpoint seals its segment and forces rotation (§4a), the
   pipeline cannot checkpoint "more often than it rotates" to shorten mint
   latency — each checkpoint ends a segment. Tune one knob, not two: a
   short cadence means many small segments (more statements, longer
   histories to serve); a long one means minting waits for the seal. Sizing
   that trade-off is part of this work item.
   Genesis values and contiguity per §4a/§7.
2. **Reconciliation oracle** (pre-review 6): §1's mintability precondition
   needs a real transfer-set check — implement `verifyTripleConsistency` (or
   equivalent transferId-join over TB/Surreal/chain for the session's set);
   the ±1-token per-user balance compare does not qualify.
3. **Pricing table versioning** (pre-review 7): a `PRICING_TABLE_VERSION`
   analog so `pricing.tableVersions` is populatable; rate deployments must
   leave a trace.
4. **Durable mint prerequisites** (pre-review 8/10): session→transfer
   linkage written on every governed path (incl. Score/passthrough),
   carrying the full `{authorizationTransferId, settlementTransferId}` pair
   (§6a) and not a bare ID; paginated retrieval; and the
   transferId→leafIndex sidecar restored on restart (today it is in-memory
   only — proofs 404 after restart).
5. **Mint key provisioning** (9-A.b) + documenting both env keys.
6. **sessionId nonce migration** (9-A.c).

Until 9-B lands, proxy receipts are unmintable; the trailer swap stays gated
(consistent with the companion's own gating: a trailer that 404s is worse
than `Co-Authored-By`).

## 10. Required companion-doc updates

1. Envelope `{ apiVersion, status, receipt, anchorEvidence?,
   checkpointHistory?, display? }`; **route/body ID equality on every read,
   and the registry binding on every read THAT SERVES A RECEIPT**
   (R1-F10, §3/§7 step 3 — nothing is "derived" from the event any more).
   The binding qualifier is not a loophole: a `reserved` (202) or
   `notMinted`/`cancelled`/`expired` (410) response has no mint event and therefore
   no binding — but `billedUnfinalized` (410) is the exception among
   terminals: its bundle carries the `originalReceiptId →
   terminalEvent.event.hash` first-write-wins binding (§10.15) and IS
   checked on every read that serves it. A `reserved`/`notMinted` response
   no `receiptId → event.hash` binding to check, only the allocation from
   §3's atomic reserve-time claim. From finalize onward the binding is
   mandatory on every read. `display` is the unsigned,
   explicitly not-chain-committed member: the H2 spend-breakdown rows live
   there, as does anything else the page shows that the chain does not
   commit. Consumers MUST NOT treat `display` content as attested, the page
   MUST label it, and its contents obey §2's public-safety rules.
   The companion also RENDERS the **`revisionSuperseded`** display state for
   pr/issue receipts (§7's consumers subsection): when the artifact's
   CURRENT revision is newer than the receipt's `work.observedRevision`, the
   page reads "attests revision `<observedRevision>`; the artifact has since
   changed". A post-finalization edit is not a failure — the receipt still
   attests the frozen revision — so this is a DISPLAY state only: never a
   `status` value, never a verdict change, and never silently dropped.
2. The draft's `proof.sessionDigest` — its synthetic
   `{ version, previousHash, sequence, occurredAt, payload: { receiptId,
   claimsHash, transferSetRoot } }` event plus `eventHash` — is replaced by
   the embedded §4 event envelope (field-complete, canonical bytes equal to
   the persisted event); one shape, one
   hash rule (R1-F3). The `claimsHash` indirection disappears with it: the
   projection IS the committed claim set (§2). (There is no `auditHashes[]`
   in the current draft; the v0.5 text named one that does not exist.)
3. `status` on 200 is the R3-8 ladder and nothing else:
   `verified_checkpoint | verified_checkpoint_history | verified_anchored`
   (§7). `verified_chain` is NOT a ut1 status name — it was renamed with
   the verdict (R3-8) and must not survive in the companion. Mint itself
   defers only on LOCAL checkpoint existence (§6). The draft's current
   200/202 model — a 200 requiring a non-empty `anchors[]`, an unpublished
   root answering 202 `{status: "anchoring"}` — is retired by §10.14, and
   `publishedTo` disappears entirely per §10.8.
4. Resolver serves the persisted mint-time proof + checkpoint (immutable)
   plus the segment-checkpoint history collection; live-head consistency is
   advisory. Failure to recompute the STORED artifact is the draft's own
   `409 "unverifiable"` (its Errors table stands); `503
   "verificationUnavailable"` is for TRANSIENT/OPERATIONAL inability to
   perform the BASE verification only — the key registry or the receipt
   store being unreachable (R1-F14 corrected: the two are not
   interchangeable, and rendering a recompute failure as 503 hides an
   integrity incident exactly as rendering a transient outage as 409 fakes
   one). **An anchor endpoint is NOT on that list (round-4 P2-4):** anchor
   and history material are optional EXTENSION inputs (§7 step 9), so
   failing to reach them is a clean 200 at `verified_checkpoint` with the
   extension reported `unavailable` — never a 503, never a downgrade.
5. `spend` adopts `assessedUsertokens`/`postedUsertokens`/`usagePosture`
   AND `roundingAdjustment` — the adjustment is adopted into the §2
   projection (chain-committed, `0 ≤ n ≤ transferCount`), replacing its
   `claimsHash` commitment in the draft; `amountUsd` derives from assessed
   via integer math (R2-5). ut1 additionally requires
   `postedUsertokens === assessedUsertokens` (§2, P1-4) — capped posts are
   not a ut1 shape. The draft's recompute equation
   (`A + roundingAdjustment`) stays the RESOLVER's — a display-grade,
   online check over its unsigned `display` rows (§2), NOT a claim §7 step
   8 makes (that step recomputes `transferSetRoot` and nothing else; see
   §10.11, which says the same thing). What the chain commits, and what an
   offline verifier therefore checks, is the bound
   `0 ≤ roundingAdjustment ≤ transferCount` and `posted === assessed` —
   bounded honesty, not offline recomputability. Two consequences for the
   companion's prose: (a) its unconditional "**Public amounts must never
   UNDERSTATE what the work cost**" claim is RETIRED as written — the
   honest form is scoped ("never understates the ledger-POSTed cost of this
   governed session", with `usagePosture`/`pricingPosture` carrying the
   caveats and estimates explicitly NOT a guaranteed upper bound, §2/R2-5);
   and (b) its `pricingTables` content hashes and `pricingDeployment`
   metadata are NOT chain-committed in ut1, so they move into the unsigned
   `display` member (labeled, §10.1) or are dropped — they must never be
   rendered as if the chain vouched for them.
6. `execution.agent`/`interactive` move into the unsigned `display` data
   (§10.1) or are dropped. They may NOT be reintroduced as "minter-asserted
   work-class fields" — v0.6 removed the minter-asserted `work` class
   entirely (B2/§6a); `work` is chain-committed and closed, and these two
   are neither.
7. **Defer-policy conflict resolved in this spec's favor** (pre-review
   conflict 12): mint defers on LOCAL checkpoint existence only. External
   publication BY ITSELF upgrades NOTHING (§7's R3-8 rule):
   `verified_checkpoint` → `verified_checkpoint_history` comes from SERVING
   the complete segment-checkpoint history, and → `verified_anchored` comes
   from valid Rekor anchor evidence. The companion's "a 200 never carries an
   unanchored root" (its `publishedRoot.anchors[]` note and offline-
   verification step (4), retired in full by §10.14) is retired —
   push-gating must not depend on external sink availability, and the
   status ladder makes the state honest on the wire. Rationale stands
   unless Cam overrides.
8. The §6a reservation state is **ALIGNED, not added** (round-4 P2-4): the
   draft's Errors table already carries 202 `{status: "reserved"}` with
   `Cache-Control: no-store`, and this spec confirms it unchanged — the
   trailer cites the reserved ID, so a reserved ID must never answer 404
   (§3's atomic reserve-time claim is what makes 404 mean "never
   allocated"). What DOES change on the 200 side: the `status` vocabulary
   becomes `verified_checkpoint | verified_checkpoint_history |
   verified_anchored` per the R3-8 ladder — the draft's Response-200
   single `"status": "verified"` is retired; `publishedTo` disappears
   entirely. Absent optional history material is a clean 200 at
   `verified_checkpoint` (R3-8) — never a 503, never a partial-history
   verdict (§10.4 owns which code covers what).
9. Trailer key casing AND value: the key is exactly `Usertrust-Receipt`
   (§12; the resolver draft's `UserTrust-Receipt` spelling updates to
   match), and the value is the FULL https URL per §12's grammar —
   `https://usertrust.ai/r/ut1_<base58>` — never the bare ID (resolver Q5
   settled here). The resolver's Q4 length estimate ("~24-30 chars") is
   corrected: the ID is 16–22 base58 characters after the `ut1_` prefix
   (§3/§12), so the trailer's real estate budget is smaller than the draft
   assumed.
10. Proof block: `PublishedMerkleRoot` v1 is replaced by `SegmentCheckpoint`
    v2 (§4a) — pre-review conflict 1, direction reversed by B1: the
    normative formats are the proxy's, but the CHECKPOINT statement is the
    v2 extension, not the v1 root-only signature (which leaves `treeSize`
    and the lineage edge unauthenticated). The resolver serves the v2
    objects and the segment-checkpoint history collection (§7), and the
    proof block carries `profile: "proxy-v1"` (§4a/§5).
11. Spend breakdown rows live in the UNSIGNED envelope as `display` data,
    labeled not-chain-committed (H2). The resolver's recompute claim
    NARROWS to what the receipt can actually support: §7 step 8 recomputes
    `transferSetRoot` and emits `amountUsd` as a computed display value —
    it contains no breakdown equation at all, and none is claimed for it
    (round-4 P2-4 caught the older wording implying otherwise; §10.5 states
    the same split from the spend side). The rows' former `claimsHash`
    commitment is deliberately
    dropped — ut1 has no `claimsHash` — so the draft's "committed inside
    claimsHash, so it cannot be tuned post-hoc" reliance (its
    `roundingAdjustment` note) is superseded by the chain-committed
    `roundingAdjustment` in §2.
12. `transferSetRoot` KEEPS its name and its pair semantics: the commitment
    is over ordered `{authorizationTransferId, settlementTransferId}` pairs
    (the draft's round-33 F1 model). THIS spec renamed its field to match —
    v0.5's `transferSetDigest` is retired — so there is no companion churn
    here; only §2's construction (domain separator + canonicalized ordered
    pair list) and the ≤ 32 disclosure rule are new to the companion. The
    disclosure rule DOES narrow the draft's "per-transfer detail behind
    `transferSetRoot` is a fixed commitment, not an enumeration": for sets
    of ≤ 32 the projection enumerates the pairs and step 8 recomputes the
    root from them; the commitment-only reading holds above 32.
13. **Retired: the anchor-clock key-validity model.** The draft's section
    "Key validity is judged by the anchor's clock, not the response's
    (round-6 F3)", and the validity-window text inside "The proof
    construction is the audit layer's existing one, not a new invention
    (Codex F1)" (its offline-verification steps (3) "historical audit-root
    keys with validity windows" and (4) "check the KEY's validity window
    against the ANCHOR's trusted timestamp"), are BOTH superseded by §8's
    key-history STATE model: a key verifies iff present, role-correct,
    minter-kind-correct, and in a permitting `state` (`active`, or
    `retired` for material it signed while active) in the verifier's pinned
    snapshot — with `predecessorKeyId` making the rotation lineage
    representable (§8, P1-7). No verification step consults any clock for
    key validity.
    What survives from that section is the timestamps-are-not-trusted-clocks
    principle and the fact that `publishedAt` is a signed input — Rekor
    integration time still upper-bounds the CHECKPOINT's existence, which is
    evidence about the checkpoint, not about the key.
    **This item also answers the draft's OPEN QUESTION 3 ("is 410
    `revoked` needed?"): NO — there is no receipt revocation.** An
    immutable ledger has no revocation; a mistaken mint is an incident, not
    a lifecycle state, and the only remedy is a later `receipt_superseded`
    chain event, which is ADVISORY: the resolver surfaces it, the page
    SHOULD show it, and it never alters the original's cryptographic
    verdict (§8). The word "revoked" in ut1 belongs to KEYS
    (`state: "revoked"`, §8) and to nothing else; the companion should not
    add a `revoked` receipt status, and the page never needs that state.
14. **Retired: `anchors[]`-non-empty-on-200 and the 202 `"anchoring"`
    state.** The draft requires a non-empty `anchors[]` on every 200 ("a 200
    never carries an unanchored root") and parks locally-checkpointed
    receipts at 202 `{status: "anchoring"}`. Both are superseded by the R3-8
    ladder: a checkpoint-only receipt is a legal, honest **200** at
    `verified_checkpoint`, and the status can rise LATER — asynchronously,
    and stated precisely so this item does not contradict §10.7:
    publication BY ITSELF upgrades nothing; what upgrades the status is the
    resolver SERVING the material (the complete segment-checkpoint history
    → `verified_checkpoint_history`; valid Rekor evidence IN ADDITION TO
    that complete history → `verified_anchored` — the ladder is cumulative,
    §7/verify-page §4.1 rule 3: anchorEvidence AND checkpointHistory are
    jointly required for the top rung; Rekor alone upgrades nothing past
    the checkpoint floor). Publishing to a sink and never serving the
    evidence changes no status at all. `"reserved"` is then the only 202
    this ladder
    recognizes — a state of the ID BEFORE it has a receipt, never a state
    of a minted proof. (The draft's `"reconciling"` sits on the same
    pre-mint side of that line and is mint-side machinery the companion
    owns; what is retired here is the idea that a MINTED receipt ever waits
    at 202 for an external sink.) Anchor evidence, when present, is served
    in the unsigned envelope (§5) and upgrades to `verified_anchored`.
    One STALE FRAGMENT goes with the `"anchoring"` state: the draft's
    `"reconciling"` row still lists "or a forced-fallback session receipt
    has not finished anchoring" as a reason to hold at 202. That clause is
    retired too — a minted fallback receipt is served at 200
    `verified_checkpoint` like any other, whatever its publication state.
15. **Identity binding re-expressed for ut1.** The draft's round-8 F3 rule
    chains `requestedReceiptId === receipt.receiptId ===
    event.payload.receiptId` — but the ut1 projection deliberately carries
    NO `receiptId` (§3: the ID is a reservation-issued locator, and the
    registry, not the payload, binds it), so that third term does not exist
    and MUST NOT be reintroduced. The equivalent ut1 chain, which closes the
    same answer-B-with-receipt-A hole, is: (i) route/trailer ID equality
    against `receipt.receiptId` (§7 step 3(a)); (ii) the registry binding
    `receiptId → event.hash` resolving to THIS receipt's event (§7 step
    3(b) — the resolver checks it server-side on every read, and it is the
    online half offline verifiers report as n/a); (iii) §4 equality 3, the
    projection's canonical bytes being `event.data`. Together those bind
    request → document → event without a payload-embedded ID. The same
    substitution applies to the 410 `billedUnfinalized` bundle's request
    binding: `body.receiptId`, `body.linkedReceiptId`, and
    `linkedReceipt.work.origin.sourceReservationReceiptId` still cross-check
    (§2's fallback-session variant keeps `origin`), but the
    `terminalEvent.event.payload.receiptId` term is replaced by an explicit
    **registry write for the ORIGINAL ID**: at the moment the terminal
    event is appended, the registry binds `originalReceiptId →
    terminalEvent.event.hash` (the terminal event nests as
    `terminalEvent.event` in the bundle — same first-write-wins discipline as
    `receiptId → event.hash`, §6), so the 410 bundle is checkable by the
    same mechanism as a green receipt instead of being self-asserted. That
    bundle's members are
    ALSO re-expressed against this spec's §4a shapes: `event` is the proxy
    envelope (field-complete, canonical bytes equal —
    `{ id, timestamp, previousHash, kind, actor, data, sequence, hash }`),
    `publishedRoot` becomes a `SegmentCheckpoint` v2
    statement, and the bundle carries `chain` + `profile` alongside them so
    the terminal proof names its vault and equality set exactly as §5's
    `proof` does (a terminal bundle without them is unverifiable in the
    same way an unlabeled receipt would be). The draft's synthetic event
    and v1 `PublishedMerkleRoot` do
    not appear in ut1 responses any more than they do in ut1 receipts.
16. **Retired: "Parallel work uses separate billing identities."** The
    sentence is gone from the pinned companion — the v0.7 re-pin retired it
    and the current §6a pin carries no trace of it — so this item now records
    a completed retirement rather than an override still in force. Its
    normative content stands on its own, independent of what the pin says:
    the sentence directly contradicted the stealth ruling this spec adopted,
    because separate
    per-job billing identities REOPEN the shopping attack one level up
    (cheap call under key A, expensive work under key B, finalize A). The
    normative rule is the one §6a adopted — **all descendant keys share ONE
    stable billing PRINCIPAL**, exclusivity and one-receipt-per-transfer
    accounting live at the principal level, and parallelism exists only as
    server-assigned ATTESTED WORKLOADS (bound by the orchestrator, named in
    the projection's `workloadId`, scoped to the provenance closure). Per-job
    keys remain credentials for ledger richness — never independently
    selectable attribution boundaries. This is the concrete reason §6a's
    adoption is pinned by hash rather than tracking the companion's head:
    automatic adoption would have imported this rule silently (round-4
    P1-5).

## 11. Codex round-2 closure + ship gate

R2 blocking findings: 1 (envelope/leaf/tree) → fixed in §4; 2 (verdict
overclaim) → renamed + segment-checkpoint-history level, §7; 3 (evidence
schema + upgrade) → unsigned attachment + RekorReceipt adoption + S3
demotion, §5;
4 (exactly-once) → intent CAS + generations + recovery scan, §6; 5
(metered/estimated) → assessed + usagePosture, §2; 6 (unverifiable steps)
→ eventDigest removed, derivations scoped, semantic rules, §§2/7; 7 (keys/
deferred mint) → proxy-only v1, minterKind binding, key-history signing to
ship gate, mint worker to §9-A.a. Smaller: base58 16–22 (§3, §12), integer USD
math (§2), `actor` constant (§2), timestamp sources defined as chain
claims (§2).

Ship gate before mint-endpoint implementation:
- [ ] **B1 decision record (this document, v0.6):** proxy profile ratified
      by Cam 2026-08-10; trade-off recorded in the headline (second verifier
      profile vs. no chain migration riding the mint feature); ut-chain
      convergence ledgered as a future project.
- [ ] **Pricing-snapshot ledger migration precedes the mint endpoint** (new
      prerequisite, from the resolver's sequencing section): per-transfer
      `pricingTableVersion` + applied tier rates + sanitized usage snapshot
      + per-transfer `pricingPosture` persist with the intent per the
      resolver's two-point durability rule; `authorizedMaxUsertokens`
      ceiling invariants per the same section.
- [x] **DONE (v0.8) — see §13.** Canonicalization frozen as a normative appendix covering **the
      PROXY's `canonical.ts`** (`apps/api/src/governance/audit/canonical.ts`
      — B1-(1) makes it the normative implementation; the SDK's is the
      cross-check) (complete algorithm:
      key sorting, UTF-8/surrogate policy, safe-integer-only numbers, no
      NaN/±Inf/−0, absent ≠ null, duplicate keys rejected, escaping).
      **Named conformance corpus (round-4 P2-7 — "signatures, digests,
      Unicode" is too broad to guarantee three implementations test
      identical preimages). The appendix MUST require:**
      - raw-JSON **duplicate-key rejection before object parsing** (a
        post-parse check cannot see the duplicate at all);
      - the **exact key comparator** and the exact escaping / number
        serialization rules, stated as algorithms, not as "sorted";
      - **end-to-end vectors** for each preimage this spec actually signs
        or hashes: a proxy event (→ `event.hash`), a `SegmentCheckpoint`
        v2 signed payload, a receipt signature preimage, a trust-snapshot
        (with its predecessor hash), and a `transferSetRoot` over an
        ordered pair list;
      - **positive AND negative vectors** for: absent vs `null`, present
        vs omitted optional fields, unsafe integers (> 2^53−1) and −0,
        malformed base64/hex, **every odd-tree leaf position** (each
        promotion path, not one example), and fixed-16-byte base58
        (including leading-zero `1`s and a string that is 16–22 chars but
        does NOT decode to 16 bytes — §12).
      All three implementations (core, verify, proxy) run the same corpus
      and must agree byte-for-byte.
- [ ] Key-history document: signing scheme, predecessor-hash versioning,
      non-equivocation story; first published keys.
- [ ] `canonicalContent` defined and versioned HERE (resolver round-28 hands
      it to this spec): exact byte representation — which fields, UTF-8
      encoding, Unicode normalization, line endings, null-body handling —
      gating pr/issue minting only; the v1 commit path does not need it.
- [ ] Stealth instance confirms/corrects the pre-review answers (§9-A) and the
      §4a proxy-profile decision (SETTLED v0.6 — B1 ratified; stealth's confirmation recorded in the 2026-08-08 review).
- [ ] Stealth 9-B net-new work either scheduled or the profile decision
      re-opened. **ALL of 9-B.1–9-B.6 are mint blockers (R3-9)** — not only
      checkpoints and durable prerequisites: without the reconciliation
      oracle (§1 has no mintability test), the pricing table version (§2
      unpopulatable), the mint key (§8 rejects), or the sessionId nonce (§6
      unsafe), no conformant receipt can be produced.
- [ ] Mint worker: takeover states, append-boundary fencing, and fail-closed
      startup on non-durable stores specified in stealth's implementation
      plan (R3-6).
- [ ] Companion updated per §10 (now **sixteen** items: 10.1-10.6 the
      envelope/proof/status/spend reconciliations, 10.7 defer-policy
      retirement, 10.8-10.12 reservation-state alignment, trailer
      key+value, checkpoint v2, breakdown-as-display, and
      `transferSetRoot`'s naming, 10.13-10.14 the two retirements — the
      anchor-clock key-validity model (which also answers the draft's
      revocation open question: NO receipt revocation) and the
      `anchors[]`-on-200 / 202-`"anchoring"` model — 10.15 the
      identity-binding chain re-expressed for a projection that carries no
      `receiptId`, including the 410 `billedUnfinalized` bundle, and 10.16
      the retirement of "parallel work uses separate billing identities" in
      favor of one billing principal + attested workloads).
- [ ] Codex round-5 on this text. (Round-4 returned REVISE with 7 P1 /
      7 P2 / 4 P3 findings; all are applied above — sealed segments,
      signed `vaultId`/`profile`, equality 9, `posted === assessed`, the
      hash-pinned adoption + §10.16, the per-kind transplant rule, the
      key-rotation state model, the §10 corrections, the no-PII
      operationalization, the trailer decode rule, and the named
      canonicalization corpus.)

## 12. Trailer grammar (resolver Q5)

`Usertrust-Receipt: https://usertrust.ai/r/ut1_<base58>` — key exactly
`Usertrust-Receipt` (casing settled HERE; the resolver draft's
`UserTrust-Receipt` variant is retired — §10.9), value the full https URL,
one trailer per receipt, multiple allowed. Grammar:
`"Usertrust-Receipt: https://usertrust.ai/r/" "ut1_" 16*22base58char`
(Bitcoin alphabet).

**The character-count rule is NOT the ID rule (round-4 P2-6).**
`16*22base58char` is necessary and nowhere near sufficient: many strings of
that length decode to fewer than 16 bytes, and some to more than 128 bits.
A conformant parser MUST, after matching the grammar:

1. **canonically DECODE the base58 to exactly 16 bytes** — any other
   decoded length is a REJECT, not a truncation or a pad; and
2. **re-encode those 16 bytes and require byte-identical output** — this
   rejects non-canonical encodings (leading-`1` padding beyond the actual
   leading zero bytes, alternative representations) that would otherwise
   let two distinct trailer strings name one ID.

**Lexical rules, so "exactly once" is decidable:**

- The trailer occupies a WHOLE LINE in the artifact's trailer block: the
  key starts at the beginning of the line (no leading whitespace), exactly
  one `:` then exactly one space, then the value, then end-of-line. No
  folding, no continuation lines, no trailing whitespace, no inline
  comment after the value.
- The key comparison is case-SENSITIVE (`Usertrust-Receipt` and nothing
  else); line endings may be LF or CRLF and the CR is not part of the
  value.
- Matching is anchored per line; a URL that merely appears inside prose,
  a code block, or a quoted body is NOT a trailer and MUST NOT satisfy
  finalization.

**"Exactly once" is scoped to THIS reserved ID.** Finalization requires the
reserved ID's trailer to appear exactly once in the artifact; a SECOND
occurrence of the same ID is a reject (§6a, resolver round-7 F3). Other
`Usertrust-Receipt` trailers naming DIFFERENT receipt IDs are permitted and
ignored by this finalization — an artifact may legitimately cite several
receipts (a commit spanning multiple governed sessions), and forbidding
them would make honest multi-receipt artifacts unmintable.

The swap replaces `Co-Authored-By` (Cam's
2026-08-08 directive); repo convention docs update lands with the swap, in
lockstep.

## 13. Canonicalization — NORMATIVE APPENDIX (v0.8; closes the §11 ship-gate item)

Every hash and every signature in ut1 is taken over canonical bytes:
`event.hash`, the receipt signature preimage, the `SegmentCheckpoint` v2
signature payload, `transferSetRoot`, and equalities 2/3/9. Two implementations
that disagree by one byte disagree on every verdict, so the algorithm is frozen
here rather than left to "whatever the code does".

**CORRECTED v0.9.1 — the normative artifact is THIS ALGORITHM, not any existing
implementation.** v0.8 named the proxy's `canonical.ts` normative; a 79-case
differential across all three real modules (2026-08-12) proved **no
implementation is fully conformant**, so "match the proxy" would freeze two of
the proxy's own defects into the format. The proxy remains normative on the
`undefined` case specifically — where core and verify diverge from it — and is
defective alongside them elsewhere (see the conformance table below). The
algorithm, stated completely and independently:

1. `undefined` and `null` both serialize to `null` — at the top level, inside
   arrays, everywhere. (A top-level `undefined` is NOT the JS `undefined` value.)
2. Numbers: non-finite (`NaN`, `±Infinity`) THROW — they are a data-corruption
   signal, never a verdict. Finite numbers serialize as `JSON.stringify(n)`.
   §2's own integer domains (safe integers, no `-0`) are enforced by SCHEMA
   validation before canonicalization, not by this function.
3. `Date` → its ISO-8601 string; an invalid Date throws. (ut1 wire documents
   carry strings, so this path exists only for in-process construction.)
4. Non-objects: `JSON.stringify(value)` — **and the RESULT must be checked.**
   `JSON.stringify` returns the JS value `undefined` (not a string) for
   functions and symbols, which string-concatenates into the literal
   `undefined` and produces unparseable output. A value whose serialization is
   not a string is REJECTED (throw), never emitted. v0.8's clause 4 as written
   mandated this bug and all three implementations have it: `{f: () => 1}`
   canonicalizes to `{"f":undefined}` everywhere today.
5. Arrays: `[` + each element canonicalized, in order, joined by `,` + `]`.
   Element order is NEVER sorted. **Iterate by INDEX over `length`, never
   `Array.prototype.map`** — `map` skips holes, so a sparse array's hole never
   reaches the recursive call and emits nothing: `[1, <hole>, 2]` becomes
   `[1,,2]`, which is not valid JSON. A hole is `null`, exactly as
   `undefined` is. All three implementations have this defect today; a
   top-of-function guard cannot fix it, because the recursion is never entered.
6. Objects: own enumerable keys (`Object.keys`), sorted by JavaScript's default
   comparator, which is **UTF-16 code-unit order**. (v0.8 described an
   additional `Object.hasOwn` filter as a "prototype-pollution guard"; it is a
   NO-OP — `Object.keys` already returns own enumerable properties only, and
   all eight pollution cases agree byte-for-byte across implementations. Keep
   it or drop it; it is not the mechanism.) Keys whose value is `undefined` are SKIPPED
   entirely (absent ≠ null: an omitted key and a `null`-valued key produce
   different bytes, which is what makes §2's key-absent rules checkable).
   Each pair is `JSON.stringify(key)` + `:` + the canonicalized value, joined
   by `,`, wrapped in `{}`.

**THE RULE THAT DECIDES REPRESENT-vs-THROW (ruled 2026-08-12).** Two of the
cases above coerce and two throw, and the boundary is not "what
`JSON.stringify` does" — this function ALREADY, deliberately, rejects
`JSON.stringify`'s answer for the analogous case: `JSON.stringify({n: NaN})`
gives `{"n":null}`, and canonicalize throws instead, because silently turning a
corrupt number into `null` puts a wrong value in financial audit data. The rule
that actually governs:

> **If JSON can represent the value FAITHFULLY, represent it deterministically.
> If it cannot, THROW — never silently coerce.**

The test is whether the coercion loses something the auditor needed:

| Input | Answer | Why |
|---|---|---|
| array hole, `undefined` in an array | `null` | Faithful. A hole IS the absence of a value at that index, and `null` says exactly that. Nothing is lost. |
| `undefined` as an OBJECT VALUE | key OMITTED | Faithful, and **load-bearing** — §2's `key-ABSENT (never null)` rules depend on it, and absence is precisely what the caller meant. **This behavior MUST NOT CHANGE.** |
| `NaN`, `±Infinity` | THROW | `null` would replace a corrupt number with a plausible one. Information the auditor needed is gone. |
| function, symbol | THROW | Omitting the key would silently drop a field the caller believed they committed — a signature over a document missing a member nobody knows is missing. |
| invalid `Date` | THROW, identifiably | Same class; and the throw must be deliberate, not an uncontrolled `RangeError` escaping `.toISOString()`. |

**HASH-COMPATIBILITY INVARIANT — the property that makes correcting this a bug
fix rather than a format break, stated so it can be MEASURED rather than
argued:**

> **The correction may change ONLY outputs that are currently unparseable. Every
> input whose current output parses as JSON MUST canonicalize byte-identically
> before and after.**

It holds by construction, not by luck: the three corrected cases (holes,
functions, symbols) never produced a readable line, so no valid chain can
depend on them; and the inputs that diverge have no JSON representation at all,
so they cannot survive a write — anything read back from storage was normalized
by `JSON.stringify` on the way in and is therefore untouched by the fix.
Verified both directions 2026-08-12. Storage-round-tripped values show zero
divergence between the current and corrected algorithms. And both repositories
were scanned: **180,270 lines, zero corruption** — usertrust 96,867 (fleet
journals, receipt logs, published chain: zero unparseable lines) and stealth
83,403 (EC2 prod `audit.jsonl`, re-canonicalized and re-hashed line by line
with every `previousHash` independently checked: zero unparseable, zero hash
mismatches, zero chain breaks).

**Read that result correctly, because it is easy to misread as absolution: a
scan can only ever tell you the vector has not fired YET.** It is evidence
about history, not about the defect — the bug was reachable the whole time in
both repositories and remains reachable until the code is corrected. Two
disciplines follow. First, a clean scan is not a reason to downgrade the fix.
Second, had either count come back NONZERO, the result would have been
genuinely AMBIGUOUS between this bug and a real tampering incident — and
"canonicalization is the more probable explanation" would have been true only
because we now know this bug exists. Filing a nonzero count as "the bug,
resolved" would be reasoning from convenience about the one signal the whole
system exists to make trustworthy.

**Any implementation of this correction MUST assert the invariant as a test
over a real corpus**, not reason about it: recanonicalize the production corpus
under both implementations and require zero divergence. An argument that the
invariant holds is not evidence that it does.

**And the binding form of that test must be one CI can RUN (ruled 2026-08-12).**
A real-vault corpus lives at `~/.usertrust-fleet`, which does not exist on a
runner — so a test written against it `skipIf`s in CI, and **a skipped test
reads as green**, which is the defect class this appendix exists to catch. Nor
may vault events be committed to a public repository. The artifact that
satisfies both constraints is a **committed corpus of canonical BYTE PAIRS** —
`input value → expected canonical output`, derived FROM the real vault but
carrying no event content. Small, diffable, publishable, and capable of
failing. The real-vault recanonicalization remains a valuable ADDITIONAL local
gate; it is not the binding one, because a gate that cannot run where the merge
decision is made is not a gate.

**Code-unit, not code-point.** Sorting is UTF-16 code-unit order because that
is what the normative implementation does. The two orders differ only for keys
containing non-BMP characters (surrogate pairs); every key in every ut1
document is ASCII, so the distinction is unreachable on conformant data — but
it is pinned here so a future implementation cannot "fix" the sort and silently
break every existing signature.

**Duplicate keys** are rejected by the strict READER before canonicalization is
ever reached (§4a); canonicalization itself never sees them.

**CONFORMANCE STATUS — all three implementations are defective, in overlapping
ways** (79-case differential, all modules imported and executed, 2026-08-12):

| Case | Proxy (minter) | core (SDK minter) | verify | Conformant answer |
|---|---|---|---|---|
| `undefined` | `null` ✓ | `undefined` ✗ | `undefined` ✗ | `null` |
| `[1, undefined, 2]` | `[1,null,2]` ✓ | `[1,,2]` ✗ | `[1,,2]` ✗ | `[1,null,2]` |
| **`[undefined]`** | `[null]` ✓ | `[]` ✗ | `[]` ✗ | `[null]` |
| **`{a:[undefined]}`** | `{"a":[null]}` ✓ | `{"a":[]}` ✗ | `{"a":[]}` ✗ | `{"a":[null]}` |
| `[1, <hole>, 2]` | `[1,,2]` ✗ | `[1,,2]` ✗ | `[1,,2]` ✗ | `[1,null,2]` |
| `{f: () => 1}` | `{"f":undefined}` ✗ | `{"f":undefined}` ✗ | `{"f":undefined}` ✗ | THROW |
| invalid `Date` | deliberate `Error` ✓ | uncontrolled `RangeError` ✗ | uncontrolled `RangeError` ✗ | deliberate throw |

Three things this table says that v0.8 got wrong:

1. **`packages/core/src/audit/canonical.ts` is code-identical to verify's**
   (they differ only in comments). v0.8 named only verify. So the **SDK MINTER
   and the verifier are bug-compatible with each other** and both diverge from
   the proxy — which is this appendix's own "a verifier sharing the bug with its
   harness cannot detect it" scenario, except the sharer is a production
   minter. **Core and verify MUST be corrected together**; fixing verify alone
   splits ut1's two implementations against each other, which is worse than the
   status quo.
2. **The dangerous divergences are SILENT.** v0.8 argued from `[1,,2]` "not even
   valid JSON," implying these announce themselves. The bolded rows do not:
   `[undefined]` → `[]` and `{a:[undefined]}` → `{"a":[]}` are **valid JSON that
   parses clean**, with a different digest and no error anywhere. Any
   conformance check shaped as "is the output parseable" passes them. The
   32-fixture wire corpus catches none of it — every non-throwing row
   reproduces byte-exactly on both sides, because wire data never contains
   `undefined`.
3. **The proxy is not wholly normative.** It shares the sparse-array and
   function-value defects. "Match the proxy" is therefore the wrong conformance
   rule; match THIS ALGORITHM, and the proxy needs the same two fixes.

**Error identity is pinned:** an invalid `Date` MUST throw a deliberate,
identifiable error (the proxy's `canonicalize: invalid Date in audit data`
form), never an uncontrolled `RangeError` escaping `.toISOString()`. A verifier
that maps a throw to a MALFORMED verdict must be able to tell a data defect
from a crash.

**Existing tests PIN the bug and must be inverted, not deleted:**
`packages/core/tests/audit/canonical.test.ts:30` and `:58`, and
`packages/verify/tests/verify.test.ts:236`. A green suite today is evidence of
the defect, not against it.

**DOWNSTREAM — this is a chain-corruption vector, not only a verification
mismatch.** `packages/core/src/audit/chain.ts:447` passes caller-supplied
`input.data` straight to `canonicalize`, and `:466,470` persist the canonical
bytes AS the audit line. An event carrying `data: {arr: [1, undefined, 2]}`
therefore writes a syntactically invalid line; `read.ts:59-63` swallows the
parse error and skips the line; the next event's `previousHash` dangles. The
event is accepted, hashed, fsync'd and reported durable — then vanishes on
read, and the chain reports TAMPERED permanently, indistinguishable from real
tampering, with the correct pre-image lost. Correcting `canonicalize` closes
it; correcting verify alone leaves it live. The regression test belongs at the
`chain.ts` level, not only at `canonicalize`.

**Named conformance corpus (round-4 P2-7).** Every implementation claiming ut1
conformance MUST reproduce these byte strings exactly. They are the cross-check
that no two implementations drifted together:

| Input | Canonical bytes |
|---|---|
| `null` | `null` |
| `undefined` | `null` |
| `[1, undefined, 2]` | `[1,null,2]` |
| `[]` / `{}` | `[]` / `{}` |
| `{"b":1,"a":2}` | `{"a":2,"b":1}` |
| `{"a":undefined,"b":1}` | `{"b":1}` |
| `{"a":null,"b":1}` | `{"a":null,"b":1}` |
| `{"Z":1,"a":1}` | `{"Z":1,"a":1}` (uppercase sorts first — code-unit order) |
| `{"a":{"d":1,"c":2}}` | `{"a":{"c":2,"d":1}}` |
| `{"n":0}` / `{"n":-1}` | `{"n":0}` / `{"n":-1}` |
| `{"s":"é"}` | `{"s":"é"}` (no `\u` escaping beyond `JSON.stringify`'s own) |
| `{"s":"a\"b"}` | `{"s":"a\"b"}` |
| `[undefined]` | `[null]` (SILENT case — parses either way) |
| `{"a":[undefined]}` | `{"a":[null]}` (SILENT case) |
| `[1, <hole>, 2]` (sparse) | `[1,null,2]` |
| `{"f": () => 1}` | THROW (serialization is not a string) |
| invalid `Date` | THROW, deliberate and identifiable |
| `NaN`, `Infinity`, `-Infinity` | THROW |

The corpus is deliberately small and total: each row pins one rule above, and
the rows together cover every branch of the algorithm.

## 14. Naming — the two `kind` vocabularies (v0.8; ruled 2026-08-12)

A reader meeting `receipt_settled` beside `billedUnfinalized` reasonably suspects
drift. It is not drift, and this section freezes the rule so no future
implementer "normalizes" one into the other and breaks a signed format.

**`event.kind` is snake_case. Every other `kind` in a ut1 document is
camelCase, or bare lowercase for single-word enums.**

The boundary is a NAMESPACE boundary, not a style preference: `event.kind`
values belong to the CHAIN's event vocabulary — written by the proxy's audit
writer, shared with every non-receipt event on that chain, and outside this
spec's authority to rename. Every other discriminator belongs to the ut1
DOCUMENT vocabulary, which this spec owns. The casing therefore carries
information: a snake_case kind tells you the string is the chain's, and that
changing it is a chain migration rather than a spec revision.

Verified against the conforming corpus (39 fixtures, every `kind` occurrence
enumerated by path, 2026-08-12) — the rule holds with zero exceptions:

| Path | Values | Case |
|---|---|---|
| `event.kind` (receipt + `terminalEvent`) | `receipt_settled`, `billing_terminal_no_receipt` | snake_case |
| `work.kind` | `commit`, `pr`, `issue`, `session` | bare |
| `work.origin.kind` | `billedUnfinalized` | camelCase |
| `work.contentBinding.kind` | `publicSha256`, `privateHmacSha256V1` | camelCase |
| `minter.kind` | `proxy` | bare |
| `advisories[].kind` | `receiptSuperseded`, `revisionSuperseded`, `generationAddendum` | camelCase |

The apparent collision is two DIFFERENT things one layer apart, both correct:
`billing_terminal_no_receipt` is the chain event that RECORDS a terminal, while
`billedUnfinalized` is the ut1 origin discriminator that REFERENCES it. Note
also §8's `receipt_superseded` (a chain event) versus the corpus's
`receiptSuperseded` (an advisory kind in the unsigned envelope) — same pair,
same rule, and neither is a typo for the other.

**Consequence:** a new chain event kind ships snake_case; a new ut1 advisory,
posture, or union discriminator ships camelCase. Renaming across the boundary
is never a cleanup — it is a format break.
