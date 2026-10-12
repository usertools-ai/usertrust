/**
 * The site's brand images, loaded at runtime from the brand kit and never tracked in this
 * repository (the guard is `scripts/no-brand-assets.test.mts`). Every URL is ABSOLUTE, so a
 * preview or Git deploy, which has no untracked files, loads the same image as production; the kit
 * serves them with `access-control-allow-origin: *`.
 *
 * Plain data, no Node import: client components read it too. The server-side `/og` card fetches the
 * poster through `kit-poster.ts`, pinned to `KIT_POSTER.integrity`.
 */
export const KIT_IMAGES = {
	/** The open-ledger section's mascot plate (898x1200, on its white studio ground). */
	mascotPanel: "https://usertrust.ai/kit/images/mascot-panel.jpg",
	/** The hero's settled frame, and the `/og` card's ground. */
	introPoster: "https://usertrust.ai/kit/images/intro-poster.jpg",
	/** The hero's first frame, shown before the intro plays. */
	introFirst: "https://usertrust.ai/kit/images/intro-first.jpg",
	/** The site icon. */
	favicon: "https://usertrust.ai/kit/images/favicon.svg",
} as const;

/**
 * The `/og` card's ground, pinned: any other bytes are refused and the card renders without it.
 * The kit keeps this file frozen; a new poster is a new kit file and a reviewed change to these
 * two lines: `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */
export const KIT_POSTER = {
	url: KIT_IMAGES.introPoster,
	integrity: "sha384-l/2ttG2T3ZccNaEIZWkwIwmYXudVN/njpHo5AmbVz4Kh8h3J2fU0z4Hg2gte8+y2",
} as const;
