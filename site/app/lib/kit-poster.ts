import { fetchPinnedBytes } from "../r/lib/kit-pinned";
import { KIT_POSTER } from "./kit-images";

/**
 * The `/og` card's ground (the hero's settled frame), loaded from the brand kit at render time and
 * PINNED, the way the share card's fonts and frame are (`r/lib/kit-fonts.ts`, `r/lib/kit-frame.ts`):
 * the bytes must match `KIT_POSTER.integrity`, and any other bytes are refused.
 *
 * Server-side only (the OG route runs on Node).
 */

/** How long the card waits for the kit before it renders without the poster. */
export const KIT_POSTER_TIMEOUT_MS = 3000;

/** A JPEG's first bytes (SOI, then a marker). */
const JPEG_SOI = [0xff, 0xd8, 0xff];

/**
 * The verified poster as the ArrayBuffer the image renderer takes, or `undefined` if the fetch
 * fails, the pin fails, or the bytes are not a JPEG. Never a throw: the card renders without it.
 */
export async function loadPinnedPoster(
	spec: { url: string; integrity: string } = KIT_POSTER,
	fetchImpl: typeof fetch = fetch,
	timeoutMs: number = KIT_POSTER_TIMEOUT_MS,
): Promise<ArrayBuffer | undefined> {
	try {
		const bytes = await fetchPinnedBytes(spec.url, spec.integrity, fetchImpl, timeoutMs);
		if (!JPEG_SOI.every((b, i) => bytes[i] === b)) return undefined;
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	} catch {
		return undefined;
	}
}

let verified: Promise<ArrayBuffer | undefined> | undefined;

/** The pinned poster, loaded once per server instance once it verifies. A failure is not cached. */
export function getKitPoster(): Promise<ArrayBuffer | undefined> {
	verified ??= loadPinnedPoster().then((poster) => {
		if (poster === undefined) verified = undefined;
		return poster;
	});
	return verified;
}
