// Test-only preload (`node --import`): an environment session's fallback pins live
// under the real `/tmp` (session.mjs `fallbackDir`), which a test must never touch.
// This maps exactly "/tmp", as the hooks resolve it (`fs.realpathSync`), to
// TEST_TMP_ROOT; every other path resolves as it would. The shipped hooks have no
// seam for this: no variable moves the fallback. Without TEST_TMP_ROOT it refuses to
// load, so a run that forgot it fails rather than use the real one.
import { createRequire, syncBuiltinESMExports } from "node:module";

const fs = createRequire(import.meta.url)("node:fs");
const root = process.env.TEST_TMP_ROOT;
if (typeof root !== "string" || root === "") {
	throw new Error("tmp-root.mjs: TEST_TMP_ROOT is not set");
}
const real = fs.realpathSync;
fs.realpathSync = Object.assign((path, options) => real(path === "/tmp" ? root : path, options), {
	native: real.native,
});
syncBuiltinESMExports();
