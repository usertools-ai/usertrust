import StateView from "../components/state-view";
import { verifyPageMetadata } from "../lib/metadata";
import { resolvePageState } from "../lib/resolve";

/**
 * `/r/<receiptId>` — what a `Usertrust-Receipt` trailer resolves to (spec
 * §9). Renders the full §7 state matrix via `StateView`: the `verified`
 * rungs through Task 4's §6 anatomy, every other `PageState` kind through
 * this task's own per-state components — 202/410/404/409/503/429/protocol-
 * error, each with its mandated loudness and copy.
 */

// Forces dynamic, per-request rendering (D1): the SSR fetch below is
// `no-store`, and a statically-optimized or ISR'd `/r/*` page would defeat
// the resolver's own caching contract by serving a stale answer regardless
// of what the fetch option says.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

interface PageProps {
	params: Promise<{ receiptId: string }>;
}

/**
 * `noindex` — the route ships DARK (plan §"Global Constraints": "unlinked,
 * `noindex`, behind the resolver-live gate"). Nothing in the site nav links
 * here, and this is the other half: a crawler that finds the URL anyway is
 * told not to index it.
 */
export const metadata = verifyPageMetadata;

export default async function VerifyReceiptPage({ params }: PageProps) {
	const { receiptId } = await params;
	// `resolvePageState`, not `resolveVerifyPageState` directly: the ONE
	// caller that renders (and may follow) the `billedUnfinalized` link
	// needs R3's cross-check run first (`lib/resolve.ts`'s own doc comment).
	const state = await resolvePageState(receiptId);

	return (
		<main>
			<StateView state={state} />
		</main>
	);
}
