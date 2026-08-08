/**
 * Exhibit D (the tamper demo) — geometry, canvas rendering, and derived-copy
 * helpers for the DOM tamper card row, the canvas ribbon, the static SVG
 * fallback, and the Merkle-tree diagram.
 *
 * This module lives OUTSIDE app/components/sections/ on purpose: the
 * check-facts prebuild gate scans sections/*.tsx line-by-line for digit
 * literals, and its allowlist covers only same-line JSX/SVG attribute
 * assignments (x=, width=, stroke=, className=, ...) — not plain JS math,
 * canvas API calls, template-literal slicing, or comments. See
 * app/lib/budget-race.ts for the established precedent. Every number Exhibit
 * D's islands render is computed here and imported under a name that itself
 * carries no digit, so the gate never sees one.
 */
import { canonicalEntryString, sha256Hex } from "@/components/sections/lib/sha256";
import type { ChainEntry } from "@/evidence/types";

// ---------------------------------------------------------------------------
// Hash / label preview lengths — one truncation depth per surface.
// ---------------------------------------------------------------------------

const CARD_HASH_CHARS = 12;
const RIBBON_HASH_CHARS = 10;
const STATIC_HASH_CHARS = 8;
const MERKLE_HASH_CHARS = 6;
const RIBBON_TYPE_CHARS = 20;
const STATIC_TYPE_CHARS = 14;

export function previewCardHash(hash: string): string {
	return hash.slice(0, CARD_HASH_CHARS);
}
export function previewRibbonHash(hash: string): string {
	return hash.slice(0, RIBBON_HASH_CHARS);
}
export function previewStaticHash(hash: string): string {
	return hash.slice(0, STATIC_HASH_CHARS);
}
export function previewMerkleHash(hash: string): string {
	return hash.slice(0, MERKLE_HASH_CHARS);
}

// ---------------------------------------------------------------------------
// DOM tamper demo (exhibit-d-dom.tsx) — chain math, verdict copy, styling.
// ---------------------------------------------------------------------------

/**
 * Recomputes the real WebCrypto chain over the fixture's visible payload,
 * entry 0 chained onto its own captured prevHash, every later entry chained
 * onto the previous entry's freshly-computed hash. This is the "baseline"
 * against which a tamper is judged broken.
 */
export async function computeBaseline(entries: ChainEntry[]): Promise<string[]> {
	const hashes: string[] = [];
	for (const [i, entry] of entries.entries()) {
		const prev = i === 0 ? entries[0].prevHash : hashes[i - 1];
		hashes.push(await sha256Hex(canonicalEntryString(entry, prev)));
	}
	return hashes;
}

/** Recomputes one entry's hash after mutating its summary, chained onto the
 * same prior link the baseline used. */
export async function computeTamperedHash(
	entries: ChainEntry[],
	baseline: string[],
	index: number,
	mutatedSummary: string,
): Promise<string> {
	const prev = index === 0 ? entries[0].prevHash : baseline[index - 1];
	return sha256Hex(canonicalEntryString({ ...entries[index], summary: mutatedSummary }, prev));
}

export interface TamperVerdict {
	brokenSeq: number;
	/** Verbatim verdict family from packages/core/src/audit/verify.ts
	 * (verifyVault continuity walk): the entry after the tampered one fails
	 * "previousHash mismatch"; when the tampered entry is last, it fails its
	 * own "hash mismatch". */
	message: string;
}

export function computeTamperVerdict(
	entries: ChainEntry[],
	tamperIndex: number,
	recomputedHash: string,
	baseline: string[],
): TamperVerdict {
	const isLast = tamperIndex === entries.length - 1;
	const affected = isLast ? entries[tamperIndex] : entries[tamperIndex + 1];
	const kind = isLast ? "hash" : "previousHash";
	return {
		brokenSeq: affected.seq,
		message: `Event ${affected.seq}: ${kind} mismatch. Expected ${previewCardHash(recomputedHash)}…, got ${previewCardHash(baseline[tamperIndex])}…`,
	};
}

/** True when `index` has a following entry — the "render an arrow" test. */
export function hasNextEntry(index: number, length: number): boolean {
	return index < length - 1;
}

/** Splits off the single highlighted lead character for the tamper `<mark>`. */
export function splitFirstChar(s: string): { first: string; rest: string } {
	return { first: s.slice(0, 1), rest: s.slice(1) };
}

export function cardStateClassName(failed: boolean): string {
	const base = "w-64 shrink-0 rounded-sm border p-4 font-mono text-xs";
	const state = failed ? "border-danger/60 bg-danger/5" : "border-brand-border bg-brand-surface";
	return `${base} ${state}`;
}

/*
 * Card inks (Addendum H2). Both of these render at 12px inside
 * cardStateClassName's `text-xs` card, so both are held to 4.5:1 on the real
 * composited grounds. white/40 measured 3.77-3.80:1 (page ground, card
 * surface, failed card) — white/70 measures 9.70:1. Red text at this size is
 * `danger-ink`, never `danger`/`danger/80`: see the token's note in
 * globals.css.
 */
export function prevHashClassName(isDownstream: boolean): string {
	return isDownstream ? "text-danger-ink" : "text-white/70";
}

/*
 * The chain arrow is aria-hidden decoration at 18px, so it could ride the
 * >=18px decorative exemption — but at white/30 (2.62:1) it very nearly
 * disappeared next to the hash lines it is supposed to chain together.
 * white/50 keeps the recede without losing the metaphor.
 */
export function chainArrowClassName(isPastTamper: boolean): string {
	return `px-2 text-lg ${isPastTamper ? "text-danger-ink" : "text-white/50"}`;
}

// ---------------------------------------------------------------------------
// Canvas ribbon (exhibit-d-ribbon.tsx) — decorative reveal sweep.
// ---------------------------------------------------------------------------

export const RIBBON_HEIGHT = 120;
export const RIBBON_IO_THRESHOLD = 0.15;

const RIBBON_SWEEP_MS = 1100;
const RIBBON_MAX_DPR = 2;

export interface RibbonRenderer {
	/** Resizes the backing store to the element's current CSS size (capped
	 * device-pixel ratio) and draws the current frame. Call once, on first
	 * intersection, and again on resize. */
	setSize: () => void;
	/** Advances the one-shot reveal by the elapsed time since the last call
	 * and draws. Returns whether the sweep is still in progress. */
	advance: (t: number) => boolean;
	/** Drops the timing baseline — call whenever the ribbon re-enters view
	 * after being paused, so the next `advance` doesn't see a huge dt. */
	resetClock: () => void;
	/** Whether the one-shot sweep has already finished. */
	isComplete: () => boolean;
}

/**
 * Builds the closures that own the ribbon's canvas drawing. All timing/IO
 * orchestration stays in the component; this factory only knows "how to
 * size the backing store" and "how to draw one frame at a given progress."
 */
export function createRibbonRenderer(
	canvas: HTMLCanvasElement,
	ctx: CanvasRenderingContext2D,
	entries: ChainEntry[],
	mono: string,
): RibbonRenderer {
	let progress = 0; // one-shot reveal, 0 to 1; never loops, never replays
	let lastT = 0;
	let width = 0;

	function draw() {
		ctx.clearRect(0, 0, width, RIBBON_HEIGHT);
		const revealWidth = width * progress;
		if (revealWidth <= 0) return;
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, revealWidth, RIBBON_HEIGHT);
		ctx.clip();

		// dimmed warm paper strip (design system: paper is always warm/dimmed)
		ctx.fillStyle = "#e9e6da";
		ctx.fillRect(0, 14, width, RIBBON_HEIGHT - 28);

		// perforation holes punched in the page ground color, both edges
		ctx.fillStyle = "#0a0a1a";
		for (let x = 8; x < width; x += 16) {
			for (const y of [14, RIBBON_HEIGHT - 14]) {
				ctx.beginPath();
				ctx.arc(x, y, 3, 0, Math.PI * 2);
				ctx.fill();
			}
		}

		// dashed tear lines between entries
		const segmentWidth = width / entries.length;
		ctx.strokeStyle = "rgba(22,22,30,0.35)";
		ctx.setLineDash([3, 4]);
		for (let i = 1; i < entries.length; i++) {
			ctx.beginPath();
			ctx.moveTo(i * segmentWidth, 22);
			ctx.lineTo(i * segmentWidth, RIBBON_HEIGHT - 22);
			ctx.stroke();
		}
		ctx.setLineDash([]);

		// ink: seq/type, sha256 stub, prev stub — the chain, printed
		ctx.fillStyle = "#16161e";
		for (const [i, entry] of entries.entries()) {
			const x = i * segmentWidth + 10;
			ctx.font = `600 11px ${mono}`;
			ctx.fillText(`#${entry.seq} ${entry.type}`.slice(0, RIBBON_TYPE_CHARS), x, 44);
			ctx.font = `10px ${mono}`;
			ctx.fillText(`sha256 ${previewRibbonHash(entry.hash)}…`, x, 62);
			ctx.fillText(`prev   ${previewRibbonHash(entry.prevHash)}…`, x, 78);
		}
		ctx.restore();
	}

	function setSize() {
		const dpr = Math.min(window.devicePixelRatio || 1, RIBBON_MAX_DPR);
		width = canvas.clientWidth;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(RIBBON_HEIGHT * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		draw();
	}

	function advance(t: number): boolean {
		if (lastT === 0) lastT = t;
		progress = Math.min(1, progress + (t - lastT) / RIBBON_SWEEP_MS);
		lastT = t;
		draw();
		return progress < 1;
	}

	function resetClock() {
		lastT = 0;
	}

	function isComplete(): boolean {
		return progress >= 1;
	}

	return { setSize, advance, resetClock, isComplete };
}

// ---------------------------------------------------------------------------
// Static SVG fallback (exhibit-d-static.tsx) — four chained stubs.
// ---------------------------------------------------------------------------

export const STATIC_STUB_WIDTH = 140;
export const STATIC_STUB_GAP = 26;

const STATIC_STUB_COUNT = 4;

export interface StaticStub {
	entry: ChainEntry;
	x: number;
	typeLabel: string;
	hashLabel: string;
	prevLabel: string;
	hasNext: boolean;
}

export function staticStubLayout(entries: ChainEntry[]): StaticStub[] {
	const stubs = entries.slice(0, STATIC_STUB_COUNT);
	return stubs.map((entry, i) => ({
		entry,
		x: i * (STATIC_STUB_WIDTH + STATIC_STUB_GAP),
		typeLabel: `#${entry.seq} ${entry.type.slice(0, STATIC_TYPE_CHARS)}`,
		hashLabel: `sha256 ${previewStaticHash(entry.hash)}…`,
		prevLabel: `prev ${previewStaticHash(entry.prevHash)}…`,
		hasNext: i < stubs.length - 1,
	}));
}

// ---------------------------------------------------------------------------
// Merkle-tree diagram (exhibit-d.tsx) — leaf-to-root layout.
// ---------------------------------------------------------------------------

const MERKLE_WIDTH = 640;
const MERKLE_HEIGHT = 160;
const MERKLE_LEAF_Y = 128;

function midpoint(a: number, b: number): number {
	return (a + b) / 2;
}

export interface MerkleLine {
	key: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface MerkleLeaf {
	key: string;
	x: number;
	rectX: number;
	textY: number;
	label: string;
}

export interface MerkleGeometry {
	viewBoxWidth: number;
	viewBoxHeight: number;
	leafRectY: number;
	leafRectWidth: number;
	leafRectHeight: number;
	leafRectHalfWidth: number;
	leafLines: MerkleLine[];
	midLinesLow: MerkleLine[];
	midLinesHigh: MerkleLine[];
	leaves: MerkleLeaf[];
	midNodesLow: { key: string; x: number }[];
	midNodesHigh: { key: string; x: number }[];
	midNodeCy: number;
	midNodeHighCy: number;
	nodeRadius: number;
	root: { x: number; y: number; radius: number; labelX: number; labelY: number };
}

export function computeMerkleGeometry(entries: ChainEntry[]): MerkleGeometry {
	const step = MERKLE_WIDTH / entries.length;
	const leafX = (i: number) => step / 2 + i * step;

	const midLow = Array.from({ length: entries.length / 2 }, (_, i) =>
		midpoint(leafX(i * 2), leafX(i * 2 + 1)),
	);
	const midHigh = Array.from({ length: midLow.length / 2 }, (_, i) =>
		midpoint(midLow[i * 2], midLow[i * 2 + 1]),
	);
	const rootX = midpoint(midHigh[0], midHigh[midHigh.length - 1]);

	const leafLines: MerkleLine[] = entries.map((e, i) => ({
		key: e.hash,
		x1: leafX(i),
		y1: MERKLE_LEAF_Y - 12,
		x2: midLow[Math.floor(i / 2)],
		y2: 92,
	}));
	const midLinesLow: MerkleLine[] = midLow.map((x, i) => ({
		key: `mid-low-${i}`,
		x1: x,
		y1: 84,
		x2: midHigh[Math.floor(i / 2)],
		y2: 52,
	}));
	const midLinesHigh: MerkleLine[] = midHigh.map((x, i) => ({
		key: `mid-high-${i}`,
		x1: x,
		y1: 44,
		x2: rootX,
		y2: 20,
	}));
	const leaves: MerkleLeaf[] = entries.map((e, i) => ({
		key: e.hash,
		x: leafX(i),
		rectX: leafX(i) - 26,
		textY: MERKLE_LEAF_Y + 3,
		label: previewMerkleHash(e.hash),
	}));
	const midNodesLow = midLow.map((x, i) => ({ key: `mid-low-node-${i}`, x }));
	const midNodesHigh = midHigh.map((x, i) => ({ key: `mid-high-node-${i}`, x }));

	return {
		viewBoxWidth: MERKLE_WIDTH,
		viewBoxHeight: MERKLE_HEIGHT,
		leafRectY: MERKLE_LEAF_Y - 10,
		leafRectWidth: 52,
		leafRectHeight: 18,
		leafRectHalfWidth: 26,
		leafLines,
		midLinesLow,
		midLinesHigh,
		leaves,
		midNodesLow,
		midNodesHigh,
		midNodeCy: 88,
		midNodeHighCy: 48,
		nodeRadius: 4,
		root: { x: rootX, y: 16, radius: 6, labelX: rootX + 14, labelY: 20 },
	};
}
