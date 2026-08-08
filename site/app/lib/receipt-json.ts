import type { CapturedReceipt, ChainSlice } from "../evidence/types";

/**
 * Server-side JSON formatter for the Exhibit A evidence terminal. Turns the
 * captured receipt object into an array of line records with STABLE KEYS
 * (the field's dotted path), so the annotation island can target
 * `[data-line="transferId"]`, `[data-line="cost"]`, … across re-renders.
 * Pure data in, data out — no DOM, no React — so it is testable under
 * node:test.
 *
 * Line keys: "root" / "root.close" for the outer braces; a scalar field is
 * its path ("transferId", "cost.estimated"); a nested object opens at its
 * path ("cost") and closes at `${path}.close`.
 */

export type JsonScalar = string | number | boolean | null;
export interface JsonObject {
	[key: string]: JsonScalar | JsonObject;
}

export interface JsonToken {
	/** Stable render key: `${lineKey}#${position-within-line}`. */
	key: string;
	text: string;
	role: "key" | "string" | "number" | "boolean" | "null" | "punct";
}

export interface JsonLine {
	key: string;
	/** Nesting depth — rendered as two spaces per level. */
	indent: number;
	tokens: JsonToken[];
}

function scalarRole(v: JsonScalar): JsonToken["role"] {
	if (v === null) return "null";
	if (typeof v === "string") return "string";
	if (typeof v === "number") return "number";
	return "boolean";
}

function scalarText(v: JsonScalar): string {
	return typeof v === "string" ? `"${v}"` : String(v);
}

function toLine(
	key: string,
	indent: number,
	parts: Array<Pick<JsonToken, "text" | "role">>,
): JsonLine {
	return { key, indent, tokens: parts.map((p, i) => ({ ...p, key: `${key}#${i}` })) };
}

function emit(obj: JsonObject, prefix: string, indent: number, lines: JsonLine[]): void {
	const entries = Object.entries(obj);
	entries.forEach(([name, value], i) => {
		const path = prefix === "" ? name : `${prefix}.${name}`;
		const comma = i < entries.length - 1;
		if (value !== null && typeof value === "object") {
			lines.push(
				toLine(path, indent, [
					{ text: `"${name}"`, role: "key" },
					{ text: ": ", role: "punct" },
					{ text: "{", role: "punct" },
				]),
			);
			emit(value, path, indent + 1, lines);
			lines.push(toLine(`${path}.close`, indent, [{ text: comma ? "}," : "}", role: "punct" }]));
		} else {
			const parts: Array<Pick<JsonToken, "text" | "role">> = [
				{ text: `"${name}"`, role: "key" },
				{ text: ": ", role: "punct" },
				{ text: scalarText(value), role: scalarRole(value) },
			];
			if (comma) parts.push({ text: ",", role: "punct" });
			lines.push(toLine(path, indent, parts));
		}
	});
}

export function jsonLines(root: JsonObject): JsonLine[] {
	const lines: JsonLine[] = [toLine("root", 0, [{ text: "{", role: "punct" }])];
	emit(root, "", 1, lines);
	lines.push(toLine("root.close", 0, [{ text: "}", role: "punct" }]));
	return lines;
}

/** The captured receipt, typed — the one JSON payload Exhibit A renders. */
export function receiptJsonLines(receipt: CapturedReceipt["receipt"]): JsonLine[] {
	return jsonLines(receipt as unknown as JsonObject);
}

/** seq of the chain entry the receipt's auditHash lands on (fallback: newest). */
export function chainSeqFor(slice: ChainSlice, auditHash: string): number {
	const hit = slice.entries.find((e) => e.hash === auditHash);
	return (hit ?? slice.entries[slice.entries.length - 1]).seq;
}

/**
 * Syntax-tint class for a JSON token in the evidence terminal. Lives here
 * (outside app/components/sections) so its Tailwind opacity literals
 * (e.g. "text-white/40") never land in the check-facts digit scan of
 * marketing-section JSX — the same rationale as the leader-path tuning
 * constants.
 */
export function tokenClass(role: JsonToken["role"], emerald: boolean): string {
	if (emerald) return "text-ut";
	if (role === "key") return "text-tim";
	if (role === "punct") return "text-white/40";
	return "text-white";
}
