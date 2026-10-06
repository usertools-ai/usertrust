import { createHash } from "node:crypto";
// @ts-expect-error -- wawoff2 ships no type declarations; decompress(woff2) resolves to TTF bytes
import decompress from "wawoff2/decompress";

/**
 * The share card's brand fonts, fetched from the brand kit at render time and
 * PINNED. No brand asset lives in this repository, so the card loads the
 * kit's own files; the kit serves them as woff2, which the image renderer
 * cannot read, so each is decompressed to TTF after its bytes check out.
 *
 * Pinned, as the page's lattice script is: each file's sha384 is set here, and
 * any other bytes are refused. A replaced font could remap glyphs so that the
 * verdict or the amount LOOKS unlike the text the card renders; with the pin,
 * it never reaches the renderer. Updating a font is a reviewed change to its
 * line below: `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
 *
 * Server-side only (the OG route runs on Node).
 */
export interface PinnedFont {
	name: string;
	weight: 500 | 700;
	url: string;
	integrity: string;
}

/** What the image renderer takes. */
export interface CardFont {
	name: string;
	data: ArrayBuffer;
	weight: 500 | 700;
	style: "normal";
}

export const KIT_FONTS: readonly PinnedFont[] = [
	{
		name: "Usertools Sans",
		weight: 700,
		url: "https://usertrust.ai/kit/fonts/UsertoolsSans-Bold.woff2",
		integrity: "sha384-4VUXquEEk06VnqIylqcwVD7njxe+rNZQwD7RgWBP/+IwwKIiXL8YGB2yrZ3SDsGE",
	},
	{
		name: "Usertools Sans",
		weight: 500,
		url: "https://usertrust.ai/kit/fonts/UsertoolsSans-Medium.woff2",
		integrity: "sha384-z/JCyQWuIoV/SEkZg8aC0AIH1faMb3TiUwkJculoPF5JlGjx8PJ6LNprEGrO5ECG",
	},
];

/** How long the card waits for the kit before it renders without the brand fonts. */
export const KIT_FONT_TIMEOUT_MS = 3000;

/**
 * Every pinned font, verified and decoded, or `undefined` if ANY of them fails
 * to fetch, fails its pin, or fails to decode. Never a partial set: the card
 * renders either fully branded or fully in the renderer's default font.
 */
export async function loadPinnedFonts(
	specs: readonly PinnedFont[] = KIT_FONTS,
	fetchImpl: typeof fetch = fetch,
	timeoutMs: number = KIT_FONT_TIMEOUT_MS,
): Promise<CardFont[] | undefined> {
	try {
		return await Promise.all(
			specs.map(async (spec) => {
				const response = await fetchImpl(spec.url, { signal: AbortSignal.timeout(timeoutMs) });
				if (!response.ok) throw new Error(`${spec.url}: HTTP ${response.status}`);
				const bytes = new Uint8Array(await response.arrayBuffer());
				const actual = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
				if (actual !== spec.integrity) throw new Error(`${spec.url}: integrity mismatch`);
				const ttf: Uint8Array = await decompress(bytes);
				const data = ttf.buffer.slice(
					ttf.byteOffset,
					ttf.byteOffset + ttf.byteLength,
				) as ArrayBuffer;
				return { name: spec.name, data, weight: spec.weight, style: "normal" as const };
			}),
		);
	} catch {
		return undefined;
	}
}

let verified: Promise<CardFont[] | undefined> | undefined;

/**
 * The pinned fonts, loaded once per server instance once they verify. A
 * failure is not cached: the next card tries the kit again.
 */
export function getKitFonts(): Promise<CardFont[] | undefined> {
	verified ??= loadPinnedFonts().then((fonts) => {
		if (fonts === undefined) verified = undefined;
		return fonts;
	});
	return verified;
}
