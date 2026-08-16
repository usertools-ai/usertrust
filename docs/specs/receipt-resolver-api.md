# Receipt Resolver API — v0.2 (companion-updated against receipt-spec v0.6-final)

Status: **v0.2 — the SIXTEEN §10 companion updates applied, and the verify
page's §4 concrete response schema adopted.** All sixteen §10 items now land
in full: the in-pin corrections that once held §10.13 to a part-landing and
§10.16 to none have been applied to the pinned section, and the pin
recomputed against this file. Interface owner: stealth (`apps/api`).
Consumer: the public verify page at `usertrust.ai/r/<id>` (usertrust instance)
and any third-party verifier.

**Normative inputs, in authority order:**

1. **`receipt-spec.md` — v0.6-final, FROZEN** (usertrust). This document
   treats the receipt ID as opaque and defers its format, the canonical
   projection, the canonicalization algorithm, and the signature scheme to
   that spec. Conflicts resolve in its favor, always. Its **§10** enumerates
   the sixteen companion updates this revision applies.
2. **`2026-08-11-verify-page-design.md` — v0.5, FROZEN FOR BUILD** (usertrust;
   v0.3 froze the schema, v0.4 carried the registryBinding conformity
   correction, v0.5 the failure-union completion and the rate-limit/opt-in
   syncs — the version-history block in that document names each; this
   document cites v0.5 as the single authoritative revision, round-3 gate F4).
   Its **§4** is the CONCRETE `apiVersion: "1"` response schema — the
   envelope union, the verdict algebra, the closed failure-code vocabulary,
   the non-receipt bodies, and the 429 exemption. Where §10 describes a
   change abstractly and §4 gives the concrete shape, **§4's shape is what
   this document transcribes**; where the receipt spec speaks, it still wins.
   §4 EXTENDS §10 rather than contradicting it: `receiptBytes`,
   `verification`, and `advisories` are envelope growth that §5 explicitly
   permits, so §10.1's six-member enumeration is a floor, not a closed set.
3. This document — the wire contract itself, owned by stealth.

Where §4 and §10 genuinely disagree, this revision **flags rather than
reconciles**; the three instances found are recorded under **§4 vs §10:
flagged discrepancies** near the bottom.

**Reference convention:** a bare `§N` in this document is a section of the
RECEIPT SPEC, never of this one (`§10.3` = the receipt spec's tenth section,
third companion item). This document's own sections are named, not numbered.
Parenthetical `round-N` markers are this document's own deliberation history
and are kept where the reasoning they record still binds.

**The Mint-lifecycle section below is CONTENT-PINNED — do not edit it.** The
receipt spec's §6a adopts it as normative for its §6, pinned by the digest of
THIS COMPLETE FILE; **§6a holds the pin's current value** and this banner
deliberately does not restate it, because a digest cannot name the bytes it
sits inside. The lineage behind that pin, oldest first:
`sha256:4c293c35fd9473ba474ff967a2d215e8fa399a43aaa36cb395a9747ca81c04d1`
was the v0.1 ancestor's digest;
`sha256:6260043a360e61f2e138c3d2f7832b3b9d1718f188ea1f56f04c0e9b9f62e18e`
was the v0.7-corrected copy held in the usertrust instance's own
`docs/specs/` (committed in usertrust PR #125); THIS v0.2 file supersedes
that copy as the normative companion, and §6a re-pins to it.
Everything outside that section is companion-updatable and is what v0.2
changes; §6a is explicit that later companion rounds do NOT adopt
automatically, so this document's head and tail may move ahead of the pin
without touching it. The three §10 items that named text INSIDE the pinned
section were all taken at the v0.7 re-pin — the changelog's re-pin bundle row
records them, and nothing remains deferred. Editing that section is a coordination event with
the usertrust instance (it forces a version bump and a re-pin on their side),
never a companion edit.

## Purpose

A receipt trailer on a commit/PR/issue replaces `Co-Authored-By` (Cam's
universal rule, 2026-08-08). The trailer is only as good as what the ID
resolves to. This API is the resolution: public, unauthenticated, cacheable
proof that the proxy executed and billed the work — model, timestamps, **$
amounts (public by directive — the flex is deliberate)**, and a Merkle
inclusion proof under a signed segment checkpoint of the audit chain.

The trailer's exact form is the spec's (§12), settled: the key is
`Usertrust-Receipt` (case-sensitive) and the value is the FULL https URL —

```
Usertrust-Receipt: https://usertrust.ai/r/ut1_<base58>
```

## Endpoint

```
GET https://api.usertools.ai/v1/receipts/{receiptId}
```

- **Public, no auth.** CORS `*` (page is on a different origin) — and because
  the contract makes consumers READ two non-safelisted headers, every
  response, **including 304 and 429 and anything a front-of-stack limiter
  emits**, carries `Access-Control-Expose-Headers: ETag, Retry-After` (gate
  round 2, F5): a browser-based third-party verifier that cannot read `ETag`
  cannot revalidate, and one that cannot read `Retry-After` cannot back off.
  Reading `ETag` is half the revalidation story — SENDING `If-None-Match` is
  the other half, and it is not a safelisted request header, so the endpoint
  answers **OPTIONS preflights** (round-3 gate, F6):
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET,
  OPTIONS`, `Access-Control-Allow-Headers: If-None-Match`, plus the
  Expose-Headers above. The closed response-code set governs GET responses;
  the OPTIONS preflight sits outside it.
- **`?include=checkpointHistory` — the complete history is OPT-IN** (gate
  round 2, F6). `checkpointHistory` is unbounded (genesis → head), so the
  default representation OMITS it — legal, since the member is optional — and
  ordinary revalidation stays O(1). The opt-in representation is a DISTINCT
  cache entry: its `ETag` differs from the default's, `Vary` semantics follow
  the query string, and its 304 discipline is evaluated against its own
  representation. Reaching `verified_checkpoint_history` requires requesting
  it; the verify page's ship-gate addendum carries the page-side sync.
- The pretty URL `https://usertrust.ai/r/{receiptId}` is the PAGE (usertrust
  side), which calls this API. The trailer cites the pretty URL, never this
  endpoint.
- **Rate limiting — dedicated reader-IP header with service-key
  authentication (Cam's ruling, 2026-08-10; option (b) ratified, superseding
  the forwarded-`X-Forwarded-For` form).** Limits are per READER and generous
  — it's a public verifier, but it sits in front of the ledger. The problem
  the ruling solves is that the verify page fetches SERVER-SIDE with
  `no-store` (verify-page R35/D1), so a naive per-IP limit sees the page
  service's egress address rather than the reader's and throttles every
  visitor on earth as one client. Four rules:

  1. **The verify-page service authenticates to this API with a SERVICE KEY,
     carried as `Authorization: Bearer <service-key>` and nowhere else** (gate
     round 2, F7). Query-string and cookie transport are PROHIBITED — a key in
     a URL leaks through logs, referrers, and caches. An invalid, expired, or
     absent key never yields a 401: the request degrades to ordinary
     anonymous peer attribution and is still served, because the key is a
     rate-limit attribution credential, not an access credential (see the
     non-goal below).
  2. **When that key validates AND the request originates from the page
     service's KNOWN EGRESS, the resolver honors `Usertrust-Reader-IP` and
     applies the per-reader limit to the address it carries.** Both
     conditions, not either: a valid key replayed from an unknown source does
     not unlock header trust. *(The working name `X-Usertrust-Reader-IP`
     appears in cross-instance coordination; the FINAL name drops the `X-`
     prefix — RFC 6648 deprecates it, and `Usertrust-Reader-IP` matches our
     own `Usertrust-Receipt` trailer convention. The usertrust addendum syncs
     to the final name.)*
  3. **`Usertrust-Reader-IP` is the ONLY attribution header, and inbound
     `X-Forwarded-For` is IGNORED ENTIRELY — on every request, authenticated
     or not.** `Usertrust-Reader-IP` presented by anything other than a valid
     key from known egress is likewise ignored, and the limit applies to the
     direct peer as normal. Neither header is ever trusted bare.
  4. **When `Usertrust-Reader-IP` is ABSENT on an authenticated page-service
     request, the keyed page-service allowance is the fallback FLOOR** — the
     page keeps working, at a service-wide budget rather than a per-reader
     one.

  **Malformed degrades to the floor; it never rejects.** A value that is not
  single-valued, or not an IP literal, falls back to rule 4's keyed
  page-service floor — **the request is still served.** A reader must never
  lose their receipt because a header they cannot see was wrong; attribution
  is a billing-of-quota question, not an integrity one, and nothing about the
  response body depends on it.

  **Why a dedicated header rather than `X-Forwarded-For`.** Two independent
  reasons, and the second is what decided it:

  - *Ambiguity of origin.* `X-Forwarded-For` is conventionally a
    comma-separated chain that readers can also populate. If the page appended
    to whatever a reader sent, a reader setting `X-Forwarded-For: 1.2.3.4` on
    their own browser request would make the page forward
    `1.2.3.4, <real reader IP>` — and taking the leftmost entry, the usual
    naive read, hands the reader control of their own rate-limit bucket, or
    lets them name someone else's. A header the page ALONE sets removes the
    ambiguity at the source: there is no inbound `Usertrust-Reader-IP` to
    merge with, because the page constructs the value rather than forwarding
    one, and a reader who sends the header directly to this API is ignored
    under rule 3 for want of a service key from known egress. Both halves of
    the spoof path are closed.
  - *Infrastructure collision — the deciding fact.* The page's hosting
    platform **rewrites `X-Forwarded-For` in transit**. Its semantics are
    therefore set by infrastructure neither side of this interface controls,
    and any rule we wrote about which entry to trust could be invalidated by a
    platform change we would not see. A dedicated header carries only what the
    page put in it.

  **The page CONSTRUCTS the value from the PLATFORM-ATTESTED client IP** — on
  Vercel, the platform's own trusted client-IP source — and never derives it
  from, or merges it with, an inbound `X-Forwarded-For`. That construction is
  the usertrust instance's verify-page ship-gate addendum
  (header-construction section); cited here, not specified here.

  **This is NOT an auth'd variant, and the non-goal below still holds.** The
  service key is a RATE-LIMIT ATTRIBUTION credential, never an access
  credential: it changes only WHICH bucket a request is counted against. The
  endpoint stays public and unauthenticated, an anonymous request gets the
  same bytes as a keyed one, and there is no privileged response shape, no
  additional field, and nothing a keyed caller can see that the public cannot.

  **Key provisioning and custody are specified elsewhere, deliberately.**
  The resolver service key lands with the MINT-KEY work under the EC2 custody
  pattern (receipt-spec §9-A H1: key material lives on the EC2 proxy host,
  never mini2, env-file custody consistent with the existing SurrealDB/Clerk
  secrets, or KMS if a rotation ceremony is wanted). Page-side key handling —
  storage, rotation, and the egress allow-list the page presents — is the
  same verify-page ship-gate addendum. Both are cited here, not specified
  here.
- **What the resolver serves is IMMUTABLE mint-time material (§10.4):** the
  persisted mint event, its inclusion proof, and the `SegmentCheckpoint` v2
  that sealed its segment — exactly the bytes minting froze, never a
  re-derivation against the current chain head. Live-head consistency is
  ADVISORY: a resolver may observe it and alert internally, but it is not a
  response input and never changes a status. The optional
  segment-checkpoint-history collection and anchor evidence are served
  alongside, unsigned, as EXTENSION material (§7 step 9).
- **Identity binding runs on EVERY read (§10.1/§10.15, shape per §4.1).**
  Route-ID = body-ID equality is unconditional, and on a receipt-bearing
  response it is checked against BOTH the top-level `envelope.receiptId` and
  `receipt.receiptId` — the two must agree with each other and with the route.
  The registry binding `receiptId → event.hash` is
  additionally checked server-side on every read THAT SERVES A RECEIPT. The
  qualifier is not a loophole: a `reserved` (202) or a
  `notMinted`/`cancelled`/`expired` (410) response has no mint event and
  therefore no binding to check — only the allocation from the spec's §3
  atomic reserve-time claim, which is what makes 404-vs-410 meaningful. From
  finalize onward the binding is mandatory on every read, and a binding that
  resolves to a different event is a 409, never a fallback to route equality.
  **`billedUnfinalized` is the one 410 that is NOT bindingless:** §10.15 gives
  it its own registry write, `originalReceiptId → terminalEvent.event.hash`
  (the terminal event nests as `terminalEvent.event` in the §4.2 bundle),
  under the same first-write-wins discipline, so that bundle is checkable by
  the same mechanism as a green receipt instead of being self-asserted.
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
  **The ETag covers the whole envelope, extension material included**, so a
  status that rises from `verified_checkpoint` to
  `verified_checkpoint_history` or `verified_anchored` (§10.14 — asynchronous,
  upgrade-only) invalidates it; a client must never revalidate its way into
  keeping a stale lower status. The receipt bytes themselves never change.

## Response — 200 (the envelope)

The 200 body is the **envelope**, in the concrete form the verify page's §4.1
defines and this document adopts (§5/§10.1 give the floor; §4.1 gives the
shape). Four tiers, and a consumer must not blur them:

1. **`receiptBytes` is the AUTHORITY for STORAGE, DOWNLOAD, and DIGEST** —
   the persisted signed bytes, verbatim. What `receipt.json` streams and what
   a digest is taken over. It is NOT the signature preimage: these bytes
   CONTAIN the signature, so nothing can be signed over them (see the
   signature block below for the actual preimage).
2. **`receipt.event.data`** (the projection) is **chain-committed**.
3. **The rest of `receipt`** is **signed** but not chain-committed —
   `mintedAt` and `minter` are the minter's own claims, and `work` is signed
   AND mirrored to a chain-committed copy under equality 9.
4. **`verification`, `advisories`, `anchorEvidence`, `checkpointHistory`, and
   `display`** are **unsigned**, and a consumer MUST label them as such.
   `verification` is the resolver's report of its own work — useful, and not
   evidence: anyone can redo it from `receiptBytes`, and should.

```jsonc
{
  "apiVersion": "1",                     // REQUIRED on every body except 429. A missing
                                         // or unsupported version FAILS CLOSED to the
                                         // consumer's protocol-error shell — unknown
                                         // MEMBERS under version 1 are tolerated
                                         // (the envelope may grow), unknown VERSIONS
                                         // and unknown statuses are never guessed at
  "receiptId": "ut1_3Qk8Ldz2Vv9tRb7mNc4Xp2",   // REQUIRED at the TOP LEVEL of every
                                         // body that has an ID (§4.1/§4.2) — this is
                                         // the envelope half of the identity chain, and
                                         // consumers check BOTH
                                         // `routeParamId === receipt.receiptId` AND
                                         // `=== envelope.receiptId` before rendering
                                         // anything green (verify-page R1)
  "status": "verified_checkpoint",       // R3-8 LADDER (§10.3) — one of
                                         // verified_checkpoint |
                                         // verified_checkpoint_history |
                                         // verified_anchored. The draft's single
                                         // "verified" is retired, and `verified_chain`
                                         // is NOT a ut1 name (it was renamed with the
                                         // verdict) — see "Status ladder" below

  "receiptBytes": "base64…",             // REQUIRED (§4.1). The PERSISTED SIGNED RECEIPT
                                         // BYTES, VERBATIM — exactly what the §6
                                         // registry's `event.hash → signed bytes`
                                         // mapping holds. AUTHORITATIVE FOR STORAGE,
                                         // DOWNLOAD, AND DIGEST: the CLI hashes these
                                         // bytes and the `receipt.json` route streams
                                         // them decoded and unchanged. The resolver MUST
                                         // NOT re-serialize the receipt to produce this
                                         // field — canonical-equivalence is not good
                                         // enough when the consumer's strict pipeline
                                         // (below) is stricter than JSON.parse.
                                         // NOT THE SIGNATURE PREIMAGE: these bytes
                                         // CONTAIN `signature`, so they cannot be what
                                         // was signed. Signature verification runs over
                                         // utf8("usertrust/receipt-signature/v1\n") ||
                                         // canonicalize(receipt − signature) — the
                                         // receipt spec §5's own wording — which is why
                                         // verification is canonical, not lexical, and
                                         // does NOT depend on serialization details
  "receipt": {                           // ── REQUIRED, and a PARSED CONVENIENCE COPY of
                                         // receiptBytes — for rendering, NEVER authority
                                         // (§4.1). Consumers equality-check the two
                                         // through a STRICT pipeline, not JSON.parse +
                                         // deep-equal (verify-page R4): canonical base64
                                         // decode → fatal UTF-8 decode → raw-JSON
                                         // DUPLICATE-KEY REJECTION BEFORE object
                                         // construction → the canonicalization
                                         // appendix's numeric/schema rules
                                         // (safe-integer-only, no NaN/±Inf/−0,
                                         // absent ≠ null) → structural comparison (key
                                         // order immaterial; the §5 preimage is
                                         // canonical, not lexical). Bytes a strict
                                         // verifier would reject are an integrity
                                         // failure EVEN IF a lenient parse accepts them.
                                         // Contents below: receipt-spec §5, verbatim.
                                         // Strict schema: any unknown field anywhere
                                         // inside `receipt` is FAIL
    "spec": "ut1",
    "receiptId": "ut1_3Qk8Ldz2Vv9tRb7mNc4Xp2",   // opaque locator, issued at RESERVE
                                         // time (spec §3) — 16 random bytes, base58btc.
                                         // THE RULE, and the whole of it: the value must
                                         // decode to EXACTLY 16 bytes AND re-encode
                                         // byte-identically (§12). The 16–22 character
                                         // range is a CONSEQUENCE of that rule, never a
                                         // test in its own right — do not shortcut it
                                         // with any length or prefix heuristic. Shorter
                                         // encodings are perfectly ordinary: a uniform
                                         // 16-byte value lands on 21 characters about
                                         // 2.8% of the time with no leading `1` at all,
                                         // so a "suspiciously short" ID is very often
                                         // valid and only the decode settles it
    "scope": "session",
    "mintedAt": "2026-08-09T02:11:04.512Z",  // the ONLY minter-asserted clock claim.
                                         // A signature input, never a trusted clock and
                                         // never a key-validity input (§10.13)
    "minter": { "kind": "proxy", "keyId": "usertrust-mint-2026a",
                "trustDomain": "usertrust.ai" },

    "work": {                            // REQUIRED — and an EQUALITY-CHECKED MIRROR of
                                         // event.data.work (spec §4 equality 9), never an
                                         // independent assertion. `work` is CHAIN-COMMITTED
                                         // inside the projection; the v0.5 minter-asserted
                                         // carve-out is gone
      "kind": "commit",                  // commit | pr | issue | session
      "repoId": "github.com:R_kgDOK1x2Yw",  // NORMATIVE scope: immutable provider-scoped ID
                                         // (keyed r1_… form for private repos) — round-12
      "repo": "github.com/usertools-ai/usertools-stealth",  // OPTIONAL display-at-mint
                                         // metadata, and ABSENT unless disclosure is
                                         // authorized (spec §2: provider-verified PUBLIC
                                         // visibility, or a recorded operator authorization);
                                         // canonical provider-URL form, ≤ 256 chars. For
                                         // undisclosed private repos a stable KEYED `repoId`
                                         // carries scope instead (round-4 F3, input fixed
                                         // round-9 F4): `"r1_" + base64url(HMAC-SHA-256(
                                         // repoIdKeyV1, providerHost || 0x00 ||
                                         // immutableRepositoryId))` — keyed off the provider's
                                         // IMMUTABLE repo ID, because a canonical URL is
                                         // mutable AND reusable (rename, then a new repo at
                                         // the old path collides). Plain SHA-256 is
                                         // dictionary-guessable; the HMAC key is never
                                         // exposed. Scope is NEVER simply dropped (round-3 F4)
      "oid": "37df16d3…<full 40/64-hex>",  // FULL git object ID — a display may truncate, the
                                         // receipt never does (32-bit prefixes are
                                         // transplantable)
      "oidAlg": "sha1",                  // sha1 | sha256 (repo object format)
      "objectSha256": "…",               // REQUIRED (round-18 F1; encoding round-26):
                                         // lowercaseHex(SHA-256(gitPreimage)) where
                                         // gitPreimage = ASCII("commit " +
                                         // byteLength(content)) ‖ 0x00 ‖ content — ONE
                                         // defined representation everywhere (provider APIs
                                         // often return content WITHOUT the git header;
                                         // minter and promotion gate must hash the same
                                         // bytes). Verifiers reject absence or short digests
      "repositoryMembership": {          // REQUIRED on artifact variants (round-15) — the
        "status": "providerVerified",    // chain-committed proof that this OID was observed
        "proofId": "…"                   // in the bound repository (provider event/fetch id).
      }                                  // `proofId` is an opaque server-generated handle
                                         // matching [A-Za-z0-9._-]{1,128} and MUST NOT embed
                                         // user data (spec §2's public-safety syntax)
      // Normative discriminated union (round-4 F4, scope normalized round-11
      // F2): EVERY variant carries `repoId` — the immutable provider ID (or
      // its keyed private form) — as the NORMATIVE scope, committed in the
      // projection and in the membership audit event and equality-checked at
      // verification; `repo` (the URL/name) is OPTIONAL display-at-mint
      // metadata under the disclosure rule, because names are mutable and
      // reusable (rename + recreate collides):
      //   type ProviderBound = { repositoryMembership: {
      //     status: "providerVerified", proofId: string } }   // REQUIRED and
      //                                             // chain-committed in every
      //                                             // artifact variant (round-14 F1)
      //                                             // — verifiers REJECT absence
      //   type Work =
      //     | ({ kind: "commit", repoId, repo?, oid, oidAlg,
      //          objectSha256 }                     & ProviderBound)  // SHA-256 of the
      //                                             // provider-FETCHED object,
      //                                             // chain-committed (round-17 F3) — the
      //                                             // promotion gate hashes the raw fetched
      //                                             // merge candidate and compares; without
      //                                             // it, chosen-prefix SHA-1 twins are
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
      //                                             // exposed; chain-committed; the resolver
      //                                             // recomputes it from provider-fetched evidence.
      //                                             // `canonicalContent` is OWNED AND VERSIONED by
      //                                             // the receipt spec (round-28) — it must pin the
      //                                             // exact byte representation (which fields, UTF-8
      //                                             // encoding, Unicode normalization, line endings,
      //                                             // null-body handling) or adapters and verifiers
      //                                             // derive different commitments for the same
      //                                             // revision. It is NOT YET WRITTEN and is a ship
      //                                             // gate for pr/issue minting only (spec §11) —
      //                                             // v1's commit path does not depend on it.
      //                                             // Bodies are MUTABLE (round-33 F4):
      //                                             // finalization retains an immutable canonical
      //                                             // evidence snapshot (or a provider-signed,
      //                                             // revision-addressable equivalent) and ALL
      //                                             // recomputation runs against that frozen
      //                                             // revision, never current provider state — an
      //                                             // ordinary edit must not 409 a valid receipt;
      //                                             // it renders `revisionSuperseded` (below).
      //                                             // Where retention is prohibited AND the provider
      //                                             // cannot serve immutable revisions, that receipt
      //                                             // mode is REJECTED at reserve.
      //                                             // lives IN work, chain-committed, equality-
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

    "event": {                           // the chain's REAL envelope (spec §4/§4a),
                                         // FIELD-COMPLETE and canonicalizing to the same
                                         // bytes as the persisted event. The draft's
                                         // synthetic `proof.sessionDigest` — its
                                         // {version, previousHash, sequence, occurredAt,
                                         // payload{receiptId, claimsHash, transferSetRoot}}
                                         // object plus a separate `eventHash` — is RETIRED
                                         // (§10.2): one shape, one hash rule. The
                                         // `claimsHash` indirection goes with it — the
                                         // PROJECTION *is* the committed claim set, so
                                         // there is no digest-of-a-subset to reconstruct
      "id": "…",
      "timestamp": "2026-08-09T02:11:03.980Z",
      "previousHash": "…",               // linear-chain predecessor
      "kind": "receipt_settled",
      "actor": { "type": "system", "id": "receipt-minter", "name": "receipt-minter" },
                                         // the §4a closed-union system OBJECT, exactly —
                                         // never a user/tenant identifier (the no-PII rule
                                         // extends to the embedded envelope). The string
                                         // form "receipt-minter" belongs to a future
                                         // ut-chain profile and ut1 never emits it
      "data": {                          // ── THE PROJECTION (spec §2). Every field here is
                                         // chain-committed and Merkle-provable. Strict
                                         // schema: unknown fields are FAIL
        "spec": "ut1",
        "scope": "session",
        "sessionId": "…",                // STABLE SCOPE ID — a nonce/ULID minted at session
                                         // open, never a content hash (spec §9-A.c). It is
                                         // NOT the reservation handle: the handle is
                                         // per-reservation, mint-side, and this document's
                                         // to define; the scope ID is carried forward
                                         // unchanged across reservations in the same scope
        "generation": 1,                 // ≥ 1. Generation 1 attests the COMPLETE session;
                                         // > 1 exists only as an operator-acknowledged
                                         // addendum carrying prevGenerationEventHash
                                         // (key-ABSENT at generation 1, as here). A commit's
                                         // trailer cites generation 1 forever; addenda are
                                         // advisory-surfaced, never a trailer rewrite
        "work": { /* the same object mirrored above — equality 9 */ },
        "sessionAssociation": "workflowAttested",  // | "ownerAsserted". REQUIRED. A posture,
                                         // never an inference: `workflowAttested` only when a
                                         // trusted execution workflow controlled the
                                         // reservation, the model traffic, the workspace, and
                                         // the artifact creation. Pages MUST render the two
                                         // postures DISTINCTLY — identical rendering is
                                         // forbidden
        "workloadId": "…",               // the SERVER-ASSIGNED attested workload identity,
                                         // bound by the orchestrator before any traffic and
                                         // never caller-selected, scoped to the provenance
                                         // CLOSURE. Present IFF sessionAssociation ===
                                         // "workflowAttested"; key-ABSENT otherwise. Same
                                         // opaque-handle syntax as proofId
        "models": ["claude-fable-5"],    // sorted unique, ASCII-lexicographic;
        "providers": ["anthropic"],      // PUBLISHED-CATALOG identifiers only, or the single
                                         // fixed literal "custom" (deduped) for any
                                         // non-catalog / custom-rate model — an internal
                                         // alias is exactly the string that leaks a customer
        "startedAt": "2026-08-09T01:02:11.000Z",   // chain timestamps of the first/last
        "endedAt": "2026-08-09T02:10:58.101Z",     // constituent event — clock CLAIMS
        "spend": {
          "assessedUsertokens": 48224,   // metered-or-estimated assessed cost, summed with
                                         // the ledger's PER-TRANSFER rounding.
                                         // WORKED EXAMPLE (round-4 F1 — the numbers below
                                         // actually satisfy the equation): raw products
                                         // 24373.23 + 22842.63 + 993.15 = 48209.01;
                                         // A = ceil → 48210; + roundingAdjustment 14 = 48224
          "postedUsertokens": 48224,     // ledger-POSTed total over the POSTed pairs. In ut1
                                         // this MUST EQUAL assessedUsertokens — the adopted
                                         // lifecycle posts actualAmount under a ceiling, so a
                                         // settlement shortfall cannot occur; verifiers reject
                                         // posted ≠ assessed outright
          "roundingAdjustment": 14,      // CHAIN-COMMITTED here (§10.5/§10.11), 0 ≤ n ≤
                                         // transferCount. The ledger rounds PER TRANSFER —
                                         // Σ max(1, ceil(per-transfer cost)) — and ceiling is
                                         // not distributive, so the aggregate recompute alone
                                         // can understate the posted total (two 0.4-usertoken
                                         // transfers post 1+1=2, aggregate says 1). Its
                                         // committed purpose is BOUNDED HONESTY, not offline
                                         // recomputability: the bound fixes that per-transfer
                                         // rounding added at most ONE usertoken per transfer,
                                         // so omitted usage cannot hide behind an arbitrarily
                                         // large "rounding" term. Non-negative because
                                         // per-transfer minimum charging can only round UP
          "transferCount": 122,          // ≥ 1 — POSTed LOGICAL PAIRS only (empty sessions
                                         // are unmintable)
          "usagePosture": "provider",    // provider | mixed | estimated — "provider" = EVERY
                                         // constituent priced from provider-reported usage;
                                         // "estimated" = every constituent used the estimate
                                         // path; "mixed" = both. Estimates are NOT a
                                         // guaranteed upper bound and the page must say so
          "pricingPosture": "exact"      // exact | conservative — the RATE-side posture (see
                                         // "Amount fidelity" below)
        },
        "pricing": { "tableVersions": ["2026-08-08"] },  // sorted unique; a session may span
                                         // versions. NOTE what is committed here: the
                                         // VERSIONS only — no content hashes, no deployment
                                         // records (§10.5b)
        // "transferSet": [...]          // PRESENCE IS A RULE, NOT AN OPTION (§10.12):
                                         // present IFF transferCount ≤ 32, ABSENT IFF > 32.
                                         // This example has 122 pairs, so it is ABSENT. When
                                         // present it carries exactly transferCount members
                                         // { authorizationTransferId, settlementTransferId }
                                         // in CHAIN ORDER, no ID repeated in either position,
                                         // and verification step 8 RECOMPUTES the root from
                                         // them. Above 32 the root is a commitment only
        "transferSetRoot": "…"           // ALWAYS. sha256( utf8("usertrust/receipt-transfers/
                                         // v1\n") || canonicalize(fullOrderedPairList) ),
                                         // lowercase hex — it commits the PAIRS, not bare IDs
                                         // (round-33 F1). The name and the pair semantics are
                                         // unchanged from the draft; the spec renamed ITS
                                         // field to match (§10.12)
      },
      "sequence": 8123421,
      "hash": "…"                        // = sha256(canonicalize(event − hash)), key-absent
                                         // exclusion. The verifier RECOMPUTES it from the
                                         // embedded envelope
    },

    "proof": {
      "profile": "proxy-v1",             // §4a — NAMES the equality set the verifier applies.
                                         // It is never inferred from the shapes on the wire,
                                         // and it is cross-checked against the registered
                                         // chains[] entry for `chain`
      "chain": "usertools-prod-audit",   // the vaultId
      "mintEventHash": "…",              // === event.hash === inclusion.leafHash (equality 1)
      "inclusion": {                     // MerkleInclusionProof, verbatim. ONE TREE PER
                                         // SEGMENT: `segmentId` is normative and load-bearing,
                                         // `leafIndex` is SEGMENT-RELATIVE, `treeSize` is the
                                         // SEGMENT's leaf count
        "version": 1,
        "leafHash": "…",                 // the RAW event hash (hex). Verification computes
                                         // leaf = sha256(0x00 ‖ hexDecode(leafHash)) and
                                         // interior = sha256(0x01 ‖ left ‖ right) over
                                         // DECODED bytes, odd nodes promoting
        "leafIndex": 21,                 // = event.sequence − checkpoint.segmentFirstSequence
                                         // = 8123421 − 8123400 (equality 4), and
                                         // 0 ≤ leafIndex < treeSize
        "treeSize": 32,
        "root": "…",
        "siblings": [                    // Example kept internally VALID (round-4 F6, now
                                         // against a 32-leaf segment): leafIndex 21 in a
                                         // 32-leaf tree needs EXACTLY 5 siblings, and their
                                         // sides are forced — 21 odd → left, 10 even → right,
                                         // 5 odd → left, 2 even → right, 1 odd → left
          { "hash": "…", "position": "left"  },
          { "hash": "…", "position": "right" },
          { "hash": "…", "position": "left"  },
          { "hash": "…", "position": "right" },
          { "hash": "…", "position": "left"  }
        ],
        "segmentId": "seg-000412"
      },
      "checkpoint": {                    // SegmentCheckpoint v2 (§4a) — REPLACES the draft's
                                         // v1 `PublishedMerkleRoot` block entirely (§10.10).
                                         // A v1 object in a receipt is FAIL: its root-only
                                         // signature left `treeSize` unauthenticated
                                         // (leaf-hiding) and the lineage edge lived OUTSIDE
                                         // the signed payload (rewritable while every
                                         // signature still verified)
        "v": 2,
        "vaultId": "usertools-prod-audit",   // SIGNED — with `profile`, this is what makes the
        "profile": "proxy-v1",               // statement say WHICH CHAIN it belongs to. Without
                                         // them one checkpoint key trusted by two vaults would
                                         // let the same event/proof/checkpoint be labeled as
                                         // either chain, with receipt-signed proof.chain /
                                         // proof.profile unable to settle it
        "root": "…",
        "treeSize": 32,                  // === inclusion.treeSize (equality 5)
        "segmentId": "seg-000412",       // === inclusion.segmentId (equality 8)
        "segmentFirstSequence": 8123400, // carried for equality 4, and it is the offline
                                         // retirement-boundary input for §8's key states
        "previousSegmentRoot": "…",      // the SIGNED lineage edge. Genesis: both fields are
        "previousSegmentId": "seg-000411",   // the fixed string "genesis" for the first segment
        "keyId": "usertools-audit-root-2026a",
        "publishedAt": "2026-08-09T02:11:04.000Z",   // a signed input, and NOT a trusted clock
        "sig": "base64…"                 // Ed25519 over canonicalize(unsigned payload)
                                         // NOTE what is NOT here: no `publishedTo` (§10.3/
                                         // §10.8 — it disappears entirely) and no `reference`
                                         // (§4a REMOVED it rather than constraining it —
                                         // publication is evidence, not proof, and it lives
                                         // outside the signed statement)
      }
    },

    "signature": {                       // over utf8("usertrust/receipt-signature/v1\n") ||
                                         // canonicalize(receipt − signature)
      "alg": "ed25519",
      "keyId": "usertrust-mint-2026a",   // === minter.keyId; role `mint`, minterKind `proxy`
      "sig": "base64…"                   // exactly 64 bytes, RFC 8032 strict
    }
  },

  "verification": {                      // ── REQUIRED on 200 AND on 409 (§4.1). The
                                         // resolver's STRUCTURED RESULTS, made
                                         // wire-visible so a consumer can render the
                                         // verdict function's INPUTS and not just its
                                         // output. Unsigned: it is the resolver's own
                                         // report of a computation the consumer can
                                         // redo from `receiptBytes`
    "trustSnapshotId": "…",              // REQUIRED — WHICH pinned trust-document
                                         // snapshot this verification ran under.
                                         // Verdicts are relative to a snapshot and the
                                         // verifier says which one; a later snapshot may
                                         // legitimately turn a pass into a fail
    "steps": {                           // the NINE §7 steps. Each entry is
                                         // { result: passed | failed | notApplicable
                                         //   | unavailable, failure?: "<CODE>" }, with
                                         // `failure` present IFF result === "failed" and
                                         // drawn only from that step's closed code
      "schema":      { "result": "passed" },   // 1 — SCHEMA_INVALID (the wire name for
                                         //     step 1 is owned by §4; §7 names 2–9)
      "event":       { "result": "passed" },   // 2 — EVENT_MISMATCH
      "registry":    { "result": "passed" },   // 3 — ID_MISMATCH (both halves)
      "signature":   { "result": "passed" },   // 4 — SIG_INVALID
      "inclusion":   { "result": "passed" },   // 5 — PROOF_INVALID
      "checkpoint":  { "result": "passed" },   // 6 — CHECKPOINT_INVALID
      "semantics":   { "result": "passed" },   // 7 — SEMANTIC_INVALID
      "derivations": { "result": "passed" },   // 8 — DERIVATION_MISMATCH;
                                         //     notApplicable when transferSet is absent
      "extensions":  { "result": "passed" }    // 9 — summary; per-check detail below
    },
    "checks": {                          // the FOUR named ONLINE checks, same
                                         // four-valued entries
      "registryBinding":    { "result": "passed" },        // 3(b) — mandatory
                                         // server-side on every read serving a receipt
      "predecessorLinkage": { "result": "notApplicable" }, // generation 1 has no
                                         // predecessor to check
      "checkpointHistory":  { "result": "notApplicable" }, // failure: HISTORY_INVALID
      "anchorEvidence":     { "result": "unavailable"   }  // failure: ANCHOR_INVALID
    }
  },

  "advisories": [],                      // ── REQUIRED on 200; MAY be empty. Advisory
                                         // ONLY — no member ever alters the verdict or
                                         // its rendering register. Defined kinds:
                                         //   { kind: "revisionSuperseded",
                                         //     observedRevision, currentRevision }
                                         //     — pr/issue only (§10.1)
                                         //   { kind: "receiptSuperseded",
                                         //     supersededByReceiptId, eventHash }
                                         //     — the §8 advisory; never a verdict change
                                         //   { kind: "generationAddendum",
                                         //     generation, receiptId }
                                         //     — one per addendum (§6a); the commit's
                                         //     trailer still cites generation 1 forever
                                         // An UNKNOWN kind is rendered generically by
                                         // name — never silently dropped, never
                                         // verdict-affecting

  // BOTH optional members are ABSENT in this example, which is one sufficient
  // reason its `status` is the floor value. PRESENCE ALONE NEVER UPGRADES the
  // status — only the corresponding CHECK returning `passed` does (gate round 2,
  // F4). Partial, invalid, or merely-present-but-unverified extension material
  // stays attached for diagnosis while the status holds the base rung; a
  // response carrying `checkpointHistory` beside `verified_checkpoint` is
  // therefore legal exactly when `checks.checkpointHistory` is not `passed`.
  // Statuses are computed fresh per response from the CURRENT check results:
  // "upgrade-only" means an extension can never DEMOTE the base verdict, not
  // that a rung, once served, is remembered — a later response during an
  // extension outage may sit at a lower rung than an earlier one, and
  // consumers cache verdicts per response (ETag), never across them.
  //
  // "anchorEvidence": { /* RekorReceipt */ }   // ── UNSIGNED, OPTIONAL. Rekor = the repo's
  //                                      // existing RekorReceipt shape (stored bytes +
  //                                      // artifact hash + log inclusion proof + signed log
  //                                      // checkpoint + pinned log key), independently
  //                                      // verifiable offline → upgrades the status to
  //                                      // `verified_anchored`. S3 Object Lock evidence is
  //                                      // OPERATOR-ASSERTED configuration probing
  //                                      // (anchor-doctor output): it is labeled as such and
  //                                      // can NEVER by itself reach `verified_anchored`.
  //                                      // Here it is `unavailable` — the evidence exists but
  //                                      // could not be fetched, which is a clean 200 at the
  //                                      // floor status and never a 503 (§10.4)
  //
  // "checkpointHistory": [ /* SegmentCheckpoint v2[] */ ]  // ── UNSIGNED, OPTIONAL. The
  //                                      // COMPLETE segment-checkpoint history from the
  //                                      // REGISTERED genesis (`genesisSegmentId`) to a head
  //                                      // at/after this receipt's segment. Serving it — and
  //                                      // its walking clean — upgrades the status to
  //                                      // `verified_checkpoint_history`; a partial history,
  //                                      // or one accepted with warnings, upgrades NOTHING.
  //                                      // Here it is `notApplicable`: the proxy does not yet
  //                                      // serve a bound history, which is the launch ceiling

  "display": {                           // ── UNSIGNED, and EXPLICITLY NOT CHAIN-COMMITTED
                                         // (§10.1). Consumers MUST NOT treat any of it as
                                         // attested and the page MUST label it. Everything
                                         // here still obeys the spec's public-safety rules —
                                         // unsigned does not mean unpublished
    "amountUsd": "4.8224",               // COMPUTED, never stored: assessedUsertokens / 10000
                                         // by integer quotient/remainder, exactly four
                                         // decimals, no floating point. It is the one display
                                         // value that IS reproducible from signed material —
                                         // a pure function of a chain-committed field — so a
                                         // verifier EMITS it rather than comparing it; it can
                                         // never "mismatch" (step 8)
    "agent": "minidev",                  // §10.6: the draft's execution.agent / .interactive
    "interactive": false,                // are NOT in the projection and are display data
                                         // here. They may NOT be reintroduced as
                                         // "minter-asserted work-class fields" — v0.6 removed
                                         // the minter-asserted `work` class entirely, and
                                         // these two are neither work nor committed
                                         // NOTE: extension availability is NOT reported
                                         // here. v0.2 briefly improvised a
                                         // `display.extensions` member because §10.4
                                         // requires an unreachable extension be REPORTED
                                         // while §10.1's envelope had nowhere to put a
                                         // check RESULT. §4.1 answers that properly with
                                         // the top-level `verification.checks` above, so
                                         // the improvisation is DROPPED — one place
                                         // reports check results, and it is not `display`
    "pricingTables": [                   // §10.5b: content hashes and deployment records are
                                         // NOT chain-committed in ut1 (the projection commits
                                         // pricing.tableVersions and nothing more), so they
                                         // live here, labeled, or are dropped. They must
                                         // NEVER render as if the chain vouched for them
      { "pricingTableVersion": "2026-08-08", "pricingTableSha256": "…" }
    ],
    "breakdown": [                       // §10.11: the recompute basis, DISPLAY DATA. One row
                                         // per (provider, model, usageTier, pricedAsTier,
                                         // pricingDeployment, adapterPolicy?, ratePer1k). A
                                         // session that spans a pricing-table deployment gets
                                         // TWO rows for the same tuple, each at the rate
                                         // actually applied (round-4 F5) — never a blended
                                         // rate that exists in no published table
      { "provider": "anthropic", "model": "claude-fable-5",
        "usageTier": "input", "pricedAsTier": "input",
        "pricingTableVersion": "2026-08-08", "pricingTableSha256": "…",
        "pricingDeployment": { "deploymentId": "deploy_…",
          "registryVersion": "2026-08-08", "registrySha256": "…" },
        "tokens": 812441, "ratePer1k": "30", "usertokens": 24373 },
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
    ]
  }
}
```

### The verdict algebra (§4.1 — complete, and the resolver is bound by it)

A 200 bearing any `verified_*` status is VALID only when all three rules
below hold. This is not advice to the consumer: the consumer enforces it as a
FUNCTION, and any violation is a protocol error on OUR side — *a resolver that
computed these results and still answered 200 must not have.* Serving a body
that violates the algebra is therefore a resolver bug, not a rendering
question.

1. **Mandatory base steps, all `passed`:** `schema`, `event`, `registry` (the
   step-3 locator half), `signature`, `inclusion`, `checkpoint`, `semantics`.
   For these, `failed` is disqualifying **and so are `unavailable` and
   `notApplicable`** — a mandatory step that did not run is not a
   verification. The only exceptions §7 allows are step 3(b) and the
   derivation/extension steps, enumerated next.
2. **Named non-mandatory results:** `derivations` is `passed` or
   `notApplicable` (the latter exactly when `transferSet` is absent) — never
   `failed` or `unavailable` on a 200, because that recompute needs nothing
   outside the receipt. `steps.extensions` (the step-9 SUMMARY) may hold any
   result, **but never a summary-level `failure` code** (round-3 gate, F3):
   the union's codes are each legal only on their own named check —
   `HISTORY_INVALID` on `checks.checkpointHistory`, `ANCHOR_INVALID` on
   `checks.anchorEvidence` — and a singular member could not summarize both
   failing anyway. The summary aggregates RESULTS (`failed` iff any named
   extension check failed); the codes live solely under the named checks. **`registryBinding` MUST be `passed` on every
   resolver-issued 200.** The registry is this API's own backing store — §6
   writes `receiptId → event.hash` and `event.hash → signed bytes` in the same
   atomic registry write, so a resolver that read the bytes it is serving
   could have read the binding, and the binding is the authoritative
   locator→event association precisely because the projection carries no
   `receiptId` of its own (§10.15). Store unreachable → **503** (§10.4 already
   lists "receipt store unreachable" as a 503 condition); missing or
   conflicting final binding → **409 `ID_MISMATCH`**. `unavailable` and
   `notApplicable` for this check are reserved for OFFLINE verification
   reports, whose actor genuinely cannot query a registry (§7's rule,
   unchanged for that actor). `predecessorLinkage` is `passed`,
   `notApplicable` (generation 1), or `unavailable`.
   **`registryBinding: failed` or `predecessorLinkage: failed`
   on a 200 is INVALID** — those two fail only on a POSITIVE CONTRADICTION (a
   binding to a different event; a predecessor hash that is not
   generation−1's), and a resolver that verified a contradiction has no
   business serving the receipt as verified. It answers 409.

   > **Resolution record (gate round 2 F3 / round 3 F1 — RESOLVED).** The
   > closed union originally had no code legal for `checks.predecessorLinkage`
   > — a frozen-union gap, escalated rather than patched. Adopted at source in
   > this document's proposed form: **receipt-spec v0.7** adds
   > **`PREDECESSOR_MISMATCH`, legal only on `checks.predecessorLinkage`**,
   > alongside an explicit named-check code mapping (registryBinding →
   > `ID_MISMATCH`, checkpointHistory → `HISTORY_INVALID`, anchorEvidence →
   > `ANCHOR_INVALID`); verify-page v0.5 carries the matching union.
   > Mapping-to-existing was rejected at source because it would break the
   > code↔check bijection that makes misplaced-code validation mechanical.
   > The eleven-code union governs; a `predecessorLinkage` contradiction
   > answers 409 with `PREDECESSOR_MISMATCH`.

   > **Resolution record (gate round 1, F3 — RESOLVED).** The v0.2
   > transcription initially matched verify-page §4.1 rule 2 verbatim, which
   > permitted `unavailable` on a 200; that was escalated as a frozen-spec
   > defect (actor conflation: §7's offline-verifier rule inherited into a
   > resolver-side algebra where its premise does not hold) and ADOPTED at
   > source — verify-page is now DRAFT v0.4, carrying the same requirement,
   > classified there as a conformity correction to receipt-spec §10.1. The
   > page-side consequence: a 200 whose `registryBinding` is not `passed` is
   > treated as a protocol error.
3. **Extension checks CAP the status, and the ladder is CUMULATIVE:**
   `verified_checkpoint_history` REQUIRES `checkpointHistory: passed`;
   `verified_anchored` REQUIRES `anchorEvidence: passed` **AND**
   `checkpointHistory: passed` (§7's "additionally" chains the rungs). An
   extension that is `failed` or `unavailable` NEVER demotes the base verdict
   — but it CAPS the status at the rung below that extension, and a status
   above its cap is a protocol error.

> **Consequence worth stating plainly:** because rung 3 presupposes rung 2,
> Rekor anchoring ALONE cannot produce `verified_anchored`. Until the
> checkpoint-history pipeline (§9-B.1) ships and the resolver actually SERVES
> a complete bound history, the honest ceiling is `verified_checkpoint` no
> matter how well anchoring works. See "§4 vs §10: flagged discrepancies" —
> §10.14's phrasing alone would permit anchored-without-history, and §4.1 +
> §7 do not.

**Failure-code union — CLOSED, no free text anywhere in `verification`.**
`failure` is present iff `result === "failed"`, and is exactly one of:
`SCHEMA_INVALID` (step 1), `EVENT_MISMATCH` (2), `ID_MISMATCH` (3, both
halves), `SIG_INVALID` (4), `PROOF_INVALID` (5), `CHECKPOINT_INVALID` (6),
`SEMANTIC_INVALID` (7), `DERIVATION_MISMATCH` (8), `HISTORY_INVALID`
(`checkpointHistory`), `ANCHOR_INVALID` (`anchorEvidence`). Each code is legal
ONLY on its own step or check; an unknown or misplaced code is a schema
failure and fails closed. `SCHEMA_INVALID` is the one code §7 does not name —
§4 owns step 1's wire name.

### The breakdown rows are display data — what that changes

The rows above carry **no cryptographic commitment at all** (§10.11). The
draft committed them inside `claimsHash`; ut1 has no `claimsHash`, and the
spec's H2 model deliberately dropped the commitment rather than pretending
otherwise. What replaces it is narrower and stronger where it counts: the
TOTALS and `roundingAdjustment` are chain-committed in the projection.
Everything the rows are still good for is therefore **resolver-side and
display-grade**, and none of it is a verifier verdict:

- **Row → table → deployment is a TRIPLE cross-check the RESOLVER performs
  online**, not an offline claim: each row's table reference must equal
  exactly one `display.pricingTables[]` entry AND the table referenced by the
  signed deployment record, and `ratePer1k` validates ONLY against that one
  table — matching a row to a table by its claimed rate would be circular.
  Rates are not self-authenticating (round-22 F3): the signed, immutable
  pricing-table registry is what authenticates them, and a row that fails this
  check is an internal alert, not a receipt failure.
- Table versions carry SIGNED ACTIVATION RANGES and each intent persists the
  active deployment reference BEFORE PENDING (round-33 F3: matching any
  historical signed table lets a pre-increase cheaper version pass after a
  price change); rows split by deployment, and the resolver verifies every
  constituent used the deployment active at its admission. **This is an
  UNSIGNED, resolver-side display check — full stop.** It is not a mint-time
  attestation and an offline verifier cannot treat it as one: the rows, the
  deployment references, and the table hashes are unsigned display data a
  resolver can alter without invalidating any signature, so there is nothing
  here for an offline verifier to authenticate. (Making it a real attestation
  is not a wording change: the deployment data would have to be covered by the
  signed receipt or the chain-committed projection. That is the §9-B
  follow-up class — new committed material, not new prose.)
- Tier DOMAINS are explicit (round-35): `PricedTier = input | output |
  cacheRead | cacheWrite`; `UsageTier = PricedTier | "unknown"`.
  `pricedAsTier` and `candidateTiers` draw from `PricedTier` ONLY — `"unknown"`
  is legal solely in `usageTier` on conservative fallback rows. Each row
  carries BOTH `usageTier` (what the tokens WERE) and `pricedAsTier` (what
  rate class was APPLIED) (round-28: a conservative-fallback cacheRead row
  priced at the input rate would otherwise fail the signed-table tuple check).
  `ratePer1k` — USERTOKENS PER 1,000 TOKENS — validates against the signed
  table's `pricedAsTier` entry AND must satisfy `appliedRate ≥
  nativeUsageTierRate` from the SAME signed table (round-30: without the
  floor, output-priced-as-input passes every check while understating —
  "conservative" must mean can-only-round-UP).
- Unknown tiers are REPRESENTABLE (round-31, candidate sets round-32):
  `usageTier: "unknown"` with `candidateTiers` — the SIGNED,
  adapter-registry-declared set of tiers the tokens could have been — and
  `pricedAsTier` the MAXIMUM-rate member of that set, `pricingPosture ===
  "conservative"`, plus a row-level `fallbackReason`. The set is per-adapter
  and signed because a global maximum would demand the output rate for prompt
  tokens (the OpenAI/Gemini fallback truthfully bills unknown prompt splits at
  the input rate — the max over {input, cacheRead}, not over all tiers).
  Fallback rows carry the adapter-policy reference `{adapterId,
  adapterRevision, adapterRegistryVersion, adapterRegistrySha256}`, which also
  joins the aggregation key (round-33 F2: without it a self-declared narrowed
  candidate set passes every check).
- A row's `usertokens` is informational display only —
  `round-half-even(tokens × ratePer1k / 1000)` — and is NOT a term in the
  equation, which uses the rows' raw products.

## Status ladder (§10.3, §10.7, §10.14)

A 200 carries exactly one of three statuses. The draft's single `"verified"`
is retired, and `verified_chain` is not a ut1 name — it was renamed together
with the verdict it reports.

| Wire `status` | Verifier verdict | Earned by |
|---|---|---|
| `verified_checkpoint` | `VERIFIED_CHECKPOINT` | Base steps 1–8 pass. **Floor for a 200**, and the honest LAUNCH CEILING until a complete history is actually served. |
| `verified_checkpoint_history` | `VERIFIED_CHECKPOINT_HISTORY` | Additionally, the resolver SERVED a complete segment-checkpoint history rooted at the registered genesis, and it walked clean (`checkpointHistory: passed`). |
| `verified_anchored` | `VERIFIED_ANCHORED` | Additionally, valid Rekor evidence validates offline against a pinned log key (`anchorEvidence: passed`) — **and, the ladder being cumulative, `checkpointHistory: passed` too** (§4.1). S3 Object Lock evidence upgrades nothing. |

Three consequences the draft got wrong and v0.2 fixes:

- **External publication BY ITSELF upgrades NOTHING (§10.7/§10.14).** What
  upgrades a status is the resolver SERVING the material. Publishing a
  checkpoint to a sink and never serving the evidence changes no status at
  all. Mint defers only on LOCAL checkpoint existence — specifically on the
  mint event's segment being SEALED — so push-gating never depends on external
  sink availability.
- **A checkpoint-only receipt is a legal, honest 200 (§10.14).** The draft's
  "a 200 never carries an unanchored root", its non-empty `anchors[]`
  requirement, and its 202 `{status:"anchoring"}` holding state are ALL
  retired. A minted receipt never waits at 202 for an external sink.
- **The status is recomputed PER RESPONSE and can move in either direction as
  optional evidence becomes available or unavailable** (round-3 gate, F5,
  aligning with the envelope rules): a receipt served today at
  `verified_checkpoint` may serve at `verified_anchored` tomorrow — and at
  `verified_checkpoint` again during an extension outage. The signed receipt
  bytes are identical throughout; "upgrade-only" means extension failures
  never lower the BASE cryptographic verdict, not that a rung, once served,
  is remembered. **A response whose rung differs from the previous
  representation carries a changed `ETag`** — a consumer can cache a verdict
  per response, never across them.

`"reserved"` is the only 202 this ladder recognizes — a state of the ID
BEFORE it has a receipt, never a state of a minted proof. (`"reconciling"`
sits on the same pre-mint side of that line: it is mint-side machinery this
document owns, and it survives.)

## Display states (never a `status`, never a verdict)

Both states below travel on the wire as `advisories[]` entries (§4.1) and are
rendered as display states. The distinction matters: an advisory is a MEMBER
OF THE RESPONSE, while a `status` is the verdict — and no advisory ever
alters the verdict or its rendering register.

**`revisionSuperseded` (§10.1; wire kind `revisionSuperseded`, carrying
`observedRevision` + `currentRevision`).** For `pr`/`issue` receipts, when the
artifact's CURRENT revision is newer than the receipt's
`work.observedRevision`, the page reads *"attests revision
`<observedRevision>`; the artifact has since changed"*. A post-finalization
edit is NOT a failure — the receipt attests the frozen revision and keeps
attesting exactly that — so this is a display state only: never a `status`
value, never a verdict change, and never silently dropped in favor of a plain
green check. The two revision meanings must not be confused: at FINALIZATION
a revision/content mismatch is a mint-side FAIL and no receipt exists; AFTER
finalization an ordinary edit is `revisionSuperseded`. A DIFFERENT artifact is
still a transplant and still fails.

**`receiptSuperseded` — the ADVISORY (§4.1); `receipt_superseded` — the
CHAIN EVENT (spec §8). Two names for two different things, and the casing is
the tell.** The wire advisory kind is camelCase `receiptSuperseded`, carrying
`supersededByReceiptId` + `eventHash`, and it is what belongs in
`advisories[]`; the underlying chain event kind is snake_case
`receipt_superseded`, defined by the receipt spec, and it never appears as an
advisory kind. Emitting the snake_case form on the wire would be silently
lossy rather than loudly wrong — a consumer would fall through to the
unknown-kind path and render a generic notice instead of the supersession
link. A later supersession chain event is
ADVISORY: the resolver surfaces it, the page SHOULD show it, and it never
alters the original's cryptographic verdict. It is not revocation — see
Open Question 3.

Design intents behind the shape:

- **The proof is the audit layer's existing machinery plus a versioned
  checkpoint (Codex F1, revised by §10.10).** `governance/audit` already
  maintains RFC 6962-style **per-segment** Merkle trees over the linear
  SHA-256 hash chain: domain-separated hashing (`0x00` leaf / `0x01` interior
  prefixes, RFC 6962 §2.1), odd-leaf promotion (CVE-2012-2459), one tree per
  JSONL segment, and Ed25519-signed roots. What is NET-NEW is the checkpoint
  STATEMENT: `SegmentCheckpoint` v2 (§4a), a versioned extension whose signed
  payload covers `{ v, vaultId, profile, root, treeSize, segmentId,
  segmentFirstSequence, previousSegmentRoot, previousSegmentId, keyId,
  publishedAt }`. The receipt attests exactly ONE leaf — the `receipt_settled`
  mint event — so the proof is a standard `MerkleInclusionProof` against that
  checkpoint.
  **Segments are SEALED by their checkpoint — exactly ONE checkpoint per
  segment, ever.** Issuing a checkpoint for a `segmentId` seals it and FORCES
  rotation: no event is ever appended to a sealed segment, and no checkpoint
  is ever issued over a still-growing one. A second checkpoint bearing an
  already-checkpointed `segmentId` — even validly signed, even with a larger
  `treeSize` — is an integrity incident on the mint side and a hard FAIL on
  the verification side. Signing `treeSize` alone does not close this: it
  prevents altering one checkpoint, not SELECTING an earlier valid checkpoint
  over the same growing segment to hide later leaves. Sealing makes "the
  checkpoint for segment S" a function, not a choice — and it makes prefix
  rollback a detectable DUPLICATE rather than a plausible alternative.
  Sealing cadence IS checkpoint cadence: the pipeline cannot checkpoint more
  often than it rotates, so a short cadence means many small segments and
  longer histories to serve, a long one means minting waits for the seal.

  **Verification (the spec's §7 steps, with the resolver's own halves named).**
  Step results are FOUR-VALUED — `passed | failed | notApplicable |
  unavailable` — and the verdict is a function of those results, never of an
  exception thrown somewhere:

  1. **Strict schema + canonicalization validation.** Any unknown field
     anywhere in the signed `receipt` is FAIL. (The unsigned envelope may grow;
     its `apiVersion` governs it.)
  2. **Recompute `event.hash`** from the embedded envelope and enforce the §4
     equalities 1–9 — including equality 3 (`event.data` canonicalizes
     byte-identically to the projection the receipt claims; they are the same
     object, not duplicate copies), equality 4
     (`inclusion.leafIndex === event.sequence −
     checkpoint.segmentFirstSequence`), equality 8 (`checkpoint.vaultId ===
     proof.chain` and `checkpoint.profile === proof.profile`, read out of the
     CHECKPOINT's own signed payload, THEN cross-checked against the registered
     `chains[]` entry), and equality 9
     (`canonicalize(receipt.work) === canonicalize(event.data.work)` — without
     it a conflicting top-level `work` renders as chain-attested when only the
     mint signature covers it). → `EVENT_MISMATCH`
  3. **IDENTITY BINDING — and it comes before trusting anything below
     (§10.15).** The draft's chain `requestedReceiptId === receipt.receiptId
     === event.payload.receiptId` no longer applies: the ut1 projection
     deliberately carries NO `receiptId` (the ID is a reservation-issued
     locator and the REGISTRY, not the payload, binds it), so the third term
     does not exist and MUST NOT be reintroduced. The equivalent ut1 chain,
     which closes the same answer-B-with-receipt-A hole, is:
     (a) ALWAYS, offline: the document's `receiptId` equals the ID it ARRIVED
     under — the resolution URL, or the trailer that pointed here. A receipt
     read from a file with no arrival context reports `notApplicable`, which is
     neither a pass nor a failure;
     (b) ONLINE (`registryBinding`): the registry's binding for that ID
     resolves to THIS receipt's `event.hash`. The resolver checks this
     server-side on EVERY read that serves a receipt; offline verifiers report
     it `notApplicable`. A binding to a DIFFERENT event, or a missing binding
     for an ID served as final, is `failed` — never a fallback to (a);
     (c) equality 3 above, which ties the projection to the event.
     Together these bind request → document → event without a payload-embedded
     ID. → `ID_MISMATCH`
  4. **Mint signature**, with key role `mint`, the `minterKind` binding, and a
     PERMITTING key state. → `SIG_INVALID`
  5. **Inclusion path.** `leaf = sha256(0x00 ‖ hexDecode(leafHash))`,
     `interior = sha256(0x01 ‖ left ‖ right)` over decoded bytes, odd nodes
     promoting. **Topology validation is NORMATIVE:** derive the expected path
     length and each sibling's SIDE from `(leafIndex, treeSize)` — odd-node
     promotions included — and reject any proof whose supplied siblings
     disagree. Folding the siblings as given is non-conformant, and without
     this equality 4 is forgeable by altering `leafIndex`. (`packages/core`
     already implements this; the STEALTH half is an open code fix —
     `merkle-proofs.ts:84` — and it gates this API.) → `PROOF_INVALID`
  6. **Checkpoint.** `checkpoint.v === 2` (a v1 `PublishedMerkleRoot` in a
     receipt is FAIL), then its signature under a key with role `checkpoint`,
     in a permitting state, and in the rotation lineage pinned by this chain's
     `checkpointRootKeyId` — and, when that key is `retired`, the offline
     boundary `checkpoint.segmentFirstSequence < key.activationSequence`. A
     retired key signing at or after its successor's activation is a FRESH
     signature from a retired key: a base failure HERE, not a warning, and not
     something only a full-history walk could catch. → `CHECKPOINT_INVALID`
  7. **Semantic validation** — exactly the spec §2 enumerated constraints,
     every one decidable from the receipt alone: sorted-unique arrays; the
     `transferSet` presence RULE; `0 < postedUsertokens ===
     assessedUsertokens`; `0 ≤ roundingAdjustment ≤ transferCount`;
     presence/exclusion (`prevGenerationEventHash` iff `generation > 1`,
     `workloadId` iff `workflowAttested`, `origin` iff the fallback session
     variant); posture ENUM validity. **Postures are ATTESTED ENUMS, not
     verifier-established facts** — a verifier checks that `usagePosture` and
     `pricingPosture` are legal values and internally consistent, and that
     consumers render them; it CANNOT confirm them, because both are defined
     over per-constituent facts the projection deliberately does not carry.
     → `SEMANTIC_INVALID`
  8. **The ONE derivation the receipt can carry:** recompute
     `transferSetRoot` over `transferSet` when the ≤ 32 pair list is present
     (absent list → `notApplicable`; the root stays a commitment). →
     `DERIVATION_MISMATCH`. `amountUsd` is COMPUTED here as a display value
     from `assessedUsertokens` and emitted; it is never stored, there is
     nothing to compare it against, and `DERIVATION_MISMATCH` never refers to
     it. **This step contains no breakdown equation** and none is claimed for
     it.
  9. **EXTENSION checks — upgrade-only, never demoting.** A complete,
     clean-walking segment-checkpoint history containing this checkpoint
     upgrades to `verified_checkpoint_history`; valid Rekor evidence upgrades
     to `verified_anchored`. A FAILED extension (`ANCHOR_INVALID`,
     `HISTORY_INVALID`) preserves the base verdict and is reported alongside
     it — a tampered UNSIGNED attachment must not turn a cryptographically
     sound receipt red, because unsigned material is exactly what an attacker
     can freely substitute. Absent material is `notApplicable`, unfetchable
     material is `unavailable`; neither is a failure and neither upgrades.

  **One rule covers the OPTIONAL online checks — and registry binding is NOT
  one of them** (round-3 gate, F2). For predecessor linkage, history, and
  anchors: the CHECK reports `unavailable`, the overall verdict is THE
  OFFLINE VERDICT, and the check's status is reported beside it —
  unreachability of an optional online input never degrades a receipt that
  verifies offline, and never becomes a 503 (§10.4). **Registry binding is
  mandatory for resolver-issued responses:** its backing store unreachable →
  503; a missing or conflicting final binding → 409 `ID_MISMATCH`; it never
  reports `unavailable` on a 200 (the verdict-algebra section carries the
  full rule and its resolution record). `UNVERIFIABLE` is reserved for
  MISSING REQUIRED MATERIAL — an unparseable receipt, unresolvable trust keys,
  an absent proof or checkpoint — and is never the answer to "an optional
  check could not run".

  **What `verified_checkpoint` does NOT prove, carried explicitly in verifier
  output:** whole-chain linear consistency, anchor-sequence continuity, or
  external immutability. A checkpoint signer could sign a fork. And the
  surviving gap even at history level is **EQUIVOCATION** — nothing above
  stops the checkpoint key's holder from signing TWO internally-perfect sealed
  histories and showing one to you and the other to someone else. (This is not
  a Merkle-prefix-consistency gap; per-segment trees are INDEPENDENT and no
  root is a prefix of another, so consistency proofs are the wrong tool.)
  Closing it needs witness cosigning or a public checkpoint log — a NAMED
  non-goal for v1. Rekor anchoring partially mitigates it, which is precisely
  what `verified_anchored` rewards.

  **Also not independently verifiable from this response** (stated rather than
  implied): (1) per-transfer detail when `transferCount > 32` — the root is a
  commitment, not an enumeration, and a verifier proves the totals are what
  the chain committed to, not how they decompose (at ≤ 32 the projection
  ENUMERATES the pairs and step 8 recomputes the root from them — §10.12);
  (2) repository-membership PROVENANCE — `repositoryMembership.proofId` and
  the observation evidence are chain-committed CLAIMS whose provider-side
  verification is an internal mint/resolver check; an offline verifier proves
  the minter committed to having observed membership, not the observation
  itself (folding a linked membership event with its own inclusion proof into
  the response is a ledgered future upgrade); (3) the `display` breakdown
  rows, which carry no commitment at all.
- **The status is recomputed, not stored.** The resolver re-derives and
  verifies the stored proof on every resolution, including conditional
  requests, before deciding whether to return 200 or 304. A receipt that fails
  recomputation NEVER returns 200 or 304 (see 409 below) — the page must not
  be able to render a green check from stale state. What is recomputed is the
  STORED artifact; failure there is an integrity incident (409), not an
  outage (503).
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
  `notMinted` and unmoor `spend` from the root). `spend.assessedUsertokens`,
  `spend.postedUsertokens`, and `spend.transferCount` are derived from that
  reconciled set and no other. dryRun, engine-less, and merely
  boolean-`settled` paths are NOT mintable. If a SurrealDB write is sitting in
  the dead-letter queue for any constituent transfer, minting DEFERS until
  reconciliation drains — a receipt never fronts an unreconciled ledger.
- **Amounts as string decimals.** `amountUsd` is computed, not stored:
  `assessedUsertokens / 10000` by integer quotient/remainder, rendered with
  exactly four decimals (`"4.8224"`, not `"4.821"`). Public money fields don't
  get float representation, and deriving from ASSESSED is what lets a
  `usagePosture: "provider"` receipt make its claim honestly.
- **Amount fidelity — the claim, scoped honestly (§10.5a; validated
  2026-08-08 against the SDK's cache-tier pricing work, `usertrust` repo
  `docs/superpowers/plans/2026-08-08-cache-tier-pricing.md`).** The draft's
  unconditional *"public amounts must never UNDERSTATE what the work cost"* is
  RETIRED AS WRITTEN. The honest form is scoped:

  > A receipt never understates the **ledger-POSTed cost of this governed
  > session**.

  Two postures carry the caveats on the wire instead of hiding them.
  `usagePosture` is the USAGE side: `"provider"` when every constituent was
  priced from provider-reported usage, `"estimated"` when every constituent
  used the estimate path, `"mixed"` when both — and **estimates are NOT a
  guaranteed upper bound**, which the page must say for estimated and mixed.
  `pricingPosture` is the RATE side: `"exact"` when every constituent priced
  with full tier extraction (requiring `usageTier === pricedAsTier` on every
  row plus persisted exact adapter posture), `"conservative"` when any leg
  used an allowlisted fallback mapping that can only round UP.

  Proxy reality today: Anthropic traffic (the dominant path — Claude Code /
  minidev) is priced EXACTLY, all four token tiers extracted and rated.
  OpenAI/Gemini adapters zero the cache counts and bill the full prompt at the
  input rate — cached tokens priced at full freight, i.e. conservatively HIGH,
  the same posture as the SDK's D1 invariant by a different route. The
  cache-read split this exposes is the 7-8× story made visible.

  **What a skeptic can recompute, and at what grade.** The equation survives,
  but as the RESOLVER's display-grade ONLINE check over the unsigned `display`
  rows — never a verifier verdict, and never a claim step 8 makes (§10.5,
  §10.11):

  ```
  A = ceil( Σ tokens × ratePer1k / 1000 )              // over display.breakdown
  A + roundingAdjustment === postedUsertokens === assessedUsertokens
  ```

  A `packages/verify` run neither has the rows nor needs them: no verification
  step may depend on material outside the receipt. What the CHAIN commits —
  and what an offline verifier therefore checks — is `0 ≤ roundingAdjustment ≤
  transferCount` and `posted === assessed`: **bounded honesty, not offline
  recomputability**. Note the direction the bound protects: `postedUsertokens
  ≥ A` wherever `A` is computable at all, because per-transfer rounding can
  only add; "posted ≤ assessed" must never be read against the aggregate
  figure. Conservative-fallback rows carry the rate actually APPLIED, so the
  recompute works without knowing provider discounts.

  Field vocabulary stays aligned with the SDK's `receipt.pricing`
  (`appliedRates`, `tableVersion`) — one vocabulary, per Q6.
- **Offline verifiability.** `receipt` + the published key material
  (`GET /.well-known/usertrust-verify` → `{ keys: [...], chains: [...] }`)
  must be sufficient to verify WITHOUT trusting this API — that's what makes
  the flex credible to a skeptic. The page gets a "verify it yourself"
  affordance for free.
  **Key authorization is key-history STATE, not a time window (§10.13).** A
  key verifies iff it is present, role-correct, minter-kind-correct, and in a
  PERMITTING `state` in the verifier's pinned snapshot:
  - `active` — verifies, and may sign new material;
  - `retired` — verifies material it signed while active, and signs nothing
    new. This is the ordinary end state of rotation, and it is why rotating
    does not invalidate history. "While active" is a SEQUENCE bound, made
    checkable offline by `activationSequence`: a retired CHECKPOINT key
    verifies only checkpoints whose `checkpoint.segmentFirstSequence <
    activationSequence`. At or after that boundary it is a FRESH signature
    from a retired key — a base-verification FAILURE at step 6, not a warning.
    **The SAME boundary binds a retired MINT key at step 4** (gate round 2,
    F2): mint keys have no segment-indexed material of their own, so their
    retirement boundary is the MINT EVENT's segment, evaluated the same way
    through the receipt's own checkpoint (§8) — a retired mint key verifies
    only receipts whose `checkpoint.segmentFirstSequence <
    activationSequence`, and at or after that boundary the signature is a
    step-4 base failure. The residual a sequence bound cannot close offline —
    a retained retired key freshly signing AROUND a pre-boundary event — is
    the receipt spec's NAMED v1 non-goal (equivocation; witness cosigning /
    checkpoint transparency is the future close, Rekor anchoring partially
    mitigates), and the ONLINE path does not inherit it: the resolver's
    mandatory `registryBinding` ties the served ID to its event.
    Because segments are sealed and `segmentFirstSequence` strictly increases,
    this is a total order over the chain's own sequence space: **no clock, and
    no history, required to evaluate it.**
  - `revoked` — verifies NOTHING, past or present. Revocation is the
    compromise path and deliberately invalidates everything that key signed;
    it is an incident action, never routine rotation hygiene.
  `predecessorKeyId` makes the rotation lineage representable, and
  `checkpointRootKeyId` pins which lineage may sign checkpoints for a given
  `vaultId` — a domain-wide `role: "checkpoint"` key confers NO authority over
  chains that don't pin it, and one lineage serves exactly ONE vault. Verdicts
  are relative to the verifier's PINNED SNAPSHOT and the verifier says which
  one; a later snapshot may legitimately turn a pass into a fail (revocation),
  never the other way, so consumers that cache verdicts cache the snapshot
  identity with them.
  **No verification step consults any clock for key validity.** Timestamps
  split by ROLE (round-27): response timestamps ARE mandatory hash/signature
  inputs (`mintedAt` in the receipt signature preimage, `timestamp` in
  `event.hash`, `publishedAt` in the checkpoint's signed payload) — but they
  are never TRUSTED CLOCKS. Rekor integration time upper-bounds the
  CHECKPOINT's existence, which is evidence about the checkpoint, not about
  the key.
- **No PII, no prompt content, no repo file paths — operationalized, not
  asserted.** The receipt attests that governed work happened and what it
  cost, never what was said to the model. Because it is a PUBLIC document,
  every string carries a presence rule or a syntax rule: `work.repo` is ABSENT
  unless disclosure is authorized, and when present is the canonical
  provider-URL form ≤ 256 chars; `models[]`/`providers[]` are
  published-catalog identifiers or the single literal `"custom"`, so operator-
  or tenant-chosen aliases never reach the wire; `proofId` and `workloadId`
  are opaque server-generated handles matching `[A-Za-z0-9._-]{1,128}` that
  MUST NOT embed user data or any structure a reader could decode into it. The
  same constraint binds everything in `display` and any operator diagnostic
  surfaced beside a receipt — **unsigned does not mean unpublished.**

---

> **The section that follows is CONTENT-PINNED.** It is what receipt-spec §6a
> adopts, and its text is byte-identical to the section in the usertrust
> instance's frozen copy under the PREDECESSOR pin
> (`sha256:6260043a…`, whole-file digest of that copy; the original
> round-35 pin `4c293c35…` precedes it in the trail). §6a now pins THIS
> file, and carries this section across unchanged. The 2026-08-11
> re-pin took all three previously-deferred corrections at once — the
> anchor-clock paragraph retired (§10.13), the separate-billing-identities
> sentence retired (§10.16), and both stale in-pin `claimsHash` mentions
> removed (§10.2 residue) — so this section and the rest of v0.2 now agree;
> no known-stale passages remain. Edits here require a coordinated re-pin,
> never a unilateral change.

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
| 202 | `"reserved"` | ID reserved, not yet finalized, TTL not expired. `Cache-Control: no-store`. Page renders "receipt pending…", never an error — a fresh commit legitimately sits here for minutes. Confirmed UNCHANGED by the spec (§10.8): the trailer cites the reserved ID, so a reserved ID must never answer 404. |
| 202 | `"reconciling"` | ANY closing-but-nonterminal reservation, finalized or not (round-16): some intent is INTENT/SUBMITTING/PENDING, or a terminal outcome is not fully SurrealDB/audit-reconciled. An uncertain SUBMITTING intent is nonterminal by definition — it may yet surface in TigerBeetle. No cacheable 410 until every condition resolves. `no-store`. (§10.14 retired this row's former third clause — a forced-fallback session receipt that "has not finished anchoring" no longer holds at 202; once MINTED it is served at 200 `verified_checkpoint` like any other receipt, whatever its publication state.) |
| 410 | `"cancelled"` / `"expired"` | Terminal: the reservation was cancelled by its owner or expired server-side — reachable ONLY for reservations with zero admitted intents (round-11 F1); an expiration tombstone persists, so an allocated ID answers 410 forever (round-12). Cacheable ≤1h. Renders as "reservation ended without a receipt" — loud on a commit, expected on abandoned work. Cancellation authorizes against the reservation owner / billing principal (or a delegated orchestrator capability) in the same transaction as the state CAS — reservation IDs are public by design (trailers), and an unauthorized caller receives the 404 shape (review-gate R7). |
| 410 | `"billedUnfinalized"` | Terminal, NON-GREEN: the reservation billed (≥1 POST) but never finalized; a spend-only session receipt exists under a SEPARATE linked ID referenced in the body (round-14 F2). Loud on a commit — the trailer's claim was never proven. Cacheable ≤1h. **The bundle's ut1 re-expression (§10.15) IS applied** — its concrete amended shape is transcribed from §4.2 under "Non-receipt response bodies", which supersedes the older description still carried in the content-pinned section. |
| 410 | `"notMinted"` | Terminal: at least one intent was admitted, ALL intents are terminal, and ZERO TigerBeetle transfers POSTed — actual transfers VOIDed; pre-ledger intents may be REJECTED or ABORTED_NOT_SUBMITTED (round-12 definition). Nothing billable settled, nothing to prove, and this can never change (round-8 F4). Cacheable ≤1h. The page renders "no billable work settled under this receipt ID" — distinct from both an error and a green check. |
| 404 | `"unknown"` | ID never allocated (round-12: allocated IDs that expire answer 410 via the tombstone — the two have opposite integrity semantics). `Cache-Control: public, no-cache, max-age=0, must-revalidate` — storage is acceptable ONLY when every reuse revalidates at the origin; NO freshness allowance (round-21: a fresh cached 404 is served without contacting the origin, so it can never observe the 202 that follows allocation). The spec's §3 makes this meaningful: the ID is CLAIMED atomically at reserve time by an insert-if-absent into the mint-side registry, in the same durable write that creates the reservation, so it exists — unresolvable-but-allocated — before it can be written into any trailer. The page renders this LOUDLY — an unknown receipt on a commit is an integrity red flag, per the fail-closed convention. |
| 409 | `"unverifiable"` | ID known, but recomputation of the STORED mint-time artifact failed — the event/proof/checkpoint the resolver serves does not verify against itself (§10.4). Never cached. Alerts internally — this should be impossible. A failed EXTENSION check is never a 409: it preserves the base verdict and is reported beside it. |
| 503 | `"verificationUnavailable"` | A transient dependency prevented the BASE verification — and the list is exactly two: **the key registry or the receipt store being unreachable** (§10.4). An OPERATIONAL condition, not a cryptographic mismatch (round-32: rendering it 409 fakes an integrity incident; rendering a recompute failure as 503 hides one; an unspecified 500 breaks deterministic retry). `Cache-Control: no-store` + `Retry-After`; never a 304, never a fallback to any cached green response. **An anchor or history endpoint is NOT on that list:** anchor and checkpoint-history material are optional EXTENSION inputs, so failing to reach them is a clean 200 at `verified_checkpoint` with the extension reported `unavailable` — never a 503, never a downgrade. |
| 429 | — | Rate limited. **The one body-less state**, and exempt from the `apiVersion` discipline: consumers derive it from the status code + `Retry-After` alone and never parse the body (§4.2, below). |

## Non-receipt response bodies (§4.2 — concrete)

Transcribed from the verify page's §4.2. `receiptBytes`, `receipt`,
`verification`, and `advisories` exist ONLY where shown: a 202/410/404 has no
receipt and no verification to report.

```jsonc
// 202 — Cache-Control: no-store
{ "apiVersion": "1", "receiptId": "ut1_…", "status": "reserved" }
{ "apiVersion": "1", "receiptId": "ut1_…", "status": "reconciling" }

// 410 terminal without a receipt — cacheable ≤ 1h
{ "apiVersion": "1", "receiptId": "ut1_…",
  "status": "cancelled" | "expired" | "notMinted" }

// 410 billedUnfinalized — the §10.15 AMENDED bundle (§4.2). The registry binds
// originalReceiptId → terminalEvent.event.hash, first-write-wins at the moment
// the terminal event is appended, so this bundle is checkable by the SAME
// mechanism as a green receipt instead of being self-asserted.
{ "apiVersion": "1",
  "status": "billedUnfinalized",
  "receiptId": "ut1_…",                    // the trailered, UNPROVEN ID
  "linkedReceiptId": "ut1_…",              // the spend-only session receipt
  "transferSetRoot": "…",
  "terminalEvent": {
    "chain": "…", "profile": "proxy-v1",   // names the vault + the equality set —
                                           // without them the terminal proof is
                                           // unverifiable in exactly the way an
                                           // unlabeled receipt would be
    "event":      { /* §4a proxy envelope, field-complete */ },
    "inclusion":  { /* MerkleInclusionProof */ },
    "checkpoint": { /* SegmentCheckpoint v2 */ }
  }
}

// 404 — public, no-cache, max-age=0, must-revalidate
{ "apiVersion": "1", "receiptId": "ut1_…", "status": "unknown" }

// 409 — no-store. `verification` is REQUIRED here, naming the failed step
// with its closed §7 code — a 409 says WHICH check failed, never just "bad".
{ "apiVersion": "1", "receiptId": "ut1_…", "status": "unverifiable",
  "verification": { /* the §4.1 shape */ } }

// 503 — no-store + Retry-After. NOTE: no receiptId — a 503 can precede
// resolving the ID at all.
{ "apiVersion": "1", "status": "verificationUnavailable" }

// 429 — EXEMPT from apiVersion parsing entirely.
```

**The 410 `billedUnfinalized` bundle SUPERSEDES the older description in the
content-pinned Mint-lifecycle section.** That section still describes the
bundle as `{ status, receiptId, linkedReceiptId, transferSetRoot,
terminalEvent: { event, inclusion, publishedRoot } }` with a request binding
through `terminalEvent.event.payload.receiptId`. Both are retired here: the
ut1 projection carries no `receiptId`, so that term does not exist, and
`publishedRoot` is a v1 object that never appears in ut1 responses. The
surviving cross-checks, which a consumer runs BEFORE rendering or following
the link, are `routeParamId === body.receiptId`,
`body.linkedReceiptId === linkedReceipt.receiptId`,
`linkedReceipt.work.origin.sourceReservationReceiptId === body.receiptId`,
and transfer-set-root equality across the terminal event and the fallback
receipt. Any mismatch is an integrity failure and no link is rendered —
otherwise an untrusted resolver answers a request for ID B with a fully valid
terminal bundle for ID A.

**429 is exempt from the version discipline (§4.2).** Its body is absent or
untrusted and is NEVER parsed; the state derives from the HTTP status code
plus `Retry-After` ALONE, and it has exactly one outcome — rate-limited,
never the protocol-error shell. The reason is structural: a rate limiter
answers in front of the resolver's body machinery, so demanding a versioned
body from it would turn every throttle into a fabricated protocol error.

**The COMPLETE allowed response-code set.** The Errors table above covers the
non-200 states, but the contract is the full set, so it is enumerated here
once and in full — **`200`, `304`, `202`, `410`, `404`, `409`, `503`, `429`,
and nothing else.** Two of these carry no body: `304` (a successful
revalidation, emitted only after a current verification succeeded — see
Caching) and `429`.

Two obligations land on this API rather than on the page: (1) **on
BODY-BEARING responses, the HTTP code and the body `status` must agree** — a
mismatch is a protocol error to consumers, so the resolver must never emit
one. The rule is scoped to body-bearing responses because `304` and `429`
have no body to agree with, and demanding one of them would make every
conditional request and every throttle a fabricated protocol error;
(2) **an HTTP code outside the set above is a protocol error**, so this API
emits nothing beyond it. Consumers
treat resolver timeouts, malformed JSON, verdict-algebra violations, unknown
or misplaced failure codes, and missing/unsupported `apiVersion` as
protocol errors — all non-green, and none of them reusing 503's wording,
because 503 is this API's own honest answer while a protocol error means the
consumer could not obtain a trustworthy answer at all.

## Non-goals (v1)

- No list/search endpoints (enumeration of receipts is a different product
  decision — amounts are public per-receipt, not necessarily as a browsable
  firehose).
- No per-transfer SPEND breakdown endpoint. `spend` is session-aggregate. (The
  transfer ID PAIRS are a different thing and are disclosed by rule, not by
  endpoint: the projection enumerates them at `transferCount ≤ 32` and omits
  them above it — §10.12.)
- No auth'd variants. One public shape, one trust story. (The verify page's
  rate-limit service key is not an exception: it selects a rate-limit bucket
  and nothing else — same endpoint, same bytes, no privileged shape. See
  "Rate limiting" under Endpoint.)

## Open questions for the spec (usertrust instance) — all six now RESOLVED

1. ~~Private-repo receipts~~ **RESOLVED (round-3 F4, construction fixed
   round-4 F3):** `work` always carries scope — canonical host-scoped repo
   identity, or for undisclosed private repos a stable keyed `repoId`:
   `"r1_" + base64url(HMAC-SHA-256(repoIdKeyV1, providerHost || 0x00 ||
   immutableRepositoryId))` — keyed off the immutable provider ID, never the
   mutable, reusable URL (round-10: this line previously contradicted the
   normative work-block construction); the HMAC key is never exposed and the
   canonical URL is display-at-mint metadata only; the git object ID is
   always the FULL oid + algorithm. The spec tightened the display half into a
   presence rule: `repo` is ABSENT unless disclosure is authorized, so this is
   no longer Cam's per-commit call but a mint-side authorization check.
2. ~~Proof size bound~~ **RESOLVED (Codex F1 remediation, revised by
   §10.10):** the receipt attests exactly ONE leaf — the `receipt_settled`
   mint event, embedded as the chain's real envelope. The proof structures are
   `MerkleInclusionProof` (the audit layer's, verbatim) plus a
   `SegmentCheckpoint` **v2** statement; v1 `PublishedMerkleRoot` objects never
   appear in receipts. The optional history collection is the only unbounded
   member, and it is unsigned EXTENSION material the caller can decline.
3. ~~Revocation~~ **RESOLVED — NO (§10.13).** There is no receipt revocation:
   an immutable ledger has no revocation, and a mistaken mint is an incident,
   not a lifecycle state. The only remedy is a later `receipt_superseded`
   chain event, which is ADVISORY — the resolver surfaces it, the page SHOULD
   show it, and it never alters the original's cryptographic verdict. The word
   "revoked" belongs to KEYS (`state: "revoked"`, spec §8) and to nothing
   else; there is no `revoked` receipt status and the page never needs that
   state.
4. ~~ID ergonomics~~ **RESOLVED (§10.9).** The draft's "~24-30 chars" estimate
   is corrected: the ID is **16–22 base58 characters after the `ut1_`
   prefix** — and length is a consequence, never the test (an ID is valid only
   if it decodes to EXACTLY 16 bytes and re-encodes byte-identically). The
   trailer's real-estate budget is therefore smaller than the draft assumed,
   but the value is now the full URL, so the line is
   `Usertrust-Receipt: https://usertrust.ai/r/ut1_<16-22>` = 62–68 characters.
   Comfortably one line.
5. ~~Trailer grammar~~ **RESOLVED (§10.9, spec §12).** The key is exactly
   `Usertrust-Receipt` — case-SENSITIVE, and the draft's `UserTrust-Receipt`
   spelling is retired — and the value is the **FULL https URL**, never the
   bare ID:
   `"Usertrust-Receipt: https://usertrust.ai/r/" "ut1_" 16*22base58char`
   (Bitcoin alphabet). Lexical rules, so "exactly once" is decidable: the
   trailer occupies a WHOLE LINE in the artifact's trailer block — key at the
   start of the line, exactly one `:` then exactly one space, then the value,
   then end-of-line; no folding, no continuation, no trailing whitespace, no
   inline comment. LF or CRLF, and the CR is not part of the value. A URL
   appearing inside prose, a code block, or a quoted body is NOT a trailer and
   MUST NOT satisfy finalization. **"Exactly once" is scoped to THIS reserved
   ID:** a second occurrence of the same ID is a reject, while trailers naming
   DIFFERENT receipt IDs are permitted and ignored by that finalization — an
   artifact may legitimately cite several receipts, and forbidding that would
   make honest multi-receipt artifacts unmintable.
6. ~~receipt.v2 alignment~~ **RESOLVED (§10.5, spec §2).** One vocabulary: the
   SDK's `receipt.pricing` (`appliedRates`, `tableVersion`) and this
   projection's `pricing.tableVersions` / `pricingPosture` / `usagePosture`
   share it, and if SDK receipts ever resolve under `/r/` they adopt the
   projection's field names unchanged. Note the v1 scope decision that settles
   the urgency: **only the proxy mints in v1** — SDK receipts stay local
   artifacts with `receiptUrl: null`, because SDK-side minting needs a
   key-custody design a distributed npm package cannot satisfy (it must never
   embed the trust domain's mint key) and is deferred to `ut2`.

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
`exact` iff EVERY constituent transfer's persisted posture is exact, and
`usagePosture` derives the same way over the metered/estimated split); (3)
only then is POST submitted — crash recovery and DLQ replay cover the
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
audit record, and DLQ replay. This ceiling chain is also what makes the
spec's `postedUsertokens === assessedUsertokens` rule true by construction:
every POST carries `amount === actualAmount` under a bound, so a conformant
ut1 receipt cannot exhibit a settlement shortfall.

**Stealth net-new work that gates the mint endpoint (spec §9-B — ALL SIX are
mint blockers, not just the checkpoint pipeline).** Without them no conformant
receipt can be produced at all:

1. **Checkpoint pipeline** — emit `SegmentCheckpoint` v2 statements over the
   EXISTING per-segment trees (no global-tree build, no `AnchorRecord` port).
   Net-new: the extended signed payload (v2 fields including the lineage edge,
   `segmentFirstSequence`, `keyId`), rotation scheduling and the publisher
   (today: no callers, no stored roots, `/segments` is a stub), an append-only
   checkpoint history + outbox with crash recovery, a stable public-safe
   `vaultId`, a sealing/checkpoint cadence that cannot indefinitely stall
   low-volume minting, and either a stated single-host writer constraint or a
   distributed lock. **The genesis decision is stealth's to make and must be
   DECLARED in the trust document**, not just in prose: either (a) verified
   backfill — re-issue v2 statements over all prior segments, whose lineage
   edges must be reconstructed from the existing unsigned `MerkleTreeState` —
   or (b) a new `vaultId` whose genesis IS the v2 cutover, leaving pre-cutover
   segments outside the receipt chain. The choice lands as `genesisSegmentId` +
   `genesisChoice` in the vault's `chains[]` entry, and the history walk
   requires the served history to root at exactly that segment.
2. **Reconciliation oracle** — a real transfer-set check
   (`verifyTripleConsistency`, or an equivalent transferId-join over
   TB/Surreal/chain for the session's set). The ±1-token per-user balance
   compare does not qualify, and without it there is no mintability test.
3. **Pricing table versioning** — a `PRICING_TABLE_VERSION` analog so
   `pricing.tableVersions` is populatable; rate deployments must leave a trace.
4. **Durable mint prerequisites** — session→transfer linkage written on EVERY
   governed path (Score and passthrough included), carrying the full
   `{authorizationTransferId, settlementTransferId}` pair and not a bare ID;
   paginated retrieval (today's query truncates at 50); and the
   transferId→leafIndex sidecar restored on restart — today it is in-memory
   only, so **proofs 404 after a restart**, which this API cannot ship over.
5. **Mint key provisioning** — one Ed25519 pair currently serves the whole
   audit subsystem (plaintext `MERKLE_SIGNING_KEY`, undocumented in both
   `.env.example` files, ephemeral outside production). The spec REJECTS
   shared material: a distinct mint key must be provisioned, custody on the
   **EC2 proxy host** (never mini2), and both env keys documented.
6. **`sessionId` nonce migration** — today's `sessionId` is a content hash and
   collides across concurrent runs; the spec requires a nonce/ULID minted at
   session open.

Plus one required code fix this API depends on directly:
**inclusion-path topology validation in stealth's `merkle-proofs.ts:84`** —
without it, equality 4 is forgeable by altering `leafIndex`, and every
verification step above inherits the hole. (`packages/core` already
implements it.)

Order: pricing-snapshot ledger migration → §9-B (1–6) → mint endpoint → this
resolver API → verify page → the swap.

spec+IDs (usertrust) → **mint endpoint (stealth)** → **this API (stealth)** →
verify page (usertrust) → the swap (stealth). The swap is additionally gated
on this API being live in prod: a trailer that 404s is worse than
`Co-Authored-By`. Publication is two-stage (round-9 F1 — "no receipt, no
push" deadlocks against observed membership, since a webhook cannot see an
unpushed commit): the BRANCH push is the quarantine stage — the commit
becomes provider-observable there, membership verifies against the branch
ref, the receipt mints and is checkpointed — and the fail-closed gate is
PROMOTION: no receipt, no merge to the destination branch. A failed mint
leaves an unmerged branch whose trailer never reaches master; cleanup is
amend-or-abandon on the branch, never a trailer on the mainline that
cannot resolve.

**What the verify page adds to the chain (its §10).** The page builds against
§8 fixtures NOW, so it is not blocked on this API; but its ROUTE goes live on
`usertrust.ai` only once `api.usertools.ai/v1/receipts/*` serves production
traffic (all six §9-B mint blockers landed first) AND
`usertrust-verify receipt <file>` is released — the page's verify panel points
at that command, and a panel citing a command that does not exist would be its
own broken trailer. The `Co-Authored-By` → `Usertrust-Receipt` swap happens
only after BOTH are observably live.

**Push-gating never depends on an external sink (§10.7).** Mint defers only
on the mint event's segment being SEALED — a LOCAL condition. A receipt that
is checkpointed but not yet published resolves 200 at `verified_checkpoint`,
which is a complete, honest answer; it is not a reason to hold a push.

**The promotion gate is unchanged and remains stricter than a 200.** It
requires `kind === "commit"`, exact `repoId`/`oid`/`oidAlg` equality against
the merge candidate, AND `work.objectSha256 === sha256(gitPreimage(candidate))`
over the exact uncompressed commit-content bytes — one representation, used
identically by minter and gate. A gate that cannot hash the candidate's bytes
MUST NOT pass it: OID equality alone leaves SHA-1 twins indistinguishable. A
`session`-kind receipt is never acceptable to the gate, and a `pr`/`issue`
receipt is compared by IMMUTABLE `providerArtifactId` (numbers and URLs are
both reusable) — a mismatch there is a transplant and fails, while a newer
revision of the SAME artifact is the `revisionSuperseded` display state, not
a failure.

## Changelog — v0.2 (sixteen §10 companion updates + the §4 schema adoption)

Applied against receipt-spec **v0.6-final** and verify-page design **v0.3**;
each item cites its §10 number, and cites §4 as well wherever §4 supplied the
concrete shape for something §10 described abstractly.

| §10 | Applied |
|---|---|
| 1 **+ §4.1** | 200 body is now the **envelope**, transcribed from §4.1's concrete shape rather than §10.1's abstract enumeration: `{ apiVersion, receiptId, status, receiptBytes, receipt, verification, advisories, anchorEvidence?, checkpointHistory?, display? }`. §10.1's six members are a floor — `receiptBytes` (byte-authoritative), `verification` (structured results + `trustSnapshotId`), `advisories[]`, and the top-level `receiptId` are envelope growth §5 permits. Route/body ID equality on every read plus the registry binding on every read that SERVES a receipt (`reserved` and the `notMinted`/`cancelled`/`expired` 410s have no mint event, so only §3's reserve-time claim applies — `billedUnfinalized` is the exception, per §10.15's terminal-event binding); `display` added as the labeled unsigned member; **`revisionSuperseded`** added, as an `advisories[]` kind per §4.1. |
| 2 | `proof.sessionDigest` and its synthetic event + separate `eventHash` REPLACED by the embedded §4 event envelope (field-complete, canonical bytes equal to the persisted event); the **`claimsHash` indirection is gone** — the projection IS the committed claim set. |
| 3 | 200 `status` is the **R3-8 ladder** (`verified_checkpoint | verified_checkpoint_history | verified_anchored`) and nothing else; single `"verified"` retired; `verified_chain` never introduced; `publishedTo` removed. |
| 4 **+ §4.1** | Resolver serves the IMMUTABLE mint-time proof + checkpoint plus the history collection, live-head consistency advisory; **503 narrowed to key-registry / receipt-store unreachability only**, with anchor and history endpoints explicitly excluded (unreachable → clean 200 + extension `unavailable`). §4.1 supplied the missing reporting channel: extension results live in `verification.checks`, so v0.2's improvised `display.extensions` member is dropped. |
| 5 | `spend` adopts `assessedUsertokens` / `postedUsertokens` / `usagePosture` / chain-committed `roundingAdjustment`; `amountUsd` derives from assessed by integer math; `posted === assessed` required; (a) the unconditional never-understate claim **retired** for the scoped "never understates the ledger-POSTed cost of this governed session"; (b) `pricingTables` hashes + `pricingDeployment` metadata moved into unsigned `display`. |
| 6 | `execution.agent` / `execution.interactive` moved into `display`, with the explicit bar on reintroducing them as minter-asserted work-class fields. |
| 7 | Defer-policy resolved in the spec's favor: mint defers on LOCAL checkpoint (segment SEAL) existence only; publication by itself upgrades nothing; "a 200 never carries an unanchored root" and its offline step (4) retired. |
| 8 | 202 `"reserved"` confirmed ALIGNED and unchanged (a reserved ID never 404s); the 200-side changes are the ladder vocabulary and the disappearance of `publishedTo`; absent optional history is a clean 200, never a 503 or a partial-history verdict. |
| 9 | Trailer key corrected to **`Usertrust-Receipt`** (case-sensitive) and the value to the **FULL https URL**; Q5 settled; Q4's "~24-30 chars" corrected to **16–22 base58 after `ut1_`** with the decode-to-16-bytes rule. |
| 10 | Proof block: v1 `PublishedMerkleRoot` REPLACED by **`SegmentCheckpoint` v2** (signed `vaultId`/`profile`, `segmentFirstSequence`, signed lineage edge, no `reference`, no `publishedTo`); resolver serves v2 objects + the history collection; `proof.profile: "proxy-v1"` added. Sealed-segment rule documented. |
| 11 | Breakdown rows moved to unsigned `display`, labeled not-chain-committed; the recompute equation restated as the **resolver's display-grade online check**, never a verifier verdict; the rows' `claimsHash` reliance superseded by the chain-committed `roundingAdjustment`. |
| 12 | `transferSetRoot` keeps its name and PAIR semantics; the domain-separated construction and the **≤ 32 disclosure rule** added (present iff `transferCount ≤ 32`, and step 8 recomputes from the list); the "commitment, not an enumeration" wording narrowed to the > 32 case. |
| 13 | **APPLIED IN FULL** — the anchor-clock key-validity model is replaced by §8's **key-history state model** (`active`/`retired`/`revoked` + `predecessorKeyId` + the offline `activationSequence` boundary) in the verification steps and the offline-verifiability bullet; the surviving timestamps-are-not-trusted-clocks principle kept; OPEN QUESTION 3 answered (**no receipt revocation**). *The standalone "Key validity is judged by the anchor's clock" section was retired from the pinned section at the v0.7 re-pin and is absent from this revision — see the re-pin bundle row below.* |
| 14 | `anchors[]`-non-empty-on-200 and the 202 `"anchoring"` state RETIRED (row deleted); a checkpoint-only receipt is a legal 200 at `verified_checkpoint` that may rise asynchronously; `"reserved"` is the only 202 the ladder recognizes; the `"reconciling"` row's stale "has not finished anchoring" clause removed. |
| 15 **+ §4.2** | **APPLIED IN FULL.** The identity-binding chain re-expressed for a projection carrying no `receiptId`: (a) route/trailer equality — now against BOTH `receipt.receiptId` and the top-level `envelope.receiptId` per §4.1 — (b) the online `registryBinding` `receiptId → event.hash`, (c) equality 3. The 410 `billedUnfinalized` half, deferred in the first pass because its shape lived inside the pin, is now transcribed from §4.2 as a concrete body OUTSIDE the pin, explicitly superseding the pinned description. |
| 16 | **APPLIED** — "Parallel work uses separate billing identities" was retired from the pinned section at the v0.7 re-pin and appears nowhere in this revision. The surviving rule is the one this document already carries: exclusivity is per billing identity, full stop — at most ONE active reservation per billing identity, with parallelism expressed as server-assigned attested workloads rather than separate attribution boundaries. See the re-pin bundle row below. |

**The §4 adoption, beyond the §10 items it sharpened:**

| From | Adopted |
|---|---|
| §4.1 | `receiptBytes` as the BYTE AUTHORITY, with `receipt` demoted to a parsed convenience copy; the resolver must serve registry bytes verbatim and never re-serialize, and consumers compare the two through the STRICT pipeline (canonical base64 → fatal UTF-8 → pre-parse duplicate-key rejection → the canonicalization appendix's numeric rules → structural comparison). |
| §4.1 | `verification` — `trustSnapshotId` plus the nine step results and four named online-check results, four-valued, so the verdict function's INPUTS are on the wire. Required on 200 and 409. |
| §4.1 | `advisories[]` — required on 200, may be empty; `revisionSuperseded`, `receiptSuperseded`, `generationAddendum`, with unknown kinds rendered generically and never verdict-affecting. |
| §4.1 | **The verdict algebra**, complete and binding on this API: mandatory-steps-all-passed (with `unavailable`/`notApplicable` equally disqualifying), the named non-mandatory results, and extension-caps-status with a CUMULATIVE ladder. A 200 that violates it is a resolver bug. |
| §4.1 | The **closed failure-code union** — ten codes, each legal only on its own step/check, no free text; `SCHEMA_INVALID` is §4's own name for step 1. |
| §4.2 | The concrete non-receipt bodies, including the amended 410 bundle, and the `verification`-bearing 409. |
| §4.2 | **The 429 exemption** — body never parsed, state from status code + `Retry-After` alone, never the protocol-error shell. |
| §3/R37 | Version discipline: unknown MEMBERS under `apiVersion: "1"` tolerated, unknown VERSIONS and statuses fail closed; plus two obligations on this API — the HTTP code and body `status` must agree on body-bearing responses, and no status code outside the enumerated allowed set (completed by F6 below). |

**Adopted AFTER the v0.2 transcription — a Cam ruling, not a §10 item:**

| Source | Adopted |
|---|---|
| **Cam's ruling, 2026-08-10 (option (b) ratified)** | **Rate limiting: dedicated reader-IP header with service-key authentication.** The verify-page service authenticates with a service key; a valid key from the KNOWN EGRESS unlocks trust in **`Usertrust-Reader-IP`**, and the per-reader limit applies to the address it carries. That header is the ONLY attribution header: inbound `X-Forwarded-For` is now IGNORED ENTIRELY, on every request. An absent header on an authenticated request falls back to a keyed page-service allowance as the floor, and a MALFORMED value (non-single-value or non-IP-literal) degrades to the same floor — **never a rejection; the request is still served.** The page CONSTRUCTS the value from the platform-attested client IP (on Vercel, the platform's own trusted source), never derived from or merged with inbound `X-Forwarded-For`. **Ratification history:** the first form of this ruling forwarded a single-valued `X-Forwarded-For`; option (b) superseded it on the deciding fact that **the page's hosting platform rewrites `X-Forwarded-For` in transit**, putting that header's semantics under infrastructure neither side controls. Header NAME fixed at `Usertrust-Reader-IP` — no `X-` prefix (RFC 6648 deprecates it; matches the `Usertrust-Receipt` convention); the working name `X-Usertrust-Reader-IP` in cross-instance coordination syncs to this. This REPLACES the open coordination item v0.2 raised from verify-page §11/D1 — that item is now closed. Cited, not specified: the service key lands with the mint-key work under the EC2 custody pattern (§9-A H1), and both page-side key handling and header construction are the usertrust verify-page ship-gate addendum. The service key is rate-limit attribution only, never access — the endpoint stays public and the "no auth'd variants" non-goal is intact. |

**Gate round-1 remediation (PR #823) — review findings, distinct from both the
§10 items and the Cam ruling:**

| Finding | Applied |
|---|---|
| F1 (High) | **Signature-preimage confusion fixed.** The byte-authority language had bled into signature semantics — raw `receiptBytes` CONTAIN the signature and therefore cannot be the preimage. `receiptBytes` is now scoped to storage/download/digest, and the preimage is stated as `utf8("usertrust/receipt-signature/v1\n") \|\| canonicalize(receipt − signature)`, in receipt-spec §5's own wording. |
| F2 (Medium) | **Leading-`1` heuristic dropped** (it was v0.2's own consistency-pass addition, and it was wrong: ~2.8% of uniform 16-byte values encode to 21 characters with no leading `1`, so the heuristic would intermittently reject valid IDs). Only the normative rule remains — decode to exactly 16 bytes, re-encode byte-identically — with the range explicitly marked a consequence, not a test. |
| F3 (High) | **ESCALATED, then RESOLVED at source.** Our text transcribed §4.1 rule 2 exactly; §4.1 itself permitted `registryBinding: unavailable` on a 200, contradicting §10.1's mandatory-binding rule. Escalated as a frozen-spec defect (actor conflation); the usertrust instance adopted the strengthening as a conformity correction to §10.1 (verify-page now DRAFT v0.4). This document now REQUIRES `registryBinding: passed` on resolver-issued 200s (store unreachable → 503; missing/conflicting binding → 409 `ID_MISMATCH`; `unavailable` reserved for offline reports). Discrepancy item 4 records the resolution. |
| F4 (Medium) | **Attestation overclaim demoted.** The row→table→deployment cross-check is now described strictly as an unsigned resolver-side display check, with one line noting that making it a real mint-time attestation requires signed or chain-committed coverage — the §9-B follow-up class, not a wording change. |
| F5 (Medium) | **Advisory kind naming fixed.** The advisory is camelCase `receiptSuperseded` (verify-page §4.1); the underlying chain event is snake_case `receipt_superseded` (receipt-spec §8). Both names now appear with the distinction stated and each cited to the document that defines it, plus the failure mode: the snake_case form on the wire is silently lossy, falling through to the unknown-kind path. |
| F6 (Medium) | **Allowed response-code set completed** — `200`, `304`, `202`, `410`, `404`, `409`, `503`, `429`, enumerated in full and closed. The code/body-`status` agreement rule is now scoped to BODY-BEARING responses, since `304` and `429` carry no body. |

**Gate round-3 remediation + re-pin bundle (PR #823, the cap round) —
reviewed at 23fcd3be:**

| Item | Applied |
|---|---|
| R3-F1 (Blocking) | **Resolved at source before the verdict landed** — receipt-spec v0.7 added `PREDECESSOR_MISMATCH` (legal only on `checks.predecessorLinkage`) with the explicit named-check code bijection; verify-page v0.5 carries the matching eleven-code union. The escalation banner became a resolution record. |
| R3-F2 (High) | **Internal contradiction fixed** — the one-rule-covers-online-checks paragraph now exempts registry binding explicitly (mandatory on resolver responses; unreachable → 503, missing/conflicting → 409 `ID_MISMATCH`); only predecessor linkage, history, and anchors may be `unavailable` while preserving the offline verdict. |
| R3-F3 (Medium) | **Extension-summary aggregation defined** — `steps.extensions` aggregates RESULTS and never carries a summary-level `failure`; codes live solely on the named checks. |
| R3-F4 (Medium) | **Authority list re-pointed** to verify-page v0.5 (v0.3 froze the schema, v0.4 the registryBinding correction, v0.5 the union completion + syncs), each named in that document's version-history block. |
| R3-F5 (Medium) | **Monotonic-wording contradiction fixed** — the status is recomputed per response and can move in either direction with optional-evidence availability; a rung change requires a changed `ETag`. |
| R3-F6 (Medium) | **CORS preflight contract added** — OPTIONS with `Allow-Headers: If-None-Match` (+ Methods/Origin/Expose); the closed response-code set scoped to GET. |
| Re-pin bundle | The Mint-lifecycle section was replaced with the byte-identical section text of the usertrust instance's re-pinned copy (§6a pin `6260043a…`, superseding `4c293c35…`): anchor-clock paragraph retired (§10.13), separate-billing-identities sentence retired (§10.16), both in-pin `claimsHash` residues removed (§10.2). The boundary banner reflects the current pin; the "Deferred: pinned-section collisions" section is DELETED — nothing remains deferred. |

**Gate round-2 remediation (PR #823) — reviewed at c7b95721; findings against
the round-1 tip:**

| Finding | Applied |
|---|---|
| F1 (High) | **Already fixed in flight** — the round-2 review examined the pre-resolution tip; the F3-round-1 escalation had already been adopted at source and this document already carries `registryBinding: passed` REQUIRED on resolver 200s. The gate independently derived the identical rule, which is corroboration, not a new finding. |
| F2 (High) | **Mint-key retirement boundary transcribed into step 4** — a transcription gap, ours: receipt-spec §8 already defines it ("the mint event's segment, evaluated the same way through the receipt's checkpoint"). A retired mint key now verifies only receipts whose checkpoint sits before its `activationSequence`; the offline residual (fresh signature around a pre-boundary event) is cited to the spec's NAMED v1 non-goal (equivocation), and the online path is covered by mandatory `registryBinding`. |
| F3 (Medium) | **ESCALATED — frozen-union gap.** §4.1's closed ten-code union has no code legal for a `predecessorLinkage` contradiction, so the 409 this document requires cannot be schema-validly reported. Proposed `PREDECESSOR_MISMATCH` (or an explicit mapping) to the union's owner; the gap is named at the rule, not papered over. |
| F4 (Medium) | **Presence-vs-passed contradiction fixed** — presence alone never upgrades a status; only the corresponding check returning `passed` does. Partial/invalid material stays attached at the base rung; statuses are computed per response ("upgrade-only" = extensions never demote, not rung memory), consumers cache per representation. |
| F5 (Medium) | **CORS exposure completed** — `Access-Control-Expose-Headers: ETag, Retry-After` on every response including `304`/`429` and front-of-stack limiter responses. |
| F6 (Medium) | **`checkpointHistory` is opt-in** — `?include=checkpointHistory`, default omits (legal: optional member), distinct cache representation with its own `ETag`; reaching `verified_checkpoint_history` requires requesting it. Page-side sync noted to the ship-gate addendum. |
| F7 (Medium) | **Service-key transport specified** — `Authorization: Bearer` only; query-string/cookie transport prohibited; invalid/missing key degrades to anonymous peer attribution, never 401 (attribution, not access). |

Also carried through, as consequences rather than separate items: the
`SegmentCheckpoint` sealed-segment rule (§4a), normative inclusion-path
topology validation and its open stealth code fix, the four-valued check
results with the one online-check rule, the equivocation non-goal, the spec's
operationalized public-safety rules, the §9-B mint blockers in Sequencing, and
the `receiptSuperseded` advisory display state.

## §4 vs §10: flagged discrepancies (not silently reconciled) — ALL FOUR CLOSED

Four places where the verify page's §4 and the receipt spec's §10 did not say
the same thing. In each case §4's concrete shape is what this document
transcribes — but the divergence was recorded rather than smoothed over,
because §10 was itself review-corrected twice for describing this document
inaccurately, and a silent reconciliation is how that class of error
propagates.

**This section is now a CLOSED LEDGER, not a live worry-list.** Every item
below was resolved at source in the document that owned it: item 4 by the
gate round-1 escalation, and items 1-3 by the receipt spec's **ERRATA of
2026-08-11** (recorded in its own status block: "§10.15's binding path
corrected to `terminalEvent.event.hash`; §10.14's anchored trigger phrased as
jointly cumulative; §10.1's binding-qualifier list completed with the
`billedUnfinalized` exception" — surfaced by this document's transcription
gate, stealth PR #823). Each item keeps its original finding and adds its
resolution; nothing is deleted, because the record of WHY the two documents
diverged is what stops the divergence recurring.

1. **The terminal-event registry key: `terminalEvent.hash` (§10.15) vs
   `terminalEvent.event.hash` (§4.2) — RESOLVED AT SOURCE (ERRATA
   2026-08-11).** §10.15 said the registry binds
   `originalReceiptId → terminalEvent.hash`. Under §4.2's concrete bundle,
   `terminalEvent` is a WRAPPER — `{ chain, profile, event, inclusion,
   checkpoint }` — with no `hash` member at all, so §10.15's path does not
   resolve against the shape §4.2 defines. **Adopted: §4.2's
   `terminalEvent.event.hash`**, which is the only path that exists. Almost
   certainly a shorthand in §10.15 rather than a disagreement, but it is a
   field path in a normative binding, so it was raised for correction in
   §10.15 rather than left for each implementer to infer. **The correction:**
   §10.15 now reads `originalReceiptId →
   terminalEvent.event.hash` and states the nesting explicitly. Both
   documents agree; this document's own statement of the binding carries the
   corrected path.
2. **Ladder cumulativity — RESOLVED AT SOURCE (ERRATA 2026-08-11).** §10.14
   phrased the two upgrades as independent
   triggers — "the complete segment-checkpoint history →
   `verified_checkpoint_history`; valid Rekor evidence → `verified_anchored`"
   — which, read alone, permits `verified_anchored` on a receipt whose
   history was never served. §4.1 rule 3 requires BOTH
   `anchorEvidence: passed` AND `checkpointHistory: passed` for the top rung.
   **Adopted: §4.1's cumulative ladder**, because §7's own wording chains the
   rungs with "additionally" and §7 outranks §10's summary of it. The
   operational consequence is real and is stated in the verdict-algebra
   section: anchoring alone cannot reach the top rung, so `verified_anchored`
   is unreachable until the §9-B.1 history pipeline ships. **The
   correction:** §10.14 now phrases the top rung jointly —
   "valid Rekor evidence IN ADDITION TO that complete history", with
   "anchorEvidence AND checkpointHistory are jointly required for the top
   rung; Rekor alone upgrades nothing past the checkpoint floor" — so the
   independent-triggers reading is gone from §10 as well.
3. **The binding-qualifier enumeration omitted `billedUnfinalized` in both
   documents — RESOLVED AT SOURCE (ERRATA 2026-08-11).** §10.1 said "a
   `reserved` (202) or `notMinted`/`cancelled`
   (410) response has no mint event and therefore no `receiptId →
   event.hash` binding to check", and §4.2's closing paragraph repeats that
   list verbatim — yet §10.15 and §4.2's own bundle both give
   `billedUnfinalized` a first-write-wins registry binding for the ORIGINAL
   ID. The list is incomplete, not wrong: `billedUnfinalized` has no MINT
   event, which is what the sentence is really about, but it does have a
   terminal-event binding. **Adopted: `billedUnfinalized` is named as the
   explicit exception** wherever this document states the qualifier.
   **The correction:** §10.1's qualifier list now
   completes itself — "`billedUnfinalized` (410) is the exception among
   terminals: its bundle carries the `originalReceiptId →
   terminalEvent.event.hash` first-write-wins binding (§10.15) and IS checked
   on every read that serves it" — so the enumeration is no longer incomplete
   in either document.

4. **`registryBinding: unavailable` permitted on a verified 200 — ESCALATED
   AND RESOLVED (gate round 1, F3).** Unlike the three above, this was §4.1
   rule 2 disagreeing with §10.1, with this document faithfully transcribing
   §4.1. Escalated rather than unilaterally corrected; the usertrust instance
   ADOPTED the strengthening at source as a conformity correction to
   receipt-spec §10.1 (verify-page now DRAFT v0.4; its fixture C7 amended,
   the old acceptance moved to the X6 rejection vectors). This document now
   carries the strengthened form — see the resolution record in the
   verdict-algebra section. The escalation mechanism worked as designed: the
   defect was fixed in the document that owned it.

The first three were not escalation-class when raised: each was
transcription-surfaced shorthand rather than a contested ruling, which is why
the ERRATA took all three editorially — no semantic movement, no verdict
round. **The other escalation class — a
§10 item that mis-describes this document's actual text — is EMPTY for v0.2:**
every phrase §10 attributes to the round-35 draft was checked against it and
found accurate, including §10.5's line citations (the worked example at
~176-178, the recompute equation at ~486-493) and §10.11's (~291). Two
apparent misses were quoting style only — §10.11 adds backticks the original
comment does not carry, and §10.8 paraphrases the Errors-table row as
`{status: "reserved"}`. The mis-description class does appear to be fixed.
