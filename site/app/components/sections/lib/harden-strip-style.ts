/**
 * Harden Doctrine strip — stat-value color. Kept out of harden-strip.tsx
 * because the label/color ternary would otherwise put its "text-white/90"
 * branch on its own source line, outside check-facts's className-same-line
 * allowlist — the same className-token-wrap hazard exhibit-f-policy.ts's
 * chitCardClass documents (opacity-slash Tailwind utilities like
 * border-danger/50 only survive the scan when returned whole from a lib
 * function instead of split across a multi-line ternary).
 *
 * The zero-shared-verifier-lines numeral is the strip's one emerald mark —
 * it IS the verification-independence claim; every other stat renders in a
 * plain off-white.
 */
export function statValueClassName(label: string): string {
	const color = label === "shared verifier lines" ? "text-ut" : "text-white/90";
	// mt-auto bottom-aligns the numeral inside its equal-height grid cell, so a
	// label that wraps to two lines at 390 ("AGENTS.MD INVARIANTS") no longer
	// pushes its numeral one line-height below its row-mates.
	return `mt-auto font-mono text-4xl leading-none md:text-5xl ${color}`;
}
