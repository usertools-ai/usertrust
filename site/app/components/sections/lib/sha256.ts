/**
 * Exhibit D tamper-demo hashing. Shared by the client island and its
 * node:test suite. Uses only WebCrypto + TextEncoder globals — present in
 * every evergreen browser (secure context) and in Node >= 18.
 */

/** The payload fields of one displayed chain-slice card. */
export interface DemoEntryPayload {
	seq: number;
	type: string;
	timestamp: string;
	summary: string;
}

/**
 * Canonical preimage for the demo: alphabetically-keyed compact JSON of the
 * card's visible payload plus its link to the previous entry. Mirrors
 * packages/core/src/audit/canonical.ts (sorted keys, no whitespace, the
 * recorded hash is never part of its own preimage). The object literal below
 * lists keys in sorted order and JSON.stringify preserves insertion order,
 * so the output is canonical by construction.
 */
export function canonicalEntryString(entry: DemoEntryPayload, prevHash: string): string {
	return JSON.stringify({
		prevHash,
		seq: entry.seq,
		summary: entry.summary,
		timestamp: entry.timestamp,
		type: entry.type,
	});
}

/** Real SHA-256 over UTF-8 bytes, hex-encoded. */
export async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * XOR the lowest bit of the first code unit — a single visible byte flip.
 * XOR with 0x01 is an involution, so flipping twice restores the original.
 */
export function flipFirstByte(s: string): string {
	if (s.length === 0) return s;
	return String.fromCharCode(s.charCodeAt(0) ^ 0x01) + s.slice(1);
}
