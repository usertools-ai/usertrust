// Test-only preload (`node --import`): the passwd database's home, as the hooks
// read it (`os.userInfo().homedir`, config.mjs), becomes TEST_PASSWD_HOME, so a
// test can give a hook a config anchor of its own. The shipped hooks have no seam
// for this: neither the environment nor argv moves the anchor.

import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";

const real = os.userInfo;
os.userInfo = (options) => ({ ...real(options), homedir: process.env.TEST_PASSWD_HOME });

// The platform's managed-settings.json (peer-meter.mjs reads `enabledPlugins` from it) is
// the machine's, not the test's: an MDM that enables an old plugin must not decide a test.
const MANAGED = new Set([
	"/Library/Application Support/ClaudeCode/managed-settings.json",
	"/etc/claude-code/managed-settings.json",
]);
const realOpen = fsp.open;
fsp.open = (path, ...rest) =>
	MANAGED.has(String(path))
		? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }))
		: realOpen(path, ...rest);
syncBuiltinESMExports();
