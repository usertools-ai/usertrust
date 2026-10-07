// A failpoint for the hook tests, preloaded into a hook process with `--import`
// (NODE_OPTIONS): the hook PAUSES after listing the holds and before acting on the
// first one, as a slow hook would, so another hook can run in between. Right before
// its first claim of a pending record (a rename of `<hold>.json` to `<hold>.settling`:
// UT_CC_PAUSE=claim) or its first delete of one (an unlink of a `.json`:
// UT_CC_PAUSE=clear), it creates the file UT_CC_PAUSED, then waits until the file
// UT_CC_GO exists.
import { existsSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const { rename, unlink } = fsp;
const at = process.env.UT_CC_PAUSE;
let paused = false;

async function pause() {
	paused = true;
	writeFileSync(String(process.env.UT_CC_PAUSED), "");
	while (!existsSync(String(process.env.UT_CC_GO))) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

fsp.rename = async (from, to, ...rest) => {
	if (
		!paused &&
		at === "claim" &&
		String(from).endsWith(".json") &&
		String(to).endsWith(".settling")
	) {
		await pause();
	}
	return rename(from, to, ...rest);
};
fsp.unlink = async (path, ...rest) => {
	if (!paused && at === "clear" && String(path).endsWith(".json")) await pause();
	return unlink(path, ...rest);
};
syncBuiltinESMExports();
