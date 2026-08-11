/**
 * Defensive reads for the UNSIGNED envelope members — `anchorEvidence`,
 * `checkpointHistory`, `display`.
 *
 * The page has two shapes of input and two different fail-closed answers, and
 * the difference is R10's:
 *
 *   - the SIGNED document is validated STRICTLY by `wire.ts` (§2/§5 shapes),
 *     and a wrong shape there is a §4 schema failure that lands in R37's named
 *     protocol-error shell — a receipt whose own committed fields are not what
 *     they claim to be is not a receipt this page will render;
 *   - the UNSIGNED members are READ, never validated into a verdict. "Unsigned
 *     material is exactly what an attacker can substitute; the page must not
 *     let it demote a sound receipt" (R10) — so a member whose shape a
 *     component does not recognize renders as ABSENT, and the base verdict is
 *     untouched. The check RESULT still renders either way, which is the part
 *     that carries authority (R9).
 *
 * What both halves rule out is the third answer: a render-time throw. That is
 * Next's generic 500 — no verdict, no §7 state, none of R35's guarantees — and
 * "fail closed" means failing into a NAMED state, not into the framework.
 */

export type Bag = Record<string, unknown>;

export function isBag(value: unknown): value is Bag {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string member, or `undefined` — never a rendered `[object Object]`. */
export function str(bag: Bag, key: string): string | undefined {
	const value = bag[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A finite number member, or `undefined`. */
export function num(bag: Bag, key: string): number | undefined {
	const value = bag[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A boolean member, or `undefined` (an absent flag is not a false one). */
export function bool(bag: Bag, key: string): boolean | undefined {
	return typeof bag[key] === "boolean" ? (bag[key] as boolean) : undefined;
}

/** The members of an array-valued member that are objects; `[]` for anything else. */
export function bagList(value: unknown): Bag[] {
	return Array.isArray(value) ? value.filter(isBag) : [];
}

/** The members of an array-valued member that are non-empty strings. */
export function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.length > 0)
		: [];
}
