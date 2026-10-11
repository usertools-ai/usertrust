import { ImageResponse } from "next/og";
import ShareCard, { SHARE_CARD_SIZE } from "../components/share-card";
import { getKitFonts } from "../lib/kit-fonts";
import { getKitFrame } from "../lib/kit-frame";
import { resolvePageState } from "../lib/resolve";

/**
 * `/r/<receiptId>`'s share card (`components/share-card.tsx`): the page's
 * brand around the verdict word and, on a verified receipt, the amount.
 * Nothing else: no receipt ID, no account handle, no linked receipt — a share
 * card is broadcast into every link unfurl, and it must not tie a receipt back
 * to whoever it charged (decided 2026-10-05).
 *
 * The brand fonts and the card's frame come from the kit, each checked against
 * its sha384 pin (`lib/kit-fonts.ts`, `lib/kit-frame.ts`). If any fails, the
 * card renders in the renderer's default font with no mark and no frame: it
 * never fails to render, and no unpinned font ever draws the verdict or the
 * amount.
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
	const [state, fonts, frame] = await Promise.all([
		resolvePageState(receiptId),
		getKitFonts(),
		getKitFrame(),
	]);
	// Fully branded or not at all: a frame without the fonts (or the reverse) is a half-card.
	const brand = fonts !== undefined && frame !== undefined;
	return new ImageResponse(<ShareCard state={state} brand={brand} frame={frame} />, {
		width: size.width,
		height: size.height,
		...(brand ? { fonts } : {}),
		headers: { "Cache-Control": "no-store" },
	});
}
