// A failpoint for the hook tests, preloaded into a hook process with `--import`
// (NODE_OPTIONS): another hook claims a hold first. The hook's first claim of a hold
// file finds that another hook has just made the same rename: the file is renamed
// away a moment before, as that hook's claim leaves it, so this hook's own rename
// finds no file (ENOENT). Its claim is lost; the file stays claimed by the "other"
// hook. A claim is a rename of `<hold>.json` to `<hold>.settling` (a settle's), or of
// a `<hold>.settling` to `<hold>.settling.abandoned.*` (an abandon's).
import { createRequire, syncBuiltinESMExports } from "node:module";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const { rename } = fsp;
let lost = false;

function isClaim(from, to) {
	const source = String(from);
	const target = String(to);
	return (
		(source.endsWith(".json") && target.endsWith(".settling")) ||
		(source.endsWith(".settling") && target.includes(".settling.abandoned."))
	);
}

fsp.rename = async (from, to) => {
	if (!lost && isClaim(from, to)) {
		lost = true;
		await rename(from, to); // the other hook's claim, first
	}
	return rename(from, to);
};
syncBuiltinESMExports();
