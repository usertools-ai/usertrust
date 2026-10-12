import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { getKitPoster } from "../lib/kit-poster";

// Deterministic, request-independent image — pre-render at build time and serve
// as a static, CDN-immutable asset (no per-request function invocation).
export const dynamic = "force-static";

/*
 * The share card IS the hero (Cam, 2026-08-10): the intro's settle frame as
 * full-bleed ground, the Khand headline stack in white, the tagline in
 * emerald — and none of the hero's small print. The previous receipt-paper
 * card read as a coupon at iMessage size; the suit was a 220px afterthought.
 *
 * Satori constraints honored here:
 *  - flexbox only; every multi-child element declares display:flex
 *  - woff2 unsupported → Khand ships in this directory as TTF (decompressed
 *    from site/public/fonts/*.woff2, same OFL license, see public/fonts/OFL.txt)
 *  - the settle frame is a brand image, so it is not kept in this repo: it is
 *    fetched from the brand kit and checked against its sha384 pin
 *    (`getKitPoster()`, lib/kit-poster.ts, the same pinned fetch as the receipt
 *    share card's fonts and frame). Prerendered at build, so the build fetches
 *    it; if the kit is unreachable or the pin fails, the card renders on its
 *    plain GROUND and the build log says so, rather than failing the build.
 *  - local assets load via fs.readFile, never fetch(new URL(...)): webpack's
 *    asset-module heuristic rewrites that literal pattern for images into a
 *    bundled public path string, which breaks force-static prerendering.
 *    The kit fetch is an absolute https URL, not that pattern; the loader
 *    slices the bytes to their own range, the true ArrayBuffer satori accepts
 *    for <img src>.
 */
const GROUND = "#0a0a1a";
const EMERALD = "#34d399"; // --color-ut: the hero tagline's exact ink on dark

// 1920x1080 poster on a 1200x630 canvas: scale to width (1200x675) and crop
// the 45px overflow entirely from the bottom (rubble), because the suit's
// head owns the top of frame. The frame is then slid RIGHT so the suit —
// centered in the poster — lands at ~72% x like the hero's desktop
// composition; the uncovered left strip is GROUND under the scrim's heaviest
// stop, which is also where the headline needs its contrast anyway.
const POSTER_W = 1200;
const POSTER_H = 675;
const POSTER_TOP = 0;
const POSTER_LEFT = 270;

export async function GET() {
	const dir = join(process.cwd(), "app/og");
	const [poster, khandBold, khandSemi] = await Promise.all([
		getKitPoster(),
		readFile(join(dir, "Khand-Bold.ttf")),
		readFile(join(dir, "Khand-SemiBold.ttf")),
	]);
	if (poster === undefined) {
		console.warn("/og: brand kit poster unavailable; rendering on the plain ground");
	}
	return new ImageResponse(
		<div
			style={{
				position: "relative",
				width: "100%",
				height: "100%",
				display: "flex",
				alignItems: "center",
				background: GROUND,
				fontFamily: "Khand",
			}}
		>
			{/* The hero settle frame, cover-cropped */}
			{poster !== undefined && (
				// biome-ignore lint/a11y/useAltText: satori OG renderer, decorative
				// biome-ignore lint/performance/noImgElement: satori renders via <img>, not next/image
				<img
					src={poster as unknown as string}
					width={POSTER_W}
					height={POSTER_H}
					style={{ position: "absolute", top: POSTER_TOP, left: POSTER_LEFT }}
				/>
			)}

			{/* Left scrim — the hero column's guaranteed contrast, gone by mid-frame
			    so the suit keeps the poster's own lighting */}
			<div
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: "100%",
					height: "100%",
					display: "flex",
					background:
						"linear-gradient(90deg, rgba(10,10,26,0.9) 0%, rgba(10,10,26,0.55) 42%, rgba(10,10,26,0) 68%)",
				}}
			/>

			{/* The hero stack, verbatim: lowercase Khand, hero leading and tracking */}
			<div
				style={{
					position: "relative",
					display: "flex",
					flexDirection: "column",
					paddingLeft: 72,
					color: "#ffffff",
					fontWeight: 700,
					fontSize: 104,
					lineHeight: 0.95,
					letterSpacing: "-0.02em",
				}}
			>
				<span>financial</span>
				<span>governance</span>
				<span>for ai agents.</span>
				<span
					style={{
						marginTop: 18,
						color: EMERALD,
						fontWeight: 600,
						fontSize: 58,
					}}
				>
					keep the receipts.
				</span>
			</div>
		</div>,
		{
			width: 1200,
			height: 630,
			fonts: [
				{ name: "Khand", data: khandBold, weight: 700, style: "normal" },
				{ name: "Khand", data: khandSemi, weight: 600, style: "normal" },
			],
		},
	);
}
