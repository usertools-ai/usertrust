/**
 * Typechecks the desk's own code (packages/ui/tsconfig.app.json).
 *
 * `tsc -b` covers src/server and src/shared only, so nothing typechecked src/app before the desk.
 * This fails on any error in a file under src/app/desk/ or src/app/windows/, and lists, without
 * failing, errors in the older components and shared modules those files import.
 *
 * It also fails when:
 *  - tsc reports an error outside any file (a config error);
 *  - tsc exits non-zero with no parseable diagnostic (it did not run);
 *  - no desk file was compiled (an empty check proves nothing).
 *
 *   node_modules/.bin/tsx packages/ui/scripts/typecheck-app.mts
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+: /;
const GATED = ["src/app/desk/", "src/app/windows/"];

const ui = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const tsc = createRequire(join(ui, "package.json")).resolve("typescript/bin/tsc");
const r = spawnSync(
	process.execPath,
	[tsc, "-p", "tsconfig.app.json", "--pretty", "false", "--listFiles"],
	{ cwd: ui, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
);
const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;

const gatedDirs = GATED.map((dir) => join(ui, dir)); // join keeps the trailing slash
let deskFiles = 0;
const gated: string[] = [];
const reported: string[] = [];
const global: string[] = [];
for (const raw of output.split("\n")) {
	const line = raw.trim();
	const m = DIAGNOSTIC.exec(line);
	if (m !== null) {
		const file = (m[1] as string).replaceAll("\\", "/");
		(GATED.some((dir) => file.startsWith(dir)) ? gated : reported).push(line);
	} else if (/\berror TS\d+:/.test(line)) {
		global.push(line);
	} else if (gatedDirs.some((dir) => line.startsWith(dir))) {
		deskFiles++;
	}
}

const errors = gated.length + reported.length + global.length;
let failed = false;
if (r.error !== undefined || (r.status !== 0 && errors === 0)) {
	console.error(
		`typecheck-app: tsc exited ${r.status} with no diagnostics — it did not run:\n${r.error ?? output}`,
	);
	failed = true;
}
if (reported.length > 0) {
	console.log(
		`typecheck-app: ${reported.length} error(s) in files the desk imports, reported, not gated:`,
	);
	for (const line of reported) console.log(`  ${line}`);
}
if (global.length > 0) {
	console.error(`typecheck-app: ${global.length} error(s) outside any file:`);
	for (const line of global) console.error(`  ${line}`);
	failed = true;
}
if (gated.length > 0) {
	console.error(`typecheck-app: ${gated.length} error(s) in the desk's own files:`);
	for (const line of gated) console.error(`  ${line}`);
	failed = true;
}
if (deskFiles === 0) {
	console.error("typecheck-app: no file under src/app/desk or src/app/windows was compiled");
	failed = true;
}
if (!failed) {
	console.log(
		`typecheck-app: ${deskFiles} desk file(s) checked, 0 errors in them; ${reported.length} reported, not gated`,
	);
}
process.exitCode = failed ? 1 : 0;
