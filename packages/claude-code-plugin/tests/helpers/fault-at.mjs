// A failpoint for the hook tests, preloaded into a hook process with `--import`: at the k-th
// rename onto a path ending in a given suffix (a cursor's save, say), the hook either THROWS
// instead of renaming, as a failed write would, or SLEEPS first, as a slow disk would, so a test
// can reach an exit that only a failure or a spent budget takes.
//
//   UT_CC_FAULT       "<suffix>|<k>|throw" or "<suffix>|<k>|sleep <ms>", e.g. "__main.json|1|throw"
//   UT_CC_FAULT_LOG   a file: each matching rename is appended as "<k> <to>", the fault as "FAULT"
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const [suffix = "", nth = "0", action = "throw"] = (process.env.UT_CC_FAULT ?? "").split("|");
const k = Number(nth);
const log = process.env.UT_CC_FAULT_LOG;
let seen = 0;

const { rename } = fsp;
fsp.rename = async (from, to, ...rest) => {
	if (suffix !== "" && String(to).endsWith(suffix)) {
		seen += 1;
		if (log) appendFileSync(log, `${seen} ${String(to)}\n`);
		if (seen === k) {
			if (log) appendFileSync(log, `FAULT ${action}\n`);
			if (action === "throw")
				throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
			const ms = Number(action.replace(/^sleep /, ""));
			await new Promise((resolve) => setTimeout(resolve, ms));
		}
	}
	return rename(from, to, ...rest);
};
syncBuiltinESMExports();
