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
	chmodSync,
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
import type { Governor } from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import { scrubForStderr } from "../src/cli/scrub.js";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, internalErrorLine, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";
import { OLD_API_KEY_VALUE, redactWith } from "./helpers/old-api-key-pattern.js";

const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const PRELOAD = join(import.meta.dirname, "helpers", "source-preload.mjs");
/** Covers compiling the sources on a cold CI runner. */
const START_MS = 30_000;
/** Recognisable, so a leak of it anywhere is found by a plain grep. */
const KEY = "ut_CANARYKEY_7f3e9a1c_do_not_log";
const OPAQUE_500 = { error: "internal", reason: "internal error" };
/** Modes, symbolic links and closed pipes are POSIX: those rows do not run on Windows. */
const onWindows = process.platform === "win32";

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
	mkdirSync(target);
	// Set exactly: mkdir's mode is masked by the umask, and under 0o077 it would be 0o700, not loose.
	chmodSync(target, 0o755);
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

describe.skipIf(onWindows)(
	"an internal error is logged with its reason, and answered as before",
	() => {
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
	},
);

/** A dryRun config with one tenant, `t1`, whose governor the test supplies. */
function inProcessConfig(stateDir: string) {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir,
		enforcement: "enforce" as const,
		pendingTtlMs: 300_000,
		dryRun: true,
		tenants: [{ id: "t1", keyHash: hashKey(KEY), budget: 50_000 }],
	};
}

/** `/v1/health`'s `logLinesDropped`: process-wide, so a row reads it before and after. */
async function logLinesDropped(base: string): Promise<number> {
	const body = (await (await fetch(`${base}/v1/health`)).json()) as { logLinesDropped: unknown };
	if (typeof body.logLinesDropped !== "number") throw new Error("no logLinesDropped");
	return body.logLinesDropped;
}

type WriteCallback = (err?: Error | null) => void;

/**
 * How the fallback's write to stderr answers while a row runs: `ok` (written, and captured),
 * `throws` (synchronously) or `fails` (its own callback gets an error, as an EPIPE does).
 */
type StderrShape = "ok" | "throws" | "fails";

/** Replaces `process.stderr.write` for one row; returns what reached it and a restore. */
function stubStderr(shape: StderrShape): { written: string[]; restore: () => void } {
	const written: string[] = [];
	const original = process.stderr.write;
	const stub = (chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown): boolean => {
		const cb = (typeof encodingOrCb === "function" ? encodingOrCb : maybeCb) as
			| WriteCallback
			| undefined;
		if (shape === "throws") throw new Error("stderr write threw");
		if (shape === "fails") {
			const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
			process.nextTick(() => cb?.(err));
			return false;
		}
		written.push(String(chunk));
		process.nextTick(() => cb?.(null));
		return true;
	};
	process.stderr.write = stub as typeof process.stderr.write;
	return {
		written,
		restore: () => {
			process.stderr.write = original;
		},
	};
}

/** A sink of each failing shape. Each type-checks as `(line: string) => void`. */
const FAILING_SINKS: Array<[string, (onCall: () => void) => (line: string) => void]> = [
	[
		"a sink that throws",
		(onCall) => () => {
			onCall();
			throw new Error("the log sink is broken");
		},
	],
	[
		"an async sink that rejects",
		(onCall) => async () => {
			onCall();
			throw new Error("sink down");
		},
	],
	[
		"a sink returning an object whose `then` getter throws",
		(onCall) => () => {
			onCall();
			return {
				// biome-ignore lint/suspicious/noThenProperty: the hostile thenable is the case under test
				get then(): never {
					throw new Error("then getter exploded");
				},
			};
		},
	],
];

const STDERR_SHAPES: Array<[StderrShape, number]> = [
	// [how stderr answers the fallback, logLinesDropped added by the 500's line]
	["ok", 0],
	["throws", 1],
	["fails", 1],
];

describe("one containment boundary: a failing log sink never changes what the server does", () => {
	describe.each(FAILING_SINKS)("%s", (_name, makeSink) => {
		it.each(STDERR_SHAPES)(
			"stderr %s: the 500 is sent unchanged, sweep and close() complete, nothing goes unhandled, the process lives; dropped += %i",
			async (shape, droppedBy) => {
				const unhandled: unknown[] = [];
				const onUnhandled = (reason: unknown): void => {
					unhandled.push(reason);
				};
				process.on("unhandledRejection", onUnhandled);
				process.on("uncaughtException", onUnhandled);
				let stderr: ReturnType<typeof stubStderr> | undefined;
				try {
					// release throws: the sweep's and shutdown's best-effort release log, and that log fails too.
					const fake = createFakeGovernor({ release: { throws: true } });
					let failNext = false;
					const governor: Governor = {
						...fake.governor,
						async authorize(params) {
							if (failNext) throw new Error("governor exploded");
							return fake.governor.authorize(params);
						},
					};
					let sinkCalls = 0;
					server = createUsertrustServer({
						config: inProcessConfig(tmp("utsrv-err-sink-")),
						factory: async () => governor,
						log: makeSink(() => {
							sinkCalls += 1;
						}),
					});
					const { port } = await server.listen();
					const base = `http://127.0.0.1:${port}`;
					const body = { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 };
					// Two pending holds: one for the sweep to release, one for shutdown.
					expect((await post(base, "/v1/authorize", body)).status).toBe(200);
					expect((await post(base, "/v1/authorize", body)).status).toBe(200);
					const before = await logLinesDropped(base);

					stderr = stubStderr(shape);
					failNext = true;
					const res = await fetch(`${base}/v1/authorize`, {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(5_000),
					});
					expect(res.status).toBe(500);
					expect(await res.json()).toEqual(OPAQUE_500);
					// Late failures (a rejection, a write's callback) land within these turns.
					await new Promise((resolve) => setImmediate(resolve));
					await new Promise((resolve) => setImmediate(resolve));
					expect(sinkCalls).toBe(1);
					stderr.restore();
					expect(await logLinesDropped(base)).toBe(before + droppedBy);
					if (shape === "ok") {
						// The line went to stderr instead, once.
						expect(stderr.written).toEqual([
							"usertrust-server: internal error: tenant=t1 route=POST /v1/authorize: Error: governor exploded\n",
						]);
					}

					stderr = stubStderr(shape);
					// The sweep, far in the future: both holds are due, and each release throws.
					await server.sweepExpired(Date.now() + 10 * 300_000);
					// A sweep that releases nothing leaves its holds pending for shutdown; either way close() completes.
					await server.close();
					server = undefined;
					await new Promise((resolve) => setImmediate(resolve));
					await new Promise((resolve) => setImmediate(resolve));
					stderr.restore();
					// The 500, then each failed release (sweep or shutdown): every one reached the sink.
					expect(sinkCalls).toBeGreaterThanOrEqual(2);
					expect(unhandled).toEqual([]);
				} finally {
					stderr?.restore();
					process.off("unhandledRejection", onUnhandled);
					process.off("uncaughtException", onUnhandled);
				}
			},
			20_000,
		);
	});

	it("the stderr `'error'` listener is installed once per process, beside an embedder's own", () => {
		const mine = (): void => {};
		process.stderr.on("error", mine);
		try {
			const a = createUsertrustServer({ config: inProcessConfig(tmp("utsrv-err-once-a-")) });
			const after = process.stderr.listenerCount("error");
			const b = createUsertrustServer({ config: inProcessConfig(tmp("utsrv-err-once-b-")) });
			expect(process.stderr.listenerCount("error")).toBe(after);
			expect(process.stderr.listeners("error")).toContain(mine);
			void a.close();
			void b.close();
		} finally {
			process.stderr.off("error", mine);
		}
	});
});

/** `logLinesDropped`, read through a throwaway server: it is process-wide, and outlives a closed one. */
async function droppedNow(): Promise<number> {
	const probe = createUsertrustServer({ config: inProcessConfig(tmp("utsrv-err-probe-")) });
	try {
		const { port } = await probe.listen();
		return await logLinesDropped(`http://127.0.0.1:${port}`);
	} finally {
		await probe.close();
	}
}

/** Lets late failures (a rejection, a write's callback) land. */
async function settleTurns(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A ledger-backed server (a deadline, not dryRun) over a fake governor whose late give-back the
 * ledger refuses (`exceeds_credits`), and whose next authorize waits until `openGate()`.
 */
async function noticeServer(sink?: (line: string) => void): Promise<{
	base: string;
	openGate: () => void;
	released: () => number;
}> {
	const fake = createFakeGovernor({
		holdTimeoutMs: 300_000,
		release: { voidError: "exceeds_credits" },
	});
	let open: () => void = () => {};
	const gated = new Promise<void>((resolve) => {
		open = resolve;
	});
	const governor: Governor = {
		...fake.governor,
		async authorize(params) {
			await gated;
			return fake.governor.authorize(params);
		},
	};
	server = createUsertrustServer({
		config: { ...inProcessConfig(tmp("utsrv-err-notice-")), dryRun: false, ledgerTimeoutMs: 100 },
		factory: async () => governor,
		...(sink === undefined ? {} : { log: sink }),
	});
	const { port } = await server.listen();
	return {
		base: `http://127.0.0.1:${port}`,
		openGate: () => open(),
		released: () => fake.calls.released.length,
	};
}

const NOTICE_BODY = { model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 };

/** An authorize refused at the deadline, its hold still owed by the ledger. */
async function refusedAtDeadline(base: string): Promise<void> {
	expect((await post(base, "/v1/authorize", NOTICE_BODY)).status).toBe(503);
}

/** Polls until the late give-back has reached the governor. */
async function released(count: () => number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (count() < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
	expect(count()).toBe(1);
	await settleTurns();
}

/**
 * Each server notice, triggered with stderr answering by `shape` (and nothing else logging
 * meanwhile). Returns the lines that reached stderr.
 */
const NOTICES: Array<[string, RegExp, (shape: StderrShape) => Promise<string[]>]> = [
	[
		"the late-hold refusal (releaseLate)",
		/^usertrust-server: a late hold's void was refused \(transfer [0-9a-f]{12}, exceeds_credits\); it expires at the hold timeout\n$/,
		async (shape) => {
			const s = await noticeServer();
			await refusedAtDeadline(s.base);
			const stderr = stubStderr(shape);
			try {
				s.openGate();
				await released(s.released);
			} finally {
				stderr.restore();
			}
			return stderr.written;
		},
	],
	[
		"the expiry warning (sweepExpired)",
		/^usertrust-server: a late hold whose void was refused has expired \(transfer [0-9a-f]{12}, exceeds_credits\)\n$/,
		async (shape) => {
			const s = await noticeServer();
			await refusedAtDeadline(s.base);
			// The refusal's own line, captured and not counted: this row measures the expiry alone.
			const quiet = stubStderr("ok");
			try {
				s.openGate();
				await released(s.released);
			} finally {
				quiet.restore();
			}
			expect(quiet.written).toHaveLength(1);
			const stderr = stubStderr(shape);
			try {
				// Past the hold's life plus one sweep interval: the refused obligation expires.
				expect(await server?.sweepExpired(Date.now() + 300_000 + 30_000 + 1_000)).toBe(0);
				await settleTurns();
			} finally {
				stderr.restore();
			}
			return stderr.written;
		},
	],
	[
		"the shutdown warning (close)",
		/^usertrust-server: shutting down with 1 authorize\(s\) still waiting on the ledger and 0 late hold void\(s\) not landed; their holds expire at the hold timeout\n$/,
		async (shape) => {
			const s = await noticeServer();
			// The gate never opens: the authorize is still waiting on the ledger at shutdown.
			await refusedAtDeadline(s.base);
			const stderr = stubStderr(shape);
			try {
				await server?.close();
				server = undefined;
				await settleTurns();
			} finally {
				stderr.restore();
			}
			return stderr.written;
		},
	],
];

describe("every server notice goes through the counted log writer", () => {
	describe.each(NOTICES)("%s", (_name, text, trigger) => {
		it.each(STDERR_SHAPES)(
			"stderr %s: the request or shutdown completes, nothing goes unhandled; dropped += %i",
			async (shape, droppedBy) => {
				const unhandled: unknown[] = [];
				const onUnhandled = (reason: unknown): void => {
					unhandled.push(reason);
				};
				process.on("unhandledRejection", onUnhandled);
				process.on("uncaughtException", onUnhandled);
				try {
					const before = await droppedNow();
					const written = await trigger(shape);
					expect(await droppedNow()).toBe(before + droppedBy);
					// The text is unchanged: one line, as it was written before.
					if (shape === "ok") {
						expect(written).toHaveLength(1);
						expect(written[0]).toMatch(text);
					}
					expect(unhandled).toEqual([]);
				} finally {
					process.off("unhandledRejection", onUnhandled);
					process.off("uncaughtException", onUnhandled);
				}
			},
			20_000,
		);
	});

	it.each(NOTICES)(
		"%s reaches an embedder's sink, and nothing reaches stderr",
		async (name, text) => {
			const lines: string[] = [];
			const s = await noticeServer((line) => lines.push(line));
			const stderr = stubStderr("ok");
			try {
				await refusedAtDeadline(s.base);
				if (name.includes("close")) {
					await server?.close();
					server = undefined;
				} else {
					s.openGate();
					await released(s.released);
					if (name.includes("sweepExpired")) {
						await server?.sweepExpired(Date.now() + 300_000 + 30_000 + 1_000);
					}
				}
				await settleTurns();
			} finally {
				stderr.restore();
			}
			expect(stderr.written).toEqual([]);
			expect(lines.filter((line) => text.test(`${line}\n`))).toHaveLength(1);
		},
		20_000,
	);
});

describe("a thenable that calls its rejection handler twice", () => {
	it.each(STDERR_SHAPES)(
		"stderr %s: the line falls back once, and is counted at most once; dropped += %i",
		async (shape, droppedBy) => {
			const fake = createFakeGovernor();
			const governor: Governor = {
				...fake.governor,
				async authorize() {
					throw new Error("governor exploded");
				},
			};
			server = createUsertrustServer({
				config: inProcessConfig(tmp("utsrv-err-twice-")),
				factory: async () => governor,
				log: () =>
					({
						// biome-ignore lint/suspicious/noThenProperty: the hostile thenable is the case under test
						then(_resolve: unknown, reject: (err: Error) => void) {
							reject(new Error("first"));
							reject(new Error("second"));
						},
					}) as unknown as undefined,
			});
			const { port } = await server.listen();
			const base = `http://127.0.0.1:${port}`;
			const before = await logLinesDropped(base);
			const stderr = stubStderr(shape);
			try {
				const res = await post(base, "/v1/authorize", NOTICE_BODY);
				expect(res.status).toBe(500);
				await settleTurns();
			} finally {
				stderr.restore();
			}
			expect(await logLinesDropped(base)).toBe(before + droppedBy);
			if (shape === "ok") {
				expect(stderr.written).toEqual([
					"usertrust-server: internal error: tenant=t1 route=POST /v1/authorize: Error: governor exploded\n",
				]);
			}
		},
		20_000,
	);
});

describe("the log line never carries the caller's key", () => {
	it.each([
		["thrown inside a route (authorize)", "route"],
		["escaping the route (the governor cannot be created)", "factory"],
	])("%s: the key is redacted before the line is written", async (_name, where) => {
		const message = `bad request: Authorization: Bearer ${KEY} body={"actor":"${KEY}"} x-api-key: ${KEY}`;
		let thrown: Error | undefined;
		const fake = createFakeGovernor();
		const governor: Governor = {
			...fake.governor,
			async authorize() {
				thrown = new Error(message);
				throw thrown;
			},
		};
		const lines: string[] = [];
		server = createUsertrustServer({
			config: inProcessConfig(tmp("utsrv-err-redact-")),
			factory: async () => {
				if (where === "factory") {
					thrown = new Error(message);
					throw thrown;
				}
				return governor;
			},
			log: (line) => lines.push(line),
		});
		const { port } = await server.listen();
		const res = await post(`http://127.0.0.1:${port}`, "/v1/authorize", {
			model: "m",
			estimatedInputTokens: 1,
			maxOutputTokens: 1,
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual(OPAQUE_500);
		// Positive control: the key WAS in what was thrown, three times.
		expect(thrown?.message.split(KEY).length).toBe(4);
		expect(lines).toHaveLength(1);
		const line = lines[0] ?? "";
		expect(line.split(KEY).length - 1).toBe(0);
		expect(line).toContain("[redacted]");
		expect(line).toContain("tenant=t1 route=POST /v1/authorize");
	});

	it("an UNQUOTED api-key value is redacted up to whitespace, a quote, `,`, `;` or `&`", () => {
		const message = "upstream said: x-api-key: plain and api_key=other;rest";
		// Positive control: every value is in what was thrown.
		for (const value of ["plain", "other"]) expect(message).toContain(value);
		const line = internalErrorLine(new Error(message), "t1", "sweep");
		expect(line).toBe(
			"usertrust-server: internal error: tenant=t1 route=sweep: Error: upstream said: x-api-key: [redacted] and api_key=[redacted];rest",
		);
		for (const left of ["plain", "other"]) expect(line).not.toContain(left);
	});

	it("an UNCLOSED quoted api-key value is redacted to the end of the message", () => {
		const message = 'upstream said: {"x-api-key":"abcSECRET';
		// Positive control: the value is in what was thrown.
		expect(message).toContain("abcSECRET");
		const line = internalErrorLine(new Error(message), "t1", "sweep");
		expect(line).toBe(
			'usertrust-server: internal error: tenant=t1 route=sweep: Error: upstream said: {"x-api-key":"[redacted]"',
		);
		expect(line).not.toContain("SECRET");
	});

	it("a Bearer token and an api-key value are redacted even when the key is not the caller's", () => {
		const line = internalErrorLine(
			new Error("upstream said: Authorization: Bearer sk-other-123 and x-api-key=abc.def"),
			"t1",
			"sweep",
		);
		expect(line).not.toContain("sk-other-123");
		expect(line).not.toContain("abc.def");
		expect(line).toBe(
			"usertrust-server: internal error: tenant=t1 route=sweep: Error: upstream said: Authorization: Bearer [redacted] and x-api-key=[redacted]",
		);
	});
});

/** Known fragments on either side of the swept character: neither may survive in the line. */
const PREFIX = "PFXsecret41";
const SUFFIX = "SFXsecret73";
/** Each key spelling with the quote its value is written in. */
const KEY_SPELLINGS: Array<[key: string, quote: string]> = [
	['"x-api-key"', '"'],
	['"api_key"', '"'],
	['"api-key"', '"'],
	["'x-api-key'", "'"],
];
/** Every ASCII character, the three non-ASCII line breaks, and one astral character. */
const SWEPT_CHARS: string[] = [
	...Array.from({ length: 0x80 }, (_, i) => String.fromCharCode(i)),
	String.fromCodePoint(0x2028),
	String.fromCodePoint(0x2029),
	String.fromCodePoint(0x85),
	"\u{1F600}",
];

interface SweepCase {
	label: string;
	message: string;
}

/**
 * For each key spelling and each swept character: (i) the character inside the quoted value,
 * between PREFIX and SUFFIX; (ii) the same, right after a backslash. The value's OWN quote,
 * unescaped, ends the value, so for it only (ii) is a character inside the value.
 */
function sweepCases(): SweepCase[] {
	const cases: SweepCase[] = [];
	for (const [key, quote] of KEY_SPELLINGS) {
		for (const char of SWEPT_CHARS) {
			const code = `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
			if (char !== quote) {
				cases.push({
					label: `${key} ${code}`,
					message: `upstream said: {${key}:${quote}${PREFIX}${char}${SUFFIX}${quote}}`,
				});
			}
			cases.push({
				label: `${key} \\${code}`,
				message: `upstream said: {${key}:${quote}${PREFIX}\\${char}${SUFFIX}${quote}}`,
			});
		}
	}
	return cases;
}

/** The labels of the cases whose line still holds a fragment of the value. */
function sweepFailures(line: (message: string) => string): string[] {
	return sweepCases()
		.filter((c) => {
			const out = line(c.message);
			return out.includes(PREFIX) || out.includes(SUFFIX);
		})
		.map((c) => c.label);
}

/** The line the server logs for a message, through the server's own function. */
const serverLine = (message: string): string =>
	internalErrorLine(new Error(message), "t1", "sweep");

/**
 * `internalErrorLine`'s pipeline (redact; scrub without a clip, join and redact; clip)
 * with `pattern` in place of the server's api-key redactor. The parity row pins it to the real
 * function on every sweep case, so the positive control below measures the sweep, not a
 * different pipeline.
 */
function lineWith(pattern: RegExp): (message: string) => string {
	const redact = (text: string): string => redactWith(pattern, text);
	return (message) => {
		const raw = redact(`Error: ${message}`);
		const whole = scrubForStderr(raw, Number.POSITIVE_INFINITY);
		// The quadratic join the server replaced, safe on these short messages: the parity row then
		// also pins the server's one-pass join to it.
		const text = scrubForStderr(redact(whole.replace(/\s*\n\s*/g, " ")));
		return `usertrust-server: internal error: tenant=t1 route=sweep: ${text}`;
	};
}

/** The escape the old pattern used, and the one it replaced (`.` stops at a line terminator). */
const ANY_ESCAPE = String.raw`\\[\s\S]`;
const BROKEN_ESCAPE = String.raw`\\.`;

describe("a quoted api-key value: the generated sweep, never point rows", () => {
	it("1052 cases (132 characters x 4 key spellings, raw and escaped): no fragment of any value survives", () => {
		const cases = sweepCases();
		expect(cases).toHaveLength(1052);
		// Positive control: both fragments are in every message.
		for (const c of cases) {
			expect(c.message).toContain(PREFIX);
			expect(c.message).toContain(SUFFIX);
		}
		expect(sweepFailures(serverLine)).toEqual([]);
	});

	it("the replica pipeline with the old pattern logs exactly internalErrorLine's line, case for case", () => {
		const replica = lineWith(OLD_API_KEY_VALUE);
		for (const c of sweepCases()) expect(replica(c.message)).toBe(serverLine(c.message));
	});

	it("positive control: the sweep, against the old `\\\\.` escape, reports every escaped line terminator", () => {
		// The old pattern carries the any-character escape in both quoted branches.
		expect(OLD_API_KEY_VALUE.source.split(ANY_ESCAPE).length - 1).toBe(2);
		const broken = new RegExp(
			OLD_API_KEY_VALUE.source.split(ANY_ESCAPE).join(BROKEN_ESCAPE),
			OLD_API_KEY_VALUE.flags,
		);
		const expected = KEY_SPELLINGS.flatMap(([key]) =>
			["000A", "000D", "2028", "2029"].map((code) => `${key} \\U+${code}`),
		);
		expect(sweepFailures(lineWith(broken)).sort()).toEqual(expected.sort());
	});
});

describe("the internal-error log line", () => {
	it("is one line with no escape sequence or control character, whatever the message holds", () => {
		const ls = String.fromCodePoint(0x2028);
		const ps = String.fromCodePoint(0x2029);
		const nel = String.fromCodePoint(0x85);
		const err = new TypeError(
			`bad \x1b[2Jthing\nsecond line\x07 end${ls}usertrust-server: forged${ps}third${nel}x`,
		);
		const line = internalErrorLine(err, "t1", "POST /v1/settle");
		expect(line).toBe(
			"usertrust-server: internal error: tenant=t1 route=POST /v1/settle: TypeError: bad thing second line end usertrust-server: forged thirdx",
		);
		for (const char of [ls, ps, nel, "\n", "\r"]) expect(line).not.toContain(char);
		expect(line.split(/\r\n|[\n\r\v\f\x85]/).length).toBe(1);
		expect(line.split(new RegExp(`[${ls}${ps}]`)).length).toBe(1);
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

describe.skipIf(onWindows)("usertrust-server CLI: the key never reaches its log", () => {
	it(
		"a refused tenant's 500 is logged on stderr with the reason, and the key appears nowhere in it",
		async () => {
			const s = await serverConfig();
			const run = startCli(s.configPath, s.cwd);
			await listening(run);

			// After start: the tenant's vault (created at start, or not yet) becomes a link to a loose target.
			const target = looseTarget();
			mkdirSync(join(s.stateDir, "acme"), { recursive: true, mode: 0o700 });
			rmSync(s.vault, { recursive: true, force: true });
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

describe.skipIf(onWindows)(
	"usertrust-server CLI: a configured tenant vault its governor would refuse stops the start",
	() => {
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
				const { code, everListened, stderr } = await runToRefusal(s);
				expect(code).toBe(1);
				expect(everListened).toBe(false);
				expect(stderr).not.toContain("listening on");
				expect(stderr).toContain(`usertrust-server failed to start: tenant acme: ${reason}`);
			},
			START_MS * 2,
		);

		// The start check CREATES the vault, as the governor would on the first request: one it cannot
		// create refuses here, not as a 500 on every request after the port opened.
		it.skipIf(process.getuid?.() === 0)(
			"an absent vault under a read-only state dir: exits non-zero, never listens, names the tenant and the reason",
			async () => {
				const s = await serverConfig();
				mkdirSync(s.stateDir, { mode: 0o500 });
				spawnSync("/bin/chmod", ["500", s.stateDir]);
				try {
					const { code, everListened, stderr } = await runToRefusal(s);
					expect(code).toBe(1);
					expect(everListened).toBe(false);
					expect(stderr).not.toContain("listening on");
					expect(stderr).toContain(
						`usertrust-server failed to start: tenant acme: EACCES: permission denied, mkdir '${join(s.stateDir, "acme")}'`,
					);
				} finally {
					spawnSync("/bin/chmod", ["700", s.stateDir]);
				}
			},
			START_MS * 2,
		);
	},
);

/** Runs the CLI until it exits, watching the port the whole time; a server that listens is killed. */
async function runToRefusal(s: {
	configPath: string;
	cwd: string;
	port: number;
}): Promise<{ code: number | null; everListened: boolean; stderr: string }> {
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
	return { code, everListened, stderr: run.stderr() };
}

describe.skipIf(onWindows)("usertrust-server CLI: a healthy tenant vault starts", () => {
	it.each([
		[
			"an owner-only vault",
			(vault: string) => mkdirSync(vault, { recursive: true, mode: 0o700 }),
			0o700,
		],
		// Created at START, owner-only, rather than on the first request.
		["a vault that does not exist yet, created at start", (_vault: string) => {}, 0o700],
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

describe("usertrust-server CLI: a SIGTERM the moment it says it is listening", () => {
	it(
		"always reaches the shutdown handler: exit 0, 20 times out of 20",
		async () => {
			const codes: (number | null)[] = [];
			for (let i = 0; i < 20; i++) {
				const s = await serverConfig();
				const run = startCli(s.configPath, s.cwd);
				// No round trip: signalled from inside the data handler that first sees the line, as a
				// supervisor that waits for it would.
				run.proc.stderr?.on("data", () => {
					if (run.stderr().includes("listening on")) run.proc.kill("SIGTERM");
				});
				codes.push(await run.exited);
				child = undefined;
			}
			expect(codes).toEqual(Array(20).fill(0));
		},
		START_MS * 4,
	);
});

const CLOSED_STDERR_SERVER = join(import.meta.dirname, "helpers", "closed-stderr-server.ts");

interface ScriptRun {
	proc: ChildProcess;
	stdout: () => string;
	stderr: () => string;
	exited: Promise<number | null>;
}

/** The default-sink server script; its stderr reader is closed before any request when `closeReader`. */
async function startScript(
	closeReader: boolean,
	mode?: "hang",
): Promise<{ run: ScriptRun; base: string }> {
	let stdout = "";
	let stderr = "";
	const proc = spawn(
		process.execPath,
		[
			CLOSED_STDERR_SERVER,
			tmp("utsrv-err-closed-state-"),
			hashKey(KEY),
			...(mode === undefined ? [] : [mode]),
		],
		{
			env: {
				...process.env,
				NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import "${PRELOAD}"`.trim(),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child = proc;
	proc.stdout?.setEncoding("utf-8");
	proc.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	proc.stderr?.setEncoding("utf-8");
	proc.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
	const run: ScriptRun = { proc, stdout: () => stdout, stderr: () => stderr, exited };
	const port = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no listen: ${stderr}`)), START_MS);
		proc.stdout?.on("data", () => {
			const m = /listening (\d+)/.exec(stdout);
			if (m) {
				clearTimeout(timer);
				resolve(Number(m[1]));
			}
		});
		void exited.then((code) => {
			clearTimeout(timer);
			reject(new Error(`exited ${code}: ${stderr}`));
		});
	});
	// Nothing reads this process's stderr from here on: its next write fails with EPIPE.
	if (closeReader) proc.stderr?.destroy();
	return { run, base: `http://127.0.0.1:${port}` };
}

/** Polls stdout until `pattern` appears. */
async function stdoutShows(run: ScriptRun, pattern: RegExp): Promise<RegExpExecArray> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const m = pattern.exec(run.stdout());
		if (m) return m;
		if (Date.now() > deadline) throw new Error(`no ${pattern} in: ${run.stdout()}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** `logLinesDropped`, polled until it reaches `atLeast` (a write's callback lands after the 500). */
async function droppedReaches(base: string, atLeast: number): Promise<number> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const n = await logLinesDropped(base);
		if (n >= atLeast || Date.now() > deadline) return n;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe.skipIf(onWindows)(
	"a server whose stderr READER has gone stays up, and counts the lines it lost",
	() => {
		it(
			"another writer's EPIPE is contained and not counted; the 500 is answered, the process lives, logLinesDropped >= 1",
			async () => {
				const { run, base } = await startScript(true);
				expect(await logLinesDropped(base)).toBe(0);

				// A writer that is not the server fails first: contained, and not this server's line.
				run.proc.kill("SIGUSR2");
				expect((await stdoutShows(run, /other-writer:(\S+)/))[1]).toBe("EPIPE");
				expect(await logLinesDropped(base)).toBe(0);
				expect(run.proc.exitCode).toBeNull();

				// A forced 500: answered unchanged, and its line, which went nowhere, is counted.
				const res = await post(base, "/v1/authorize", {
					model: "m",
					estimatedInputTokens: 1,
					maxOutputTokens: 1,
				});
				expect(res.status).toBe(500);
				expect(await res.json()).toEqual(OPAQUE_500);
				expect(await droppedReaches(base, 1)).toBeGreaterThanOrEqual(1);
				// Still alive after both failed writes, and still answering.
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(run.proc.exitCode).toBeNull();
				// Lost log lines are informational: health stays ok, whatever the count.
				const health = await fetch(`${base}/v1/health`);
				expect(health.status).toBe(200);
				const body = (await health.json()) as { ok: unknown; logLinesDropped: unknown };
				expect(body.ok).toBe(true);
				expect(body.logLinesDropped).toBeGreaterThanOrEqual(1);

				run.proc.kill("SIGTERM");
				expect(await run.exited).toBe(0);
				child = undefined;
			},
			START_MS * 2,
		);

		it.each([
			[true, 1],
			[false, 0],
		])(
			"reader closed %s: the shutdown warning is written or counted, and the shutdown exits 0; dropped = %i",
			async (closeReader, dropped) => {
				const { run, base } = await startScript(closeReader, "hang");
				// Refused at the deadline, and still waiting on the ledger when the server shuts down.
				const res = await post(base, "/v1/authorize", {
					model: "m",
					estimatedInputTokens: 1,
					maxOutputTokens: 1,
				});
				expect(res.status).toBe(503);
				expect(await logLinesDropped(base)).toBe(0);
				run.proc.kill("SIGTERM");
				expect(await run.exited).toBe(0);
				child = undefined;
				expect((await stdoutShows(run, /dropped-after-close:(\d+)/))[1]).toBe(String(dropped));
				if (!closeReader) {
					expect(run.stderr()).toContain(
						"usertrust-server: shutting down with 1 authorize(s) still waiting on the ledger and 0 late hold void(s) not landed; their holds expire at the hold timeout\n",
					);
				}
			},
			START_MS * 2,
		);

		it(
			"control, the reader open: the line is on stderr and logLinesDropped stays 0",
			async () => {
				const { run, base } = await startScript(false);
				const res = await post(base, "/v1/authorize", {
					model: "m",
					estimatedInputTokens: 1,
					maxOutputTokens: 1,
				});
				expect(res.status).toBe(500);
				expect(await res.json()).toEqual(OPAQUE_500);
				const deadline = Date.now() + 5_000;
				while (!run.stderr().includes("internal error") && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				expect(run.stderr()).toContain(
					"usertrust-server: internal error: tenant=t1 route=POST /v1/authorize: Error: governor exploded",
				);
				expect(await logLinesDropped(base)).toBe(0);
				run.proc.kill("SIGTERM");
				expect(await run.exited).toBe(0);
				child = undefined;
			},
			START_MS * 2,
		);
	},
);
