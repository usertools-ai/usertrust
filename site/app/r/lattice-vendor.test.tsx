/**
 * The receipt page's brand field is a VENDORED copy of the usertools site kit's
 * lattice, byte-for-byte. Never patch it here: a hand-edited mirror drifts from
 * the source and the page stops matching the other surfaces. The hash below is
 * the pin; to update, copy the new file and its new hash in the same commit.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import LatticeField from "./components/lattice-field";

const VENDORED_LATTICE_SHA256 = "0f62d45424d1bfa48f5414b327e3e9096b560de0dd9b38edfcffc3b9e813ad5d";

const vendored = readFileSync(new URL("./vendor/lattice.js", import.meta.url));

test("the vendored lattice is byte-identical to the pinned source", () => {
	const actual = createHash("sha256").update(vendored).digest("hex");
	assert.equal(
		actual,
		VENDORED_LATTICE_SHA256,
		"site/app/r/vendor/lattice.js changed: copy the site kit's file and its hash together, never edit it here",
	);
});

test("the vendored lattice carries the config the page relies on", () => {
	const src = vendored.toString("utf8");
	for (const needle of [
		"wave-once",
		"data-mode",
		"prefers-reduced-motion",
		"net-fallback",
		"gold",
	]) {
		assert.ok(
			src.includes(needle) || src.includes(needle.replace("data-", "")),
			`${needle} is in the module`,
		);
	}
});

test("the field is a gold, wave-once canvas, decorative", () => {
	const html = renderToStaticMarkup(<LatticeField />);
	assert.match(html, /<canvas /);
	assert.match(html, /id="field"/);
	assert.match(html, /data-network/);
	assert.match(html, /data-accent="gold"/);
	assert.match(html, /data-mode="wave-once"/);
	assert.match(html, /aria-hidden="true"/);
});

test("the route layout renders the field on every state, below the content", () => {
	const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
	assert.ok(layout.includes("<LatticeField />"), "the layout renders the field");
	assert.ok(layout.indexOf("<LatticeField />") < layout.indexOf("{children}"));
});
