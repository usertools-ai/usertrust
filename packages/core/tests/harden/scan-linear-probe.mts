// Measurement only, never merged: each normalized-view row's ratio at a fixed pairing (n, 2n),
// sampled exactly as scan-linear.test.ts samples (inputs flat and kept, reads per sample enough
// for 30 ms, least of five alternating samples), three times from inputs built anew.
import { detectInjection } from "../../src/policy/injection.js";
import { detectPII } from "../../src/policy/pii.js";

const flat = (t: string): string => JSON.parse(JSON.stringify(t));
const cp = (c: number): string => String.fromCodePoint(c);
const run =
	(unit: string) =>
	(n: number): string =>
		unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const after =
	(head: string, unit: string) =>
	(n: number): string =>
		head + run(unit)(n - head.length);

const ROWS: Array<[string, (n: number) => string]> = [
	["zero-width spaces", run(cp(0x200b))],
	["a digit, then a zero-width space", run(`1${cp(0x200b)}`)],
	["a letter, then a zero-width joiner", run(`a${cp(0x200d)}`)],
	["fullwidth digits", run(cp(0xff11))],
	["fullwidth digits and spaces", run(`${cp(0xff14)} `)],
	["U+FDFA", run(cp(0xfdfa))],
	["a key prefix, then zero-width spaces", after("sk-", cp(0x200b))],
	["fullwidth letters and an at sign", run(`${cp(0xff41)}${cp(0xff20)}`)],
];
const SIZES = (process.env.PROBE_SIZES ?? "500000,1000000,2000000,4000000").split(",").map(Number);
const REPS = Number(process.env.PROBE_REPS ?? 3);

const timed = (read: () => unknown, reads: number): number => {
	const started = performance.now();
	for (let i = 0; i < reads; i++) read();
	return performance.now() - started;
};

const scans: Array<[string, (s: string) => unknown]> = [
	["detectPII", detectPII],
	["detectInjection", detectInjection],
];
const started = performance.now();
for (const [scanName, scan] of scans) {
	for (const [row, make] of ROWS) {
		for (const n of SIZES) {
			for (let rep = 0; rep < REPS; rep++) {
				const a = flat(make(n));
				const b = flat(make(2 * n));
				const small = () => scan(a);
				const big = () => scan(b);
				small();
				big();
				let reads = Math.max(1, Math.ceil(30 / Math.max(timed(small, 1), 0.01)));
				while (timed(small, reads) < 30) reads *= 2;
				let once = Number.POSITIVE_INFINITY;
				let twice = Number.POSITIVE_INFINITY;
				for (let i = 0; i < 5; i++) {
					once = Math.min(once, timed(small, reads));
					twice = Math.min(twice, timed(big, reads));
				}
				console.log(
					`[probe] ${scanName}|${row}|${n}|${rep}|${(twice / once).toFixed(3)}|${(once / reads).toFixed(1)}`,
				);
			}
		}
	}
}
console.log(`[probe] done in ${((performance.now() - started) / 1000).toFixed(0)} s`);
