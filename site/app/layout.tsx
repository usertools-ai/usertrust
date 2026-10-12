import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import { preconnect, preload } from "react-dom";
import Cursor from "./components/cursor";
import { NoiseOverlay } from "./components/noise-overlay";
import "./globals.css";

/*
 * No font file lives in this public repository (site/scripts/no-font-files.test.mts
 * fails if one is tracked). The faces are declared in globals.css and load at
 * runtime from the brand kit, which serves them with
 * `access-control-allow-origin: *`; `font-display: swap` and the system stacks
 * behind them keep the page readable if the kit is unreachable.
 *
 * Font-loading doctrine: preload display + mono only — the faces the hero
 * paints first (its headline renders Khand SemiBold). Usertools Sans is the
 * prose voice, first used below the fold; preloading it would compete with the
 * LCP. Fonts are always fetched in CORS mode, so the preconnect and the
 * preloads are anonymous too, or the browser fetches each file twice.
 */
const KIT_ORIGIN = "https://usertrust.ai";
const PRELOADED_FONTS = [
	"https://usertrust.ai/kit/fonts/Khand-SemiBold.woff2",
	"https://usertrust.ai/kit/fonts/JetBrainsMono-Regular.woff2",
] as const;

/*
 * "tamper-evident", not "immutable". The audit chain DETECTS mutation; it does
 * not prevent it, and the small print in Exhibit D has said so since it
 * shipped ("tamper-evident, not tamper-proof — detection, not recovery"). A
 * meta description promising immutability contradicted the page's own most
 * careful sentence, in the one string search engines quote back.
 */
const description =
	"financial governance for AI agents. every governed LLM call becomes a tamper-evident ledger transaction — with a receipt anyone can verify.";

export const metadata: Metadata = {
	/*
	 * The TAB says just the brand; the SHARE CARDS keep the tagline. A browser
	 * tab is a few characters wide and truncates from the right, so the tagline
	 * was the only part a reader with a dozen tabs open ever saw. og:title and
	 * twitter:title below are unchanged — a share card has room, and that is
	 * where the brand line earns its keep.
	 */
	title: "usertrust",
	description,
	keywords: [
		"AI governance",
		"LLM spend",
		"budget holds",
		"audit trail",
		"receipts",
		"verifiable audit",
		"usertrust",
		"AI finance",
		"agent governance",
		"OpenAI",
		"Anthropic",
		"SDK",
	],
	metadataBase: new URL("https://usertrust.ai"),
	alternates: { canonical: "/" },
	openGraph: {
		title: "usertrust — keep the receipts.",
		description,
		url: "https://usertrust.ai",
		siteName: "usertrust",
		images: [{ url: "/og", width: 1200, height: 630, type: "image/png" }],
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "usertrust — keep the receipts.",
		description,
		images: [{ url: "/og", width: 1200, height: 630 }],
	},
	icons: { icon: "/favicon.svg" },
};

/*
 * `viewportFit: "cover"` is what makes `env(safe-area-inset-*)` resolve to real
 * values on iOS; without it they are 0px and every safe-area utility in
 * globals.css silently does nothing. themeColor paints the iOS status bar and
 * Android chrome to match the page rather than flashing white on load.
 *
 * themeColor and colorScheme belong here, not on `metadata` — both carry
 * `@deprecated Use the new viewport configuration instead` on `Metadata`.
 */
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	themeColor: "#0a0a1a",
	colorScheme: "dark",
};

const jsonLd = {
	"@context": "https://schema.org",
	"@type": "SoftwareApplication",
	name: "usertrust",
	applicationCategory: "DeveloperApplication",
	license: "https://www.apache.org/licenses/LICENSE-2.0",
	offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
	author: { "@type": "Organization", name: "Usertools Inc" },
	url: "https://usertrust.ai",
	description:
		"keep the receipts. One line wraps your LLM client — every governed call becomes a ledger transaction with a receipt anyone can verify: budget holds, a tamper-evident audit chain, and an independent verifier with zero runtime dependencies.",
};

// Vercel sets VERCEL=1 at build time and at runtime for both Functions and
// static hosting, on every environment it actually serves (production AND
// preview) — never on a local `next dev`/`next start`. Gating on it means
// the analytics script tag is only emitted where its endpoint
// (`/_vercel/insights/script.js`) actually resolves: the real Vercel edge
// injects that route, `next start` on localhost does not, so requesting it
// there 404s and surfaces as a console network error. Real deploys are
// unaffected; this only silences a localhost-only artifact.
const isVercelRuntime = process.env.VERCEL === "1";

export default function RootLayout({ children }: { children: React.ReactNode }) {
	preconnect(KIT_ORIGIN, { crossOrigin: "anonymous" });
	for (const href of PRELOADED_FONTS) {
		preload(href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
	}
	return (
		<html lang="en">
			<body className="bg-brand-bg text-white font-sans antialiased overflow-x-hidden">
				<NoiseOverlay />
				<Cursor />
				{children}
				<script
					type="application/ld+json"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD structured data requires this pattern
					dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
				/>
				{isVercelRuntime && <Analytics />}
			</body>
		</html>
	);
}
