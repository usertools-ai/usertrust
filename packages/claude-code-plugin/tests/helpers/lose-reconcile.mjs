// A failpoint for the hook tests, preloaded into a hook process with `--import`
// (NODE_OPTIONS): another hook's reconcile removes a stale `.settling` record first.
// Right before this hook first takes an agent's lock (the mkdir of a `.lock` dir),
// the file named by UT_CC_TAKEN is removed, as that other hook's journal step would
// remove it. This hook's own reconcile then finds nothing to remove.
import { createRequire, syncBuiltinESMExports } from "node:module";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const { mkdir, unlink } = fsp;
const taken = process.env.UT_CC_TAKEN;
let done = false;

fsp.mkdir = async (path, ...rest) => {
	if (!done && taken && String(path).endsWith(".lock")) {
		done = true;
		await unlink(taken).catch(() => {});
	}
	return mkdir(path, ...rest);
};
syncBuiltinESMExports();
