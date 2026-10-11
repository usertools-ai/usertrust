import { ogCardAmount, ogCardRegister, ogCardWord } from "../lib/shell-copy";
import type { PageState } from "../lib/wire";

/**
 * The `/r/<receiptId>` share card, in the page's brand: the ut mark and the
 * usertrust wordmark, the page's black ground and silver glow with a still
 * frame of the dot lattice, the verdict word in its register's colour and, on
 * a verified receipt, the amount, then the tagline. The card's text is the
 * verdict and the amount only: no receipt ID, no account handle, no linked
 * receipt (decided 2026-10-05).
 *
 * Every glyph is drawn in the image renderer's default font, and the card
 * fetches nothing. The brand fonts are not usable here: the kit serves them as
 * woff2, which the renderer cannot read, and an unpinned remote font must
 * never draw the verdict or the amount. With nothing fetched, the card renders
 * the same whether or not the kit is reachable. The mark is drawn as the
 * page's CSS draws it (brand.css `.brand .mark`), not loaded as an image.
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

interface Dot {
	x: number;
	y: number;
	r: number;
	lit: boolean;
	opacity: number;
}

/**
 * A still frame of the page's lattice: rows of dots receding toward a horizon,
 * displaced by one slow wave, a rare point lit gold. Deterministic, so the
 * same card renders the same pixels every time.
 */
export function latticeFrame(): Dot[] {
	const dots: Dot[] = [];
	const rows = 14;
	const horizon = 470;
	const front = SHARE_CARD_SIZE.height + 30;
	for (let row = 0; row < rows; row++) {
		const depth = row / (rows - 1); // 0 at the horizon, 1 at the front
		const y = horizon + (front - horizon) * depth * depth;
		const spacing = 9 + 21 * depth;
		const r = 0.8 + 1.6 * depth;
		const amplitude = 6 + 22 * depth;
		const count = Math.ceil(SHARE_CARD_SIZE.width / spacing) + 2;
		for (let i = 0; i < count; i++) {
			const x = i * spacing - spacing + ((row % 2) * spacing) / 2;
			const wave = Math.sin(x / 170 + row * 0.42) * amplitude - Math.cos(x / 420) * amplitude * 0.6;
			const lit = (i * 7 + row * 5) % 37 === 0;
			dots.push({ x, y: y + wave, r, lit, opacity: lit ? 0.95 : 0.16 + 0.5 * depth });
		}
	}
	return dots;
}

export default function ShareCard({ state }: { state: PageState }) {
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
			}}
		>
			{/* the lattice, a still frame behind everything */}
			<div
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					width: "100%",
					height: "100%",
					display: "flex",
				}}
			>
				{latticeFrame().map((dot) => (
					<div
						key={`${dot.x.toFixed(1)}:${dot.y.toFixed(1)}`}
						style={{
							position: "absolute",
							left: dot.x - dot.r,
							top: dot.y - dot.r,
							width: dot.r * 2,
							height: dot.r * 2,
							borderRadius: dot.r,
							backgroundColor: dot.lit ? TOKENS.brand : TOKENS.silver,
							opacity: dot.opacity,
						}}
					/>
				))}
			</div>

			{/* the nav: the mark and the wordmark, as the page draws them */}
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
				<div style={{ display: "flex", alignItems: "center" }}>
					<div
						data-share="mark"
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							width: 60,
							height: 60,
							borderRadius: 16,
							backgroundColor: TOKENS.brand,
							color: TOKENS.brandOn,
							fontSize: 40,
							letterSpacing: "-0.045em",
							WebkitTextStroke: `1.6px ${TOKENS.brandOn}`,
						}}
					>
						ut
					</div>
					<div
						data-share="wordmark"
						style={{ display: "flex", marginLeft: 20, fontSize: 40, letterSpacing: "-0.01em" }}
					>
						usertrust
					</div>
				</div>
				<div
					data-share="where"
					style={{ display: "flex", fontSize: 22, letterSpacing: "0.14em", color: TOKENS.text2 }}
				>
					RECEIPT
				</div>
			</div>

			{/* the verdict and the amount: the card's whole claim */}
			<div style={{ display: "flex", flexDirection: "column", marginTop: 48 }}>
				<div
					data-share="verdict"
					style={{
						display: "flex",
						color: ink,
						fontSize: word.length > 24 ? 60 : 96,
						lineHeight: 1,
						letterSpacing: "-0.02em",
						WebkitTextStroke: `2px ${ink}`,
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
							fontSize: 84,
							lineHeight: 1,
							letterSpacing: "-0.03em",
							WebkitTextStroke: `1.5px ${TOKENS.text}`,
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
				<div data-share="tagline" style={{ display: "flex", fontSize: 30, color: TOKENS.silver }}>
					{SHARE_CARD_TAGLINE}
				</div>
				<div
					data-share="site"
					style={{ display: "flex", marginLeft: 20, fontSize: 30, color: TOKENS.brand }}
				>
					{SHARE_CARD_SITE}
				</div>
			</div>
		</div>
	);
}
