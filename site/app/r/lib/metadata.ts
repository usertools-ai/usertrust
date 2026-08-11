import type { Metadata } from "next";

/**
 * Dark-ship metadata for `/r/<receiptId>` (plan §"Global Constraints":
 * "Route ships DARK: unlinked, `noindex`, behind the resolver-live gate").
 * Static (not `generateMetadata`) because it never depends on the route
 * param — every receipt ID gets the same non-indexing treatment. Kept in
 * its own pure module, rather than inline in `page.tsx`, so it is testable
 * without importing a `.tsx` file (the repo's existing test convention:
 * `.test.ts` files test pure `.ts` logic, never render `.tsx` directly —
 * see `app/components/receipt/format.test.ts` beside the untested
 * `receipt-paper.tsx` it backs).
 *
 * `next.config.ts`'s `headers()` sets the `X-Robots-Tag: noindex, nofollow`
 * HTTP header for the same route as belt-and-suspenders: a crawler that
 * never renders the HTML `<head>` still honors the header.
 */
export const verifyPageMetadata: Metadata = {
	robots: { index: false, follow: false },
};
