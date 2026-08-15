# `/r/<receiptId>` — the verify page

What a `Usertrust-Receipt` trailer resolves to. One public, read-only,
unauthenticated URL — `https://usertrust.ai/r/ut1_<base58>` — that renders
the resolver's answer as a receipt: action on the stage, invoice beneath,
header names the artifact type. The page never computes a verdict itself
(D2); the Proven ladder is the verdict, and every non-green outcome is
loud, not swallowed.

The §6 masthead + thermal-paper exhibit is retired. Honesty-critical copy
(R5–R8, R18, R20–R27, R38–R41) lives on the visitor card. The check ledger,
extension evidence, work-claims and display annex stay below as
check-it-yourself surfaces, not a second receipt.

Normative spec: `docs/specs/2026-08-11-verify-page-design.md` (DRAFT v0.3,
frozen for this build). Authority order above this README:
receipt-spec v0.6-final > verify-page spec > the SDD plan
(`docs/superpowers/plans/2026-08-11-verify-page.md`) > this file.

## Status: ships DARK

The route is code-complete and merges to `master` in that state, but is
**not reachable in production**:

- **Unlinked.** Nothing in site nav, sitemap, or any other page links to
  `/r/*`. The only way in is a URL someone already has.
- **`noindex`.** `verifyPageMetadata` (`app/r/lib/metadata.ts`) tells any
  crawler that finds the URL anyway not to index it.
- **Points at the real resolver, which isn't live yet.** There is no local
  feature flag gating the route — `USERTRUST_RESOLVER_BASE_URL` defaults to
  `https://api.usertools.ai/v1/receipts` (`app/r/lib/resolve.ts`), the same
  production endpoint the trailer will eventually point at. Until that
  endpoint is serving real traffic, every request this page makes 404s or
  times out into the page's own protocol-error shell — which is the correct,
  fail-closed behavior, not a bug to route around.

Dev/test fixtures (`app/r/fixtures/`) are the only thing this page renders
against today; they're excluded from the prod build path and exist purely to
drive the conformance harness and component tests.

## The resolver-live gate

Per spec §10 ("Non-goals and sequencing gates"), going DNS-visible on
`usertrust.ai` — i.e. flipping this from merged-but-dark to linked/indexed —
requires, in order:

1. `api.usertools.ai/v1/receipts/*` serving production traffic (stealth's
   9-B mint blockers land first).
2. `usertrust-verify receipt <file>` released from `packages/verify` — the
   page's verify panel cites this command by name; a panel pointing at a
   command that doesn't exist would be its own broken trailer.
3. Only once **both** are observably live does stealth flip the
   `Co-Authored-By` → `Usertrust-Receipt` trailer swap. A trailer that 404s
   is worse than the `Co-Authored-By` line it would replace.

None of the three are this build's job. This PR ships the route; it does
not flip any of them.

## Ledgered items (explicitly out of this build's scope)

Carried forward from the plan's Global Constraints, unchanged by this task:

- **#811 companion adoption of §4** — stealth's side of the wire contract.
- **Rate-limit forwarded-client-IP arrangement** — stealth coordination
  (`Usertrust-Reader-IP` + bearer service key mechanism; spec v0.5 ruled the
  *mechanism*, not this build's wiring of it).
- **`usertrust-verify receipt` CLI** — does not exist yet
  (`packages/verify`, separate tier-0/1 ship). Because of this, the verify
  panel's v1 copy uses the download-affordance wording only, never a command
  invocation string.
- **OG dollar-amount and in-browser re-verification** — both left at their
  spec-default answers (verdict-only share card, no in-page re-verify; no
  dollar amount on the OG card) pending Cam's override.

A further set of review-found minors (base58 codec edge cases, a few
under-asserted copy strings, non-numeric-literal nits) is itemized in this
route's PR description rather than duplicated here.
