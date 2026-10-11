// A failpoint for the hook tests, preloaded into a hook's PARENT with `--import`
// (launch.mjs never passes it on: a child gets no node options). Right before the
// parent starts a configured session's child, the session's pin is removed, as a
// sweep or a hand that deletes it at that instant would: the child, which reads the
// pin the parent names, refuses to run.
import { unlinkSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const childProcess = createRequire(import.meta.url)("node:child_process");
const { spawn } = childProcess;
const PIN = "--ut-pin=";

childProcess.spawn = (file, args, options) => {
	const pin = (args ?? []).find((arg) => String(arg).startsWith(PIN));
	if (pin !== undefined) unlinkSync(String(pin).slice(PIN.length));
	return spawn(file, args, options);
};
syncBuiltinESMExports();
