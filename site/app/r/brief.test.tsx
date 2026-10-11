/**
 * The brief receipt: one glance card up front, everything else behind ONE
 * Details disclosure, and plain headlines for every state. These tests pin the
 * SHAPE of that split — what is visible, what is folded — not the verdicts,
 * which the conformance suites already own.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import StateView from "./components/state-view";
import { fixtureState, loadFixture } from "./fixture-harness";
import { plainState } from "./lib/plain-copy";

function render(file: string): { html: string; before: string; inside: string } {
	const html = renderToStaticMarkup(<StateView state={fixtureState(loadFixture(file))} />);
	const at = html.indexOf("<details");
	return {
		html,
		before: at === -1 ? html : html.slice(0, at),
		inside: at === -1 ? "" : html.slice(at),
	};
}

const text = (s: string) =>
	s
		.replace(/<[^>]*>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ");

test("a verified receipt: the glance is the card, the rest is ONE Details", () => {
	const { html, before, inside } = render("commit-checkpoint.json");
	assert.equal(html.split("<details").length - 1, 1, "exactly one disclosure on the page");
	assert.ok(!/<details[^>]*\sopen/.test(html), "collapsed by default");
	for (const id of [
		"verdict",
		"amount-usd",
		"amount-scope-chip",
		"covers",
		"time-span",
		"receipt-short-id",
		"levels",
	]) {
		assert.ok(before.includes(`data-testid="${id}"`), `${id} is in the glance`);
	}
	assert.ok(text(before).includes("Verified"), "the verdict is one plain word");
	for (const id of [
		"receipt-details",
		"verify-command",
		"rung-disclaimers",
		"postures",
		"timestamps",
	]) {
		assert.ok(inside.includes(`data-testid="${id}"`), `${id} is in Details, not deleted`);
		assert.ok(!before.includes(`data-testid="${id}"`), `${id} is not in the glance`);
	}
	assert.ok(
		inside.includes('data-testid="check-ledger"') ||
			inside.includes("CHECK LEDGER") ||
			/check ledger/i.test(text(inside)),
		"the check ledger is in Details",
	);
});

test("every non-verified state leads with a plain word and one line, spec wording in Details", () => {
	const cases: Array<[string, string, string]> = [
		["reserved.json", "Pending", "The work behind this receipt hasn't finished yet."],
		["reconciling.json", "Pending", "This receipt is still settling. Check back shortly."],
		[
			"unknown.json",
			"No receipt yet",
			"There's no receipt under this ID yet. Receipts are minted after the agent key goes idle — 10 minutes by default — and its audit segment seals.",
		],
		["unverifiable.json", "Not verified", "The proof didn't match the audit log."],
		["not-minted.json", "No receipt", "No billable work was settled under this ID."],
		["cancelled.json", "No receipt", "This reservation ended without a receipt."],
		[
			"billed-unfinalized.json",
			"Not proven",
			"This work was billed, but its receipt was never finalized.",
		],
		[
			"verification-unavailable.json",
			"Can't verify now",
			"Verification is temporarily down. That is not a mismatch. Try again shortly.",
		],
		["rate-limited.json", "Slow down", "Too many requests. Try again shortly."],
	];
	for (const [file, word, line] of cases) {
		const { html, before } = render(file);
		const visible = text(before);
		assert.ok(visible.includes(word), `${file}: word ${word}`);
		assert.ok(visible.includes(line), `${file}: line`);
		assert.equal(html.split("<details").length - 1, 1, `${file}: one disclosure`);
		assert.ok(word.split(" ").length <= 4, `${file}: 2-4 words`);
	}
});

test("page-side integrity causes keep their own plain line (never worded as a resolver incident)", () => {
	const resolver = plainState(fixtureState(loadFixture("unverifiable.json")) as never).line;
	assert.equal(resolver, "The proof didn't match the audit log.");
	const lines = new Set(
		(["R1", "R3", "R4", "R39"] as const).map(
			(obligation) =>
				plainState({
					kind: "integrityFailure",
					receiptId: undefined,
					cause: { source: "page", obligation, detail: "x" },
				} as never).line,
		),
	);
	assert.equal(lines.size, 4, "four distinct page-side lines");
	assert.ok(!lines.has(resolver), "none reuses the resolver's line");
});

test("the resource footer: two receipt links, then usertrust.ai's docs, github, npm, licence and the part-of line", async () => {
	const { default: SiteFooter, FOOTER_LINKS } = await import("./components/site-footer");
	const html = renderToStaticMarkup(<SiteFooter />);
	assert.ok(html.includes('data-testid="site-footer"'), "the footer renders");
	assert.deepEqual(
		FOOTER_LINKS.map((l) => l.label),
		["what is a receipt?", "verify it yourself", "docs", "github", "npm", "licence"],
		"the two receipt links, then the links the usertrust.ai footer carries",
	);
	for (const link of FOOTER_LINKS) {
		assert.ok(html.includes(`href="${link.href}"`), `${link.label} is linked`);
		assert.ok(link.href.startsWith("https://"), "absolute: this page is served from another host");
	}
	assert.ok(html.includes("part of"), "the part-of line is present");
	assert.ok(html.includes('href="https://usertools.ai"'), "and links usertools.ai");
	for (const missing of ["/privacy", "/status", "/support"]) {
		assert.ok(!html.includes(missing), `no ${missing} link: that page does not exist yet`);
	}
	const { readFileSync } = await import("node:fs");
	const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
	assert.ok(
		layout.includes("<SiteFooter />"),
		"the route layout renders the footer on every state",
	);
});
