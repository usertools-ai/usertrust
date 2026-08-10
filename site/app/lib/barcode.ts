/*
 * Code-128-STYLE bars — honest decoration, not a scannable symbology. Each hex
 * nibble of the chain-head prefix maps to one dark bar (nibble % 4) + 1 units
 * wide, separated by 1-unit gaps, so the pattern is a deterministic function
 * of the captured chain head and nothing else. The rendered label states the
 * hash prefix in plain text; the bars are provenance-as-texture.
 */
export interface Bar {
	x: number;
	width: number;
}

/*
 * Chars of the chain-head hash rendered as bars — kept here (not as a bare
 * literal in open-ledger.tsx) because check-facts scans every line of
 * app/components/sections/*.tsx for un-sanctioned digit literals; this length
 * is a rendering choice, not a fact from facts.json, so it belongs beside the
 * function that consumes it instead of in the scanned section file.
 */
export const CHAIN_HEAD_PREFIX_LENGTH = 24;

/** Slices the chain-head hash down to the prefix `barcodeBars` renders. */
export function chainHeadPrefix(hash: string): string {
	return hash.slice(0, CHAIN_HEAD_PREFIX_LENGTH);
}

export function barcodeBars(hexPrefix: string): { bars: Bar[]; total: number } {
	let x = 0;
	const bars: Bar[] = [];
	for (const ch of hexPrefix) {
		const nibble = Number.parseInt(ch, 16);
		if (Number.isNaN(nibble)) throw new Error(`barcodeBars: non-hex character "${ch}"`);
		const width = (nibble % 4) + 1;
		bars.push({ x, width });
		x += width + 1;
	}
	return { bars, total: Math.max(0, x - 1) };
}

/**
 * Hash of the newest entry in a chain slice — the chain HEAD.
 *
 * Lives here rather than inline in open-ledger.tsx for the reason every helper
 * in app/lib does: `entries[entries.length - 1]` puts a bare `1` in a file the
 * check-facts gate scans line by line, and index arithmetic is not a product
 * number. Moving the expression is the fix; exempting the line is not.
 */
export function chainHeadHash(entries: Array<{ hash: string }>): string {
	return entries[entries.length - 1].hash;
}

/** Date half of an ISO timestamp, without a digit-literal slice length. */
export function isoDate(iso: string): string {
	return iso.split("T")[0];
}
