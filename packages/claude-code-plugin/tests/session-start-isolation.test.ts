// SessionStart's one request (does the server list `job-type`?) and the README's isolation
// guarantee: a configured session's requests are made from its sanitized child, never from the
// parent that inherits the environment. Each test names the mutant it kills.

import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runHook } from "./helpers/run-hook.js";

vi.setConfig({ testTimeout: 30_000 });

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION_START = join(HOOKS, "session-start.mjs");
const BANNER = "usertrust: watch-only — nothing is blocked";
const CAPS = JSON.stringify({ status: "ok", capabilities: ["job", "job-type", "principal"] });

const servers: Server[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) {
		s.closeAllConnections();
		s.close();
	}
});

interface Fake {
	port: number;
	requests: string[];
}
function listen(server: Server, requests: string[]): Promise<Fake> {
	servers.push(server);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const a = server.address();
			resolve({ port: typeof a === "object" && a !== null ? a.port : 0, requests });
		});
	});
}
const answer =
	(requests: string[]) => (req: { url?: string }, res: import("node:http").ServerResponse) => {
		requests.push(req.url ?? "");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(CAPS);
	};
function httpFake(): Promise<Fake> {
	const requests: string[] = [];
	return listen(createHttp(answer(requests)), requests);
}

let cert: { key: string; cert: string };
beforeAll(async () => {
	// A throwaway self-signed certificate: no store trusts it, so only a client that does not
	// verify (NODE_TLS_REJECT_UNAUTHORIZED=0) will talk to it.
	const dir = await mkdtemp(join(tmpdir(), "utcc-tls-"));
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(dir, "k.pem"),
			"-out",
			join(dir, "c.pem"),
			"-days",
			"1",
			"-subj",
			"/CN=127.0.0.1",
		],
		{ stdio: "ignore" },
	);
	cert = {
		key: await readFile(join(dir, "k.pem"), "utf-8"),
		cert: await readFile(join(dir, "c.pem"), "utf-8"),
	};
});
function httpsFake(): Promise<Fake> {
	const requests: string[] = [];
	return listen(createHttps(cert, answer(requests)) as unknown as Server, requests);
}

/** A configured session: a config file under the passwd home's anchor, as the README says. */
async function configured(url: string, { peer = false } = {}) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "utcc-iso-home-")));
	const anchor = join(home, ".config", "usertrust");
	await mkdir(anchor, { recursive: true, mode: 0o700 });
	const stateDir = await mkdtemp(join(tmpdir(), "utcc-iso-state-"));
	const path = join(anchor, "session.json");
	await writeFile(path, JSON.stringify({ url, key: "file-key", mode: "watch", stateDir }), {
		mode: 0o600,
	});
	if (peer) {
		// The old plugin looks enabled: the parent's `warnOfPeer` leaves a warning for the banner.
		await mkdir(join(home, ".claude"), { recursive: true });
		await writeFile(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "usertrust-claude-code@elsewhere": true } }),
		);
	}
	return { TEST_PASSWD_HOME: home, UT_CC_CONFIG: path };
}

const start = (
	env: Record<string, string>,
	options: { hooksDir?: string } = {},
	session = "sess-iso",
) => {
	const began = Date.now();
	return runHook(
		SESSION_START,
		{ hook_event_name: "SessionStart", source: "startup", session_id: session },
		env,
		[],
		options,
	).then((r) => ({ ...r, ms: Date.now() - began }));
};
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const contextOf = (stdout: string) =>
	(JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
		?.additionalContext;

describe("a configured session's SessionStart request is made from its isolated child", () => {
	it("a self-signed HTTPS server is NOT trusted through an inherited NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
		const fake = await httpsFake();
		const env = await configured(`https://127.0.0.1:${fake.port}`);
		const r = await start({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" });
		expect(r.code).toBe(0);
		// mutant: the probe runs in the parent again → the unverified TLS is accepted, and the
		// instruction (and a request) arrive
		expect(contextOf(r.stdout)).toBeUndefined();
		expect(fake.requests).toEqual([]);
		// the banner is still the one announcement, in one object
		expect(Object.keys(JSON.parse(r.stdout))).toEqual(["systemMessage"]);
		expect(count(r.stdout, BANNER)).toBe(1);
		expect(r.stderr).toContain("capabilities are unknown");
	});

	it("control: the same HTTPS server IS reached by a session configured through the environment", async () => {
		// The legacy path is unchanged: it probes in this process, under the environment it has.
		const fake = await httpsFake();
		const r = await start({
			UT_SERVER_URL: `https://127.0.0.1:${fake.port}`,
			UT_SERVER_KEY: "k",
			UT_CC_STATE_DIR: await mkdtemp(join(tmpdir(), "utcc-iso-env-")),
			NODE_TLS_REJECT_UNAUTHORIZED: "0",
		});
		expect(contextOf(r.stdout)).toContain("usertrust-job.mjs start --type <type>");
		expect(fake.requests).toEqual(["/v1/health"]);
		expect(count(r.stdout, BANNER)).toBe(1);
	});

	it("control: a plain server that lists job-type gives a configured session the instruction, once", async () => {
		const fake = await httpFake();
		const r = await start(await configured(`http://127.0.0.1:${fake.port}`, { peer: true }));
		expect(r.code).toBe(0);
		const out = JSON.parse(r.stdout) as Record<string, unknown>;
		expect(Object.keys(out).sort()).toEqual(["hookSpecificOutput", "systemMessage"]);
		expect(contextOf(r.stdout)).toContain("usertrust-job.mjs start --type <type> --source agent");
		expect(count(r.stdout, BANNER)).toBe(1);
		expect(fake.requests).toEqual(["/v1/health"]);
		// the parent-side peer check still speaks in the banner, before the mode line
		expect(out.systemMessage).toMatch(
			/^usertrust: usertrust-claude-code also appears to be enabled/,
		);
	});

	describe("a child that fails still ends in the banner, once, with no instruction", () => {
		async function standIn(body: string) {
			const dir = await mkdtemp(join(tmpdir(), "utcc-iso-hooks-"));
			await cp(HOOKS, dir, { recursive: true });
			await writeFile(join(dir, "session-probe.mjs"), body);
			return dir;
		}
		const cases: Array<[string, string]> = [
			["exits 1", "process.exitCode = 1;"],
			["is refused (exit 3)", "process.exitCode = 3;"],
			["throws", 'throw new Error("boom");'],
			["is killed by a signal", 'process.kill(process.pid, "SIGKILL");'],
		];
		for (const [what, body] of cases) {
			it(`a probe child that ${what}`, async () => {
				const fake = await httpFake();
				const hooksDir = await standIn(body);
				const r = await start(await configured(`http://127.0.0.1:${fake.port}`), { hooksDir });
				expect(r.code).toBe(0);
				expect(Object.keys(JSON.parse(r.stdout))).toEqual(["systemMessage"]);
				expect(count(r.stdout, BANNER)).toBe(1);
			});
		}
		it("a probe child that never ends is cut off, well inside the hook's 5 s", async () => {
			const fake = await httpFake();
			const hooksDir = await standIn("await new Promise(() => setInterval(() => {}, 1000));");
			const r = await start(await configured(`http://127.0.0.1:${fake.port}`), { hooksDir });
			// mutant: no kill timer → the parent waits for a child that never ends
			expect(r.ms).toBeLessThan(4_800);
			expect(Object.keys(JSON.parse(r.stdout))).toEqual(["systemMessage"]);
			expect(count(r.stdout, BANNER)).toBe(1);
		});
		it("the answer is the child's EXIT CODE: its stdout is never the parent's", async () => {
			const fake = await httpFake();
			const hooksDir = await standIn(
				'process.stdout.write("garbage that is not the hook\'s JSON"); process.exitCode = 10;',
			);
			const r = await start(await configured(`http://127.0.0.1:${fake.port}`), { hooksDir });
			// stdout is still ONE parseable object, and the exit code 10 means "listed"
			expect(contextOf(r.stdout)).toContain("usertrust-job.mjs start");
			expect(r.stdout).not.toContain("garbage");
			expect(count(r.stdout, BANNER)).toBe(1);
		});
	});

	it("session-probe is a child only: run as a hook of its own it is not a hook", async () => {
		const r = await runHook(
			join(HOOKS, "session-probe.mjs"),
			{},
			{ UT_CC_STATE_DIR: await mkdtemp(join(tmpdir(), "utcc-iso-x-")) },
		);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("launch.mjs runs a hook");
	});
});
