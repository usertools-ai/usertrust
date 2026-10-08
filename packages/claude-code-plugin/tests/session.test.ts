import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

// A session's settings are resolved once, at its first hook, and pinned for its life
// (session.mjs); a configured session's hooks send from a child that gets nothing of
// the environment (launch.mjs). Driven as Claude Code drives the hooks: through
// launch.mjs, with a passwd home of the test's own (helpers/passwd-home.mjs).

const HOOKS = join(import.meta.dirname, "..", "hooks");
const hook = (name: string) => join(HOOKS, `${name}.mjs`);
const LOSE_PIN = join(import.meta.dirname, "helpers", "lose-pin.mjs");
const SPAWN_FAILS = join(import.meta.dirname, "helpers", "spawn-fails.mjs");
const WIN32 = join(import.meta.dirname, "helpers", "win32.mjs");
const ANNOUNCE = join(import.meta.dirname, "helpers", "announce-preload.mjs");
const PAUSE_AT_PIN = join(import.meta.dirname, "helpers", "pause-at-pin.mjs");
const UID = process.getuid?.() ?? null;
const SESSION = "sess-pin";
const MODEL = "claude-sonnet-4-6";

interface Settings {
	configured: boolean;
	refused: string | null;
	url: string | null;
	key: string;
	mode: string;
	stateDir: string;
}

interface Pin {
	v: number;
	kind: string;
	createdAt: string;
	settings: Record<string, unknown>;
}

interface SessionModule {
	sessionSettings(input: {
		env: Record<string, string>;
		payload: unknown;
		passwdHome: string | null;
		uid: number | null;
		now?: number;
		fs?: Record<string, unknown>;
	}): { settings: Settings; kind: string | null; path: string | null };
	readPin(
		path: string,
		options: { uid: number | null },
	): { pin?: Pin; missing?: true; refused?: string };
	sweep(input: {
		passwdHome: string | null;
		uid: number | null;
		stateDir?: string | null;
		now?: number;
		idleMs?: number;
		limit?: number;
	}): number;
	touchPin(path: string, options?: { now?: number }): void;
	PIN_IDLE_MS: number;
}

interface LaunchModule {
	childOutcome(input: { hook: string; mode: string; failOpen: boolean; what: string }): {
		exitCode: number;
		gap: boolean;
		reason: string;
	};
	startedAt(value: unknown, now?: number): number;
	childOptions(env?: Record<string, string>): {
		cwd: string;
		env: Record<string, string>;
		stdio: unknown;
	};
	CHILD_REFUSED: number;
}

async function sessionModule(): Promise<SessionModule> {
	// @ts-expect-error TS7016: session.mjs ships as plain .mjs, with no type declarations.
	return (await import("../hooks/session.mjs")) as SessionModule;
}

async function launchModule(): Promise<LaunchModule> {
	// @ts-expect-error TS7016: launch.mjs ships as plain .mjs, with no type declarations.
	return (await import("../hooks/launch.mjs")) as LaunchModule;
}

/** A passwd home of the test's own, by its real path (a pin's directories hold no symlink). */
async function makeHome(): Promise<string> {
	return nodeFs.realpathSync(await mkdtemp(join(tmpdir(), "utcc-pin-home-")));
}

const pinsOf = (home: string) => join(home, ".local", "state", "usertrust", "sessions");
const pinOf = (home: string, session = SESSION) => join(pinsOf(home), `${session}.json`);
const keyHashOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** A state dir, as a session that already ran under it leaves it: its transcript state made in 2020. */
async function usedStateDir(): Promise<string> {
	const dir = nodeFs.realpathSync(await mkdtemp(join(tmpdir(), "utcc-pin-used-")));
	await mkdir(join(dir, "transcripts"), { mode: 0o700 });
	await chmod(dir, 0o700);
	await writeFile(join(dir, "transcripts", "since"), "2020-01-01T00:00:00.000Z", { mode: 0o600 });
	return dir;
}

/** A config file under `home`'s anchor, 0600 in a 0700 anchor, holding `fields`. */
async function writeConfig(home: string, fields: Record<string, unknown>): Promise<string> {
	const anchor = join(home, ".config", "usertrust");
	await mkdir(anchor, { recursive: true });
	await chmod(anchor, 0o700);
	const path = join(anchor, "session.json");
	await writeFile(path, JSON.stringify(fields));
	await chmod(path, 0o600);
	return path;
}

// ── A recording usertrust server ──

interface Request {
	path: string;
	auth: string;
	body: Record<string, unknown>;
}

const servers: Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
});

/**
 * A usertrust server that records every request: each authorize a fresh hold
 * (`tx_<n>`), each settle and release a success. With `keyed`, it advertises and
 * honours idempotency keys: a key it has charged answers 409 `already_settled`.
 * Otherwise it advertises the bundled server's own list, which has no keys. With
 * `deny`, every authorize is refused for budget (402).
 */
async function recordingServer({ keyed = false, deny = false } = {}) {
	const requests: Request[] = [];
	const charged = new Set<string>();
	let next = 0;
	const capabilities = keyed
		? ["principal", "authorize-cache-tiers", "hold-expiry", "release", "idempotency-key"]
		: ["principal", "authorize-cache-tiers", "hold-expiry", "release"];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const path = req.url ?? "";
			const body = JSON.parse(raw || "{}") as Record<string, unknown>;
			requests.push({ path, auth: req.headers.authorization ?? "", body });
			let status = 200;
			let json: unknown = { settled: true, released: true, cost: 1, budgetRemaining: 9 };
			if (path === "/v1/health") json = { status: "ok", capabilities };
			else if (path === "/v1/authorize") {
				const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
				if (deny) {
					status = 402;
					json = { error: "budget_exceeded", reason: "over budget" };
				} else if (keyed && key !== undefined && charged.has(key)) {
					status = 409;
					json = { error: "already_settled", reason: "this key's charge already stands" };
				} else {
					next += 1;
					if (key !== undefined) charged.add(key);
					json = { transferId: `tx_${next}`, estimatedCost: 1, model: MODEL, createdAt: 1 };
				}
			}
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(json));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		posts: (path: string) => requests.filter((r) => r.path === path),
		/** Input and output tokens across every settle: what the ledger was charged. */
		charged: () =>
			requests
				.filter((r) => r.path === "/v1/settle")
				.reduce(
					(sum, r) => sum + Number(r.body.inputTokens ?? 0) + Number(r.body.outputTokens ?? 0),
					0,
				),
	};
}

// ── A transcript ──

/** The two entries one API response writes, a partial and the final one, written now. */
function responseEntries(id: string, input: number, output: number): string[] {
	const timestamp = new Date().toISOString();
	return [0, 1].map((final) =>
		JSON.stringify({
			type: "assistant",
			sessionId: SESSION,
			uuid: `${id}-${final ? "final" : "p0"}`,
			timestamp,
			message: {
				id,
				model: MODEL,
				role: "assistant",
				type: "message",
				stop_reason: final ? "end_turn" : null,
				content: [{ type: "text", text: "synthetic" }],
				usage: {
					input_tokens: input,
					output_tokens: final ? output : 1,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	);
}

async function transcriptFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "utcc-pin-project-"));
	const path = join(dir, `${SESSION}.jsonl`);
	await writeFile(
		path,
		`${JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: "x" } })}\n`,
	);
	return path;
}

const append = (path: string, lines: string[]) => appendFile(path, `${lines.join("\n")}\n`);

// ── One session, through the config file or the environment ──

interface Path {
	name: string;
	/** Start a session: its first state dir, the server, the key. */
	start(stateDir: string, url: string, key: string): Promise<void>;
	/** Change the state dir (the file's, or the environment's) the way a user would. */
	moveTo(stateDir: string): Promise<void>;
	/** Run a hook of the session as it stands. */
	run(name: string, payload: Record<string, unknown>): ReturnType<typeof runHook>;
	home: string;
}

/** A session through a config file: switches rewrite the file. */
async function configPath(): Promise<Path> {
	const home = await makeHome();
	let config = "";
	let fields: Record<string, unknown> = {};
	return {
		name: "the config file",
		home,
		async start(stateDir, url, key) {
			fields = { url, key, mode: "watch", stateDir };
			config = await writeConfig(home, fields);
		},
		async moveTo(stateDir) {
			fields = { ...fields, stateDir };
			config = await writeConfig(home, fields);
		},
		run: (name, payload) =>
			runHook(hook(name), payload, { TEST_PASSWD_HOME: home, UT_CC_CONFIG: config }),
	};
}

/** A session through the environment: switches change UT_CC_STATE_DIR. */
async function environmentPath(): Promise<Path> {
	const home = await makeHome();
	let env: Record<string, string> = {};
	return {
		name: "the environment",
		home,
		async start(stateDir, url, key) {
			env = { UT_CC_STATE_DIR: stateDir, UT_SERVER_URL: url, UT_SERVER_KEY: key };
		},
		async moveTo(stateDir) {
			env = { ...env, UT_CC_STATE_DIR: stateDir };
		},
		run: (name, payload) => runHook(hook(name), payload, { ...env, TEST_PASSWD_HOME: home }),
	};
}

const PATHS = [configPath, environmentPath];

/** The hold files in a state dir. */
async function holdFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((name) => /\.tx_\d+\.json$/.test(name)).sort();
	} catch {
		return [];
	}
}

async function watchRecords(dir: string): Promise<Array<Record<string, unknown>>> {
	try {
		return (await readFile(join(dir, "watch.jsonl"), "utf-8"))
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

describe("a session's settings are pinned at its first hook: a state dir that moves mid-session charges every message exactly once", () => {
	for (const make of PATHS) {
		const label = make === configPath ? "the config file" : "the environment";
		it(`through ${label}: a switch to a dir that already exists, to a fresh one, and back, charges the transcript ONCE (the r3 repro: 1 440 for 720 before pins)`, async () => {
			const session = await make();
			const server = await recordingServer();
			const [own, used] = [await mkdtemp(join(tmpdir(), "utcc-pin-own-")), await usedStateDir()];
			const fresh = await mkdtemp(join(tmpdir(), "utcc-pin-fresh-"));
			const transcript = await transcriptFile();
			const stop = () => session.run("stop", { session_id: SESSION, transcript_path: transcript });
			await session.start(own, server.url, "k");
			// The session's first hook makes its transcript state, before any response.
			expect((await stop()).code).toBe(0);
			await append(transcript, [
				...responseEntries("msg_a", 100, 20),
				...responseEntries("msg_b", 200, 40),
			]);
			await stop();
			expect(server.charged()).toBe(360);
			for (const dir of [used, fresh, own]) {
				await session.moveTo(dir);
				await stop();
			}
			await session.moveTo(used);
			await append(transcript, responseEntries("msg_c", 300, 60));
			await stop();
			await session.moveTo(own);
			await stop();
			// Every message once: 720 for the 720 the transcript holds.
			expect(server.charged()).toBe(720);
			expect(server.posts("/v1/settle")).toHaveLength(2);
			// The dirs it was moved to were never used: the pin kept the session in its own.
			expect(await readdir(join(used, "transcripts"))).toEqual(["since"]);
			expect(nodeFs.existsSync(join(fresh, "transcripts"))).toBe(false);
		});

		it(`through ${label}: with a server that honours keys, the same switch charges 360 for 360 (720 before pins)`, async () => {
			const session = await make();
			const server = await recordingServer({ keyed: true });
			const [own, used] = [await mkdtemp(join(tmpdir(), "utcc-pin-own-")), await usedStateDir()];
			const transcript = await transcriptFile();
			const stop = () => session.run("stop", { session_id: SESSION, transcript_path: transcript });
			await session.start(own, server.url, "k");
			await stop();
			await append(transcript, responseEntries("msg_a", 100, 20));
			await stop();
			await append(transcript, responseEntries("msg_b", 200, 40));
			await stop();
			// A new dir's remainder would carry [msg_a, msg_b]: a key the server never saw.
			await session.moveTo(used);
			await stop();
			expect(server.charged()).toBe(360);
			expect(server.posts("/v1/settle")).toHaveLength(2);
		});

		it(`through ${label}: a hold made before the switch settles from the session's own dir; a NEW session takes the new settings`, async () => {
			const session = await make();
			const server = await recordingServer();
			const [own, moved] = [
				await mkdtemp(join(tmpdir(), "utcc-pin-own-")),
				await mkdtemp(join(tmpdir(), "utcc-pin-moved-")),
			];
			await session.start(own, server.url, "k");
			const call = {
				session_id: SESSION,
				tool_name: "Bash",
				tool_use_id: "tu_1",
				tool_input: { command: "ls" },
			};
			expect((await session.run("pre-tool-use", call)).stderr).toContain("reserved tx_1");
			expect(await holdFiles(own)).toEqual([`${SESSION}__main__tu_1.tx_1.json`]);
			await session.moveTo(moved);
			const post = await session.run("post-tool-use", { ...call, tool_response: "ok" });
			expect(post.code).toBe(0);
			// Settled, from the dir the hold was made in: nothing moved, nothing lost.
			expect(server.posts("/v1/settle").map((r) => r.body.transferId)).toEqual(["tx_1"]);
			expect(await holdFiles(own)).toEqual([]);
			expect(await readdir(moved)).toEqual([]);
			// Control: a new session pins the settings as they now are.
			const next = { ...call, session_id: "sess-next", tool_use_id: "tu_2" };
			expect((await session.run("pre-tool-use", next)).stderr).toContain("reserved tx_2");
			expect(await holdFiles(moved)).toEqual(["sess-next__main__tu_2.tx_2.json"]);
		});

		it(`through ${label}: eight first hooks racing for one session make ONE pin, and all of them use it`, async () => {
			const session = await make();
			const server = await recordingServer();
			const dirs = await Promise.all(
				Array.from({ length: 8 }, () => mkdtemp(join(tmpdir(), "utcc-pin-race-"))),
			);
			await session.start(dirs[0] as string, server.url, "k");
			// Through the environment, each racer has a state dir of its own; through the
			// file, all of them read the one file. Either way, one pin.
			const racers = dirs.map(async (dir, i) => {
				if (make === environmentPath) {
					return runHook(
						hook("pre-tool-use"),
						{ session_id: "sess-race", tool_name: "Bash", tool_use_id: `tu_${i}`, tool_input: {} },
						{
							UT_CC_STATE_DIR: dir,
							UT_SERVER_URL: server.url,
							UT_SERVER_KEY: "k",
							UT_CC_USAGE: "estimate",
							TEST_PASSWD_HOME: session.home,
						},
					);
				}
				return session.run("pre-tool-use", {
					session_id: "sess-race",
					tool_name: "Bash",
					tool_use_id: `tu_${i}`,
					tool_input: {},
				});
			});
			const results = await Promise.all(racers);
			for (const result of results) expect(result.code, result.stderr).toBe(0);
			expect(
				(await readdir(pinsOf(session.home))).filter((n) => n.startsWith("sess-race")),
			).toEqual(["sess-race.json"]);
			const pinned = JSON.parse(await readFile(pinOf(session.home, "sess-race"), "utf-8")) as Pin;
			const holds = await Promise.all(dirs.map((dir) => holdFiles(dir)));
			// All eight holds in the pinned dir, and none anywhere else.
			const pinnedDir = pinned.settings.stateDir as string;
			expect(holds.flat()).toHaveLength(8);
			for (const [i, dir] of dirs.entries()) {
				expect(holds[i]?.length, dir).toBe(dir === pinnedDir ? 8 : 0);
			}
		});
	}
});

describe("an environment session's pin holds no key; a key changed mid-session is refused", () => {
	it("the pin stores the key's hash, never the key", async () => {
		const home = await makeHome();
		const server = await recordingServer();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-key-"));
		const key = "secret-env-key-1234567890";
		const env = {
			UT_CC_STATE_DIR: stateDir,
			UT_SERVER_URL: server.url,
			UT_SERVER_KEY: key,
			UT_CC_USAGE: "estimate",
			TEST_PASSWD_HOME: home,
		};
		const call = { session_id: SESSION, tool_name: "Bash", tool_use_id: "tu_1", tool_input: {} };
		expect((await runHook(hook("pre-tool-use"), call, env)).stderr).toContain("reserved tx_1");
		const text = await readFile(pinOf(home), "utf-8");
		expect(text).not.toContain(key);
		expect(JSON.parse(text)).toMatchObject({
			kind: "environment",
			settings: { keyHash: keyHashOf(key) },
		});
		expect((await stat(pinOf(home))).mode & 0o777).toBe(0o600);
		// A key changed mid-session is refused: nothing sent, the call recorded as a gap.
		const before = server.requests.length;
		const changed = await runHook(
			hook("pre-tool-use"),
			{ ...call, tool_use_id: "tu_2" },
			{ ...env, UT_SERVER_KEY: "another-key" },
		);
		expect(changed.code).toBe(0);
		expect(server.requests).toHaveLength(before);
		expect(await watchRecords(stateDir)).toMatchObject([
			{ kind: "gap", tool: "Bash", reason: "pin: key changed" },
		]);
		// Control: the pinned key, back again, sends.
		await runHook(hook("pre-tool-use"), { ...call, tool_use_id: "tu_3" }, env);
		expect(server.posts("/v1/authorize")).toHaveLength(2);
	});

	it("a configured session's pin holds the file's key, which is on disk already", async () => {
		const home = await makeHome();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-cfg-"));
		const config = await writeConfig(home, {
			url: "http://127.0.0.1:9",
			key: "file-key",
			mode: "watch",
			stateDir,
		});
		await runHook(
			hook("session-start"),
			{ session_id: SESSION },
			{ TEST_PASSWD_HOME: home, UT_CC_CONFIG: config },
		);
		expect(JSON.parse(await readFile(pinOf(home), "utf-8"))).toMatchObject({
			kind: "configured",
			settings: { key: "file-key", stateDir },
		});
	});
});

describe("a config refused, then fixed, mid-session: the refused hooks send nothing and are gaps; the fix pins once; nothing is charged twice", () => {
	it("refused, fixed, then charged once", async () => {
		const home = await makeHome();
		const server = await recordingServer();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-fix-"));
		const transcript = await transcriptFile();
		const config = await writeConfig(home, { url: server.url, key: "k", mode: "bogus", stateDir });
		const env = { TEST_PASSWD_HOME: home, UT_CC_CONFIG: config };
		const call = {
			session_id: SESSION,
			transcript_path: transcript,
			tool_name: "Bash",
			tool_use_id: "tu_1",
			tool_input: {},
		};
		// Refused: the response before the fix is a gap, never sent, and nothing is pinned.
		await append(transcript, responseEntries("msg_a", 100, 20));
		const refused = await runHook(hook("pre-tool-use"), call, env);
		expect(refused.code).toBe(0);
		expect(server.requests).toEqual([]);
		expect(await watchRecords(join(home, ".claude", "usertrust-cc"))).toMatchObject([
			{ kind: "gap", reason: 'config: field "mode" invalid' },
		]);
		expect(nodeFs.existsSync(pinOf(home))).toBe(false);
		// Fixed: the next hook pins the file as it now is, once.
		await writeConfig(home, { url: server.url, key: "k", mode: "watch", stateDir });
		await runHook(hook("stop"), { session_id: SESSION, transcript_path: transcript }, env);
		await append(transcript, responseEntries("msg_b", 200, 40));
		await runHook(hook("stop"), { session_id: SESSION, transcript_path: transcript }, env);
		await runHook(hook("stop"), { session_id: SESSION, transcript_path: transcript }, env);
		expect(await readdir(pinsOf(home))).toEqual([`${SESSION}.json`]);
		// msg_b once. msg_a, from before the session's state was made, stays a gap: at
		// most once means it is never posted at all, rather than posted twice.
		expect(server.charged()).toBe(240);
		expect(server.posts("/v1/settle")).toHaveLength(1);
	});
});

describe("a pin that cannot be used runs the hook refused: key-less, a gap, nothing sent", () => {
	const call = (session = SESSION) => ({
		session_id: session,
		tool_name: "Bash",
		tool_use_id: "tu_1",
		tool_input: {},
	});

	async function refusedRun(
		prepare: (home: string, stateDir: string) => Promise<void>,
		session = SESSION,
	) {
		const home = await makeHome();
		const server = await recordingServer();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-refuse-"));
		await prepare(home, stateDir);
		const result = await runHook(hook("pre-tool-use"), call(session), {
			UT_CC_STATE_DIR: stateDir,
			UT_SERVER_URL: server.url,
			UT_SERVER_KEY: "k",
			UT_CC_USAGE: "estimate",
			TEST_PASSWD_HOME: home,
		});
		expect(result.code).toBe(0);
		expect(server.requests).toEqual([]);
		return (await watchRecords(join(home, ".claude", "usertrust-cc")))[0]?.reason;
	}

	it("a session id that is not safe as a file name", async () => {
		for (const id of ["../x", "a/b", "", "x".repeat(129), "sess\u001b[2J"]) {
			expect(await refusedRun(async () => {}, id), JSON.stringify(id)).toBe(
				"pin: session id refused",
			);
		}
	});

	it("a sessions dir that is a symlink, or writable by its group, and a state dir that cannot take the pin either", async () => {
		// An environment session pins under its state dir when the passwd home cannot
		// (below): it is refused only when that fails too, and the reason names both.
		const groupWritable = async (dir: string) => chmod(dir, 0o770);
		expect(
			await refusedRun(async (home, stateDir) => {
				const elsewhere = await mkdtemp(join(tmpdir(), "utcc-pin-elsewhere-"));
				await mkdir(join(home, ".local", "state", "usertrust"), { recursive: true });
				await symlink(elsewhere, pinsOf(home));
				await groupWritable(stateDir);
			}),
		).toBe("pin: dir refused (symlink); pin: state dir refused (mode)");
		expect(
			await refusedRun(async (home, stateDir) => {
				await mkdir(pinsOf(home), { recursive: true });
				await groupWritable(pinsOf(home));
				await groupWritable(stateDir);
			}),
		).toBe("pin: dir refused (mode); pin: state dir refused (mode)");
	});

	it("a corrupt pin, one others can read, and one that is a link", async () => {
		expect(
			await refusedRun(async (home) => {
				await mkdir(pinsOf(home), { recursive: true, mode: 0o700 });
				await writeFile(pinOf(home), "{not a pin", { mode: 0o600 });
			}),
		).toBe("pin: corrupt");
		expect(
			await refusedRun(async (home) => {
				await mkdir(pinsOf(home), { recursive: true, mode: 0o700 });
				await writeFile(pinOf(home), "{}", { mode: 0o644 });
			}),
		).toBe("pin: unreadable");
		expect(
			await refusedRun(async (home) => {
				await mkdir(pinsOf(home), { recursive: true, mode: 0o700 });
				const real = join(pinsOf(home), "real.json");
				await writeFile(real, "{}", { mode: 0o600 });
				await symlink(real, pinOf(home));
			}),
		).toBe("pin: unreadable");
	});
});

describe("a session that cannot pin keeps its mode: enforce never silently stops enforcing", () => {
	const call = (tool_use_id = "tu_1") => ({
		session_id: SESSION,
		tool_name: "Bash",
		tool_use_id,
		tool_input: {},
	});
	/** An environment session in enforce mode, unless `more` says otherwise. */
	const enforce = (url: string, stateDir: string, more: Record<string, string> = {}) => ({
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_URL: url,
		UT_SERVER_KEY: "k",
		UT_CC_USAGE: "estimate",
		UT_CC_MODE: "enforce",
		...more,
	});
	/** The call's permission decision, or "(none)" when the hook printed none. */
	const decision = (stdout: string) =>
		stdout === ""
			? "(none)"
			: (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } })
					.hookSpecificOutput.permissionDecision;
	/** A HOME of the test's own: with no passwd home, a refused session's gaps go under it. */
	const scratchHome = () => mkdtemp(join(tmpdir(), "utcc-pin-HOME-"));
	const statePins = (stateDir: string) => join(nodeFs.realpathSync(stateDir), "sessions");

	for (const [what, place] of [
		["no passwd home at all", async () => ({ TEST_PASSWD_HOME: "", HOME: await scratchHome() })],
		[
			"a passwd home whose sessions dir its group can write",
			async () => {
				const home = await makeHome();
				await mkdir(pinsOf(home), { recursive: true });
				await chmod(pinsOf(home), 0o770);
				return { TEST_PASSWD_HOME: home };
			},
		],
	] as const) {
		it(`an environment session with ${what} pins under its state dir, and is enforced: a deny still blocks`, async () => {
			const server = await recordingServer({ deny: true });
			const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-fallback-"));
			const pre = await runHook(
				hook("pre-tool-use"),
				call(),
				enforce(server.url, stateDir, await place()),
			);
			// mutant: no state-dir pin, so refused: nothing sent, exit 2
			expect(server.posts("/v1/authorize")).toHaveLength(1);
			expect(pre.code).toBe(0);
			expect(decision(pre.stdout)).toBe("deny");
			const pin = join(statePins(stateDir), `${SESSION}.json`);
			expect(JSON.parse(await readFile(pin, "utf-8"))).toMatchObject({
				kind: "environment",
				settings: { mode: "enforce" },
			});
			expect((await stat(pin)).mode & 0o777).toBe(0o600);
		});
	}

	it("both places unusable: an enforce PreToolUse fails closed and sends nothing; with failOpen it proceeds, as a gap", async () => {
		const server = await recordingServer();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-nowhere-"));
		await chmod(stateDir, 0o770);
		const HOME = await scratchHome();
		const reason = "pin: dir refused (home); pin: state dir refused (mode)";
		const nowhere = { TEST_PASSWD_HOME: "", HOME };
		const strict = await runHook(
			hook("pre-tool-use"),
			call(),
			enforce(server.url, stateDir, nowhere),
		);
		// mutant: a session that cannot pin runs watch-only: exit 0, the call let through
		expect(strict.code).toBe(2);
		expect(strict.stderr).toContain(`failed closed: ${reason}`);
		const open = await runHook(
			hook("pre-tool-use"),
			call("tu_2"),
			enforce(server.url, stateDir, { ...nowhere, UT_FAIL_OPEN: "1" }),
		);
		expect(open.code).toBe(0);
		expect(server.requests).toEqual([]);
		expect(await watchRecords(join(HOME, ".claude", "usertrust-cc"))).toMatchObject([
			{ kind: "gap", tool: "Bash", reason },
		]);
	});

	it("a corrupt pin under enforce: PreToolUse fails closed, and sends nothing", async () => {
		const server = await recordingServer();
		const home = await makeHome();
		await mkdir(pinsOf(home), { recursive: true, mode: 0o700 });
		await writeFile(pinOf(home), "{not a pin", { mode: 0o600 });
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-corrupt-"));
		const pre = await runHook(
			hook("pre-tool-use"),
			call(),
			enforce(server.url, stateDir, { TEST_PASSWD_HOME: home }),
		);
		// mutant: a corrupt pin runs watch-only: exit 0
		expect(pre.code).toBe(2);
		expect(pre.stderr).toContain("failed closed: pin: corrupt");
		expect(server.requests).toEqual([]);
	});

	it("a key changed mid-session under enforce is blocked, in the PINNED mode", async () => {
		const server = await recordingServer();
		const home = await makeHome();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-key-enforce-"));
		const env = enforce(server.url, stateDir, { TEST_PASSWD_HOME: home });
		expect((await runHook(hook("pre-tool-use"), call(), env)).stderr).toContain("reserved tx_1");
		const before = server.requests.length;
		// The environment says watch now as well: the session's pin still says enforce.
		const changed = await runHook(hook("pre-tool-use"), call("tu_2"), {
			...env,
			UT_SERVER_KEY: "another-key",
			UT_CC_MODE: "watch",
		});
		// mutant: a changed key runs watch-only: exit 0
		expect(changed.code).toBe(2);
		expect(changed.stderr).toContain("failed closed: pin: key changed");
		expect(server.requests).toHaveLength(before);
	});

	it("SessionStart says why: ENFORCING with nothing sent, every call blocked, or with failOpen let through as gaps", async () => {
		const server = await recordingServer();
		const home = await makeHome();
		await mkdir(pinsOf(home), { recursive: true, mode: 0o700 });
		await writeFile(pinOf(home), "{not a pin", { mode: 0o600 });
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-announce-"));
		const start = async (more: Record<string, string> = {}) =>
			(
				JSON.parse(
					(
						await runHook(
							hook("session-start"),
							{ session_id: SESSION, source: "startup" },
							enforce(server.url, stateDir, { TEST_PASSWD_HOME: home, ...more }),
						)
					).stdout,
				) as { systemMessage: string }
			).systemMessage;
		const strict = await start();
		// mutant: a refused session announces itself watch-only
		expect(strict).toContain("usertrust: ENFORCING, but nothing can be sent");
		expect(strict).toContain("pin: corrupt");
		expect(strict).toContain("every tool call is blocked");
		expect(await start({ UT_FAIL_OPEN: "1" })).toContain("every tool call proceeds ungoverned");
	});

	it("a configured session never pins under its state dir: refused, it keeps the file's mode", async () => {
		const home = await makeHome();
		const server = await recordingServer();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-cfg-home-only-"));
		const config = await writeConfig(home, {
			url: server.url,
			key: "k",
			mode: "enforce",
			stateDir,
			usage: "estimate",
		});
		await mkdir(pinsOf(home), { recursive: true });
		await chmod(pinsOf(home), 0o770);
		const pre = await runHook(hook("pre-tool-use"), call(), {
			TEST_PASSWD_HOME: home,
			UT_CC_CONFIG: config,
		});
		// mutant: a configured session pins under its state dir as well, and sends
		expect(server.requests).toEqual([]);
		expect(pre.code).toBe(2);
		expect(pre.stderr).toContain("failed closed: pin: dir refused (mode)");
		expect(nodeFs.existsSync(join(stateDir, "sessions"))).toBe(false);
	});

	it("a refused config file names no mode: watch-only, whatever the environment says", async () => {
		const server = await recordingServer();
		const home = await makeHome();
		const pre = await runHook(hook("pre-tool-use"), call(), {
			TEST_PASSWD_HOME: home,
			UT_CC_CONFIG: "",
			UT_CC_MODE: "enforce",
			UT_SERVER_URL: server.url,
		});
		expect(pre.code).toBe(0);
		expect(server.requests).toEqual([]);
		expect(await watchRecords(join(home, ".claude", "usertrust-cc"))).toMatchObject([
			{ kind: "gap", reason: "config: empty" },
		]);
	});

	it("a pin already under the state dir is the session's, even once the passwd home could take one", async () => {
		const server = await recordingServer({ deny: true });
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-stays-"));
		const HOME = await scratchHome();
		await runHook(
			hook("pre-tool-use"),
			call(),
			enforce(server.url, stateDir, { TEST_PASSWD_HOME: "", HOME }),
		);
		expect(nodeFs.readdirSync(statePins(stateDir))).toEqual([`${SESSION}.json`]);
		// A passwd home appears, and the environment says watch now: the pin still decides.
		const home = await makeHome();
		const later = await runHook(
			hook("pre-tool-use"),
			call("tu_2"),
			enforce(server.url, stateDir, { TEST_PASSWD_HOME: home, UT_CC_MODE: "watch" }),
		);
		// mutant: the passwd home pins it again, from the settings now: watch, so no deny
		expect(decision(later.stdout)).toBe("deny");
		expect(nodeFs.existsSync(pinOf(home))).toBe(false);
	});

	it("SessionStart sweeps an environment session's state-dir pins too", async () => {
		const server = await recordingServer();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-sweep-start-"));
		const pins = join(nodeFs.realpathSync(stateDir), "sessions");
		await mkdir(pins, { mode: 0o700 });
		await writeFile(join(pins, "idle.json"), "{}", { mode: 0o600 });
		const old = new Date(Date.now() - 31 * 24 * 3600_000);
		await utimes(join(pins, "idle.json"), old, old);
		await runHook(
			hook("session-start"),
			{ session_id: SESSION, source: "startup" },
			enforce(server.url, stateDir, { TEST_PASSWD_HOME: "", HOME: await scratchHome() }),
		);
		// mutant: SessionStart sweeps the passwd home's pins only
		expect((await readdir(pins)).sort()).toEqual([`${SESSION}.json`]);
	});
});

describe("session.mjs, unit by unit", () => {
	const envSession = (stateDir: string, key = "k") => ({
		UT_CC_STATE_DIR: stateDir,
		UT_SERVER_URL: "http://127.0.0.1:9",
		UT_SERVER_KEY: key,
	});

	it("a foreign-owned sessions dir is refused (an owner the user is not), the state dir's too", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-owner-"));
		const fs = {
			...nodeFs,
			lstatSync: (path: string) => {
				const real = nodeFs.lstatSync(path);
				return Object.assign(
					Object.create(Object.getPrototypeOf(real) as object) as nodeFs.Stats,
					real,
					{
						uid: real.uid + 1,
					},
				);
			},
		};
		const { settings, kind } = sessionSettings({
			env: envSession(stateDir),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			fs,
		});
		expect(kind).toBeNull();
		expect(settings.refused).toBe("pin: dir refused (owner); pin: state dir refused (owner)");
	});

	it("no hard links: refused, never a pin written in two steps, in either place", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-nolink-"));
		const fs = {
			...nodeFs,
			linkSync: () => {
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			},
		};
		const { settings } = sessionSettings({
			env: envSession(stateDir),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			fs,
		});
		expect(settings.refused).toBe("pin: no hard links; pin: state dir has no hard links");
		expect(nodeFs.readdirSync(pinsOf(home))).toEqual([]);
		expect(nodeFs.readdirSync(join(nodeFs.realpathSync(stateDir), "sessions"))).toEqual([]);
	});

	it("a home the system reaches through a symlink is followed: the pin lives under its real path", async () => {
		const { sessionSettings } = await sessionModule();
		const real = await makeHome();
		const link = join(await mkdtemp(join(tmpdir(), "utcc-pin-link-")), "home");
		await symlink(real, link);
		const { settings, path } = sessionSettings({
			env: envSession("/tmp/x"),
			payload: { session_id: SESSION },
			passwdHome: link,
			uid: UID,
		});
		expect(settings.refused).toBeNull();
		expect(path).toBe(pinOf(real));
	});

	it("a refused config file is not pinned: the next hook resolves again", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const { settings, path } = sessionSettings({
			env: { UT_CC_CONFIG: "" },
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
		});
		expect(settings.refused).toBe("config: empty");
		expect(path).toBeNull();
		expect(nodeFs.readdirSync(pinsOf(home))).toEqual([]);
	});

	it("a pin deleted mid-session is made again from the settings then current", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const first = sessionSettings({
			env: envSession("/tmp/first"),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
		});
		expect(first.settings.stateDir).toBe("/tmp/first");
		// While pinned, a change is not seen.
		expect(
			sessionSettings({
				env: envSession("/tmp/second"),
				payload: { session_id: SESSION },
				passwdHome: home,
				uid: UID,
			}).settings.stateDir,
		).toBe("/tmp/first");
		nodeFs.unlinkSync(first.path as string);
		expect(
			sessionSettings({
				env: envSession("/tmp/second"),
				payload: { session_id: SESSION },
				passwdHome: home,
				uid: UID,
			}).settings.stateDir,
		).toBe("/tmp/second");
	});

	it("the sweep takes an environment session's state-dir pins too, only when given that dir", async () => {
		const { sweep } = await sessionModule();
		const home = await makeHome();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-sweep-state-"));
		const pins = join(nodeFs.realpathSync(stateDir), "sessions");
		await mkdir(pins, { mode: 0o700 });
		for (const name of ["idle.json", "fresh.json"]) {
			await writeFile(join(pins, name), "{}", { mode: 0o600 });
		}
		const now = Date.now();
		const old = new Date(now - 31 * 24 * 3600_000);
		await utimes(join(pins, "idle.json"), old, old);
		expect(sweep({ passwdHome: home, uid: UID, now })).toBe(0);
		// mutant: the state dir is never swept
		expect(sweep({ passwdHome: home, uid: UID, stateDir, now })).toBe(1);
		expect((await readdir(pins)).sort()).toEqual(["fresh.json"]);
	});

	it("the sweep removes pins idle past 30 days and a crashed publish's temp files, at most `limit`, and keeps the rest", async () => {
		const { sweep, touchPin, PIN_IDLE_MS } = await sessionModule();
		const home = await makeHome();
		await mkdir(pinsOf(home), { recursive: true, mode: 0o700 });
		const now = Date.now();
		const at = async (name: string, ageMs: number) => {
			const path = join(pinsOf(home), name);
			await writeFile(path, "{}", { mode: 0o600 });
			const then = new Date(now - ageMs);
			await utimes(path, then, then);
			return path;
		};
		await at("old.json", PIN_IDLE_MS + 60_000);
		const kept = await at("recent.json", PIN_IDLE_MS - 60_000);
		await at("old.json.123.0123456789ab.tmp", 2 * 60 * 60_000);
		await at("fresh.json.123.0123456789ab.tmp", 60_000);
		await at("not-a-pin.txt", PIN_IDLE_MS * 2);
		expect(sweep({ passwdHome: home, uid: UID, now })).toBe(2);
		expect((await readdir(pinsOf(home))).sort()).toEqual(
			["fresh.json.123.0123456789ab.tmp", "not-a-pin.txt", "recent.json"].sort(),
		);
		// Touched, a pin is kept past its age.
		const touched = await at("touched.json", PIN_IDLE_MS + 60_000);
		touchPin(touched, { now });
		await at("other-old.json", PIN_IDLE_MS + 60_000);
		await at("third-old.json", PIN_IDLE_MS + 60_000);
		expect(sweep({ passwdHome: home, uid: UID, now, limit: 1 })).toBe(1);
		expect(nodeFs.existsSync(touched)).toBe(true);
		expect(nodeFs.existsSync(kept)).toBe(true);
	});

	it("SessionStart sweeps; SessionEnd never does (a session can be resumed); a hook keeps its own session's pin in use", async () => {
		const home = await makeHome();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-sweep-"));
		await mkdir(pinsOf(home), { recursive: true, mode: 0o700 });
		const old = join(pinsOf(home), "old-session.json");
		await writeFile(old, "{}", { mode: 0o600 });
		const then = new Date(Date.now() - 31 * 24 * 60 * 60_000);
		await utimes(old, then, then);
		const env = {
			UT_CC_STATE_DIR: stateDir,
			UT_SERVER_URL: "http://127.0.0.1:9",
			UT_SERVER_KEY: "k",
			TEST_PASSWD_HOME: home,
		};
		await runHook(hook("session-end"), { session_id: "s-end", reason: "other" }, env);
		expect(nodeFs.existsSync(old)).toBe(true);
		// s-end's pin, idle for 31 days, then used again: its hook marks it in use.
		await utimes(pinOf(home, "s-end"), then, then);
		await runHook(hook("session-end"), { session_id: "s-end", reason: "other" }, env);
		await runHook(hook("session-start"), { session_id: "s-start" }, env);
		expect(nodeFs.existsSync(old)).toBe(false);
		expect(nodeFs.existsSync(pinOf(home, "s-end"))).toBe(true);
	});
});

describe("launch.mjs: a child that fails is the hook's outage, and nothing else", () => {
	it("the outcome of a failed child, in every mode", async () => {
		const { childOutcome } = await launchModule();
		const what = "signal SIGKILL";
		expect(
			childOutcome({ hook: "pre-tool-use", mode: "enforce", failOpen: false, what }),
		).toMatchObject({ exitCode: 2, gap: false });
		expect(
			childOutcome({ hook: "pre-tool-use", mode: "enforce", failOpen: true, what }),
		).toMatchObject({ exitCode: 0, gap: true });
		expect(
			childOutcome({ hook: "pre-tool-use", mode: "watch", failOpen: false, what }),
		).toMatchObject({ exitCode: 0, gap: true });
		for (const name of ["post-tool-use", "stop", "subagent-stop", "session-end"]) {
			for (const mode of ["watch", "enforce"]) {
				for (const failOpen of [false, true]) {
					expect(
						childOutcome({ hook: name, mode, failOpen, what }),
						`${name} ${mode} ${failOpen}`,
					).toMatchObject({
						exitCode: 0,
						gap: true,
						reason: "launch: the hook's process failed (signal SIGKILL)",
					});
				}
			}
		}
	});

	it("a child's start is its parent's, within the last minute", async () => {
		const { startedAt } = await launchModule();
		const now = 1_000_000_000;
		expect(startedAt(String(now - 250), now)).toBe(now - 250);
		expect(startedAt(String(now + 1), now)).toBe(now);
		expect(startedAt(String(now - 60_001), now)).toBe(now);
		expect(startedAt(undefined, now)).toBe(now);
		expect(startedAt("not a number", now)).toBe(now);
	});

	it("a child starts in /, with the child's environment and its parent's stdout and stderr", async () => {
		const { childOptions } = await launchModule();
		expect(
			childOptions({ HTTP_PROXY: "x", CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "3000" }),
		).toEqual({
			cwd: "/",
			env: { CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "3000", NODE_V8_COVERAGE: "" },
			stdio: ["pipe", "inherit", "inherit"],
		});
	});

	for (const [mode, expected] of [
		["watch", { code: 0, gap: true }],
		["enforce", { code: 2, gap: false }],
	] as const) {
		it(`a configured session whose child refuses to run (its pin gone): PreToolUse in ${mode} ${expected.code === 2 ? "fails closed" : "records a gap"}, and nothing is sent`, async () => {
			const home = await makeHome();
			const server = await recordingServer();
			const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-lost-"));
			const config = await writeConfig(home, {
				url: server.url,
				key: "k",
				mode,
				stateDir,
				usage: "estimate",
			});
			const call = { session_id: SESSION, tool_name: "Bash", tool_use_id: "tu_1", tool_input: {} };
			const began = Date.now();
			const pre = await runHook(
				hook("pre-tool-use"),
				call,
				{ TEST_PASSWD_HOME: home, UT_CC_CONFIG: config },
				["--import", LOSE_PIN],
			);
			expect(pre.code).toBe(expected.code);
			expect(server.requests).toEqual([]);
			const gaps = await watchRecords(stateDir);
			if (expected.gap) {
				expect(gaps).toMatchObject([
					{
						kind: "gap",
						phase: "pre-tool-use",
						tool: "Bash",
						reason: "launch: the hook's process failed (its child refused to run)",
					},
				]);
				// The call began when the hook did (its parent's start): known, so never null,
				// which would count the gap against every job.
				const { started, at } = gaps[0] as { started: unknown; at: string };
				expect(typeof started).toBe("string");
				expect(Date.parse(started as string)).toBeGreaterThanOrEqual(began);
				expect(Date.parse(started as string)).toBeLessThanOrEqual(Date.parse(at));
			} else {
				expect(gaps).toEqual([]);
				expect(pre.stderr).toContain("authorization failed closed");
			}
		});
	}

	it("a configured session's Stop whose child refuses to run records a gap, exit 0", async () => {
		const home = await makeHome();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-lost-"));
		const config = await writeConfig(home, {
			url: "http://127.0.0.1:9",
			key: "k",
			mode: "enforce",
			stateDir,
		});
		const stop = await runHook(
			hook("stop"),
			{ session_id: SESSION },
			{ TEST_PASSWD_HOME: home, UT_CC_CONFIG: config },
			["--import", LOSE_PIN],
		);
		expect(stop.code).toBe(0);
		expect(await watchRecords(stateDir)).toMatchObject([
			{
				kind: "gap",
				phase: "stop",
				reason: "launch: the hook's process failed (its child refused to run)",
				// What Stop settles began before it, at a time its parent never reads.
				started: null,
			},
		]);
	});

	/** A configured session's PreToolUse whose parent runs with `preload`, and what it left. */
	async function preToolUseWith(mode: string, preload: string, env: Record<string, string> = {}) {
		const home = await makeHome();
		const server = await recordingServer();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-launch-"));
		const config = await writeConfig(home, {
			url: server.url,
			key: "k",
			mode,
			stateDir,
			usage: "estimate",
		});
		const call = { session_id: SESSION, tool_name: "Bash", tool_use_id: "tu_1", tool_input: {} };
		const pre = await runHook(
			hook("pre-tool-use"),
			call,
			{ TEST_PASSWD_HOME: home, UT_CC_CONFIG: config, ...env },
			["--import", preload],
		);
		return { pre, sent: server.requests, gaps: await watchRecords(stateDir) };
	}

	// Exit 1 from a hook is a non-blocking error to Claude Code: the call RUNS, in enforce
	// mode ungoverned, and nothing records it. However the launcher fails, it ends as a
	// failed child does (`childOutcome`).
	for (const [failure, what] of [
		// A spawn short of descriptors: no stdin, and EMFILE only on a later tick.
		["emfile", "no process: EMFILE"],
		// A throw in the parent that nothing foresaw.
		["throw", "an unexpected TypeError"],
		// A throw in a callback, which no `catch` reaches.
		["uncaught", "an unexpected Error"],
	] as const) {
		for (const [mode, expected] of [
			["watch", { code: 0, gap: true }],
			["enforce", { code: 2, gap: false }],
		] as const) {
			it(`a launcher that fails (${failure}): PreToolUse in ${mode} ${expected.code === 2 ? "fails closed" : "records a gap"}, never exit 1, and nothing is sent`, async () => {
				const { pre, sent, gaps } = await preToolUseWith(mode, SPAWN_FAILS, {
					TEST_SPAWN_FAIL: failure,
				});
				const reason = `launch: the hook's process failed (${what})`;
				// mutant: no top-level catch: exit 1. mutant: stdin written at once: a TypeError, not EMFILE
				expect(pre.code).toBe(expected.code);
				expect(sent).toEqual([]);
				if (expected.gap) {
					expect(gaps).toMatchObject([
						{ kind: "gap", phase: "pre-tool-use", tool: "Bash", reason },
					]);
				} else {
					expect(gaps).toEqual([]);
					expect(pre.stderr).toContain(reason);
				}
			});
		}
	}

	it("Windows: configured sessions do not run there yet, and the refusal says so", async () => {
		// @ts-expect-error TS7016: config.mjs ships as plain .mjs, with no type declarations.
		const config = (await import("../hooks/config.mjs")) as {
			childUnsupported(platform?: string): string | null;
		};
		expect(config.childUnsupported("win32")).toBe("configured sessions do not run on Windows yet");
		for (const platform of ["darwin", "linux", "freebsd"]) {
			expect(config.childUnsupported(platform), platform).toBeNull();
		}
	});

	for (const [mode, expected] of [
		["watch", { code: 0, gap: true }],
		["enforce", { code: 2, gap: false }],
	] as const) {
		it(`Windows: a configured session's PreToolUse in ${mode} starts no child, sends nothing, and says why`, async () => {
			const { pre, sent, gaps } = await preToolUseWith(mode, WIN32);
			const reason =
				"launch: the hook's process failed (configured sessions do not run on Windows yet)";
			// mutant: the child is started there all the same, and sends
			expect(sent).toEqual([]);
			expect(pre.code).toBe(expected.code);
			if (expected.gap) {
				expect(gaps).toMatchObject([{ kind: "gap", phase: "pre-tool-use", reason }]);
			} else {
				expect(gaps).toEqual([]);
				expect(pre.stderr).toContain(reason);
			}
		});
	}
});

/** Wait until `ready` holds, for 15 s at most. */
async function until(ready: () => boolean): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!ready() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(ready()).toBe(true);
}

describe("a configured session sends from its child, whatever the parent's environment and options", () => {
	const call = (id: string) => ({
		session_id: SESSION,
		tool_name: "Bash",
		tool_use_id: id,
		tool_input: {},
	});

	async function configuredSession(server: { url: string }) {
		const home = await makeHome();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-pin-child-"));
		const config = await writeConfig(home, {
			url: server.url,
			key: "file-key",
			mode: "watch",
			stateDir,
			usage: "estimate",
		});
		return { home, stateDir, env: { TEST_PASSWD_HOME: home, UT_CC_CONFIG: config } };
	}

	it("its UT_CC_CONFIG gone mid-session, it keeps its pin, and still sends from its scrubbed child", async () => {
		const server = await recordingServer();
		const session = await configuredSession(server);
		await runHook(hook("pre-tool-use"), call("tu_1"), session.env);
		// The environment loses UT_CC_CONFIG, and gains variables the child must never see.
		const post = await runHook(
			hook("post-tool-use"),
			{ ...call("tu_1"), tool_response: "ok" },
			{
				TEST_PASSWD_HOME: session.home,
				NODE_DEBUG: "timer",
				UT_SERVER_URL: "http://127.0.0.1:9",
				UT_SERVER_KEY: "env-key",
			},
		);
		expect(post.code).toBe(0);
		expect(server.posts("/v1/settle").map((r) => r.auth)).toEqual(["Bearer file-key"]);
		expect([...post.stderr.matchAll(/^TIMER \d+:/gm)]).toEqual([]);
	});

	it("its node options reach its parent only, never its child", async () => {
		const server = await recordingServer();
		const session = await configuredSession(server);
		const pre = await runHook(hook("pre-tool-use"), call("tu_1"), session.env, [
			"--import",
			ANNOUNCE,
		]);
		expect(pre.code).toBe(0);
		expect(server.posts("/v1/authorize")).toHaveLength(1);
		expect([...pre.stderr.matchAll(/^preloaded in (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([
			pre.pid,
		]);
	});

	it("a pin is never seen half-written: a hook that reads it while the first is still publishing gets it whole", async () => {
		const home = await makeHome();
		const server = await recordingServer();
		const [first, second] = [
			await mkdtemp(join(tmpdir(), "utcc-pin-first-")),
			await mkdtemp(join(tmpdir(), "utcc-pin-second-")),
		];
		const control = await mkdtemp(join(tmpdir(), "utcc-pin-pause-"));
		const [paused, go] = [join(control, "paused"), join(control, "go")];
		const env = (stateDir: string) => ({
			UT_CC_STATE_DIR: stateDir,
			UT_SERVER_URL: server.url,
			UT_SERVER_KEY: "k",
			UT_CC_USAGE: "estimate",
			TEST_PASSWD_HOME: home,
		});
		// The first hook stops right after the pin first exists under its name.
		const firstHook = runHook(
			hook("pre-tool-use"),
			call("tu_1"),
			{ ...env(first), UT_CC_PAUSE_PIN: pinOf(home), UT_CC_PAUSED: paused, UT_CC_GO: go },
			["--import", PAUSE_AT_PIN],
		);
		await until(() => nodeFs.existsSync(paused));
		const secondHook = await runHook(hook("pre-tool-use"), call("tu_2"), env(second));
		await writeFile(go, "");
		const firstDone = await firstHook;
		// The second read the first one's pin, whole: its state dir, and nothing refused.
		expect(secondHook.code).toBe(0);
		expect(secondHook.stderr).toContain("reserved");
		expect(firstDone.code).toBe(0);
		expect(await holdFiles(first)).toHaveLength(2);
		expect(await holdFiles(second)).toEqual([]);
		expect(await watchRecords(join(home, ".claude", "usertrust-cc"))).toEqual([]);
	});
});
