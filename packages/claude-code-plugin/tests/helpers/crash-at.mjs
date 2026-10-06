// A failpoint for the hook tests, preloaded into a hook process with `--import`:
// SIGKILL the hook right before, or right after, the k-th call of one operation,
// so a test can stop a hook at every step boundary that can change what is
// posted — a claim published (link), a cursor or hold file renamed into place
// (rename), an exclusive create (a lock owner, an estimate marker, a claim on a
// link-less filesystem), and every server call (fetch, by path).
//
//   UT_CC_CRASH         "<op>|<k>|<before|after>", e.g. "fetch /v1/settle|1|after"
//   UT_CC_CRASH_LOG     a file: each call is appended as "<op>", the crash as "CRASH ..."
//   UT_CC_CRASH_ACTION  "write <path>": instead of the kill, write that file there —
//                       another process's write, landing at exactly that boundary
//
// SIGKILL, not an exception: nothing after the boundary runs — no finally, no
// handler — exactly as when the hook's process is killed there.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const [target = "", nth = "0", when = "before"] = (process.env.UT_CC_CRASH ?? "").split("|");
const k = Number(nth);
const log = process.env.UT_CC_CRASH_LOG;
const action = process.env.UT_CC_CRASH_ACTION ?? "kill";
const seen = new Map();

function note(line) {
	if (log) appendFileSync(log, `${line}\n`);
}

function fire(op, n) {
	if (action.startsWith("write ")) {
		const path = action.slice("write ".length);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "recorded by another hook");
		note(`WROTE ${path} at ${op} ${n} ${when}`);
		return;
	}
	note(`CRASH ${op} ${n} ${when}`);
	process.kill(process.pid, "SIGKILL");
}

async function step(op, call) {
	const n = (seen.get(op) ?? 0) + 1;
	seen.set(op, n);
	note(op);
	const hit = op === target && n === k;
	if (hit && when === "before") fire(op, n);
	// "After" holds for an operation that failed too (a claim's link that found the
	// name taken): the hook is killed before it handles the error.
	try {
		return await call();
	} finally {
		if (hit && when === "after") fire(op, n);
	}
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
