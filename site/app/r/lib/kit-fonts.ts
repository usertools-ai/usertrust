// @ts-expect-error -- wawoff2 ships no type declarations; decompress(woff2) resolves to TTF bytes
import decompress from "wawoff2/decompress";
import { fetchPinnedBytes } from "./kit-pinned";

/**
 * The share card's brand fonts, fetched from the brand kit at render time and
 * PINNED. The card never takes a font file from this repository: it loads the
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

/**
 * wawoff2 runs on ONE shared WASM heap and `decompress` returns a VIEW into it. A second decode
 * in flight overwrites the first's output before the first's post-`await` copy runs, so the first
 * font was another font's bytes (or invalid) and `getKitFonts()` then cached that for the whole
 * server instance. Every decode is therefore serialised TOGETHER with its copy; the fetches and the
 * integrity checks stay parallel. The chain survives a rejection so one bad font cannot wedge the
 * next card.
 */
let decodeChain: Promise<unknown> = Promise.resolve();

/** How long one font's decode may run before it is abandoned and the card renders unbranded. */
export const KIT_DECODE_TIMEOUT_MS = 3000;

/**
 * The queue is tied to each decode's ACTUAL settlement, and only the CALLER's wait is bounded. wawoff2
 * decodes in one shared WASM heap, so a decode that was merely abandoned (its caller timed out) can still
 * complete late and overwrite the NEXT decode's output if the next one is allowed to start. It is not:
 * the next decode waits for the abandoned one to really finish. The price of a decode that never settles
 * is that every later card's wait times out and renders UNBRANDED; the price is never a wrong font.
 */
export function decodeToTtf(
	bytes: Uint8Array,
	timeoutMs: number = KIT_DECODE_TIMEOUT_MS,
	decode: (woff2: Uint8Array) => Promise<Uint8Array> = decompress,
): Promise<ArrayBuffer> {
	// `actual` settles when THIS decode (and its copy) really does; the chain follows it, not the timer.
	const actual = decodeChain.then(async () => {
		const ttf = await decode(bytes);
		return ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength) as ArrayBuffer;
	});
	decodeChain = actual.then(
		() => undefined,
		() => undefined,
	);
	let settled = false;
	let abandoned = false;
	const done = (): void => {
		settled = true;
		// A decode that outlived its caller's wait has now really finished: the pipeline is free again.
		if (abandoned) stalledDecodes -= 1;
	};
	actual.then(done, done);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			if (!settled) {
				abandoned = true;
				stalledDecodes += 1;
			}
			reject(new Error("font decode timed out"));
		}, timeoutMs);
	});
	return Promise.race([actual, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * Decodes whose caller gave up but which have not really finished. While any is stalled, a new card does NOT
 * fetch fonts or enqueue another decode behind it (each would keep its buffers after its caller timed out:
 * unbounded memory on a public endpoint): it answers UNBRANDED at once. Single-flight until the stalled
 * decode actually settles, which also keeps the WASM heap serialised.
 */
let stalledDecodes = 0;

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
	decodeImpl: (bytes: Uint8Array) => Promise<ArrayBuffer> = decodeToTtf,
): Promise<CardFont[] | undefined> {
	if (stalledDecodes > 0) return undefined;
	try {
		return await Promise.all(
			specs.map(async (spec) => {
				const bytes = await fetchPinnedBytes(spec.url, spec.integrity, fetchImpl, timeoutMs);
				const data = await decodeImpl(bytes);
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
