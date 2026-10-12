// A failpoint for the hook tests, preloaded into a hook process with `--import`: the first
// fs/promises writeFile whose path contains UT_CC_TORN_WRITE writes HALF its content and then
// fails (EIO), as a full disk or a killed process leaves a file. A state file written straight to
// its name is then found half-written by the next reader; one written to a temp file and only
// then linked to its name is never seen at all.
//
//   UT_CC_TORN_WRITE  a path fragment, e.g. "/key-rejected/"
import { createRequire, syncBuiltinESMExports } from "node:module";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const fragment = process.env.UT_CC_TORN_WRITE ?? "";
let torn = false;

const { writeFile } = fsp;
fsp.writeFile = async (path, data, options) => {
	if (!torn && fragment !== "" && typeof path === "string" && path.includes(fragment)) {
		torn = true;
		const text = String(data);
		await writeFile(path, text.slice(0, Math.floor(text.length / 2)), options);
		throw Object.assign(new Error("injected torn write"), { code: "EIO" });
	}
	return writeFile(path, data, options);
};
syncBuiltinESMExports();
