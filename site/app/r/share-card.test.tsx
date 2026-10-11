/**
 * The share card's content, pinned: the brand chrome, the verdict word and, on
 * a verified receipt only, the amount. Never an ID or a handle (decided
 * 2026-10-05), and never anything fetched.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ShareCard, {
	latticeFrame,
	SHARE_CARD_SITE,
	SHARE_CARD_TAGLINE,
} from "./components/share-card";
import { fixtureState, loadFixture } from "./fixture-harness";

/** The card's text, in order, by its data-share slots. */
function cardText(markup: string): Array<[string, string]> {
	return [...markup.matchAll(/data-share="([a-z]+)"[^>]*>([^<]*)</g)].map((match) => [
		match[1],
		match[2],
	]);
}

const BRAND_HEAD: Array<[string, string]> = [
	["mark", "ut"],
	["wordmark", "usertrust"],
	["where", "RECEIPT"],
];
const TAIL: Array<[string, string]> = [
	["tagline", SHARE_CARD_TAGLINE],
	["site", SHARE_CARD_SITE],
];

const CASES: Array<[string, Array<[string, string]>]> = [
	[
		"cluster/first.json",
		[
			["verdict", "VERIFIED"],
			["amount", "$4.8224"],
		],
	],
	[
		"cluster/skipped-overflow.json",
		[
			["verdict", "VERIFIED"],
			["amount", "$245.0000"],
		],
	],
	["unknown.json", [["verdict", "NO RECEIPT YET"]]],
	["expired.json", [["verdict", "NO RECEIPT"]]],
];

for (const [file, claim] of CASES) {
	for (const brand of [true, false]) {
		test(`share card for ${file} (${brand ? "brand fonts" : "fallback"}): the verdict word, the amount only when verified — nothing else`, () => {
			const markup = renderToStaticMarkup(
				<ShareCard state={fixtureState(loadFixture(file))} brand={brand} />,
			);
			assert.deepEqual(cardText(markup), [...(brand ? BRAND_HEAD : []), ...claim, ...TAIL]);
			// No ID of any kind, no handle, no repository: the card ties the receipt to no one.
			assert.doesNotMatch(markup, /ut1_|a1_|r1_/);
			const { routeParamId } = loadFixture(file);
			assert.ok(
				!markup.includes(routeParamId.slice(4, 12)),
				"not even a fragment of the receipt's ID",
			);
		});
	}
}

test("with the brand fonts the card is set in Usertools Sans; without them, no font is named and no mark is drawn", () => {
	const state = fixtureState(loadFixture("cluster/first.json"));
	const branded = renderToStaticMarkup(<ShareCard state={state} brand={true} />);
	assert.match(branded, /^<div style="[^"]*font-family:Usertools Sans/);
	assert.match(branded, /data-share="mark"/);
	const fallback = renderToStaticMarkup(<ShareCard state={state} brand={false} />);
	assert.doesNotMatch(fallback, /font-family/, "the renderer's default font");
	assert.doesNotMatch(fallback, /data-share="(mark|wordmark)"/, "never a mark in another font");
});

test("the verdict is green only when verified, in brand.css's register inks", () => {
	const verified = renderToStaticMarkup(
		<ShareCard state={fixtureState(loadFixture("cluster/first.json"))} brand={true} />,
	);
	const unknown = renderToStaticMarkup(
		<ShareCard state={fixtureState(loadFixture("unknown.json"))} brand={true} />,
	);
	const inkOf = (markup: string) =>
		/data-share="verdict" style="[^"]*?color:(#[0-9A-Fa-f]{6})/.exec(markup)?.[1];
	assert.equal(inkOf(verified), "#30D158");
	assert.equal(inkOf(unknown), "#FFFFFF");
});

test("the card draws; the route fetches only through the pinned font loader", () => {
	const strip = (path: string) =>
		readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	assert.doesNotMatch(strip("./components/share-card.tsx"), /fetch\(|https?:\/\/|<img|readFile/);
	const route = strip("./[receiptId]/opengraph-image.tsx");
	assert.doesNotMatch(route, /fetch\(|https?:\/\/|readFile/, "no direct fetch, URL or file read");
	assert.match(route, /getKitFonts\(\)/, "fonts come from the pinned loader");
	const markup = renderToStaticMarkup(
		<ShareCard state={fixtureState(loadFixture("cluster/first.json"))} brand={true} />,
	);
	assert.doesNotMatch(markup, /<img|url\(/);
});

test("the lattice is a deterministic still frame", () => {
	assert.deepEqual(latticeFrame(), latticeFrame());
	assert.ok(latticeFrame().length > 300, "a sheet, not a scatter");
	assert.ok(
		latticeFrame().some((dot) => dot.lit),
		"a rare point lit gold",
	);
});
