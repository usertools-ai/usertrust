// A failpoint for the hook tests, preloaded into a hook with `--import`: the first pin the
// hook tries to publish fails, and at that very moment its config file (UT_CC_CONFIG) is
// caught mid-replacement, half written, as a save that is not atomic leaves it. Where the
// pin fails is TEST_TEAR_AT:
// - "open": its temp file cannot be made (EACCES);
// - "link": the filesystem has no hard links (EPERM);
// - "read": it is made, then cannot be read back (EACCES).
// The hook read the file whole before the failure, so it knows the session's mode: a read
// of the file now finds none.
import { createRequire, syncBuiltinESMExports } from "node:module";

const fs = createRequire(import.meta.url)("node:fs");
const { constants, linkSync, openSync, writeFileSync } = fs;
const at = process.env.TEST_TEAR_AT;
let torn = false;
let linked = false;

/** Half the config file, then the failure: once. */
function tear(code, what) {
	torn = true;
	writeFileSync(process.env.UT_CC_CONFIG, '{"url": "http');
	throw Object.assign(new Error(`${code}: ${what}`), { code });
}

fs.openSync = (path, flags, mode) => {
	const name = String(path);
	if (!torn && at === "open" && typeof flags === "number" && (flags & constants.O_CREAT) !== 0) {
		if (name.endsWith(".tmp")) tear("EACCES", `permission denied, open '${name}'`);
	}
	if (!torn && at === "read" && linked && /\/sessions\/[^/]+\.json$/.test(name)) {
		tear("EACCES", `permission denied, open '${name}'`);
	}
	return openSync(path, flags, mode);
};

fs.linkSync = (from, to) => {
	if (!torn && at === "link") tear("EPERM", `operation not permitted, link '${from}' -> '${to}'`);
	linkSync(from, to);
	linked = true;
};

syncBuiltinESMExports();
