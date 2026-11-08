// Dev-only: how long the dashboard's data layer takes over a large vault. Not shipped (the package's "files" lists
// only dist, LICENSE and NOTICE). Run from the repository root:
//   npx tsx packages/ui/scripts/measure-desk-data.mts <vault path>
// It needs the workspace built (`npm run build`), so that `usertrust` and `usertrust-verify` resolve.
//
// It reads the vault's log once, then times each function over the usual one-week window (the window ends just after
// the newest record) and prints the median of five runs in milliseconds. The same records are timed again with their
// lanes and models spread over more keys (20 each, 50 lanes and 30 models, 100 each), because the cost of the
// per-category work grows with the key count.
//
// For each vault the TOTAL is the sum of these medians, as the plan lists them:
//   breakdown x5 dimensions + rankColors x5 dimensions + categoryRows (lane) + shareBands (lane) + bucketTotals.
// shareBands includes a categoryRows pass, so that sum counts it twice: it is an upper bound on the work, and it is
// the figure held to the limit. Every other line (role, model) is printed for reading and is not summed.
// Exits 1 and prints OVER LIMIT when any vault's TOTAL passes the limit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { breakdown, categoryRows, type Dimension, shareBands } from "../src/shared/breakdown.js";
import { rankColors } from "../src/shared/colors.js";
import { type LedgerRow, toLedgerRows } from "../src/shared/rows.js";
import { bucketTotals, LANE_BUCKET_MS, rangeWindow } from "../src/shared/spend-series.js";

const RUNS = 5;
const LIMIT_MS = 250;
const DIMS: readonly Dimension[] = ["lane", "role", "model", "kind", "provider"];

const vault = process.argv[2];
if (vault === undefined || vault === "") {
	console.error("usage: measure-desk-data.mts <vault path>");
	process.exit(2);
}

const loadStart = performance.now();
// The log is read directly: the timing is of the data layer, not of the server's load and chain check.
const events = readFileSync(join(vault, ".usertrust", "audit", "events.jsonl"), "utf8")
	.split("\n")
	.filter((line) => line !== "")
	.map((line) => JSON.parse(line));
const realRows = toLedgerRows(events, { valid: true, breakIndex: null }, undefined, 0);
const loadMs = performance.now() - loadStart;
let latest = 0;
for (const r of realRows) {
	const t = Date.parse(r.ts);
	if (t > latest) latest = t;
}
// Half-open: the newest record is inside the window.
const win = rangeWindow("1w", latest + 1);
const bucketMs = LANE_BUCKET_MS["1w"];

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] as number;
}

function time(label: string, fn: () => void): number {
	fn(); // one warm-up, so compilation is not counted
	const runs: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const t0 = performance.now();
		fn();
		runs.push(performance.now() - t0);
	}
	const m = median(runs);
	console.log(
		`${label.padEnd(34)} median ${m.toFixed(2).padStart(8)} ms   runs ${runs.map((x) => x.toFixed(1)).join(" ")}`,
	);
	return m;
}

/** The same records with their lanes and models spread over `lanes` and `models` keys. */
function spread(lanes: number, models: number): LedgerRow[] {
	return realRows.map((r, i) => ({
		...r,
		actor: `lane-${i % lanes}`,
		model: `model-${i % models}`,
	}));
}

function keyCount(rows: readonly LedgerRow[], dim: Dimension): number {
	return breakdown(rows, win, dim).keys.length;
}

let over = false;

function measure(name: string, rows: readonly LedgerRow[]): void {
	console.log(`\n== ${name}: ${rows.length} rows ==`);
	const keys = (d: Dimension): string => `${keyCount(rows, d)} keys`;
	const parts = [
		time("breakdown x5 dims", () => {
			for (const d of DIMS) breakdown(rows, win, d);
		}),
		time("rankColors x5 dims", () => {
			for (const d of DIMS) rankColors(rows, d);
		}),
		time(`categoryRows lane (${keys("lane")})`, () => {
			categoryRows(rows, win, "lane", bucketMs);
		}),
		time(`shareBands lane (${keys("lane")})`, () => {
			shareBands(rows, win, "lane", bucketMs);
		}),
		time("bucketTotals", () => {
			bucketTotals(rows, win, bucketMs);
		}),
	];
	for (const d of ["role", "model"] as const) {
		time(`categoryRows ${d} (${keys(d)})`, () => {
			categoryRows(rows, win, d, bucketMs);
		});
		time(`shareBands ${d} (${keys(d)})`, () => {
			shareBands(rows, win, d, bucketMs);
		});
	}
	const total = parts.reduce((a, b) => a + b, 0);
	const flag = total > LIMIT_MS ? "   OVER LIMIT" : "";
	if (total > LIMIT_MS) over = true;
	console.log(`TOTAL of the summed medians ${total.toFixed(2)} ms (limit ${LIMIT_MS} ms)${flag}`);
}

console.log(`load ${loadMs.toFixed(0)} ms (not counted), window 1W ending after the newest record`);
measure("vault as recorded", realRows);
measure("20 lanes, 20 models", spread(20, 20));
measure("50 lanes, 30 models", spread(50, 30));
measure("100 lanes, 100 models", spread(100, 100));
if (over) process.exitCode = 1;
