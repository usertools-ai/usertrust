// Every test runs as an UNCONFIGURED plugin session whose state dir is a temporary one, whatever
// the host exports. A host that meters its own sessions exports UT_CC_CONFIG, and config.mjs then
// takes every setting from that file and ignores UT_CC_STATE_DIR, UT_SERVER_URL and UT_SERVER_KEY:
// a test that sets those in-process would write its fixtures into the host's LIVE state dir and
// send the host's key to its own localhost fakes. So none of the plugin's variables reaches a
// test, the default state dir is a temporary one, and a plugin test that resolves a state dir
// outside the temporary directory fails (`assertTestStateDir`; run-hook.ts checks each hook's).
// Registered in the root vitest.config.ts (`setupFiles`): it runs before each test file.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect } from "vitest";

/** The plugin's own variables (config.mjs): the config file's name, and every setting's. */
export const PLUGIN_VARIABLE = /^UT_(CC_|SERVER_|FAIL_OPEN$)/;

for (const name of Object.keys(process.env)) {
	if (PLUGIN_VARIABLE.test(name)) delete process.env[name];
}
// The default state dir sits under CLAUDE_CONFIG_DIR (config.mjs): never the developer's own.
process.env.CLAUDE_CONFIG_DIR = join(
	realpathSync(mkdtempSync(join(tmpdir(), "utcc-claude-"))),
	".claude",
);

/** The temporary directory, as given and as its real path (on macOS it is reached through a symlink). */
const TEMPORARY = [...new Set([resolve(tmpdir()), realpathSync(tmpdir())])];

/** Fail when a state dir lies outside the temporary directory: it could be a live one. */
export function assertTestStateDir(stateDir: string, where: string): void {
	const dir = resolve(stateDir);
	if (!TEMPORARY.some((root) => dir.startsWith(root + sep))) {
		throw new Error(
			`${where} resolved the plugin state dir ${dir}, outside the temporary directory (${TEMPORARY.join(", ")}): a test must never read or write a live one`,
		);
	}
}

const PLUGIN_TESTS = resolve(import.meta.dirname, "..");
const CONFIG = pathToFileURL(join(import.meta.dirname, "..", "..", "hooks", "config.mjs")).href;

afterEach(async () => {
	const testPath = expect.getState().testPath;
	if (testPath === undefined || !resolve(testPath).startsWith(PLUGIN_TESTS + sep)) return;
	const { settings } = (await import(CONFIG)) as { settings(): { stateDir: string } };
	assertTestStateDir(settings().stateDir, "this test's own process");
});
