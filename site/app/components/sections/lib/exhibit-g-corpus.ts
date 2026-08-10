/**
 * Exhibit G tuning constant. Lives in app/components/sections/lib — outside
 * the check-facts prebuild gate's line-by-line scan of
 * app/components/sections/*.tsx — so the attack-row reveal stagger is a real
 * named constant, never a digit literal in marketing JSX. Same pattern as
 * app/lib/leader-path.ts's DRAW_STAGGER_MS and this directory's
 * exhibit-f-policy.ts's DROP_STAGGER_MS.
 *
 * 50ms (Addendum M2's reveal choreography) — the bolder y-rise + blur entry
 * (globals.css's attack-row-in) reads as a single crisp cascade at this step;
 * the previous 40ms was tuned for the smaller 6px slide it has since traded up
 * from and looked too fast once the entry grew heavier.
 */
export const ROW_STAGGER_MS = 50;

/**
 * Zero-padded 1..N ROW INDEX for the corpus table.
 *
 * The fixture preserves each harden test's title verbatim, and those titles
 * open with the SPEC-ROW number they cover — a sequence that skips 17 (the
 * fork case folds row 17 into case 5). So the visible list counted to 30 beside
 * a 29 stat, which reads as a miscount on a page whose entire argument is that
 * its numbers are derived.
 *
 * The fix is an index column derived from array POSITION, so the ordinal a
 * reader counts along always ends at the count the stat states. Titles stay
 * untouched: they are provenance, and renumbering a test title in a marketing
 * table is the exact move this page exists to refuse. The footnote under the
 * table says both things are true at once.
 *
 * Padded to the width of the largest index so the column is a straight edge —
 * derived from `total`, never a hardcoded width.
 */
export function rowIndexLabel(position: number, total: number): string {
	return String(position + 1).padStart(String(total).length, "0");
}

/**
 * A leading SPEC-ROW ORDINAL: digits, a dot, then whitespace or end of string.
 * The trailing `(?=\s|$)` is what keeps `1.2 rotation window` and
 * `sha-256 mismatch` out — a version number and a hyphenated algorithm name
 * are content, and stripping either would corrupt a real test title.
 */
const SPEC_NUMBER_PREFIX = /^\s*\d+\.(?=\s|$)\s*/;

/** True when a title still opens with its own spec-row number. */
export function titleCarriesSpecNumber(name: string): boolean {
	return SPEC_NUMBER_PREFIX.test(name);
}

/**
 * The title as the corpus table RENDERS it.
 *
 * The fixture preserves each harden test's title verbatim, prefix included —
 * that is provenance, and the row still links to the source file where the
 * prefix is visible. But those prefixes are SPEC-ROW numbers from a sequence
 * that skips 17 (folded into scenario 5 upstream), so on the page they sat
 * beside the table's own 01..N gutter disagreeing with it: two numbering
 * systems, one row, on a page whose whole argument is that its numbers are
 * derived.
 *
 * So the prefix is dropped at RENDER only. The fixture stays frozen, the link
 * stays honest, and the gutter is the only numbering a reader can count.
 * A title with no prefix comes back untouched.
 */
export function displayTitle(name: string): string {
	return name.replace(SPEC_NUMBER_PREFIX, "");
}

/*
 * The corpus FOOTNOTE is deliberately not here. It is copy, so it lives with
 * the copy, in exhibit-g.tsx under the check-facts scan; its two provenance
 * digits are sanctioned by name in scripts/check-facts.mts. This file holds
 * tuning constants and pure functions — things whose digits are code — and
 * that is the only thing its position outside the scan is allowed to buy.
 */
