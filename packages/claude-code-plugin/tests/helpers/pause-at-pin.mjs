// A failpoint for the hook tests, preloaded into a hook with `--import`. The hook
// PAUSES right after the session's pin first exists under its name (UT_CC_PAUSE_PIN),
// whichever way it came to exist: a link() onto the name, or an exclusive create of
// it. It creates the file UT_CC_PAUSED, then waits until the file UT_CC_GO exists, for
// 15 s at most. The pin is published with sync calls, so the wait is sync too.
import { constants, existsSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const fs = createRequire(import.meta.url)("node:fs");
const { linkSync, openSync } = fs;
const pin = process.env.UT_CC_PAUSE_PIN;
const MAX_WAIT_MS = 15_000;
let paused = false;

function pause() {
	if (paused) return;
	paused = true;
	writeFileSync(String(process.env.UT_CC_PAUSED), "");
	const tick = new Int32Array(new SharedArrayBuffer(4));
	const until = Date.now() + MAX_WAIT_MS;
	while (!existsSync(String(process.env.UT_CC_GO)) && Date.now() < until) {
		Atomics.wait(tick, 0, 0, 10);
	}
}

fs.linkSync = (from, to) => {
	linkSync(from, to);
	if (String(to) === pin) pause();
};
fs.openSync = (path, flags, mode) => {
	const fd = openSync(path, flags, mode);
	if (String(path) === pin && typeof flags === "number" && (flags & constants.O_CREAT) !== 0) {
		pause();
	}
	return fd;
};
syncBuiltinESMExports();
