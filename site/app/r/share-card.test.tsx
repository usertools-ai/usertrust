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

const CASES: Array<[string, Array<[string, string]>]> = [
	[
		"cluster/first.json",
		[
			["mark", "ut"],
			["wordmark", "usertrust"],
			["where", "RECEIPT"],
			["verdict", "VERIFIED"],
			["amount", "$4.8224"],
			["tagline", SHARE_CARD_TAGLINE],
			["site", SHARE_CARD_SITE],
		],
	],
	[
		"cluster/skipped-overflow.json",
		[
			["mark", "ut"],
			["wordmark", "usertrust"],
			["where", "RECEIPT"],
			["verdict", "VERIFIED"],
			["amount", "$245.0000"],
			["tagline", SHARE_CARD_TAGLINE],
			["site", SHARE_CARD_SITE],
		],
	],
	[
		"unknown.json",
		[
			["mark", "ut"],
			["wordmark", "usertrust"],
			["where", "RECEIPT"],
			["verdict", "NO RECEIPT YET"],
			["tagline", SHARE_CARD_TAGLINE],
			["site", SHARE_CARD_SITE],
		],
	],
	[
		"expired.json",
		[
			["mark", "ut"],
			["wordmark", "usertrust"],
			["where", "RECEIPT"],
			["verdict", "NO RECEIPT"],
			["tagline", SHARE_CARD_TAGLINE],
			["site", SHARE_CARD_SITE],
		],
	],
];

for (const [file, expected] of CASES) {
	test(`share card for ${file}: the brand, the verdict word, the amount only when verified — nothing else`, () => {
		const markup = renderToStaticMarkup(<ShareCard state={fixtureState(loadFixture(file))} />);
		assert.deepEqual(cardText(markup), expected);
		// No ID of any kind, no handle, no repository: the card ties the receipt to no one.
		assert.doesNotMatch(markup, /ut1_|a1_|r1_/);
		const { routeParamId } = loadFixture(file);
		assert.ok(
			!markup.includes(routeParamId.slice(4, 12)),
			"not even a fragment of the receipt's ID",
		);
	});
}

test("the verdict is green only when verified, in brand.css's register inks", () => {
	const verified = renderToStaticMarkup(
		<ShareCard state={fixtureState(loadFixture("cluster/first.json"))} />,
	);
	const unknown = renderToStaticMarkup(
		<ShareCard state={fixtureState(loadFixture("unknown.json"))} />,
	);
	const inkOf = (markup: string) =>
		/data-share="verdict" style="[^"]*?color:(#[0-9A-Fa-f]{6})/.exec(markup)?.[1];
	assert.equal(inkOf(verified), "#30D158");
	assert.equal(inkOf(unknown), "#FFFFFF");
});

test("the card fetches nothing: no URL, no image, no font, in its source or its markup", () => {
	const source = readFileSync(
		new URL("./components/share-card.tsx", import.meta.url),
		"utf8",
	).replace(/\/\*[\s\S]*?\*\//g, "");
	assert.doesNotMatch(source, /fetch\(|https?:\/\/|<img|readFile|fonts:/);
	const route = readFileSync(
		new URL("./[receiptId]/opengraph-image.tsx", import.meta.url),
		"utf8",
	).replace(/\/\*[\s\S]*?\*\//g, "");
	assert.doesNotMatch(
		route,
		/fetch\(|https?:\/\/|readFile|fonts:/,
		"the route passes no font: the renderer's default",
	);
	const markup = renderToStaticMarkup(
		<ShareCard state={fixtureState(loadFixture("cluster/first.json"))} />,
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
