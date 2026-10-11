import { ogCardAmount, ogCardRegister, ogCardWord } from "../lib/shell-copy";
import type { PageState } from "../lib/wire";

/**
 * The `/r/<receiptId>` share card, in the page's brand: the ut mark and the
 * usertrust wordmark, the page's black ground and silver glow with the kit's
 * frame behind them, the verdict word in its register's colour and, on
 * a verified receipt, the amount, then the tagline. The card's text is the
 * verdict and the amount only: no receipt ID, no account handle, no linked
 * receipt (decided 2026-10-05).
 *
 * `brand` says whether the brand assets are in hand: the route fetches the
 * fonts (`lib/kit-fonts.ts`) and the frame (`lib/kit-frame.ts`) from the kit and
 * checks each against its sha384 pin, so a card is fully branded or not at all. With them, the card sets everything in Usertools Sans
 * and draws the mark by the page's own CSS recipe (brand.css `.brand .mark`:
 * a gold pill, "ut" in Usertools Sans 700 with a same-colour stroke) — the
 * real font, so the mark is cloned, not rebuilt. Without them (the kit is
 * unreachable, a pin fails, a decode fails) the card renders in the
 * renderer's default font with NO mark and no wordmark at all: a mark drawn
 * in another font would be a fake. Either way the verdict and the amount are
 * drawn only by a pinned font or the renderer's own.
 *
 * The palette is brand.css's tokens, by value.
 */

export const SHARE_CARD_SIZE = { width: 1200, height: 630 } as const;

const TOKENS = {
	bg: "#000000",
	text: "#FFFFFF",
	text2: "#98989E",
	silver: "#C8CCD4",
	brand: "#E8B54B",
	brandOn: "#000000",
} as const;

/** brand.css's register inks: green for verified only, never for anything else. */
const REGISTER_INK: Record<ReturnType<typeof ogCardRegister>, string> = {
	green: "#30D158", // --approve
	warning: "#FFB020", // --info
	danger: "#FF5B5B", // --stakes
	neutral: TOKENS.text,
};

export const SHARE_CARD_TAGLINE = "keep the receipts.";
export const SHARE_CARD_SITE = "usertrust.ai";

/** The page's mark recipe (brand.css: 26px box, 7px radius, 18.5px glyph, .7px stroke), scaled. */
const MARK_SCALE = 60 / 26;

export default function ShareCard({
	state,
	brand,
	frame,
}: {
	state: PageState;
	brand: boolean;
	/** The kit's verified frame, as a data URI; drawn only on a branded card. */
	frame?: string | undefined;
}) {
	const word = ogCardWord(state).toUpperCase();
	const amount = ogCardAmount(state);
	const ink = REGISTER_INK[ogCardRegister(state)];

	return (
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				position: "relative",
				flexDirection: "column",
				padding: "56px 72px",
				backgroundColor: TOKENS.bg,
				backgroundImage:
					"radial-gradient(118% 78% at 50% -6%, rgba(200,204,212,0.10) 0%, rgba(200,204,212,0) 62%)",
				color: TOKENS.text,
				...(brand ? { fontFamily: "Usertools Sans" } : {}),
			}}
		>
			{/* the kit's frame, behind everything: loaded from the kit and pinned, never drawn here */}
			{brand && frame !== undefined ? (
				// biome-ignore lint/performance/noImgElement: the image renderer's own <img>, not next/image
				<img
					src={frame}
					alt=""
					width={SHARE_CARD_SIZE.width}
					height={SHARE_CARD_SIZE.height}
					style={{ position: "absolute", left: 0, top: 0 }}
				/>
			) : null}

			{/* the nav: the mark and the wordmark, only in the brand's own font */}
			{brand ? (
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
					<div style={{ display: "flex", alignItems: "center" }}>
						<div
							data-share="mark"
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								width: 26 * MARK_SCALE,
								height: 26 * MARK_SCALE,
								borderRadius: 7 * MARK_SCALE,
								backgroundColor: TOKENS.brand,
								color: TOKENS.brandOn,
								fontWeight: 700,
								fontSize: 18.5 * MARK_SCALE,
								lineHeight: 1,
								letterSpacing: "-0.045em",
								WebkitTextStroke: `${0.7 * MARK_SCALE}px ${TOKENS.brandOn}`,
							}}
						>
							ut
						</div>
						<div
							data-share="wordmark"
							style={{
								display: "flex",
								marginLeft: 9 * MARK_SCALE,
								fontWeight: 500,
								fontSize: 16 * MARK_SCALE,
								letterSpacing: "-0.01em",
							}}
						>
							usertrust
						</div>
					</div>
					<div
						data-share="where"
						style={{
							display: "flex",
							fontWeight: 500,
							fontSize: 22,
							letterSpacing: "0.14em",
							color: TOKENS.text2,
						}}
					>
						RECEIPT
					</div>
				</div>
			) : null}

			{/* the verdict and the amount: the card's whole claim */}
			<div style={{ display: "flex", flexDirection: "column", marginTop: brand ? 48 : 108 }}>
				<div
					data-share="verdict"
					style={{
						display: "flex",
						color: ink,
						fontWeight: 700,
						fontSize: word.length > 24 ? 60 : 96,
						lineHeight: 1,
						letterSpacing: "-0.02em",
					}}
				>
					{word}
				</div>
				{amount === undefined ? null : (
					<div
						data-share="amount"
						style={{
							display: "flex",
							marginTop: 20,
							color: TOKENS.text,
							fontWeight: 700,
							fontSize: 84,
							lineHeight: 1,
							letterSpacing: "-0.03em",
						}}
					>
						{amount}
					</div>
				)}
			</div>

			{/* the tagline */}
			<div
				style={{ display: "flex", alignItems: "baseline", marginTop: "auto", marginBottom: 112 }}
			>
				<div
					data-share="tagline"
					style={{ display: "flex", fontWeight: 500, fontSize: 30, color: TOKENS.silver }}
				>
					{SHARE_CARD_TAGLINE}
				</div>
				<div
					data-share="site"
					style={{
						display: "flex",
						marginLeft: 20,
						fontWeight: 500,
						fontSize: 30,
						color: TOKENS.brand,
					}}
				>
					{SHARE_CARD_SITE}
				</div>
			</div>
		</div>
	);
}
