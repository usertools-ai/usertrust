// SessionStart's one request (does the server list `job-type`?) and the README's isolation
// guarantee: a configured session's requests are made from its sanitized child, never from the
// parent that inherits the environment. Each test names the mutant it kills.

import { execFile, execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer as createHttp, type RequestListener, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import { createServer as createTcp, type Socket, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	LAUNCH,
	PASSWD_HOME_PRELOAD,
	passwdHomeFor,
	pinsDir,
	runHook,
} from "./helpers/run-hook.js";

// timing: 30 s budget; the slowest test in this file took 5.1 s, slowest of 3 runs on a loaded runner
vi.setConfig({ testTimeout: 30_000 });

const HOOKS = join(import.meta.dirname, "..", "hooks");
const SESSION_START = join(HOOKS, "session-start.mjs");
const BANNER = "usertrust: watch-only — nothing is blocked";
const CAPS = JSON.stringify({ status: "ok", capabilities: ["job", "job-type", "principal"] });

const servers: Server[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) {
		s.closeAllConnections?.();
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
	(requests: string[]): RequestListener =>
	(req, res) => {
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
	// timing: reports the hook's wall time; asserted against bounds of 2.5 s, 3.5 s and 4.8 s; the slowest test in this file, three session starts, took 5.1 s, slowest of 3 runs on a loaded runner
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
		const TOKEN = "ut-job-type-listed";
		const answered = async (body: string) => {
			const fake = await httpFake();
			const hooksDir = await standIn(body);
			return start(await configured(`http://127.0.0.1:${fake.port}`), { hooksDir });
		};
		it("the answer is the TOKEN with exit 0, and the child's stdout is never the parent's", async () => {
			const r = await answered(
				`process.stdout.write(${JSON.stringify(`${TOKEN}\n`)}); process.exitCode = 0;`,
			);
			// stdout is still ONE parseable object, and the token means "listed"
			expect(contextOf(r.stdout)).toContain("usertrust-job.mjs start");
			expect(r.stdout).not.toContain(TOKEN);
			expect(Object.keys(JSON.parse(r.stdout)).sort()).toEqual([
				"hookSpecificOutput",
				"systemMessage",
			]);
			expect(count(r.stdout, BANNER)).toBe(1);
		});
		const notListed: Array<[string, string]> = [
			// mutant: the exit code alone is taken (10 is node's own bootstrap failure)
			["exit 10 with no token", "process.exitCode = 10;"],
			["exit 0 with no token", "process.exitCode = 0;"],
			// mutant: the token alone is taken
			[
				"the token with a nonzero exit",
				`process.stdout.write(${JSON.stringify(`${TOKEN}\n`)}); process.exitCode = 1;`,
			],
			[
				"the token, then a signal",
				`process.stdout.write(${JSON.stringify(`${TOKEN}\n`)}, () => process.kill(process.pid, "SIGKILL"));`,
			],
			["output before the token", `process.stdout.write(${JSON.stringify(`x${TOKEN}\n`)});`],
			["output after the token", `process.stdout.write(${JSON.stringify(`${TOKEN}\nmore\n`)});`],
			["the token twice", `process.stdout.write(${JSON.stringify(`${TOKEN}\n${TOKEN}\n`)});`],
			["the token without its newline", `process.stdout.write(${JSON.stringify(TOKEN)});`],
			[
				"more output than the bound, token included",
				`process.stdout.write(${JSON.stringify(`${TOKEN}\n`)} + "y".repeat(400));`,
			],
		];
		it("a child flooding stdout is cut off at the read bound, not left to the 3 s timer", async () => {
			const r = await answered(
				'setInterval(() => process.stdout.write("y".repeat(1000)), 5); await new Promise(() => {});',
			);
			// mutant: the read has no bound → the parent waits out the 3 s kill timer
			expect(r.ms).toBeLessThan(2_500);
			expect(Object.keys(JSON.parse(r.stdout))).toEqual(["systemMessage"]);
			expect(count(r.stdout, BANNER)).toBe(1);
		});
		for (const [what, body] of notListed) {
			it(`${what} is NOT listed`, async () => {
				const r = await answered(body);
				expect(r.code).toBe(0);
				expect(Object.keys(JSON.parse(r.stdout))).toEqual(["systemMessage"]);
				expect(count(r.stdout, BANNER)).toBe(1);
			});
		}
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

	it("the module's own guard: run DIRECTLY (not through launch.mjs) it refuses and sends nothing", async () => {
		const fake = await httpFake();
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
			(resolve) => {
				execFile(
					process.execPath,
					[join(HOOKS, "session-probe.mjs")],
					{
						// An environment that would make it probe: a server that lists job-type.
						env: {
							PATH: process.env.PATH ?? "",
							UT_SERVER_URL: `http://127.0.0.1:${fake.port}`,
							UT_SERVER_KEY: "k",
							UT_CC_STATE_DIR: join(tmpdir(), "utcc-iso-direct"),
						},
					},
					(error, stdout, stderr) =>
						resolve({
							code: error === null ? 0 : ((error as { code?: number }).code ?? 1),
							stdout,
							stderr,
						}),
				);
			},
		);
		// mutant: requireLaunch() removed → it probes, writes the token, exits 0
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("a hook runs only through launch.mjs");
		expect(result.stdout).not.toContain("ut-job-type-listed");
		expect(fake.requests).toEqual([]);
	});

	describe("the probe child dies with its launcher, and ends itself", () => {
		// A server that accepts the TCP connection and never answers the TLS handshake: the
		// request's abort at its bound leaves connection work that keeps a process alive.
		const stallers: TcpServer[] = [];
		const held: Socket[] = [];
		afterEach(() => {
			for (const sock of held.splice(0)) sock.destroy();
			for (const srv of stallers.splice(0)) srv.close();
		});
		async function staller(): Promise<number> {
			const srv = createTcp((sock) => held.push(sock));
			stallers.push(srv);
			await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
			return (srv.address() as { port: number }).port;
		}
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		// timing: a 25 ms poll interval inside goneWithin; the deadlines it serves are 0.5 s to 2.3 s
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		const childOf = (pid: number): number | null => {
			try {
				const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf-8" });
				return Number(out.trim().split("\n")[0]) || null;
			} catch {
				return null;
			}
		};
		/** Start SessionStart's launcher against a stalling TLS server; resolves once its probe child exists. */
		async function launcherWithStalledProbe() {
			const port = await staller();
			const env = await configured(`https://127.0.0.1:${port}`);
			const launcher = spawn(
				process.execPath,
				["--import", PASSWD_HOME_PRELOAD, LAUNCH, "session-start"],
				{
					env: {
						PATH: process.env.PATH ?? "",
						CLAUDE_CONFIG_DIR: join(env.TEST_PASSWD_HOME, ".claude"),
						CLAUDE_PROJECT_DIR: join(env.TEST_PASSWD_HOME, "project"),
						...env,
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			launcher.stdin.end(
				JSON.stringify({
					hook_event_name: "SessionStart",
					source: "startup",
					session_id: "s-orph",
				}),
			);
			let child: number | null = null;
			for (let i = 0; i < 100 && child === null; i++) {
				await sleep(50);
				child = childOf(launcher.pid as number);
			}
			expect(child, "the probe child started").not.toBeNull();
			return { launcher, child: child as number };
		}
		const goneWithin = async (pid: number, ms: number) => {
			// timing: deadlines of 0.5 s, 1 s and 2.3 s for a process that must already be ending; the slowest test in this file took 5.1 s, slowest of 3 runs on a loaded runner
			const until = Date.now() + ms;
			while (alive(pid) && Date.now() < until) await sleep(25);
			return !alive(pid);
		};

		it("SIGTERM to the launcher: the stalled probe child is gone within a second", async () => {
			const { launcher, child } = await launcherWithStalledProbe();
			const closed = new Promise((r) => launcher.on("close", r));
			launcher.kill("SIGTERM");
			// mutant: no signal forwarding or exit cleanup → the child outlives the launcher (the
			// probe's own bound is 1.5 s away)
			const gone = await goneWithin(child, 1_000);
			if (!gone) process.kill(child, "SIGKILL");
			expect(gone, "the probe child was left running").toBe(true);
			await closed;
		});

		it("a launcher that simply EXITS takes its probe child with it (no signal involved)", async () => {
			// A pin made by a real SessionStart, then a driver that starts the probe child
			// (against a stand-in that never ends) and calls process.exit while it runs.
			const fake = await httpFake();
			const env = await configured(`http://127.0.0.1:${fake.port}`);
			expect((await start(env, {}, "s-exit")).code).toBe(0);
			const hooksDir = await mkdtemp(join(tmpdir(), "utcc-iso-hooks-"));
			await cp(HOOKS, hooksDir, { recursive: true });
			await writeFile(
				join(hooksDir, "session-probe.mjs"),
				"await new Promise(() => setInterval(() => {}, 1000));",
			);
			const code = `
				const { probeInChild } = await import(${JSON.stringify(pathToFileURL(join(hooksDir, "launch.mjs")).href)});
				void probeInChild({ path: ${JSON.stringify(join(pinsDir(env), "s-exit.json"))} }, ${JSON.stringify(env.TEST_PASSWD_HOME)});
				setTimeout(() => process.exit(0), 700);
			`;
			const driver = spawn(process.execPath, ["--input-type=module", "-e", code], {
				env: { PATH: process.env.PATH ?? "" },
				stdio: "ignore",
			});
			const closed = new Promise((r) => driver.on("close", r));
			let child: number | null = null;
			for (let i = 0; i < 100 && child === null; i++) {
				await sleep(20);
				child = childOf(driver.pid as number);
			}
			expect(child, "the probe child started").not.toBeNull();
			await closed;
			// mutant: no cleanup on the launcher's exit → the stand-in child runs on, orphaned
			const gone = await goneWithin(child as number, 500);
			if (!gone) process.kill(child as number, "SIGKILL");
			expect(gone, "the probe child outlived the launcher's exit").toBe(true);
		});

		it("the launcher KILLED outright (no cleanup can run): the probe child still ends itself", async () => {
			const { launcher, child } = await launcherWithStalledProbe();
			launcher.kill("SIGKILL");
			// mutant: no process.exit / self-end timer in the child → a stalled connection keeps it alive
			const gone = await goneWithin(child, 2_300);
			if (!gone) process.kill(child, "SIGKILL");
			expect(gone, "the probe child did not end by itself").toBe(true);
		});

		it("an environment session against a stalled TLS handshake: the launcher ends well inside the hook's 5 s", async () => {
			const port = await staller();
			const r = await start({
				UT_SERVER_URL: `https://127.0.0.1:${port}`,
				UT_SERVER_KEY: "k",
				UT_CC_STATE_DIR: await mkdtemp(join(tmpdir(), "utcc-iso-state-")),
			});
			// mutant: the launcher does not end after SessionStart → the stalled handshake keeps it
			// alive past the hook's 5 s kill
			expect(r.ms).toBeLessThan(3_500);
			expect(r.code).toBe(0);
			expect(Object.keys(JSON.parse(r.stdout))).toEqual(["systemMessage"]);
			expect(count(r.stdout, BANNER)).toBe(1);
		});
	});
});

// ── The probe and the circuit breaker (breaker.mjs) ──

interface BreakerLib {
	useBreakerHome(home: string | null): void;
	noteTimeout(url: string, deadlineMs: number): boolean;
	consultBreaker(
		url: string,
		probe: () => Promise<boolean | null>,
	): Promise<{ state: "open" | "closed" }>;
}
const breakerLib = async () =>
	(await import(pathToFileURL(join(HOOKS, "breaker.mjs")).href)) as BreakerLib;

describe("SessionStart's probe and the host's circuit breaker", () => {
	const PRE = join(HOOKS, "pre-tool-use.mjs");
	const SESSION = "s-brk";
	const stateOf = async () => mkdtemp(join(tmpdir(), "utcc-brk-state-"));

	/** A session's env and the passwd home its breaker lives under, for each way a session is set up. */
	async function sessionFor(mode: "env" | "configured", url: string) {
		if (mode === "configured") {
			const env = await configured(url);
			return { env, home: env.TEST_PASSWD_HOME };
		}
		const env = { UT_SERVER_URL: url, UT_SERVER_KEY: "k", UT_CC_STATE_DIR: await stateOf() };
		return { env, home: passwdHomeFor(env) };
	}
	const breakerState = async (home: string, url: string) => {
		const lib = await breakerLib();
		lib.useBreakerHome(home);
		return (await lib.consultBreaker(url, async () => true)).state;
	};

	/** A server on one port, then another on the SAME port (the breaker is keyed by the URL). */
	async function portHolder(make: () => Server, sockets: Socket[] = []) {
		const server = make();
		servers.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const port = (server.address() as { port: number }).port;
		return {
			port,
			async replaceWith(next: Server) {
				for (const sock of sockets) sock.destroy();
				server.closeAllConnections?.();
				await new Promise((r) => server.close(r));
				servers.push(next);
				await new Promise<void>((r) => next.listen(port, "127.0.0.1", () => r()));
			},
		};
	}
	const live = (seen: string[]) =>
		createHttp((req, res) => {
			seen.push(`${req.method} ${req.url}`);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				req.url === "/v1/health" ? CAPS : JSON.stringify({ transferId: "tx_1", estimatedCost: 1 }),
			);
		});

	for (const mode of ["env", "configured"] as const) {
		for (const [what, make] of [
			[
				"a server that accepts the connection and never answers",
				(sockets: Socket[]) => createTcp((sock) => sockets.push(sock)) as unknown as Server,
			],
			[
				"a /v1/health that answers in 1.7 s",
				() =>
					createHttp((_req, res) => {
						// timing: answers at 1.7 s on purpose, just past the probe's 1.5 s bound; the test asserts the bound is not counted against the breaker, so the delay has no headroom to lose
						setTimeout(() => {
							res.writeHead(200, { "content-type": "application/json" });
							res.end(CAPS);
						}, 1_700);
					}),
			],
		] as const) {
			it(`${mode}: three session starts against ${what} leave the breaker closed, and a watch-mode call still sends`, async () => {
				const sockets: Socket[] = [];
				const holder = await portHolder(() => make(sockets), sockets);
				const url = `http://127.0.0.1:${holder.port}`;
				const { env, home } = await sessionFor(mode, url);
				for (let i = 0; i < 3; i++) {
					const r = await start(env, {}, SESSION);
					expect(r.code).toBe(0);
					expect(Object.keys(JSON.parse(r.stdout))).toEqual(["systemMessage"]);
					expect(count(r.stdout, BANNER)).toBe(1);
				}
				// mutant: the probe's timeout is counted → the third opens the breaker
				expect(await breakerState(home, url)).toBe("closed");
				// ...and the server, answering again, is metered: the call is authorized, not skipped
				const seen: string[] = [];
				await holder.replaceWith(live(seen));
				const call = await runHook(
					PRE,
					{
						session_id: SESSION,
						tool_name: "Bash",
						tool_use_id: "tu_1",
						tool_input: { command: "ls" },
					},
					{ ...env, UT_CC_USAGE: "estimate" },
				);
				expect(call.code).toBe(0);
				expect(seen).toContain("POST /v1/authorize");
			});
		}

		it(`${mode}: with the breaker OPEN, SessionStart sends nothing, adds no instruction, and still shows the banner once`, async () => {
			const fake = await httpFake();
			const url = `http://127.0.0.1:${fake.port}`;
			const { env, home } = await sessionFor(mode, url);
			const lib = await breakerLib();
			lib.useBreakerHome(home);
			// Three counted timeouts, by the breaker's own writer: it is open for a minute.
			for (let i = 0; i < 3; i++) lib.noteTimeout(url, 5_000);
			expect(await breakerState(home, url)).toBe("open");
			const r = await start(env, {}, SESSION);
			expect(r.code).toBe(0);
			// mutant: the open-check removed → the probe asks the server, and the instruction arrives
			expect(fake.requests).toEqual([]);
			expect(Object.keys(JSON.parse(r.stdout))).toEqual(["systemMessage"]);
			expect(count(r.stdout, BANNER)).toBe(1);
			expect(await breakerState(home, url)).toBe("open");
		});
	}
});
