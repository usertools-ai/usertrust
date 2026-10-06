/**
 * Details on a phone. With Details open on a narrow screen, the check ledger's
 * three columns (long mono check names, the result, the meaning) pushed the
 * meaning column past the viewport, and the trust-snapshot line, one
 * unbreakable mono token, overflowed its section: the page scrolled sideways.
 * These tests pin the two rules that fix it, in the markup and the stylesheet
 * (the suite has no browser):
 *   - below 640px the ledger stacks each row (check, result, meaning), hides
 *     its column headers, and lets a long check name wrap;
 *   - the receipt's container wraps any unbreakable token instead of
 *     overflowing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import StateView from "./components/state-view";
import { fixtureState, loadFixture } from "./fixture-harness";

const FIXTURES = [
	"cluster/first.json",
	"cluster/chained.json",
	"cluster/skipped.json",
	"cluster/skipped-overflow.json",
	"cluster/superseded.json",
	"session-owner-estimated.json",
];

/** The element carrying `data-testid="<id>"`, whole (first match, balanced). */
function element(html: string, id: string): string {
	const at = html.indexOf(`data-testid="${id}"`);
	assert.ok(at !== -1, `no element carries data-testid="${id}"`);
	const start = html.lastIndexOf("<", at);
	const tag = /^<([a-z0-9]+)/.exec(html.slice(start))?.[1] ?? "";
	let depth = 0;
	const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
	re.lastIndex = start;
	for (let match = re.exec(html); match !== null; match = re.exec(html)) {
		depth += match[1] === "/" ? -1 : 1;
		if (depth === 0) return html.slice(start, re.lastIndex);
	}
	return assert.fail(`unbalanced <${tag}>`);
}

for (const file of FIXTURES) {
	test(`${file}: the check ledger stacks its rows below 640px, so Details never scrolls sideways`, () => {
		const ledger = element(
			renderToStaticMarkup(<StateView state={fixtureState(loadFixture(file))} />),
			"check-ledger",
		);
		assert.match(ledger, /<table class="[^"]*\bmax-sm:block\b/, "the table stacks");
		assert.match(ledger, /<thead class="max-sm:hidden">/, "the column headers hide");
		assert.match(ledger, /<tbody class="max-sm:block">/, "the body stacks");
		const rows = [...ledger.matchAll(/<tr [^>]*data-check="[^"]+"[^>]*class="([^"]*)"/g)];
		assert.ok(rows.length > 0, "rows found");
		for (const [, cls] of rows) assert.match(cls, /\bmax-sm:block\b/, "each row stacks");
		const names = [...ledger.matchAll(/<th scope="row" class="([^"]*)"/g)];
		assert.equal(names.length, rows.length, "every row has its name cell");
		for (const [, cls] of names) {
			assert.match(cls, /\[overflow-wrap:anywhere\]/, "a long check name may wrap");
			assert.match(cls, /\bmax-sm:block\b/, "and sits on its own line");
		}
		const cells = [...ledger.matchAll(/<td class="([^"]*)"/g)];
		assert.equal(cells.length, rows.length * 2, "result and meaning per row");
		for (const [, cls] of cells) assert.match(cls, /\bmax-sm:block\b/, "each cell stacks");
	});
}

test("no unbreakable token may push the receipt sideways: the receipt wraps anywhere it must", () => {
	// Measured on a live receipt at 320px with Details open: the trust
	// snapshot's long name overflowed its section by about 340px until this rule.
	const css = readFileSync(new URL("./brand.css", import.meta.url), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);
	const main = /\.ut-r \.ut-r-main\{([^}]*)\}/.exec(css)?.[1] ?? "";
	assert.match(main, /overflow-wrap:anywhere/);
	assert.match(main, /font-variant-numeric:tabular-nums/, "the existing rule is kept");
});
