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

/** The class tokens of an opening tag's `class` attribute. */
const classesOf = (tag: string) =>
	(/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
/** Every opening tag `<name ...>` in `html`. */
const tags = (html: string, name: string) =>
	[...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);

for (const file of FIXTURES) {
	test(`${file}: the check ledger stacks below 640px and stays a table above it, for sight and for screen readers`, () => {
		const ledger = element(
			renderToStaticMarkup(<StateView state={fixtureState(loadFixture(file))} />),
			"check-ledger",
		);
		const [table] = tags(ledger, "table");
		const [thead] = tags(ledger, "thead");
		const [tbody] = tags(ledger, "tbody");
		assert.ok(table && thead && tbody, "a table with a head and a body");
		// Stacked on a phone.
		assert.ok(classesOf(table).includes("max-sm:block"), "the table stacks");
		assert.ok(classesOf(tbody).includes("max-sm:block"), "the body stacks");
		// The column headers leave the screen, not the accessibility tree.
		assert.ok(
			classesOf(thead).includes("max-sm:sr-only"),
			"the column headers are visually hidden",
		);
		assert.ok(
			!classesOf(thead).includes("max-sm:hidden"),
			"never display:none, which hides them from screen readers",
		);
		// display:block can strip table semantics in some engines, so every stacked
		// cell names its column for screen readers; above 640px the label is not
		// rendered (display:none), so it is never read twice.
		const label = (name: string) =>
			`<span class="hidden max-sm:inline max-sm:sr-only">${name}: </span>`;
		const rows = tags(ledger, "tr").filter((tr) => tr.includes("data-check="));
		assert.ok(rows.length > 0, "rows found");
		for (const tr of rows) assert.ok(classesOf(tr).includes("max-sm:block"), "each row stacks");
		const names = tags(ledger, "th").filter((th) => th.includes('scope="row"'));
		assert.equal(names.length, rows.length, "every row has its name cell");
		for (const th of names) {
			const cls = classesOf(th);
			// A check name may wrap anywhere ONLY when stacked: above 640px it is a
			// table cell, and an unprefixed rule would collapse the name column and
			// break every label mid-word.
			assert.ok(cls.includes("max-sm:[overflow-wrap:anywhere]"), "a long name may wrap on a phone");
			assert.ok(!cls.includes("[overflow-wrap:anywhere]"), "and never in the desktop table");
			assert.ok(cls.includes("max-sm:block"), "and sits on its own line when stacked");
		}
		const cells = tags(ledger, "td");
		assert.equal(cells.length, rows.length * 2, "result and meaning per row");
		for (const td of cells) assert.ok(classesOf(td).includes("max-sm:block"), "each cell stacks");
		// Each stacked cell opens with its column's screen-reader label.
		for (const [name, opener] of [
			["check", /<th scope="row"[^>]*>/g],
			["result", /<td class="[^"]*font-mono[^"]*">/g],
			["meaning", /<td class="[^"]*leading-relaxed[^"]*">/g],
		] as const) {
			const opens = [...ledger.matchAll(opener)];
			assert.equal(opens.length, rows.length, `${name}: one per row`);
			for (const open of opens) {
				const after = ledger.slice((open.index ?? 0) + open[0].length);
				assert.ok(after.startsWith(label(name)), `the ${name} cell is labelled for screen readers`);
			}
		}
	});
}

test("only the overflowing line wraps anywhere; the receipt as a whole does not, so a large amount stays on one line", () => {
	// The trust snapshot's long name overflowed the ledger by about 270px on a
	// phone. It alone may break anywhere.
	const html = renderToStaticMarkup(
		<StateView state={fixtureState(loadFixture("cluster/skipped-overflow.json"))} />,
	);
	assert.match(element(html, "trust-snapshot"), /^<p [^>]*class="[^"]*\[overflow-wrap:anywhere\]/);
	// A container-wide `overflow-wrap: anywhere` lowers min-content widths, so a
	// flex-wrapped amount like "$12345.6789" would split across two lines at
	// 320px. The receipt's container must not carry it, and neither may the amount.
	const css = readFileSync(new URL("./brand.css", import.meta.url), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);
	const main = /\.ut-r \.ut-r-main\{([^}]*)\}/.exec(css)?.[1] ?? "";
	assert.match(main, /font-variant-numeric:tabular-nums/, "the existing rule is kept");
	assert.doesNotMatch(
		css,
		/\.ut-r-main[^{]*\{[^}]*overflow-wrap/,
		"no wrap-anywhere on the receipt as a whole",
	);
	assert.doesNotMatch(
		element(html, "amount-usd"),
		/overflow-wrap|break-all|break-words/,
		"the amount never breaks",
	);
});
