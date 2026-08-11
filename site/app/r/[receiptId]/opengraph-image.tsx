import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { truncateForDisplay } from "../lib/claims";
import { resolvePageState } from "../lib/resolve";
import { ogCardRegister, ogCardWord } from "../lib/shell-copy";

/**
 * `/r/<receiptId>`'s share card — spec §12 open question 1, resolved to its
 * OWN stated default (b), unanswered: "verdict-only card, amount on the
 * page." The card renders exactly ONE piece of receipt-specific content —
 * `ogCardWord`, which IS `shellHeadline`, the same string the page itself
 * renders as its verdict/state headline — plus the truncated receipt ID for
 * disambiguation. No kind, no work claim, and NO dollar amount: "Amounts
 * are public by directive and the flex is deliberate — but a share card
 * broadcasts the spend figure into every link unfurl, ahead of the reader
 * seeing the disclaimers," which is precisely the risk (b) declines.
 *
 * Per-request, not `force-static` (contrast `app/og/route.tsx`, the
 * site-wide card, which IS static): the word depends on live resolver state,
 * and the route's `Cache-Control: no-store` mirrors D1/R35's rule for the
 * page itself — a share card is a secondary artifact, but caching a stale
 * verdict at the edge would still be a cached wrong answer by another road.
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
	green: "#34d399", // --color-ut
	warning: "#f59e0b", // --color-warning
	danger: "#ef4444", // --color-danger
	neutral: "#ffffff",
};

interface RouteContext {
	params: Promise<{ receiptId: string }>;
}

export default async function Image({ params }: RouteContext) {
	const { receiptId } = await params;
	const state = await resolvePageState(receiptId);
	const word = ogCardWord(state).toUpperCase();
	const ink = REGISTER_INK[ogCardRegister(state)];
	const { display: idDisplay } = truncateForDisplay(receiptId, 18);

	const dir = join(process.cwd(), "app/og");
	const [khandBold, khandSemi] = await Promise.all([
		readFile(join(dir, "Khand-Bold.ttf")),
		readFile(join(dir, "Khand-SemiBold.ttf")),
	]);

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
				fontFamily: "Khand",
			}}
		>
			<div
				style={{
					display: "flex",
					color: "rgba(255,255,255,0.5)",
					fontSize: 30,
					fontWeight: 600,
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
					fontWeight: 700,
					lineHeight: 1.05,
					letterSpacing: "-0.01em",
				}}
			>
				{word}
			</div>
			<div
				style={{
					display: "flex",
					marginTop: 44,
					color: "rgba(255,255,255,0.4)",
					fontSize: 28,
					fontWeight: 600,
				}}
			>
				{idDisplay}
			</div>
		</div>,
		{
			width: size.width,
			height: size.height,
			fonts: [
				{ name: "Khand", data: khandBold, weight: 700, style: "normal" },
				{ name: "Khand", data: khandSemi, weight: 600, style: "normal" },
			],
			headers: { "Cache-Control": "no-store" },
		},
	);
}
