// A failpoint for crash.test.ts, preloaded into a hook process with `--import`:
// SIGKILL the hook right before, or right after, the k-th call of one operation,
// so a test can stop a hook at every step boundary that can change what is
// posted — a claim published (link), a cursor or hold file renamed into place
// (rename), an exclusive create (a lock owner, an estimate marker, a claim on a
// link-less filesystem), and every server call (fetch, by path).
//
//   UT_CC_CRASH      "<op>|<k>|<before|after>", e.g. "fetch /v1/settle|1|after"
//   UT_CC_CRASH_LOG  a file: each call is appended as "<op>", the crash as "CRASH ..."
//
// SIGKILL, not an exception: nothing after the boundary runs — no finally, no
// handler — exactly as when the hook's process is killed there.
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const [target = "", nth = "0", when = "before"] = (process.env.UT_CC_CRASH ?? "").split("|");
const k = Number(nth);
const log = process.env.UT_CC_CRASH_LOG;
const seen = new Map();

function note(line) {
	if (log) appendFileSync(log, `${line}\n`);
}

function die(op, n) {
	note(`CRASH ${op} ${n} ${when}`);
	process.kill(process.pid, "SIGKILL");
}

async function step(op, call) {
	const n = (seen.get(op) ?? 0) + 1;
	seen.set(op, n);
	note(op);
	const hit = op === target && n === k;
	if (hit && when === "before") die(op, n);
	const result = await call();
	if (hit && when === "after") die(op, n);
	return result;
}

const { link, rename, writeFile } = fsp;
fsp.link = (...args) => step("link", () => link(...args));
fsp.rename = (...args) => step("rename", () => rename(...args));
fsp.writeFile = (path, data, options) =>
	options?.flag === "wx"
		? step("create", () => writeFile(path, data, options))
		: writeFile(path, data, options);
syncBuiltinESMExports();

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) =>
	step(`fetch ${new URL(String(url)).pathname}`, () => realFetch(url, init));
