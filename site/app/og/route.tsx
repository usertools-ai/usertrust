import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

// Deterministic, request-independent image — pre-render at build time and serve
// as a static, CDN-immutable asset (no per-request function invocation).
export const dynamic = "force-static";

// Design tokens, inlined: this route renders via satori and never sees
// globals.css. Satori supports flexbox only; any element with more than one
// child needs an explicit display:flex. woff2 is unsupported, so the bundled
// default font renders all text (accepted — matches the previous route).
const GROUND = "#0a0a1a";
const PAPER = "#f2efe6";
const INK = "#16161e";
const INK_DIM = "rgba(22, 22, 30, 0.55)";
const RULE = "rgba(22, 22, 30, 0.3)";
const PAPER_EMERALD = "#0b6b4f"; // on-paper emerald — #34d399 is forbidden as ink on paper

export async function GET() {
	const dots = Array.from({ length: 22 }, (_, i) => i);
	// Two-register mascot cutout (Addendum G): white face/gloves read clean
	// against the dark ground here — never place this mark on the paper card.
	// Loaded via fs.readFile (Next's own opengraph-image.tsx pattern), not
	// `fetch(new URL(..., import.meta.url))`: for .png specifically, webpack's
	// asset-module heuristic rewrites that literal pattern into a bundled
	// public path string ("/_next/static/media/...") instead of a resolvable
	// URL, which breaks force-static build-time prerendering with "Failed to
	// parse URL". Slicing to the buffer's own range (not the pool) yields a
	// true ArrayBuffer, which satori's <img src> accepts.
	const mascotFile = await readFile(join(process.cwd(), "app/og/mascot-full.png"));
	const mascotBytes = mascotFile.buffer.slice(
		mascotFile.byteOffset,
		mascotFile.byteOffset + mascotFile.byteLength,
	);
	return new ImageResponse(
		<div
			style={{
				position: "relative",
				width: "100%",
				height: "100%",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: GROUND,
			}}
		>
			{/* Thermal-paper receipt card */}
			<div
				style={{
					position: "relative",
					display: "flex",
					flexDirection: "column",
					width: 640,
					padding: "56px 56px",
					background: PAPER,
					transform: "rotate(-1deg)",
					boxShadow: "0 24px 80px rgba(0, 0, 0, 0.55)",
				}}
			>
				{/* Top perforation — punched holes in the ground color */}
				<div
					style={{
						position: "absolute",
						top: -9,
						left: 0,
						right: 0,
						display: "flex",
						justifyContent: "space-between",
						padding: "0 18px",
					}}
				>
					{dots.map((i) => (
						<div
							key={`t${i}`}
							style={{ width: 16, height: 16, borderRadius: 9999, background: GROUND }}
						/>
					))}
				</div>

				{/* Wordmark */}
				<div
					style={{
						display: "flex",
						justifyContent: "center",
						fontSize: 30,
						fontWeight: 700,
						letterSpacing: "0.14em",
						color: INK,
						fontFamily: "monospace",
					}}
				>
					usertrust
				</div>

				<div style={{ marginTop: 30, borderTop: `2px dashed ${RULE}` }} />

				{/* Headline — pinned two-line break; period is on-paper emerald */}
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						marginTop: 34,
						fontSize: 88,
						fontWeight: 800,
						lineHeight: 1,
						letterSpacing: "-0.02em",
						color: INK,
					}}
				>
					<span>keep the</span>
					<div style={{ display: "flex" }}>
						<span>receipts</span>
						<span style={{ color: PAPER_EMERALD }}>.</span>
					</div>
				</div>

				<div style={{ marginTop: 34, borderTop: `2px dashed ${RULE}` }} />

				{/* Mono footer */}
				<div
					style={{
						display: "flex",
						marginTop: 28,
						fontSize: 26,
						fontFamily: "monospace",
						color: INK,
					}}
				>
					<span style={{ color: INK_DIM }}>$</span>
					<span style={{ marginLeft: 12 }}>npm install usertrust</span>
				</div>

				{/* Bottom perforation */}
				<div
					style={{
						position: "absolute",
						bottom: -9,
						left: 0,
						right: 0,
						display: "flex",
						justifyContent: "space-between",
						padding: "0 18px",
					}}
				>
					{dots.map((i) => (
						<div
							key={`b${i}`}
							style={{ width: 16, height: 16, borderRadius: 9999, background: GROUND }}
						/>
					))}
				</div>
			</div>

			{/* Mascot cutout — dark ground, right of the card (Addendum G) */}
			<div style={{ display: "flex", position: "absolute", right: 72, bottom: 64 }}>
				{/* biome-ignore lint/a11y/useAltText: satori OG renderer, decorative */}
				{/* biome-ignore lint/performance/noImgElement: satori renders via <img>, not next/image */}
				<img src={mascotBytes as unknown as string} height={220} style={{ opacity: 0.9 }} />
			</div>
		</div>,
		{ width: 1200, height: 630 },
	);
}
