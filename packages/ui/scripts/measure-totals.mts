// Dev-only: what the whole-vault totals cost. Not shipped (the package's "files" lists only dist, LICENSE and NOTICE).
// Run from the repository root:
//   npx tsx packages/ui/scripts/measure-totals.mts <vault path> [--fold-limit-ms=N] [--get-limit-ms=N]
// It needs the workspace built (`npm run build`), so that `usertrust` and `usertrust-verify` resolve. Point it at a
// copy of a vault: it starts a server over it, which reads the vault and writes nothing there.
//
// It prints the median of five runs of two numbers:
//   (a) the cost the fold adds to the server's start-up read: `TotalsIndex.add(spendFactsOf(e))` over every event of
//       the vault, timed alone (the log is read and parsed beforehand, and that time is not counted);
//   (b) the p95 of 50 `GET /api/totals` requests to a started server.
// Exits 1 and prints OVER LIMIT when a median passes its limit: (a) 100 ms, (b) 50 ms (the target `/api/at` is held
// to). The limits can be set with the two flags; setting both to 0 is the positive control, and must exit 1.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { PersistedAuditEvent } from "usertrust";

const RUNS = 5;
const REQUESTS = 50;
const FOLD_LIMIT_MS = 100;
const GET_LIMIT_MS = 50;

const USAGE =
	"usage: measure-totals.mts <vault path> [--fold-limit-ms=N] [--get-limit-ms=N]\n" +
	"  <vault path> is the project directory that holds .usertrust (use a copy)";

function limitFlag(args: readonly string[], name: string, fallback: number): number {
	const prefix = `--${name}=`;
	const arg = args.find((a) => a.startsWith(prefix));
	if (arg === undefined) return fallback;
	const n = Number(arg.slice(prefix.length));
	if (!Number.isFinite(n) || n < 0) {
		console.error(`${USAGE}\n--${name} must be a number of milliseconds, 0 or more`);
		process.exit(2);
	}
	return n;
}

const args = process.argv.slice(2);
const vault = args.find((a) => !a.startsWith("--"));
if (vault === undefined || vault === "") {
	console.error(USAGE);
	process.exit(2);
}
const foldLimit = limitFlag(args, "fold-limit-ms", FOLD_LIMIT_MS);
const getLimit = limitFlag(args, "get-limit-ms", GET_LIMIT_MS);

// Loaded only now, so that asking for the usage does not need the workspace built.
const { spendFactsOf } = await import("../src/shared/rows.js");
const { TotalsIndex } = await import("../src/shared/totals.js");
const { createUiServer } = await import("../src/server/server.js");

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] as number;
}

const loadStart = performance.now();
// The log is read directly: the timing is of the fold, not of the server's load and chain check.
const events = readFileSync(join(vault, ".usertrust", "audit", "events.jsonl"), "utf8")
	.split("\n")
	.filter((line) => line !== "")
	.map((line) => JSON.parse(line) as PersistedAuditEvent);
const loadMs = performance.now() - loadStart;

function foldAll(): number {
	const totals = new TotalsIndex();
	const t0 = performance.now();
	for (const e of events) totals.add(spendFactsOf(e));
	const ms = performance.now() - t0;
	if (totals.records !== events.length) throw new Error("the fold missed records");
	return ms;
}

foldAll(); // one warm-up, so compilation is not counted
const foldRuns: number[] = [];
for (let i = 0; i < RUNS; i++) foldRuns.push(foldAll());
const foldMs = median(foldRuns);

/** The 95th percentile of `REQUESTS` sequential requests, in milliseconds. */
async function getP95(base: string): Promise<number> {
	const times: number[] = [];
	for (let i = 0; i < REQUESTS; i++) {
		const t0 = performance.now();
		const res = await fetch(`${base}/api/totals`);
		const body = await res.text();
		const ms = performance.now() - t0;
		if (res.status !== 200 || body === "")
			throw new Error(`GET /api/totals answered ${res.status}`);
		times.push(ms);
	}
	times.sort((a, b) => a - b);
	return times[Math.ceil(0.95 * times.length) - 1] as number;
}

// Settings live in a directory of their own, outside the vault.
const workspace = mkdtempSync(join(tmpdir(), "measure-totals-ws-"));
const startStart = performance.now();
const ui = await createUiServer(vault, { port: 0, workspaceDir: join(workspace, "workspace") });
const startMs = performance.now() - startStart;
let getMs: number;
let getRuns: number[];
try {
	const base = `http://127.0.0.1:${ui.port}`;
	await getP95(base); // one warm-up round
	getRuns = [];
	for (let i = 0; i < RUNS; i++) getRuns.push(await getP95(base));
	getMs = median(getRuns);
} finally {
	await ui.close();
	rmSync(workspace, { recursive: true, force: true });
}

const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(1)).join(" ");
console.log(
	`${events.length} records; load ${loadMs.toFixed(0)} ms, server start ${startMs.toFixed(0)} ms (not counted)`,
);
console.log(
	`(a) fold over every event   median ${foldMs.toFixed(2).padStart(8)} ms   runs ${fmt(foldRuns)}   limit ${foldLimit} ms`,
);
console.log(
	`(b) GET /api/totals p95     median ${getMs.toFixed(2).padStart(8)} ms   runs ${fmt(getRuns)}   limit ${getLimit} ms`,
);
const over = foldMs > foldLimit || getMs > getLimit;
if (over) {
	console.log("OVER LIMIT");
	process.exitCode = 1;
}
