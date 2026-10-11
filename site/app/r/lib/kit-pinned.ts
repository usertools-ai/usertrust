import { createHash } from "node:crypto";

/**
 * One kit file, fetched and PINNED: the bytes, or an error. Any other bytes than the reviewed
 * sha384 are refused, so a replaced file never reaches the renderer. Server-side only.
 */
export async function fetchPinnedBytes(
	url: string,
	integrity: string,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<Uint8Array> {
	const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const actual = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
	if (actual !== integrity) throw new Error(`${url}: integrity mismatch`);
	return bytes;
}
