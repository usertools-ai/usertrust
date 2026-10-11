import { fetchPinnedBytes } from "./kit-pinned";

/**
 * The share card's frame (the dotted field behind the card), loaded from the brand kit at render
 * time and PINNED, the way the card's fonts are (`lib/kit-fonts.ts`). No brand asset lives in this
 * repository, so the card fetches the kit's own file, an inert SVG at a content-addressed path:
 * `card-frame.<first 12 hex of its sha384>.svg`. A published frame is never edited; a change is a
 * new file and a reviewed change to the two lines below:
 * `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
 *
 * Server-side only (the OG route runs on Node).
 */
export const KIT_FRAME = {
	url: "https://usertrust.ai/kit/card-frame.482f6c2af97b.svg",
	integrity: "sha384-SC9sKvl7HM9xaduVgNYFjvRxCvD6m/h3CCQjeP6ETbo7faZ6YKFZrLQDHdzrBMS5",
} as const;

/** How long the card waits for the kit before it renders unbranded. */
export const KIT_FRAME_TIMEOUT_MS = 3000;

/**
 * The verified frame as a data URI the renderer can draw, or `undefined` if the fetch fails, the
 * pin fails, or the bytes are not an SVG document. Never a throw: the card renders unbranded.
 */
export async function loadPinnedFrame(
	spec: { url: string; integrity: string } = KIT_FRAME,
	fetchImpl: typeof fetch = fetch,
	timeoutMs: number = KIT_FRAME_TIMEOUT_MS,
): Promise<string | undefined> {
	try {
		const bytes = await fetchPinnedBytes(spec.url, spec.integrity, fetchImpl, timeoutMs);
		if (!new TextDecoder().decode(bytes.subarray(0, 64)).startsWith("<svg ")) return undefined;
		return `data:image/svg+xml;base64,${Buffer.from(bytes).toString("base64")}`;
	} catch {
		return undefined;
	}
}

let verified: Promise<string | undefined> | undefined;

/** The pinned frame, loaded once per server instance once it verifies. A failure is not cached. */
export function getKitFrame(): Promise<string | undefined> {
	verified ??= loadPinnedFrame().then((frame) => {
		if (frame === undefined) verified = undefined;
		return frame;
	});
	return verified;
}
