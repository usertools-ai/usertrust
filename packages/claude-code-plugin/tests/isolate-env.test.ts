// A host that meters its own sessions exports UT_CC_CONFIG. Its config file names the host's LIVE
// state dir and bearer key, and config.mjs takes every setting from that file, ignoring the
// UT_CC_STATE_DIR, UT_SERVER_URL and UT_SERVER_KEY a test sets. isolate-env.ts (the root vitest
// setup) removes the plugin's variables before any test. This row runs a real test file in a
// nested vitest under a sentinel config, as such a host would, and proves the sentinel's state dir
// stays empty and its key reaches no server.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertTestStateDir, PLUGIN_VARIABLE } from "./helpers/isolate-env.js";
import { PASSWD_HOME_PRELOAD, runHook } from "./helpers/run-hook.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(
	dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
	"vitest.mjs",
);
/** A test file that sets UT_CC_STATE_DIR and UT_SERVER_KEY in its own process and writes state. */
const PROBE = "packages/claude-code-plugin/tests/lib.test.ts";

let server: Server | undefined;
afterEach(() => {
	server?.closeAllConnections();
	server?.close();
	server = undefined;
});

describe("a test never runs as the host's configured session", () => {
	it("no plugin variable reaches a test, and the default state dir is a temporary one", () => {
		expect(Object.keys(process.env).filter((name) => PLUGIN_VARIABLE.test(name))).toEqual([]);
		assertTestStateDir(join(process.env.CLAUDE_CONFIG_DIR ?? "", "usertrust-cc"), "the default");
		// A fixed path outside any temporary directory, wherever the checkout lies.
		expect(() => assertTestStateDir("/dev/null/state", "a live dir")).toThrow(
			/outside the temporary directory/,
		);
	});

	it("a hook whose session would resolve a state dir outside the temporary directory is never run", () => {
		const hook = join(import.meta.dirname, "..", "hooks", "session-start.mjs");
		// A dir no hook can create: were the check gone, the hook would still write nothing.
		expect(() =>
			runHook(hook, { session_id: "isolate" }, { UT_CC_STATE_DIR: "/dev/null/live-state" }),
		).toThrow(
			/the session-start hook resolved the plugin state dir .* outside the temporary directory/,
		);
	});

	it("a suite run under a host's UT_CC_CONFIG leaves that config's state dir empty and sends its key nowhere", async () => {
		const home = await realpath(await mkdtemp(join(tmpdir(), "utcc-host-")));
		const anchor = join(home, ".config", "usertrust");
		await mkdir(anchor, { recursive: true, mode: 0o700 });
		await chmod(join(home, ".config"), 0o700);
		await chmod(anchor, 0o700);
		const sentinel = join(home, "live-state");
		const requests: string[] = [];
		const port = await new Promise<number>((resolve) => {
			server = createServer((req, res) => {
				requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
				res.writeHead(500).end();
			});
			server.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		const config = join(anchor, "config.json");
		await writeFile(
			config,
			JSON.stringify({
				url: `http://127.0.0.1:${port}`,
				key: "sentinel-live-key",
				mode: "watch",
				stateDir: sentinel,
			}),
			{ mode: 0o600 },
		);
		// The host's environment: its config named, and its passwd home where the config is anchored.
		const run = await new Promise<{ code: number | null; out: string }>((resolve) => {
			const child = spawn(process.execPath, [VITEST, "run", PROBE], {
				cwd: ROOT,
				env: {
					...process.env,
					UT_CC_CONFIG: config,
					TEST_PASSWD_HOME: home,
					NODE_OPTIONS: `--import ${PASSWD_HOME_PRELOAD}`,
					NO_COLOR: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			child.stdout.on("data", (c) => {
				out += c;
			});
			child.stderr.on("data", (c) => {
				out += c;
			});
			child.on("close", (code) => resolve({ code, out }));
		});
		expect(run.code, run.out.slice(-2_000)).toBe(0);
		expect(await readdir(sentinel).catch(() => [])).toEqual([]);
		expect(requests).toEqual([]);
	}, 120_000);
});
