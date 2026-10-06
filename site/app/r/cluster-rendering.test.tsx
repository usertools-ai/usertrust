/**
 * The verified CLUSTER receipt (receipt-spec v0.10 §15), rendered through the
 * page's own dispatch (`StateView`) from the conforming fixtures CL1-CL5 —
 * through the real parser, never hand-built props.
 *
 * What is pinned is the brief layout's SPLIT and the cluster kind's honesty
 * rules: the glance card up front (verdict, level strip, amount and its scope
 * chip, window, coverage, and the refused windows ALWAYS visible), everything
 * else folded behind the page's ONE Details; no session sentence the receipt
 * never made; `windowTransfersRoot` never marked passed; no
 * `usertrust-verify receipt` command, which cannot read a cluster receipt yet;
 * and PRIVACY: nothing rendered ties the receipt to whoever it charged or to
 * any other receipt (no handle, no other receipt's ID, no repository).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import StateView from "./components/state-view";
import { fixtureState, loadFixture, type WireFixture } from "./fixture-harness";
import { applyClusterVector, LIVE_SHAPED_CLUSTER_VECTOR } from "./fixtures/cluster-vectors";
import {
	AMOUNT_SCOPE_CAPTION,
	amountUsdFromUsertokens,
	CUSTOM_MODEL_MEANING,
	FORK_DISCLAIMER,
	LEDGER_ROWS,
	NEVER_ARTIFACT_VERIFIED,
	OTHER_RECEIPT_WITHHELD,
	PLAIN_VERDICT_VERIFIED,
	PROVIDER_SCOPED_CLAIM,
} from "./lib/claims";
import {
	CLUSTER_AMOUNT_SCOPE_CAPTION,
	CLUSTER_COMPLETENESS_TRUST,
	CLUSTER_LEDGER_ROWS,
	CLUSTER_NON_ARTIFACT,
	CLUSTER_OFFLINE_VERIFIER_PENDING,
	CLUSTER_PROVIDER_SCOPED_CLAIM,
	CLUSTER_SIGNED_BYTES_LABEL,
	LEDGER_TIME_NOTE,
	modelsLine,
	SETTLEMENT_TIMES_NOTE,
	SKIPPED_NOTE,
	WINDOW_TRANSFERS_ROOT_MEANING,
} from "./lib/cluster-claims";
import { ogCardAmount, ogCardWord } from "./lib/shell-copy";
import type { ClusterReceiptDocument } from "./lib/wire";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWire(fixture: WireFixture): { html: string; before: string; inside: string } {
	const html = renderToStaticMarkup(<StateView state={fixtureState(fixture)} />);
	const at = html.indexOf("<details");
	return {
		html,
		before: at === -1 ? html : html.slice(0, at),
		inside: at === -1 ? "" : html.slice(at),
	};
}

function render(file: string) {
	return renderWire(loadFixture(file));
}

/** Rendered TEXT, tags removed and entities decoded — what a reader sees. */
function textOf(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

/** The outer markup of the first element carrying `attr`, up to its OWN closing tag. */
function element(html: string, attr: string): string {
	const at = html.indexOf(attr);
	assert.ok(at !== -1, `no element carries ${attr}`);
	const open = html.lastIndexOf("<", at);
	const tag = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(open))?.[1];
	assert.ok(tag, `no tag opens before ${attr}`);
	const tags = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, "g");
	tags.lastIndex = open;
	let depth = 0;
	for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
		depth += match[1] === "/" ? -1 : 1;
		if (depth === 0) return html.slice(open, match.index + match[0].length);
	}
	throw new Error(`${attr}: <${tag}> never closes`);
}

const testid = (id: string) => `data-testid="${id}"`;

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function receiptOf(fixture: WireFixture): ClusterReceiptDocument {
	return (fixture.wire.body as { receipt: ClusterReceiptDocument }).receipt;
}

// ---------------------------------------------------------------------------
// The conforming fixtures (CL5 is CL2's receipt with advisories)
// ---------------------------------------------------------------------------

interface ClusterCase {
	id: string;
	file: string;
	amount: string;
	window: string;
	covers: string;
	claim: string;
	skipped?: { headline: string; spans: string[]; reasons: string[] };
}

const CASES: ClusterCase[] = [
	{
		id: "CL1",
		file: "cluster/first.json",
		amount: "$4.8224",
		window: "Oct 5 · 21:09–21:14 UTC 4 min 51 s · closes after 10 min idle",
		covers: "2 governed calls",
		claim:
			"charged to this agent key between 2026-10-05T21:09:27.890Z and 2026-10-05T21:14:19.000Z — $4.8224",
	},
	{
		id: "CL2",
		file: "cluster/chained.json",
		amount: "$12.0000",
		window: "Oct 5 · 21:39–21:51 UTC 12 min 7 s · closes after 10 min idle",
		covers: "3 governed calls",
		claim:
			"charged to this agent key between 2026-10-05T21:39:19.123Z and 2026-10-05T21:51:26.123Z — $12.0000",
	},
	{
		id: "CL5",
		file: "cluster/superseded.json",
		amount: "$12.0000",
		window: "Oct 5 · 21:39–21:51 UTC 12 min 7 s · closes after 10 min idle",
		covers: "3 governed calls",
		claim:
			"charged to this agent key between 2026-10-05T21:39:19.123Z and 2026-10-05T21:51:26.123Z — $12.0000",
	},
	{
		id: "CL3",
		file: "cluster/skipped.json",
		amount: "$0.3150",
		window: "Oct 5 · 23:44–23:45 UTC 48 s · closes after 10 min idle",
		covers: "1 governed call",
		claim:
			"charged to this agent key between 2026-10-05T23:44:26.123Z and 2026-10-05T23:45:14.123Z — $0.3150",
		skipped: {
			headline: "3 earlier windows weren’t receipted",
			spans: [
				"Oct 5 · 22:06:26 → 22:08:26 UTC",
				"Oct 5 · 22:38:26 → 22:39:26 UTC",
				"Oct 5 · 23:19:26 → 23:24:26 UTC",
			],
			reasons: ["cluster-void", "estimated-transfer", "cluster-void"],
		},
	},
	{
		id: "CL4",
		file: "cluster/skipped-overflow.json",
		amount: "$245.0000",
		window: "Oct 6 · 20:53–21:34 UTC 41 min 13 s · closes after 1 h idle",
		covers: "40 governed calls",
		claim:
			"charged to this agent key between 2026-10-06T20:53:20.000Z and 2026-10-06T21:34:33.000Z — $245.0000",
		skipped: {
			headline:
				"20 earlier windows weren’t receipted — the first 16 are listed; windowsRoot commits all 20",
			spans: ["Oct 5 · 04:53:20 → 04:56:20 UTC"],
			reasons: [
				"snapshot-missing",
				"unknown-provider",
				"empty-cluster",
				"bad-repo-id",
				"non-exact-rate",
				"posted-assessed-mismatch",
				"duplicate-transfer",
				"bad-transfer-id",
				"bad-amount",
				"rounding-out-of-bounds",
				"duplicate-mint-event",
				"mint-event-mismatch",
				"anchor-mismatch",
				"evidence-inconsistent",
				"consumed-by-another-receipt",
				"snapshot-not-on-chain",
			],
		},
	},
];

const GLANCE_IDS = [
	"cluster-receipt-card",
	"receipt-short-id",
	"verdict",
	"levels",
	"amount-usd",
	"amount-scope-chip",
	"glance-facts",
	"cluster-window",
	"covers",
];

const FOLDED_IDS = [
	"cluster-receipt-details",
	"scope-claim",
	"rung-disclaimers",
	"postures",
	"timestamps",
	"window-transfers",
	"completeness-trust",
	"cluster-verify",
	"check-ledger",
];

for (const c of CASES) {
	test(`${c.id} ${c.file}: ONE Details, collapsed, and the glance carries the receipt`, () => {
		const fixture = loadFixture(c.file);
		const { html, before } = renderWire(fixture);
		assert.ok(html.includes('data-state="verified" data-scope="cluster"'), "the cluster view");
		assert.equal(occurrences(html, "<details"), 1, "exactly one disclosure on the page");
		assert.ok(!/<details[^>]*\sopen/.test(html), "collapsed by default");
		for (const id of GLANCE_IDS) {
			assert.ok(before.includes(testid(id)), `${id} is in the glance`);
		}

		assert.equal(textOf(element(before, testid("verdict"))), PLAIN_VERDICT_VERIFIED);
		const levels = element(before, testid("levels"));
		assert.ok(
			levels.includes('data-rung="verified_checkpoint" data-rung-state="reached"'),
			"the reached rung",
		);
		assert.ok(textOf(levels).includes("anchored · resolver-asserted"), "R41 tag in the glance");

		const amount = textOf(element(before, testid("amount-usd")));
		assert.equal(amount, c.amount);
		const assessed = receiptOf(fixture).event.data.spend.assessedUsertokens;
		assert.equal(amount, `$${amountUsdFromUsertokens(assessed)}`, "R23: derived, never stored");
		assert.equal(
			textOf(element(before, testid("amount-scope-chip"))),
			"SELF-DEBITS ONLY",
			"R38: the posture label beside the figure",
		);

		assert.equal(textOf(element(before, testid("cluster-window"))), c.window);
		assert.equal(textOf(element(before, testid("covers"))), c.covers);
	});

	test(`${c.id} ${c.file}: the glance shows no command, no postures, no ledger — they are in Details`, () => {
		const { before, inside } = render(c.file);
		for (const id of FOLDED_IDS) {
			assert.ok(inside.includes(testid(id)), `${id} is in Details, not deleted`);
			assert.ok(!before.includes(testid(id)), `${id} is not in the glance`);
		}
		assert.equal(textOf(element(inside, testid("scope-claim"))), c.claim, "§15.14's claim");
		// Every restatement of the amount carries its scope label, right after it (R38).
		const label = textOf(element(before, testid("amount-scope-chip")));
		for (const [claim, chip] of [
			["scope-claim", "claim-scope-chip"],
			["comparison-claim", "comparison-scope-chip"],
		]) {
			assert.equal(textOf(element(inside, testid(claim))), c.claim, `${claim} restates the amount`);
			const chipHtml = element(inside, testid(chip));
			assert.equal(textOf(chipHtml), label, `${chip}: the same label as the glance`);
			const claimEnd =
				inside.indexOf(element(inside, testid(claim))) + element(inside, testid(claim)).length;
			const chipAt = inside.indexOf(chipHtml);
			assert.ok(chipAt >= claimEnd, `${chip} follows ${claim}`);
			assert.equal(textOf(inside.slice(claimEnd, chipAt)), "", `${chip} sits right after ${claim}`);
		}
		assert.ok(inside.includes('data-clock-claim="ledger"'), "the window, in ledger time");
		assert.ok(inside.includes('data-clock-claim="minter-asserted"'), "R27: mintedAt");
		assert.ok(inside.includes('data-clock-claim="chain-committed"'), "R27: settlements");
		const data = receiptOf(loadFixture(c.file)).event.data;
		const text = textOf(inside);
		for (const raw of [data.windowStart, data.windowEnd, data.idleThresholdNs]) {
			assert.ok(text.includes(raw), `the raw ledger value ${raw} is shown`);
		}
		for (const sentence of [
			LEDGER_TIME_NOTE,
			SETTLEMENT_TIMES_NOTE,
			FORK_DISCLAIMER,
			NEVER_ARTIFACT_VERIFIED,
			CLUSTER_NON_ARTIFACT,
			CLUSTER_COMPLETENESS_TRUST,
			WINDOW_TRANSFERS_ROOT_MEANING,
		]) {
			assert.ok(text.includes(sentence), `missing: ${sentence}`);
		}
	});

	test(`${c.id} ${c.file}: PRIVACY — nothing on the page ties the receipt back to whoever it charged`, () => {
		const fixture = loadFixture(c.file);
		const { html, before, inside } = renderWire(fixture);
		const receipt = receiptOf(fixture);
		const data = receipt.event.data;
		// No account handle, anywhere.
		assert.ok(!html.includes("a1_"), "no a1_ handle in any render");
		assert.ok(!html.includes(data.account), "and not the handle's body either");
		// No other receipt's ID: the only ut1_ is this receipt's own.
		const ids = new Set([...html.matchAll(/ut1_[1-9A-HJ-NP-Za-km-z]+/g)].map((m) => m[0]));
		for (const id of ids)
			assert.ok(receipt.receiptId.startsWith(id.replace(/…$/, "")), `foreign ID ${id}`);
		if (data.previousReceiptId !== undefined) {
			assert.ok(!html.includes(data.previousReceiptId), "no previous receipt's ID");
			assert.ok(!html.includes(`/r/${data.previousReceiptId}`), "and no link to it");
		}
		// No repository, in either form.
		if (data.work.repoId !== undefined) assert.ok(!html.includes(data.work.repoId), "no repoId");
		assert.ok(!html.includes("data-repo-label"), "no repository line");
		// The header is "Receipt"; the kind is technical metadata in Details only.
		const glanceText = textOf(
			before.replace(/<span[^>]*data-reason="[^"]*"[^>]*>[^<]*<\/span>/g, ""),
		);
		assert.ok(!/cluster/i.test(glanceText), `no "cluster" wording on the glance: ${glanceText}`);
		assert.equal(textOf(element(inside, testid("spec-scope"))), "SPEC ut1 · SCOPE cluster");
		// The predecessor check still reports its result — with no ID.
		const row = html.match(/data-check="predecessorLinkage"[\s\S]*?<\/tr>/)?.[0] ?? "";
		assert.ok(
			row.includes(
				`data-result="${data.previousReceiptId === undefined ? "notApplicable" : "passed"}"`,
			),
		);
		assert.ok(!/ut1_/.test(row), "the predecessor row names no receipt");
		// Advisories (unsigned, rendered above the card): each notice stays, and
		// none names another receipt or a revision, as text or as a link.
		const advisories = (fixture.wire.body as { advisories: Array<Record<string, unknown>> })
			.advisories;
		for (const advisory of advisories) {
			assert.ok(html.includes(`data-advisory="${advisory.kind}"`), `${advisory.kind} is shown`);
			for (const key of [
				"supersededByReceiptId",
				"receiptId",
				"observedRevision",
				"currentRevision",
			]) {
				const value = advisory[key];
				if (typeof value === "string") assert.ok(!html.includes(value), `${advisory.kind}.${key}`);
			}
		}
		if (advisories.length > 0) {
			assert.ok(textOf(html).includes(OTHER_RECEIPT_WITHHELD), "each band says what it withholds");
			assert.ok(
				!/href="\/r\/ut1_/.test(html.split(`href="/r/${receipt.receiptId}`).join("")),
				"no link to another receipt",
			);
		}
		// The share card: the verdict word and the amount, nothing else.
		const state = fixtureState(fixture);
		for (const line of [ogCardWord(state), ogCardAmount(state) ?? ""]) {
			assert.ok(!/a1_|ut1_/.test(line), `share card line: ${line}`);
		}
		assert.equal(ogCardAmount(state), c.amount);
	});

	test(`${c.id} ${c.file}: refused windows are ALWAYS visible in the glance, never folded, never an amount`, () => {
		const { html, before, inside } = render(c.file);
		if (c.skipped === undefined) {
			assert.ok(!html.includes(testid("skipped-disclosure")), "nothing refused, nothing shown");
			assert.ok(!textOf(html).includes(SKIPPED_NOTE));
			return;
		}
		const note = element(before, testid("skipped-disclosure"));
		assert.ok(/^<div\s[^>]*\brole="note"/.test(note), "a note, not a disclosure");
		assert.ok(!note.includes("<details"), "never folded");
		const text = textOf(note);
		assert.ok(text.startsWith(c.skipped.headline), `headline: ${text}`);
		assert.equal(occurrences(note, "data-skipped-window"), c.skipped.reasons.length);
		assert.deepEqual(
			[...note.matchAll(/data-reason="([^"]+)"/g)].map((match) => match[1]),
			c.skipped.reasons,
			"each listed window's reason, in order",
		);
		for (const span of c.skipped.spans) assert.ok(text.includes(span), `span ${span}`);
		assert.ok(!text.includes("$"), "a refused window is never an amount");
		assert.ok(textOf(inside).includes(SKIPPED_NOTE), "what the windows are, in Details");
	});

	test(`${c.id} ${c.file}: cluster sentences only — no session claim the receipt never made`, () => {
		const { html, inside } = render(c.file);
		const text = textOf(html);
		assert.ok(text.includes(CLUSTER_AMOUNT_SCOPE_CAPTION.selfDebitsOnly), "the cluster caption");
		assert.ok(!text.includes(AMOUNT_SCOPE_CAPTION.selfDebitsOnly), "not the session caption");
		assert.ok(text.includes(CLUSTER_PROVIDER_SCOPED_CLAIM), "the re-scoped provider claim");
		assert.ok(!text.includes(PROVIDER_SCOPED_CLAIM), "not the session-scoped one");
		assert.ok(!text.includes("usertrust-verify receipt"), "no command that cannot read it");
		assert.ok(!html.includes("[object Object]"));
		for (const banned of [
			"governed session",
			"Governed session",
			"session association",
			"workloadId",
			"1 session",
		]) {
			assert.ok(!text.includes(banned), `no "${banned}"`);
		}

		const verify = element(inside, testid("cluster-verify"));
		const receiptId = receiptOf(loadFixture(c.file)).receiptId;
		assert.ok(verify.includes(`href="/r/${receiptId}/receipt.json"`), "the signed bytes");
		assert.ok(textOf(verify).includes(CLUSTER_SIGNED_BYTES_LABEL));
		assert.ok(textOf(verify).includes(CLUSTER_OFFLINE_VERIFIER_PENDING));
	});

	test(`${c.id} ${c.file}: windowTransfersRoot is a commitment — never a pass mark`, () => {
		const { inside } = render(c.file);
		const line = element(inside, testid("window-transfers"));
		const data = receiptOf(loadFixture(c.file)).event.data;
		assert.ok(line.includes(data.windowTransfersRoot), "the full root, one interaction away");
		assert.ok(textOf(line).includes(String(data.windowTransferCount)), "its transfer count");
		assert.ok(textOf(line).includes(WINDOW_TRANSFERS_ROOT_MEANING));
		assert.ok(!line.includes("✓"), "no tick");
		assert.ok(!line.includes("PASSED") && !line.includes("data-result"), "no result word");
	});

	test(`${c.id} ${c.file}: the check ledger carries the four CLUSTER meanings, none of the session four`, () => {
		const { html } = render(c.file);
		const text = textOf(html);
		for (const name of ["registry", "semantics", "derivations", "predecessorLinkage"]) {
			const cluster = CLUSTER_LEDGER_ROWS.find((row) => row.name === name)?.meaning;
			const session = LEDGER_ROWS.find((row) => row.name === name)?.meaning;
			assert.ok(cluster && session && cluster !== session, name);
			assert.ok(textOf(element(html, `data-check="${name}"`)).includes(cluster), `${name} row`);
			// The session `semantics` meaning is a suffix of the cluster one, so
			// it may only ever appear INSIDE it.
			assert.equal(
				occurrences(text, session),
				cluster.includes(session) ? occurrences(text, cluster) : 0,
				`${name}: the session meaning is not rendered`,
			);
		}
	});
}

test("§6: the cluster view renders nothing below the 12px type floor", () => {
	for (const c of CASES) {
		const { html } = render(c.file);
		const sizes = [...html.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
		for (const size of sizes) assert.ok(size >= 12, `${c.id}: a ${size}px type size`);
		assert.ok(!/\btext-\[?(?:2xs|10px|11px)\]?\b/.test(html), `${c.id}: sub-12px utility class`);
	}
});

test("R37: hostile signed strings render escaped — models, providers and a clock claim", () => {
	const fixture = loadFixture("cluster/first.json");
	const body = fixture.wire.body as { receipt: ClusterReceiptDocument; receiptBytes: string };
	body.receipt.event.data.models = ["<script>alert(1)</script>"];
	body.receipt.event.data.providers = ["<img src=x onerror=alert(2)>"];
	body.receipt.event.data.startedAt = "<b>3</b>";
	// Re-encode, so the mutation reaches the renderer instead of stopping at R4's byte check.
	body.receiptBytes = Buffer.from(JSON.stringify(body.receipt), "utf-8").toString("base64");
	const state = fixtureState(fixture);
	assert.ok(state.kind === "verified" && state.scope === "cluster", "still a verified cluster");
	const { html } = renderWire(fixture);
	for (const raw of ["<script>", "<img", "<b>3</b>"]) assert.ok(!html.includes(raw), raw);
	assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"));
	assert.ok(html.includes("&lt;b&gt;3&lt;/b&gt;"));
});

test("dispatch: a session receipt still renders the session card; a cluster one the cluster view", () => {
	const session = render("session-owner-estimated.json");
	assert.ok(session.html.includes(testid("receipt-card")), "the session card");
	assert.ok(textOf(session.before).includes("1 session"), "its glance says 1 session");
	assert.ok(!session.html.includes('data-scope="cluster"'));

	const cluster = render("cluster/first.json");
	assert.ok(cluster.html.includes('data-scope="cluster"'), "the cluster view");
	assert.ok(!cluster.html.includes(testid("receipt-card")), "never the session card");
	assert.ok(!cluster.html.includes("cannot render a cluster receipt"), "no longer the error shell");
});

// ---------------------------------------------------------------------------
// The card's edge (Cam's v7): clean and straight, a 12px radius, a 1px neutral
// hairline, a faint inner top highlight — no torn or perforated edge, no gold.
// ---------------------------------------------------------------------------

test("EDGE: both cards wear the clean edge — 12px radius, neutral hairline, no perforation, no gold", () => {
	const css = readFileSync(new URL("./brand.css", import.meta.url), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);
	const rule = css.match(/\.ut-r \.ut-card\{([^}]*)\}/)?.[1];
	assert.ok(rule, "brand.css defines .ut-r .ut-card");
	assert.match(rule, /border-radius:var\(--r-row\)/);
	assert.match(css, /--r-row:12px;/);
	assert.match(rule, /border:1px solid var\(--line\)/);
	assert.match(css, /--line:rgba\(255,255,255,\.10\);/);
	assert.match(rule, /box-shadow:inset 0 1px 0 rgba\(255,255,255,\.06\)/);
	assert.doesNotMatch(
		rule,
		/gradient|mask|clip-path|--brand|232,\s*181,\s*75/i,
		"no zigzag, punch hole or gold",
	);
	assert.doesNotMatch(css, /ut-perf|perforat/i, "no perforation rule survives");
	for (const file of [
		"session-owner-estimated.json",
		"cluster/first.json",
		"cluster/skipped.json",
	]) {
		const { html } = render(file);
		assert.equal(occurrences(html, 'class="ut-card"'), 1, `${file}: one card, on the clean edge`);
		assert.doesNotMatch(html, /ut-perf/, file);
	}
});

// ---------------------------------------------------------------------------
// MOBILE (320-420px). Measured on the live receipt ut1_EjdnKqFWFoGxnansQuSsBj
// at 360px: the Models line broke "claude-opus-" / "5-5" mid-name, and at
// 360/390px the header's ID floated ABOVE its "receipt ID copy" chip. These
// tests run with no layout engine, so they pin the CSS CONTRACT that makes
// both impossible rather than a measured box.
// ---------------------------------------------------------------------------

/** CL1-CL5 plus the live receipt's shape, every one through the real parser. */
function mobileCases(): { id: string; fixture: WireFixture }[] {
	const live = applyClusterVector(LIVE_SHAPED_CLUSTER_VECTOR);
	return [
		...CASES.map((c) => ({ id: c.id, fixture: loadFixture(c.file) })),
		{
			id: "live-shaped",
			fixture: {
				routeParamId: live.routeParamId,
				wire: { httpStatus: live.httpStatus, headers: live.headers, body: live.body },
			},
		},
	];
}

/** The class list of the opening tag that carries `attr`. */
function classesAt(html: string, attr: string): string[] {
	const open = element(html, attr).match(/^<[^>]*>/)?.[0] ?? "";
	return (open.match(/\bclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean);
}

/**
 * A " · " list's wrap contract: every name is one nowrap span carrying its
 * trailing separator, and the ONLY text outside those spans is the single
 * space after each "·" — so the browser can break between names and nowhere else.
 */
function assertUnbreakableList(
	dd: string,
	names: string[],
	tail: string | undefined,
	where: string,
) {
	const units = [...dd.matchAll(/<span class="([^"]*)" data-list-unit="">([^<]*)<\/span>/g)];
	assert.equal(units.length, names.length, `${where}: one nowrap unit per name`);
	units.forEach((unit, index) => {
		assert.ok(
			unit[1].split(/\s+/).includes("whitespace-nowrap"),
			`${where}: unit ${index} is nowrap`,
		);
		const more = index < names.length - 1 || tail !== undefined;
		assert.equal(unit[2], more ? `${names[index]} ·` : names[index], `${where}: unit ${index}`);
	});
	const between = dd
		.replace(/^<dd[^>]*>|<\/dd>$/g, "")
		.replace(/<span class="[^"]*" data-list-unit="">[^<]*<\/span>/g, "|")
		.replace(/<span data-list-tail="">[^<]*<\/span>/g, "T");
	const gaps = names.length - 1 + (tail === undefined ? 0 : 1);
	const expected = [...names.map(() => "|"), ...(tail === undefined ? [] : ["T"])].join(" ");
	assert.equal(between, expected, `${where}: breaks only between names`);
	assert.equal(occurrences(between, " "), gaps, `${where}: one break point per separator`);
	if (tail !== undefined)
		assert.ok(dd.includes(`<span data-list-tail="">${tail}</span>`), `${where}: tail`);
}

test("MOBILE: the live-shaped fixture verifies and reads like the live receipt", () => {
	const { fixture } = mobileCases().at(-1) ?? assert.fail("no live-shaped case");
	const state = fixtureState(fixture);
	assert.ok(state.kind === "verified" && state.scope === "cluster", "a verified cluster receipt");
	const { before } = renderWire(fixture);
	assert.equal(textOf(element(before, testid("covers"))), "14 governed calls");
	assert.equal(
		textOf(element(before, testid("models"))),
		"claude-haiku-4-5 · claude-opus-5-5",
		"the Models line, word for word",
	);
});

test("MOBILE: each model and provider name is an unbreakable unit; wrapping only BETWEEN names", () => {
	for (const { id, fixture } of mobileCases()) {
		const { before } = renderWire(fixture);
		const data = receiptOf(fixture).event.data;
		const catalog = data.models.filter((model) => model !== "custom");
		const tail = data.models.includes("custom") ? CUSTOM_MODEL_MEANING : undefined;
		if (data.models.length > 0) {
			const dd = element(before, testid("models"));
			assert.ok(!/break-all|break-words|wrap-anywhere/.test(dd), `${id}: no forced mid-word break`);
			assertUnbreakableList(dd, catalog, tail, `${id} models`);
			assert.equal(textOf(dd), modelsLine(data.models), `${id}: still reads as modelsLine`);
		}
		if (data.providers.length > 0) {
			const dd = element(before, testid("providers"));
			assertUnbreakableList(dd, data.providers, undefined, `${id} providers`);
			assert.equal(textOf(dd), data.providers.join(" · "), `${id}: still the providers join`);
		}
	}
});

test("MOBILE: the custom-model sentence stays prose and wraps; only catalog names are nowrap", () => {
	const live = applyClusterVector({
		...LIVE_SHAPED_CLUSTER_VECTOR,
		receipt: (r) => {
			LIVE_SHAPED_CLUSTER_VECTOR.receipt?.(r);
			((r.event as Record<string, unknown>).data as Record<string, unknown>).models = [
				"claude-opus-5-5",
				"custom",
			];
		},
	});
	const fixture: WireFixture = {
		routeParamId: live.routeParamId,
		wire: { httpStatus: live.httpStatus, headers: live.headers, body: live.body },
	};
	const dd = element(renderWire(fixture).before, testid("models"));
	assertUnbreakableList(dd, ["claude-opus-5-5"], CUSTOM_MODEL_MEANING, "custom");
	assert.equal(textOf(dd), `claude-opus-5-5 · ${CUSTOM_MODEL_MEANING}`);
});

test("MOBILE: the header keeps the ID and its copy chip on ONE row, ellipsizing the ID inside the chip", () => {
	for (const { id, fixture } of mobileCases()) {
		const { before } = renderWire(fixture);
		const receiptId = receiptOf(fixture).receiptId;
		const header = element(before, testid("card-header"));

		// The row: flex, never wraps; the label never shrinks.
		const row = classesAt(before, testid("card-header"));
		for (const rule of ["flex", "flex-nowrap", "items-center"]) {
			assert.ok(row.includes(rule), `${id}: header row has ${rule}`);
		}
		assert.ok(!row.includes("flex-wrap"), `${id}: header row never wraps`);
		assert.ok(
			/<span class="[^"]*\bshrink-0\b[^"]*">Receipt<\/span>/.test(header),
			`${id}: the "Receipt" label never shrinks`,
		);

		// Every box from the row down to the ID may shrink (min-w-0) and none wraps.
		const slot = classesAt(header, testid("receipt-short-id"));
		const wrap = classesAt(header, "data-hash-chip");
		const chip = (header.match(/<button[^>]*class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
		for (const [name, classes] of [
			["ID slot", slot],
			["chip row", wrap],
			["copy chip", chip],
		] as const) {
			assert.ok(classes.includes("min-w-0"), `${id}: ${name} has min-w-0`);
			assert.ok(!classes.includes("flex-wrap"), `${id}: ${name} never wraps`);
		}
		assert.ok(wrap.includes("flex-nowrap"), `${id}: chip row is nowrap`);
		assert.ok(chip.includes("max-w-full"), `${id}: the chip never outgrows its slot`);

		// The ID is INSIDE the chip and ellipsizes there; the chip's glyphs do not.
		const button = element(header, "<button");
		const shown = button.match(/<span class="([^"]*)" data-copy-display="">([^<]*)<\/span>/);
		assert.ok(shown, `${id}: the ID renders inside the copy chip`);
		assert.ok(shown[1].split(/\s+/).includes("truncate"), `${id}: the ID ellipsizes (truncate)`);
		assert.ok(shown[1].split(/\s+/).includes("min-w-0"), `${id}: the ID can shrink below its text`);
		assert.equal(shown[2], `${receiptId.slice(0, 10)}…`, `${id}: the R17 head`);
		for (const glyph of ["$", "copy"]) {
			assert.ok(
				new RegExp(`class="[^"]*\\bshrink-0\\b[^"]*">${glyph.replace("$", "\\$")}</span>`).test(
					button,
				),
				`${id}: "${glyph}" never shrinks`,
			);
		}
		assert.ok(!/break-all/.test(header), `${id}: nothing in the header breaks mid-ID`);
		assert.equal(
			occurrences(header, "<code"),
			0,
			`${id}: no ID outside the chip to float above it`,
		);

		// R17 still holds: the full value on hover, to a screen reader, and on copy.
		assert.ok(header.includes(`title="${receiptId}"`), `${id}: full ID in the title`);
		assert.ok(
			textOf(header).includes(`receipt ID, in full: ${receiptId}`),
			`${id}: full ID, sr-only`,
		);
		assert.ok(button.includes('aria-label="Copy receipt ID"'), `${id}: the copy affordance`);
	}
});
