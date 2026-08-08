import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalEntryString, sha256Hex } from "../components/sections/lib/sha256";
import chainSliceJson from "../evidence/chain-slice.json";
import type { ChainSlice } from "../evidence/types";
import {
	cardStateClassName,
	chainArrowClassName,
	computeBaseline,
	computeMerkleGeometry,
	computeTamperedHash,
	computeTamperVerdict,
	createRibbonRenderer,
	hasNextEntry,
	prevHashClassName,
	previewCardHash,
	previewMerkleHash,
	previewRibbonHash,
	previewStaticHash,
	RIBBON_HEIGHT,
	STATIC_STUB_GAP,
	STATIC_STUB_WIDTH,
	splitFirstChar,
	staticStubLayout,
} from "./exhibit-d";

const ENTRIES = (chainSliceJson as unknown as ChainSlice).entries;

// ---------------------------------------------------------------------------
// Hash preview truncation — one depth per surface.
// ---------------------------------------------------------------------------

test("preview helpers truncate to their surface's fixed depth", () => {
	const hash = ENTRIES[0].hash;
	assert.equal(previewCardHash(hash), hash.slice(0, 12));
	assert.equal(previewRibbonHash(hash), hash.slice(0, 10));
	assert.equal(previewStaticHash(hash), hash.slice(0, 8));
	assert.equal(previewMerkleHash(hash), hash.slice(0, 6));
});

// ---------------------------------------------------------------------------
// DOM tamper demo — chain math and verdict copy.
// ---------------------------------------------------------------------------

test("computeBaseline recomputes a real WebCrypto chain, seeded by entries[0]'s captured prevHash", async () => {
	const baseline = await computeBaseline(ENTRIES);
	assert.equal(baseline.length, ENTRIES.length);

	// Independently recompute the same chain by hand (not by calling
	// computeBaseline again) so a regression in its chaining logic — e.g.
	// always linking onto entries[0].prevHash instead of the prior computed
	// hash — would actually be caught here.
	let prev = ENTRIES[0].prevHash;
	for (const [i, entry] of ENTRIES.entries()) {
		const expected = await sha256Hex(canonicalEntryString(entry, prev));
		assert.equal(baseline[i], expected, `entry ${entry.seq} baseline hash mismatch`);
		prev = expected;
	}
});

test("every baseline hash is distinct — no accidental collisions or no-op links", async () => {
	const baseline = await computeBaseline(ENTRIES);
	assert.equal(new Set(baseline).size, baseline.length);
});

test("computeTamperedHash chains a mutated entry onto the SAME prior link the baseline used", async () => {
	const baseline = await computeBaseline(ENTRIES);
	const index = 3;
	const mutatedSummary = `${ENTRIES[index].summary}!`;
	const tampered = await computeTamperedHash(ENTRIES, baseline, index, mutatedSummary);
	const expected = await sha256Hex(
		canonicalEntryString({ ...ENTRIES[index], summary: mutatedSummary }, baseline[index - 1]),
	);
	assert.equal(tampered, expected);
	assert.notEqual(tampered, baseline[index]);
});

test("computeTamperedHash at index 0 chains onto the fixture's captured prevHash, not baseline[-1]", async () => {
	const baseline = await computeBaseline(ENTRIES);
	const mutatedSummary = "tampered";
	const tampered = await computeTamperedHash(ENTRIES, baseline, 0, mutatedSummary);
	const expected = await sha256Hex(
		canonicalEntryString({ ...ENTRIES[0], summary: mutatedSummary }, ENTRIES[0].prevHash),
	);
	assert.equal(tampered, expected);
});

test("tampering a non-last entry reports the NEXT entry's previousHash mismatch", async () => {
	const baseline = await computeBaseline(ENTRIES);
	const index = 2;
	const recomputed = await computeTamperedHash(ENTRIES, baseline, index, "x");
	const verdict = computeTamperVerdict(ENTRIES, index, recomputed, baseline);
	assert.equal(verdict.brokenSeq, ENTRIES[index + 1].seq);
	assert.equal(
		verdict.message,
		`Event ${ENTRIES[index + 1].seq}: previousHash mismatch. Expected ${previewCardHash(recomputed)}…, got ${previewCardHash(baseline[index])}…`,
	);
});

test("tampering the LAST entry reports its own hash mismatch, never a previousHash one", async () => {
	const baseline = await computeBaseline(ENTRIES);
	const lastIndex = ENTRIES.length - 1;
	const recomputed = await computeTamperedHash(ENTRIES, baseline, lastIndex, "x");
	const verdict = computeTamperVerdict(ENTRIES, lastIndex, recomputed, baseline);
	assert.equal(verdict.brokenSeq, ENTRIES[lastIndex].seq);
	assert.match(verdict.message, /^Event \d+: hash mismatch\. Expected/);
	assert.doesNotMatch(verdict.message, /previousHash/);
});

test("hasNextEntry is true for every index except the last", () => {
	assert.equal(hasNextEntry(0, 3), true);
	assert.equal(hasNextEntry(1, 3), true);
	assert.equal(hasNextEntry(2, 3), false);
});

test("splitFirstChar isolates the lead character for the tamper <mark>", () => {
	assert.deepEqual(splitFirstChar("settled"), { first: "s", rest: "ettled" });
	assert.deepEqual(splitFirstChar("s"), { first: "s", rest: "" });
	assert.deepEqual(splitFirstChar(""), { first: "", rest: "" });
});

test("card/prevHash/arrow class builders switch on their boolean state", () => {
	assert.match(cardStateClassName(false), /border-brand-border/);
	assert.match(cardStateClassName(true), /border-danger\/60/);
	// Addendum H2: 12px card ink clears 4.5:1 — white/40 measured 3.77-3.80:1.
	assert.equal(prevHashClassName(false), "text-white/70");
	assert.equal(prevHashClassName(true), "text-danger-ink");
	assert.match(chainArrowClassName(false), /text-white\/50/);
	assert.match(chainArrowClassName(true), /text-danger-ink/);
});

test("small-size danger roles use the danger-ink token, never the /80 alpha step", () => {
	// text-danger/80 at 12px measured 3.52-3.64:1 on the real grounds; the
	// lighter danger-ink is the sanctioned <16px red (globals.css @theme).
	for (const cls of [prevHashClassName(true), chainArrowClassName(true)]) {
		assert.doesNotMatch(cls, /text-danger\/\d/);
	}
});

// ---------------------------------------------------------------------------
// Static SVG fallback — four chained stubs.
// ---------------------------------------------------------------------------

test("staticStubLayout keeps only the first four entries, spaced by stub width + gap", () => {
	const stubs = staticStubLayout(ENTRIES);
	assert.equal(stubs.length, 4);
	for (const [i, stub] of stubs.entries()) {
		assert.equal(stub.entry, ENTRIES[i]);
		assert.equal(stub.x, i * (STATIC_STUB_WIDTH + STATIC_STUB_GAP));
		assert.equal(stub.hasNext, i < stubs.length - 1);
	}
	assert.equal(stubs[0].hashLabel, `sha256 ${previewStaticHash(ENTRIES[0].hash)}…`);
	assert.equal(stubs[0].prevLabel, `prev ${previewStaticHash(ENTRIES[0].prevHash)}…`);
});

// ---------------------------------------------------------------------------
// Merkle-tree diagram — leaf-to-root geometry.
// ---------------------------------------------------------------------------

test("computeMerkleGeometry reduces the fixture's leaves through two levels to a single root", () => {
	const g = computeMerkleGeometry(ENTRIES);
	assert.equal(g.leaves.length, ENTRIES.length);
	assert.equal(g.leafLines.length, ENTRIES.length);
	assert.equal(g.midNodesLow.length, ENTRIES.length / 2);
	assert.equal(g.midNodesHigh.length, ENTRIES.length / 4);
	assert.equal(g.midLinesLow.length, g.midNodesLow.length);
	assert.equal(g.midLinesHigh.length, g.midNodesHigh.length);

	const highXs = g.midNodesHigh.map((n) => n.x);
	const expectedRootX = (highXs[0] + highXs[highXs.length - 1]) / 2;
	assert.equal(g.root.x, expectedRootX);
	assert.equal(g.leaves[0].label, previewMerkleHash(ENTRIES[0].hash));
});

// ---------------------------------------------------------------------------
// Canvas ribbon renderer — sizing and the one-shot reveal state machine.
//
// There's no real <canvas> in node:test, so these stub out just the handful
// of Canvas2D calls createRibbonRenderer actually makes and read the reveal
// state back out of the clip-rect width it draws with — the same value the
// real canvas would end up filled to.
// ---------------------------------------------------------------------------

interface MockCanvas {
	clientWidth: number;
	width: number;
	height: number;
}

function createMockCanvas(clientWidth: number): MockCanvas {
	return { clientWidth, width: 0, height: 0 };
}

function createMockContext() {
	const rectCalls: number[][] = [];
	const transformCalls: number[][] = [];
	const noop = () => {};
	const stub = {
		fillStyle: "",
		strokeStyle: "",
		font: "",
		clearRect: noop,
		save: noop,
		beginPath: noop,
		rect: (x: number, y: number, w: number, h: number) => {
			rectCalls.push([x, y, w, h]);
		},
		clip: noop,
		fillRect: noop,
		arc: noop,
		fill: noop,
		moveTo: noop,
		lineTo: noop,
		stroke: noop,
		setLineDash: noop,
		fillText: noop,
		restore: noop,
		setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
			transformCalls.push([a, b, c, d, e, f]);
		},
	};
	return { ctx: stub as unknown as CanvasRenderingContext2D, rectCalls, transformCalls };
}

/** createRibbonRenderer reads `window.devicePixelRatio` directly; node:test
 * has no `window` global, so tests that call setSize() install one for the
 * duration of the callback and always restore whatever was there before. */
function withMockWindow<T>(devicePixelRatio: number, fn: () => T): T {
	const globals = globalThis as Record<string, unknown>;
	const previous = globals.window;
	globals.window = { devicePixelRatio };
	try {
		return fn();
	} finally {
		if (previous === undefined) {
			delete globals.window;
		} else {
			globals.window = previous;
		}
	}
}

test("setSize caps the device pixel ratio at 2 and sizes the backing store to match", () => {
	const canvas = createMockCanvas(300);
	const { ctx, transformCalls } = createMockContext();
	const renderer = createRibbonRenderer(
		canvas as unknown as HTMLCanvasElement,
		ctx,
		ENTRIES,
		"monospace",
	);
	withMockWindow(4, () => renderer.setSize());
	assert.equal(canvas.width, 600);
	assert.equal(canvas.height, RIBBON_HEIGHT * 2);
	assert.deepEqual(transformCalls.at(-1), [2, 0, 0, 2, 0, 0]);
});

test("setSize falls back to a 1x pixel ratio when devicePixelRatio is unset", () => {
	const canvas = createMockCanvas(200);
	const { ctx, transformCalls } = createMockContext();
	const renderer = createRibbonRenderer(
		canvas as unknown as HTMLCanvasElement,
		ctx,
		ENTRIES,
		"monospace",
	);
	withMockWindow(0, () => renderer.setSize());
	assert.equal(canvas.width, 200);
	assert.equal(canvas.height, RIBBON_HEIGHT);
	assert.deepEqual(transformCalls.at(-1), [1, 0, 0, 1, 0, 0]);
});

test("advance is a one-shot reveal: it grows, clamps at the full width, and never regresses or replays", () => {
	const canvas = createMockCanvas(400);
	const { ctx, rectCalls } = createMockContext();
	const renderer = createRibbonRenderer(
		canvas as unknown as HTMLCanvasElement,
		ctx,
		ENTRIES,
		"monospace",
	);
	withMockWindow(1, () => renderer.setSize());

	// advance() treats a lastT of exactly 0 as "uninitialized", so the very
	// first timestamp fed in — whatever its value — always sets the timing
	// baseline with zero visible progress. Start the clock at 1, not 0, so
	// later calls are unambiguously "elapsed time since the baseline".
	assert.equal(renderer.advance(1), true); // baseline: no reveal drawn yet
	assert.equal(rectCalls.length, 0, "no reveal is drawn before any time has elapsed");

	assert.equal(renderer.advance(11), true); // 10ms elapsed
	const widthAfterTenMs = rectCalls.at(-1)?.[2];
	assert.ok(typeof widthAfterTenMs === "number" && widthAfterTenMs > 0);

	assert.equal(renderer.advance(21), true); // 20ms elapsed
	const widthAfterTwentyMs = rectCalls.at(-1)?.[2] as number;
	assert.ok(widthAfterTwentyMs > (widthAfterTenMs as number));

	assert.equal(renderer.advance(1_000_000), false); // long past the sweep duration
	assert.equal(rectCalls.at(-1)?.[2], 400, "fully revealed, clamped to the canvas width");
	assert.equal(renderer.isComplete(), true);

	assert.equal(renderer.advance(2_000_000), false); // never replays once complete
	assert.equal(rectCalls.at(-1)?.[2], 400);
});

test("resetClock discards elapsed time so re-entering the viewport never jumps the sweep", () => {
	const canvas = createMockCanvas(400);
	const { ctx, rectCalls } = createMockContext();
	const renderer = createRibbonRenderer(
		canvas as unknown as HTMLCanvasElement,
		ctx,
		ENTRIES,
		"monospace",
	);
	withMockWindow(1, () => renderer.setSize());

	renderer.advance(1); // baseline (see the note above on why not 0)
	renderer.advance(501); // 500ms of visible sweep
	const widthBeforePause = rectCalls.at(-1)?.[2] as number;
	assert.ok(widthBeforePause > 0 && widthBeforePause < 400);

	// The canvas leaves the viewport here in the real component: rAF is
	// cancelled and resetClock() is called. A long real-world gap passes
	// while it's offscreen, then it comes back into view — the next
	// timestamp jumps by a huge amount, but resetClock must make that next
	// call a fresh baseline (zero elapsed), never a giant catch-up jump.
	renderer.resetClock();
	renderer.advance(999_999);
	assert.equal(rectCalls.at(-1)?.[2], widthBeforePause, "resuming must not jump the reveal");

	renderer.advance(999_999 + 10); // 10ms of real sweep time after resuming
	const widthAfterResume = rectCalls.at(-1)?.[2] as number;
	assert.ok(widthAfterResume > widthBeforePause);
	assert.ok(widthAfterResume < 400, "still short of a full reveal after only 10ms");
});
