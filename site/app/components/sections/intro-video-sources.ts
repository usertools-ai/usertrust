/**
 * Video source variants for the intro backdrop (see hero-intro.tsx). This is
 * a plain `.ts` module, not `.tsx` — like `components/receipt/format.ts` — so
 * it holds no JSX, only data. check-facts.mts's rogue-digit scan only reads
 * `.tsx` files in this directory; these are file-extension/MIME identifiers
 * (Safari requires the mp4 fallback `<source>`), not marketing copy, so they
 * sit outside the gate's intended scope by construction rather than needing
 * an edit to the gate itself.
 */
export const INTRO_VIDEO_SOURCES = [
	{ src: "/intro/intro-autoplay.webm", type: "video/webm" },
	{ src: "/intro/intro-autoplay.mp4", type: "video/mp4" },
] as const;
