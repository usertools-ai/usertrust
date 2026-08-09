import assert from "node:assert/strict";
import test from "node:test";
import attackCorpusJson from "../../../evidence/attack-corpus.json" with { type: "json" };
import { displayTitle, rowIndexLabel, titleCarriesSpecNumber } from "./exhibit-g-corpus";

const corpus = attackCorpusJson as { attacks: { name: string; verdict: string }[] };

test("rowIndexLabel pads to the width of the largest index", () => {
	assert.equal(rowIndexLabel(0, 29), "01");
	assert.equal(rowIndexLabel(28, 29), "29");
	assert.equal(rowIndexLabel(0, 9), "1");
	assert.equal(rowIndexLabel(0, 100), "001");
});

test("titleCarriesSpecNumber detects a leading spec-row number", () => {
	assert.equal(titleCarriesSpecNumber("16. forged anchor signature"), true);
	assert.equal(titleCarriesSpecNumber("  3.  leading whitespace"), true);
	assert.equal(titleCarriesSpecNumber("forged anchor signature"), false);
	// A digit that is not a leading ORDINAL must not count.
	assert.equal(titleCarriesSpecNumber("sha-256 mismatch"), false);
	assert.equal(titleCarriesSpecNumber("rotation 2 fails"), false);
});

test("displayTitle strips the leading spec-row prefix, and only that", () => {
	assert.equal(displayTitle("16. forged anchor signature"), "forged anchor signature");
	assert.equal(displayTitle("18.  double-spaced prefix"), "double-spaced prefix");
	assert.equal(displayTitle("  7. leading whitespace"), "leading whitespace");
	// No prefix: returned untouched.
	assert.equal(displayTitle("forged anchor signature"), "forged anchor signature");
	// A digit mid-title is content, not a prefix.
	assert.equal(displayTitle("verify sha-256 leaf 2. prefix"), "verify sha-256 leaf 2. prefix");
	// A version-like leading token is not an ordinal prefix (no dot-space form).
	assert.equal(displayTitle("1.2 rotation window"), "1.2 rotation window");
});

test("displayTitle leaves no visible digit prefix on any real corpus title", () => {
	for (const attack of corpus.attacks) {
		assert.equal(
			titleCarriesSpecNumber(displayTitle(attack.name)),
			false,
			`"${attack.name}" still renders a spec-row prefix`,
		);
		assert.ok(displayTitle(attack.name).length > 0, `"${attack.name}" stripped to nothing`);
	}
});

test("the corpus fixture itself is untouched — provenance stays verbatim", () => {
	// The whole point of a render-only transform: at least one fixture title
	// still carries its source prefix, so the footnote that explains the
	// omission is still warranted.
	assert.ok(corpus.attacks.some((a) => titleCarriesSpecNumber(a.name)));
});
