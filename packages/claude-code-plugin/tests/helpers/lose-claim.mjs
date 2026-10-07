// A failpoint for the hook tests, preloaded into a hook process with `--import`
// (NODE_OPTIONS): another hook claims a hold first. The hook's first claim of a
// pending record (a rename of `<hold>.json` to `<hold>.settling`) finds that another
// hook has just made the same rename: the record is renamed away a moment before, as
// that hook's claim leaves it, so this hook's own rename finds no record (ENOENT).
// Its claim is lost; the record stays claimed by the "other" hook.
import { createRequire, syncBuiltinESMExports } from "node:module";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const { rename } = fsp;
let lost = false;

fsp.rename = async (from, to) => {
	if (!lost && String(from).endsWith(".json") && String(to).endsWith(".settling")) {
		lost = true;
		await rename(from, to); // the other hook's claim, first
	}
	return rename(from, to);
};
syncBuiltinESMExports();
