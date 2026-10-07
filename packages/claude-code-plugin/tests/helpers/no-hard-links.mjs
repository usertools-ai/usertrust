// A failpoint for the hook tests, preloaded into a hook process with `--import`
// (NODE_OPTIONS): the state dir's filesystem cannot make hard links. Every link()
// fails as such a filesystem's does (EPERM), so each exclusive publish falls back to
// an exclusive create.
import { createRequire, syncBuiltinESMExports } from "node:module";

const fsp = createRequire(import.meta.url)("node:fs/promises");

fsp.link = async (from, to) => {
	const err = new Error(`EPERM: operation not permitted, link '${from}' -> '${to}'`);
	err.code = "EPERM";
	throw err;
};
syncBuiltinESMExports();
