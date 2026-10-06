/**
 * The glance on a narrow screen. Real receipts carry longer lists than the
 * fixtures did: the first live receipt's models line, "claude-haiku-4-5 ·
 * claude-opus-5-5", split "claude-opus-" / "5-5" at 360px, and the header's ID
 * wrapped above its copy chip. These tests pin the two layout rules that fix
 * it, in the markup (the suite has no browser):
 *   - a list wraps BETWEEN names only: every name is one unbreakable unit;
 *   - the header's ID and its copy chip are one non-wrapping unit that can
 *     shrink (the ID ellipsizes), and the chip drops its label text below
 *     480px (its accessible name keeps it).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import StateView from "./components/state-view";
import { fixtureState, loadFixture } from "./fixture-harness";
import { applyClusterVector } from "./fixtures/cluster-vectors";
import { parseResolverResponse } from "./lib/wire";

/** A receipt shaped like the first live one: two long model names. */
function liveShapedState() {
	const applied = applyClusterVector({
		label: "live-shaped: two long model names",
		base: "cluster/chained.json",
		receipt: (receipt) => {
			const data = (receipt.event as Record<string, unknown>).data as Record<string, unknown>;
			data.models = ["claude-haiku-4-5", "claude-opus-5-5"];
			data.providers = ["anthropic"];
		},
		expect: { kind: "verified" },
		rule: "a rendering fixture, not a contract vector",
	});
	return parseResolverResponse({
		routeParamId: applied.routeParamId,
		httpStatus: applied.httpStatus,
		headers: new Headers(applied.headers),
		raw: JSON.stringify(applied.body),
	});
}

const CLUSTER_FILES = [
	"cluster/first.json",
	"cluster/chained.json",
	"cluster/skipped.json",
	"cluster/skipped-overflow.json",
	"cluster/superseded.json",
];

function states() {
	return [
		...CLUSTER_FILES.map((file) => [file, fixtureState(loadFixture(file))] as const),
		["live-shaped", liveShapedState()] as const,
	];
}

/** The inner HTML of the element carrying `data-testid="<id>"` (first match, balanced). */
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

const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&#x27;/g, "'")
		.trim();

test("the live-shaped fixture parses as the verified cluster receipt it imitates", () => {
	const state = liveShapedState();
	assert.equal(state.kind, "verified");
	const glance = element(renderToStaticMarkup(<StateView state={state} />), "glance-models");
	assert.equal(textOf(glance), "claude-haiku-4-5 · claude-opus-5-5");
});

for (const [name, state] of states()) {
	test(`${name}: models and providers wrap between names only — every name is unbreakable`, () => {
		const html = renderToStaticMarkup(<StateView state={state} />);
		for (const id of ["glance-models", "glance-providers"]) {
			if (!html.includes(`data-testid="${id}"`)) continue;
			const list = element(html, id);
			const tokens = [
				...list.matchAll(
					/<span( class="whitespace-nowrap")? data-list-token="true">([^<]*)<\/span>/g,
				),
			];
			assert.ok(tokens.length > 0, `${id} renders its items`);
			for (const [, nowrap, text] of tokens) {
				const prose = text.includes(" ");
				assert.equal(
					Boolean(nowrap),
					!prose,
					`${id}: "${text}" ${prose ? "may wrap" : "is one unit"}`,
				);
			}
			// The separators sit BETWEEN the units, where the line may break.
			const between = list.replace(/<span[^>]*data-list-token="true"[^>]*>[^<]*<\/span>/g, "|");
			assert.match(textOf(between), /^\|( · \|)*$/, `${id}: ${textOf(between)}`);
		}
	});

	test(`${name}: the header's ID and copy chip stay on one row, the ID ellipsizing`, () => {
		const header = element(renderToStaticMarkup(<StateView state={state} />), "receipt-short-id");
		assert.match(header, /^<span class="ml-auto flex min-w-0 /, "the slot can shrink");
		assert.match(header, /class="inline-flex items-center gap-2 align-middle min-w-0 flex-nowrap"/);
		assert.match(
			header,
			/<code class="font-mono text-\[13px\] min-w-0 truncate /,
			"the ID ellipsizes",
		);
		assert.match(
			header,
			/<span class="max-\[479px\]:hidden">receipt ID<\/span>/,
			"the label hides <480px",
		);
		assert.match(header, /aria-label="Copy receipt ID"/, "the chip still names what it copies");
	});
}

test("the session card's header uses the same one-row form", () => {
	const header = element(
		renderToStaticMarkup(
			<StateView state={fixtureState(loadFixture("session-owner-estimated.json"))} />,
		),
		"receipt-short-id",
	);
	assert.match(header, /min-w-0 flex-nowrap/);
	assert.match(header, /min-w-0 truncate/);
	assert.match(header, /max-\[479px\]:hidden/);
});
