import { ImageResponse } from "next/og";
import ShareCard, { SHARE_CARD_SIZE } from "../components/share-card";
import { resolvePageState } from "../lib/resolve";

/**
 * `/r/<receiptId>`'s share card (`components/share-card.tsx`): the page's
 * brand around the verdict word and, on a verified receipt, the amount.
 * Nothing else: no receipt ID, no account handle, no linked receipt — a share
 * card is broadcast into every link unfurl, and it must not tie a receipt back
 * to whoever it charged (decided 2026-10-05).
 *
 * It renders in the image renderer's default font and fetches nothing, so it
 * renders the same whether or not the brand kit is reachable: see the card's
 * own header for why the brand fonts are not used here.
 *
 * Per-request, not `force-static`: the word depends on live resolver state, and
 * the route's `Cache-Control: no-store` mirrors the page's own rule (D1/R35) —
 * caching a stale verdict at the edge would be a cached wrong answer.
 *
 * `resolvePageState`, not `resolveVerifyPageState`: `billedUnfinalized`'s
 * card register (danger) is a function of the FINAL state after R3's
 * cross-check, not the unchecked bundle — see `lib/resolve.ts`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "usertrust receipt verification status";
export const size = SHARE_CARD_SIZE;
export const contentType = "image/png";

interface RouteContext {
	params: Promise<{ receiptId: string }>;
}

export default async function Image({ params }: RouteContext) {
	const { receiptId } = await params;
	const state = await resolvePageState(receiptId);
	return new ImageResponse(<ShareCard state={state} />, {
		width: size.width,
		height: size.height,
		headers: { "Cache-Control": "no-store" },
	});
}
