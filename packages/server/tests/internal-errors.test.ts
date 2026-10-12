// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An error a client only ever sees as the opaque `500 internal` is named in the server's own
 * log: the tenant, the route, and the error's reason. Never the tenant's key, a header or a
 * request body. And a tenant vault its governor would refuse (a symbolic link to a vault other
 * users can read, a dangling link, a non-directory) stops the server at START, naming the
 * tenant and the reason, before the port opens.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, internalErrorLine, type UsertrustServer } from "../src/server.js";

const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const PRELOAD = join(import.meta.dirname, "helpers", "source-preload.mjs");
/** Covers compiling the sources on a cold CI runner. */
const START_MS = 30_000;
/** Recognisable, so a leak of it anywhere is found by a plain grep. */
const KEY = "ut_CANARYKEY_7f3e9a1c_do_not_log";
const OPAQUE_500 = { error: "internal", reason: "internal error" };

const tracked: string[] = [];
let server: UsertrustServer | undefined;
let child: ChildProcess | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
	child?.kill("SIGKILL");
	child = undefined;
	for (const d of tracked.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tracked.push(d);
	return d;
}

/** A directory other users can read, outside the state dir: what a planted link points at. */
function looseTarget(): string {
	const target = join(tmp("utsrv-err-target-"), "vault");
	mkdirSync(target, { mode: 0o755 });
	return target;
}

function linkRefusal(link: string, target: string): string {
	return `usertrust: the vault ${link} is a symbolic link to ${target}, which other users can read (mode 755). usertrust does not change a directory through a link; make it owner-only with: chmod 700 ${target}`;
}

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	if (address === null || typeof address === "string") throw new Error("no port");
	return address.port;
}

function accepts(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

async function post(base: string, path: string, body: unknown): Promise<Response> {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify(body),
	});
}

describe("an internal error is logged with its reason, and answered as before", () => {
	it("a tenant vault refused after start: the client gets the opaque 500, the log names tenant, route and reason", async () => {
		const stateDir = tmp("utsrv-err-state-");
		const lines: string[] = [];
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				dryRun: true,
				tenants: [{ id: "t1", keyHash: hashKey(KEY), budget: 50_000 }],
			},
			log: (line) => lines.push(line),
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;

		// After start: the tenant's vault becomes a link to a directory other users can read.
		const target = looseTarget();
		mkdirSync(join(stateDir, "t1"), { mode: 0o700 });
		const link = join(stateDir, "t1", ".usertrust");
		symlinkSync(target, link);

		const authorize = await post(base, "/v1/authorize", {
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 100,
		});
		expect(authorize.status).toBe(500);
		expect(await authorize.json()).toEqual(OPAQUE_500);
		const budget = await fetch(`${base}/v1/budget`, {
			headers: { authorization: `Bearer ${KEY}` },
		});
		expect(budget.status).toBe(500);
		expect(await budget.json()).toEqual(OPAQUE_500);

		const reason = `Error: ${linkRefusal(link, target)}`;
		expect(lines).toEqual([
			`usertrust-server: internal error: tenant=t1 route=POST /v1/authorize: ${reason}`,
			`usertrust-server: internal error: tenant=t1 route=GET /v1/budget: ${reason}`,
		]);
		// Never changed through the link.
		expect(statSync(target).mode & 0o777).toBe(0o755);
	});
});

describe("the internal-error log line", () => {
	it("is one line with no escape sequence or control character, whatever the message holds", () => {
		const err = new TypeError("bad \u001b[2Jthing\nsecond line\u0007 end");
		expect(internalErrorLine(err, "t1", "POST /v1/settle")).toBe(
			"usertrust-server: internal error: tenant=t1 route=POST /v1/settle: TypeError: bad thing second line end",
		);
		expect(internalErrorLine("not an error", undefined, "unrouted")).toBe(
			"usertrust-server: internal error: tenant=- route=unrouted: string: not an error",
		);
	});
});

interface CliRun {
	proc: ChildProcess;
	stderr: () => string;
	exited: Promise<number | null>;
}

function startCli(configPath: string, cwd: string): CliRun {
	let stderr = "";
	const proc = spawn(process.execPath, [CLI, "--config", configPath], {
		cwd,
		env: {
			...process.env,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import "${PRELOAD}"`.trim(),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	child = proc;
	proc.stderr?.setEncoding("utf-8");
	proc.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
	return { proc, stderr: () => stderr, exited };
}

/** Resolves when the CLI prints its listening line; rejects if it exits first or takes too long. */
function listening(run: CliRun): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no listen: ${run.stderr()}`)), START_MS);
		run.proc.stderr?.on("data", () => {
			if (run.stderr().includes("listening on")) {
				clearTimeout(timer);
				resolve();
			}
		});
		void run.exited.then((code) => {
			clearTimeout(timer);
			reject(new Error(`exited ${code}: ${run.stderr()}`));
		});
	});
}

/**
 * SIGTERM a listening CLI and wait for it to exit. A round trip first: the listening line is
 * written just before the CLI installs its signal handlers, so a SIGTERM sent the instant the
 * line arrives can beat them; once the server has answered a request, they are installed.
 */
async function stopCli(run: CliRun, port: number): Promise<number | null> {
	await fetch(`http://127.0.0.1:${port}/v1/health`);
	run.proc.kill("SIGTERM");
	const code = await run.exited;
	child = undefined;
	return code;
}

/** A dryRun server config with one tenant, `acme`, in a fresh directory; and the paths it names. */
async function serverConfig(): Promise<{
	configPath: string;
	stateDir: string;
	vault: string;
	port: number;
	cwd: string;
}> {
	const dir = tmp("utsrv-err-cli-");
	const stateDir = join(dir, "state");
	const port = await freePort();
	const configPath = join(dir, "usertrust-server.config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			host: "127.0.0.1",
			port,
			stateDir,
			dryRun: true,
			tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 50_000 }],
		}),
	);
	return {
		configPath,
		stateDir,
		vault: join(stateDir, "acme", ".usertrust"),
		port,
		cwd: tmp("utsrv-err-cwd-"),
	};
}

describe("usertrust-server CLI: the key never reaches its log", () => {
	it(
		"a refused tenant's 500 is logged on stderr with the reason, and the key appears nowhere in it",
		async () => {
			const s = await serverConfig();
			const run = startCli(s.configPath, s.cwd);
			await listening(run);

			const target = looseTarget();
			mkdirSync(join(s.stateDir, "acme"), { recursive: true, mode: 0o700 });
			symlinkSync(target, s.vault);
			// The key rides the Authorization header AND the request body: neither may be logged.
			const res = await post(`http://127.0.0.1:${s.port}`, "/v1/authorize", {
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 100,
				maxOutputTokens: 100,
				actor: KEY,
			});
			expect(res.status).toBe(500);
			expect(await res.json()).toEqual(OPAQUE_500);

			expect(await stopCli(run, s.port)).toBe(0);
			const stderr = run.stderr();
			expect(stderr).toContain(
				`usertrust-server: internal error: tenant=acme route=POST /v1/authorize: Error: ${linkRefusal(s.vault, target)}`,
			);

			// The whole of stderr, grepped for the key: 0 hits.
			const logFile = join(tmp("utsrv-err-log-"), "stderr.log");
			writeFileSync(logFile, stderr);
			const scan = spawnSync("/usr/bin/grep", ["-c", "-F", KEY, logFile], { encoding: "utf-8" });
			expect(scan.stdout.trim()).toBe("0");
			expect(scan.status).toBe(1);
			// Positive control: the same grep finds the key once it is planted in a copy on purpose.
			const planted = `${logFile}.planted`;
			writeFileSync(planted, `${stderr}\n${KEY}\n`);
			const control = spawnSync("/usr/bin/grep", ["-c", "-F", KEY, planted], { encoding: "utf-8" });
			expect(control.stdout.trim()).toBe("1");
			expect(control.status).toBe(0);
		},
		START_MS * 2,
	);
});

describe("usertrust-server CLI: a configured tenant vault its governor would refuse stops the start", () => {
	it.each([
		[
			"a symbolic link to a vault other users can read",
			(vault: string) => {
				const target = looseTarget();
				symlinkSync(target, vault);
				return linkRefusal(vault, target);
			},
		],
		[
			"a dangling symbolic link",
			(vault: string) => {
				const missing = join(tmp("utsrv-err-gone-"), "vault");
				symlinkSync(missing, vault);
				return `usertrust: the vault ${vault} is a symbolic link to ${missing}, which does not exist; remove the link or create the target owner-only (mkdir -m 700 ${missing})`;
			},
		],
		[
			"a regular file",
			(vault: string) => {
				writeFileSync(vault, "not a vault");
				return `usertrust: the vault ${vault} is a regular file, not a directory; move it aside and the vault is created owner-only`;
			},
		],
	])(
		"%s: exits non-zero, never listens, and names the tenant and the reason",
		async (_name, plant) => {
			const s = await serverConfig();
			mkdirSync(join(s.stateDir, "acme"), { recursive: true, mode: 0o700 });
			const reason = plant(s.vault);
			const run = startCli(s.configPath, s.cwd);
			let exited = false;
			const exit = run.exited.then((code) => {
				exited = true;
				return code;
			});
			let everListened = false;
			const watch = (async () => {
				while (!exited) {
					if (await accepts(s.port)) {
						everListened = true;
						// A server that started is the failure: stop it now rather than wait out the test.
						run.proc.kill("SIGKILL");
					}
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			})();
			const code = await exit;
			await watch;
			child = undefined;
			expect(code).toBe(1);
			expect(everListened).toBe(false);
			expect(run.stderr()).not.toContain("listening on");
			expect(run.stderr()).toContain(`usertrust-server failed to start: tenant acme: ${reason}`);
		},
		START_MS * 2,
	);
});

describe("usertrust-server CLI: a healthy tenant vault starts", () => {
	it.each([
		[
			"an owner-only vault",
			(vault: string) => mkdirSync(vault, { recursive: true, mode: 0o700 }),
			0o700,
		],
		["a vault that does not exist yet", (_vault: string) => {}, undefined],
		[
			"a loose real directory, tightened as its governor would",
			(vault: string) => {
				mkdirSync(vault, { recursive: true, mode: 0o755 });
				// mkdir's mode is masked by the umask; set it exactly.
				spawnSync("/bin/chmod", ["755", vault]);
			},
			0o700,
		],
	])(
		"%s: listens, and stops cleanly",
		async (_name, plant, modeAfter) => {
			const s = await serverConfig();
			plant(s.vault);
			const run = startCli(s.configPath, s.cwd);
			await listening(run);
			if (modeAfter !== undefined) expect(statSync(s.vault).mode & 0o777).toBe(modeAfter);
			expect(await stopCli(run, s.port)).toBe(0);
			expect(run.stderr()).not.toContain("internal error");
		},
		START_MS * 2,
	);
});
