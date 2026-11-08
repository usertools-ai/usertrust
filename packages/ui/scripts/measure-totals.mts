// Dev-only: what the whole-vault totals cost. Not shipped (the package's "files" lists only dist, LICENSE and NOTICE).
// Run from the repository root:
//   npx tsx packages/ui/scripts/measure-totals.mts <vault path> [--fold-limit-ms=N] [--get-limit-ms=N] [--keys-limit-ms=N]
// It needs the workspace built (`npm run build`), so that `usertrust` and `usertrust-verify` resolve. Point it at a
// copy of a vault: it starts a server over it, which reads the vault and writes nothing there.
//
// It prints the median of five runs of three numbers:
//   (a) the cost the fold adds to the server's start-up read: `TotalsIndex.add(spendFactsOf(e))` over every event of
//       the vault, timed alone (the log is read and parsed beforehand, and that time is not counted); limit 100 ms;
//   (b) the p95 of 50 `GET /api/totals` requests to a started server; limit 50 ms (the target `/api/at` is held to);
//   (c) `payload()` over an in-memory `TotalsIndex` of 1,000,000 distinct lanes (built from synthetic facts, no
//       vault): the work of one request when every session is its own lane; limit 250 ms.
// The limits can be set with the three flags; setting all three to 0 is the positive control, and must exit 1.
//
// Exit codes: 0 every median within its limit; 1 OVER LIMIT (a median passes its limit); 2 usage (no vault path, or
// a flag that is not a number of milliseconds); 3 crashed (the measurement itself failed; "measure-totals: crashed:
// <message>" is printed and the temporary workspace is removed all the same).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { PersistedAuditEvent } from "usertrust";

const RUNS = 5;
const REQUESTS = 50;
const KEYS = 1_000_000;
const FOLD_LIMIT_MS = 100;
const GET_LIMIT_MS = 50;
const KEYS_LIMIT_MS = 250;

const USAGE =
	"usage: measure-totals.mts <vault path> [--fold-limit-ms=N] [--get-limit-ms=N] [--keys-limit-ms=N]\n" +
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
const keysLimit = limitFlag(args, "keys-limit-ms", KEYS_LIMIT_MS);

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] as number;
}

const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(1)).join(" ");

/** Prints the three numbers; true when a median is over its limit. */
async function measure(vaultPath: string, workspace: string): Promise<boolean> {
	// Loaded only now, so that asking for the usage does not need the workspace built.
	const { spendFactsOf } = await import("../src/shared/rows.js");
	const { TotalsIndex } = await import("../src/shared/totals.js");
	const { createUiServer } = await import("../src/server/server.js");

	const loadStart = performance.now();
	// The log is read directly: the timing is of the fold, not of the server's load and chain check.
	const events = readFileSync(join(vaultPath, ".usertrust", "audit", "events.jsonl"), "utf8")
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

	// (c) One request's work when every session is its own lane: no vault, no server.
	const many = new TotalsIndex();
	for (let i = 0; i < KEYS; i++)
		many.add({
			ts: "2026-07-27T10:00:00.000Z",
			kind: "llm_call",
			actor: `lane-${i}`,
			costUt: (i * 7919) % 1000,
		});
	many.payload(0); // one warm-up
	const keysRuns: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const t0 = performance.now();
		many.payload(0);
		keysRuns.push(performance.now() - t0);
	}
	const keysMs = median(keysRuns);

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

	const startStart = performance.now();
	const ui = await createUiServer(vaultPath, {
		port: 0,
		workspaceDir: join(workspace, "workspace"),
	});
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
	}

	console.log(
		`${events.length} records; load ${loadMs.toFixed(0)} ms, server start ${startMs.toFixed(0)} ms (not counted)`,
	);
	console.log(
		`(a) fold over every event   median ${foldMs.toFixed(2).padStart(8)} ms   runs ${fmt(foldRuns)}   limit ${foldLimit} ms`,
	);
	console.log(
		`(b) GET /api/totals p95     median ${getMs.toFixed(2).padStart(8)} ms   runs ${fmt(getRuns)}   limit ${getLimit} ms`,
	);
	console.log(
		`(c) payload() over ${KEYS.toLocaleString("en-US")} lanes   median ${keysMs.toFixed(2).padStart(8)} ms   runs ${fmt(keysRuns)}   limit ${keysLimit} ms`,
	);
	return foldMs > foldLimit || getMs > getLimit || keysMs > keysLimit;
}

// Settings live in a directory of their own, outside the vault. Removed whatever happens below.
const workspace = mkdtempSync(join(tmpdir(), "measure-totals-ws-"));
try {
	if (await measure(vault, workspace)) {
		console.log("OVER LIMIT");
		process.exitCode = 1;
	}
} catch (err) {
	console.error(`measure-totals: crashed: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 3;
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
