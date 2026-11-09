// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Every handler that acts on Escape marks the press as handled (`preventDefault`) on the path where it acts, so the
 * desk's Escape peel (escape-peel.ts), which ignores a marked press, does not take a second layer with the same press.
 * A React handler runs before the peel's document listener, and its state update can have closed what it closed
 * before the peel looks, so "the peel will see the popover is open" is not a guard. Read in the source: these tests
 * render without a DOM.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(import.meta.dirname, "..", "src", "app");

/** The index of the bracket that closes the one at `open` (`(` or `{`), or -1. */
function closing(src: string, open: number): number {
	const o = src[open];
	const c = o === "(" ? ")" : "}";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === o) depth++;
		else if (src[i] === c && --depth === 0) return i;
	}
	return -1;
}

/** The index of the `{` that opens the block enclosing `at`, or -1. */
function enclosingOpen(src: string, at: number): number {
	let depth = 0;
	for (let i = at; i >= 0; i--) {
		if (src[i] === "}") depth++;
		else if (src[i] === "{") {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

export interface EscapeSite {
	line: number;
	/** The source of the `if` whose condition tests for Escape, for the allowlist and the report. */
	check: string;
	/** The code that runs when the press IS Escape: the `if`'s consequent for `=== "Escape"`, the rest of the block for
	 *  an early return on `!== "Escape"`. */
	acting: string;
}

/** Every `if` that tests a key against "Escape", with the code that acts on it. */
export function escapeSites(src: string): EscapeSite[] {
	const out: EscapeSite[] = [];
	for (const m of src.matchAll(/\.key\s*(===|!==)\s*"Escape"/g)) {
		const at = m.index ?? 0;
		const ifAt = src.lastIndexOf("if (", at);
		if (ifAt < 0) continue;
		const condEnd = closing(src, ifAt + 3);
		if (condEnd < at) continue;
		const check = src.slice(ifAt, condEnd + 1);
		let acting: string;
		if (m[1] === "===") {
			// The consequent: a block, or one statement up to its semicolon.
			let i = condEnd + 1;
			while (/\s/.test(src[i] ?? "")) i++;
			acting =
				src[i] === "{" ? src.slice(i, closing(src, i) + 1) : src.slice(i, src.indexOf(";", i) + 1);
		} else {
			// An early return on any other key: what follows it, to the end of the enclosing block, acts on Escape.
			const open = enclosingOpen(src, ifAt);
			const end = open < 0 ? src.length : closing(src, open);
			acting = src.slice(condEnd + 1, end);
		}
		out.push({ line: src.slice(0, at).split("\n").length, check, acting });
	}
	return out;
}

/** The sites whose acting code never marks the press. */
export function unmarked(src: string): EscapeSite[] {
	return escapeSites(src).filter((s) => !/\bpreventDefault\(\)/.test(s.acting));
}

/** Sites that need not mark the press, each with its reason. An entry that matches no unmarked site fails the scan. */
const ALLOW: Array<{ file: string; check: string; reason: string }> = [
	{
		file: "desk/escape-peel.ts",
		check: 'if (e.key !== "Escape" || e.defaultPrevented)',
		reason:
			"the peel's own test of the press: it is the listener the mark is for, and it reads the mark rather than setting it",
	},
];

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
		d.isDirectory()
			? sources(join(dir, d.name))
			: /\.(ts|tsx)$/.test(d.name)
				? [join(dir, d.name)]
				: [],
	);
}

describe("every Escape handler marks the press it acts on", () => {
	it("red-first (Escape handled twice): no handler in the app acts on Escape without marking it", () => {
		const found: string[] = [];
		const allowed = new Set<string>();
		for (const path of sources(APP)) {
			const file = relative(APP, path);
			for (const s of unmarked(readFileSync(path, "utf8"))) {
				const ok = ALLOW.find((a) => a.file === file && s.check.startsWith(a.check));
				if (ok) allowed.add(`${ok.file} ${ok.check}`);
				else found.push(`${file}:${s.line} ${s.check}`);
			}
		}
		expect(found).toEqual([]);
		// A stale allowlist entry fails: each must still name an unmarked site.
		expect(ALLOW.map((a) => `${a.file} ${a.check}`).filter((k) => !allowed.has(k))).toEqual([]);
	});

	it("CONTROL: a planted handler that closes on Escape without the mark is found, and the same handler marked is not", () => {
		const planted = `const esc = (e: KeyboardEvent): void => {\n\tif (e.key === "Escape") setOpen(false);\n};`;
		expect(unmarked(planted).map((s) => s.line)).toEqual([2]);
		const marked = `const esc = (e: KeyboardEvent): void => {\n\tif (e.key === "Escape") {\n\t\te.preventDefault();\n\t\tsetOpen(false);\n\t}\n};`;
		expect(unmarked(marked)).toEqual([]);
		// An early return on other keys: what follows acts on Escape, and must carry the mark.
		const early = `const onKey = (e: React.KeyboardEvent): void => {\n\tif (e.key !== "Escape" || !open) return;\n\tsetOpen(false);\n};`;
		expect(unmarked(early)).toHaveLength(1);
		// A mark on another key's branch does not count for Escape's.
		const otherBranch = `const onKey = (e: KeyboardEvent): void => {\n\tif (e.key === "Escape") {\n\t\tsetSheet(false);\n\t\treturn;\n\t}\n\tif (e.key === "Tab") e.preventDefault();\n};`;
		expect(unmarked(otherBranch)).toHaveLength(1);
	});
});
