import { ImageResponse } from "next/og";
import { resolvePageState } from "../lib/resolve";
import { ogCardAmount, ogCardRegister, ogCardWord } from "../lib/shell-copy";

/**
 * `/r/<receiptId>`'s share card: the verdict word (`ogCardWord`, the plain word
 * the page itself leads with) and, on a verified receipt, the amount
 * (`ogCardAmount`). Nothing else: no receipt ID, no account handle, no linked
 * receipt — a share card is broadcast into every link unfurl, and it must not
 * tie a receipt back to whoever it charged (decided 2026-10-05).
 *
 * The card renders in the image renderer's default font: no font file is read
 * from this repository, which carries no brand assets.
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
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GROUND = "#0a0a1a";

const REGISTER_INK: Record<ReturnType<typeof ogCardRegister>, string> = {
	green: "#30D158", // --approve
	warning: "#FFB020", // --info
	danger: "#FF5B5B", // --stakes
	neutral: "#ffffff",
};

interface RouteContext {
	params: Promise<{ receiptId: string }>;
}

export default async function Image({ params }: RouteContext) {
	const { receiptId } = await params;
	const state = await resolvePageState(receiptId);
	const word = ogCardWord(state).toUpperCase();
	const amount = ogCardAmount(state);
	const ink = REGISTER_INK[ogCardRegister(state)];

	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				justifyContent: "center",
				padding: "80px",
				background: GROUND,
			}}
		>
			<div
				style={{
					display: "flex",
					color: "rgba(255,255,255,0.5)",
					fontSize: 30,
					letterSpacing: 2,
				}}
			>
				usertrust — receipt verification
			</div>
			<div
				style={{
					display: "flex",
					marginTop: 28,
					color: ink,
					fontSize: word.length > 40 ? 56 : 84,
					lineHeight: 1.05,
					letterSpacing: "-0.01em",
				}}
			>
				{word}
			</div>
			{amount === undefined ? null : (
				<div
					style={{
						display: "flex",
						marginTop: 36,
						color: "#ffffff",
						fontSize: 64,
						letterSpacing: "-0.02em",
					}}
				>
					{amount}
				</div>
			)}
		</div>,
		{
			width: size.width,
			height: size.height,
			headers: { "Cache-Control": "no-store" },
		},
	);
}
