/**
 * Exhibit G tuning constant. Lives in app/components/sections/lib — outside
 * the check-facts prebuild gate's line-by-line scan of
 * app/components/sections/*.tsx — so the attack-row reveal stagger is a real
 * named constant, never a digit literal in marketing JSX. Same pattern as
 * app/lib/leader-path.ts's DRAW_STAGGER_MS and this directory's
 * exhibit-f-policy.ts's DROP_STAGGER_MS.
 */
export const ROW_STAGGER_MS = 40;

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

/** True when a title still opens with its own spec-row number. */
export function titleCarriesSpecNumber(name: string): boolean {
	return /^\s*\d+\./.test(name);
}
