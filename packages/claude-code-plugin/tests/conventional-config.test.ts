import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

// Where a session's settings come from (config.mjs `configSource`): UT_CC_CONFIG's file, else the
// CONVENTIONAL file <passwd home>/.config/usertrust/claude-code.json when anything is there, else
// the UT_* variables. And the one change a pin ever takes (session.mjs `deadPin`): at SessionStart,
// a DEAD environment pin is re-pinned to the conventional file; any other environment pin is kept,
// and SessionStart says, loudly, that the session is UNCONFIGURED.

const HOOKS = join(import.meta.dirname, "..", "hooks");
const hook = (name: string) => join(HOOKS, `${name}.mjs`);
const UID = process.getuid?.() ?? null;
const SESSION = "sess-conv";
const MODEL = "claude-sonnet-4-6";
const keyHashOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const EMPTY = keyHashOf("");

interface Settings {
	configured: boolean;
	refused: string | null;
	url: string | null;
	key: string;
	mode: string;
	stateDir: string;
	configSource?: string;
}

interface Pin {
	v: number;
	kind: string;
	createdAt: string;
	settings: Record<string, unknown>;
}

interface Session {
	settings: Settings;
	kind: string | null;
	path: string | null;
	note: string | null;
}

interface SessionModule {
	sessionSettings(input: {
		env: Record<string, string>;
		payload: unknown;
		passwdHome: string | null;
		uid: number | null;
		now?: number;
		repin?: boolean;
		fs?: typeof nodeFs;
	}): Session;
	movedNoMoney(stateDir: string, id: string, options: { uid: number | null }): string | null;
}

interface ConfigModule {
	resolveSettings(input: {
		env: Record<string, string>;
		passwdHome: string | null;
		uid: number | null;
	}): Settings;
	configSource(input: { env: Record<string, string>; passwdHome: string | null }): string;
	refusalNote(reason: string, source?: string): string;
	ignoredVariablesNote(env: Record<string, string>, current: Partial<Settings>): string | null;
}

async function sessionModule(): Promise<SessionModule> {
	// @ts-expect-error TS7016: session.mjs ships as plain .mjs, with no type declarations.
	return (await import("../hooks/session.mjs")) as SessionModule;
}

async function configModule(): Promise<ConfigModule> {
	// @ts-expect-error TS7016: config.mjs ships as plain .mjs, with no type declarations.
	return (await import("../hooks/config.mjs")) as ConfigModule;
}

async function makeHome(): Promise<string> {
	return nodeFs.realpathSync(await mkdtemp(join(tmpdir(), "utcc-conv-home-")));
}

async function makeDir(prefix: string): Promise<string> {
	const dir = nodeFs.realpathSync(await mkdtemp(join(tmpdir(), prefix)));
	await chmod(dir, 0o700);
	return dir;
}

const anchorOf = (home: string) => join(home, ".config", "usertrust");
const conventionalOf = (home: string) => join(anchorOf(home), "claude-code.json");
const pinOf = (home: string, session = SESSION) =>
	join(home, ".local", "state", "usertrust", "sessions", `${session}.json`);
const recordsOf = (home: string) =>
	join(home, ".local", "state", "usertrust", "repins", "repins.jsonl");
const PINS = (home: string) => join(home, ".local", "state", "usertrust", "sessions");

/** The conventional config file under `home`, 0600 in a 0700 anchor, holding `fields`. */
async function writeConventional(home: string, fields: Record<string, unknown>): Promise<string> {
	await mkdir(anchorOf(home), { recursive: true });
	await chmod(anchorOf(home), 0o700);
	const path = conventionalOf(home);
	await writeFile(path, JSON.stringify(fields));
	await chmod(path, 0o600);
	return path;
}

/** A v2 cursor (transcript.mjs `writeCursor`), with no id in it, then `more`. */
function cursor(more: Record<string, unknown> = {}): string {
	return JSON.stringify({
		v: 2,
		byteOffset: 0,
		nextSeq: 0,
		partial: {},
		accounted: [],
		posted: [],
		denied: [],
		assigned: {},
		estimateMode: false,
		estimateReason: null,
		lastModel: null,
		unresolved: {},
		preMetering: { ids: [], responses: 0, recorded: 0 },
		...more,
	});
}

/** An old, unconfigured state dir as the real one was found: empty cursors, gaps only, a health answer. */
async function oldStateDir(session = SESSION): Promise<string> {
	const dir = await makeDir("utcc-conv-old-");
	await mkdir(join(dir, "transcripts"), { mode: 0o700 });
	await mkdir(join(dir, "capabilities"), { mode: 0o700 });
	await writeFile(join(dir, "capabilities", "350fb5f079edf41b-e3b0c44298fc1c14.json"), "{}", {
		mode: 0o600,
	});
	await writeFile(join(dir, "transcripts", `${session}__main.json`), cursor(), { mode: 0o600 });
	await writeFile(join(dir, "transcripts", `${session}__a00c63d53da08671f.json`), cursor(), {
		mode: 0o600,
	});
	const gap = {
		at: "2026-11-07T23:52:42.882Z",
		kind: "gap",
		mode: "watch",
		session,
		agent: "main",
	};
	await writeFile(
		join(dir, "watch.jsonl"),
		`${JSON.stringify(gap)}\n${JSON.stringify({ ...gap, kind: "pre-metering" })}\n`,
		{ mode: 0o600 },
	);
	return dir;
}

/** Every file under `dir`, with its content: what "left exactly as it was" compares. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (at: string) => {
		for (const entry of nodeFs.readdirSync(at, { withFileTypes: true })) {
			const path = join(at, entry.name);
			if (entry.isDirectory()) walk(path);
			else out[path.slice(dir.length)] = nodeFs.readFileSync(path, "utf-8");
		}
	};
	walk(dir);
	return out;
}

/** The environment an unconfigured session started with: no key, a server that never answered. */
const unconfigured = (stateDir: string): Record<string, string> => ({
	UT_CC_STATE_DIR: stateDir,
	UT_SERVER_URL: "http://127.0.0.1:9",
});

/** Pin SESSION from `env` under `home`, as its first hook did before the conventional file existed. */
async function pinFromEnvironment(home: string, env: Record<string, string>): Promise<Pin> {
	const { sessionSettings } = await sessionModule();
	const first = sessionSettings({
		env,
		payload: { session_id: SESSION },
		passwdHome: home,
		uid: UID,
	});
	expect(first.kind).toBe("environment");
	return JSON.parse(await readFile(pinOf(home), "utf-8")) as Pin;
}

/** Why a dead pin is kept when the conventional file names the state dir it was pinned with. */
const SAME_DIR =
	"the conventional file names the state dir it was pinned with, where the usage recorded before the re-pin would be posted under the new key";

const FILE = (stateDir: string) => ({
	url: "http://127.0.0.1:4520",
	key: "file-key-0123",
	mode: "watch",
	stateDir,
});

// ── (c): where settings come from ──

describe("config.mjs: UT_CC_CONFIG's file, else the conventional file, else the UT_* variables", () => {
	it("the conventional file is read when UT_CC_CONFIG is unset, and every UT_* variable is ignored", async () => {
		const { resolveSettings, configSource } = await configModule();
		const home = await makeHome();
		const state = await makeDir("utcc-conv-state-");
		await writeConventional(home, FILE(state));
		const env = {
			UT_SERVER_URL: "http://evil.example",
			UT_CC_MODE: "enforce",
			UT_SERVER_KEY: "env",
		};
		expect(configSource({ env, passwdHome: home })).toBe("conventional");
		const settings = resolveSettings({ env, passwdHome: home, uid: UID });
		// mutant: no conventional branch → the environment's url, mode and key
		expect(settings).toMatchObject({
			configured: true,
			refused: null,
			url: "http://127.0.0.1:4520",
			key: "file-key-0123",
			mode: "watch",
			stateDir: state,
			configSource: "conventional",
		});
	});

	it("no conventional file: the UT_* variables, as before", async () => {
		const { resolveSettings, configSource } = await configModule();
		const home = await makeHome();
		const env = { UT_SERVER_URL: "http://127.0.0.1:7", UT_SERVER_KEY: "env" };
		expect(configSource({ env, passwdHome: home })).toBe("environment");
		expect(resolveSettings({ env, passwdHome: home, uid: UID })).toMatchObject({
			configured: false,
			url: "http://127.0.0.1:7",
			key: "env",
		});
	});

	it("~/.config/usertrust that is a file (ENOTDIR) is no conventional file", async () => {
		const { configSource } = await configModule();
		const home = await makeHome();
		await mkdir(join(home, ".config"), { recursive: true });
		await writeFile(anchorOf(home), "not a dir");
		expect(configSource({ env: {}, passwdHome: home })).toBe("environment");
	});

	it("UT_CC_CONFIG wins over the conventional file", async () => {
		const { resolveSettings } = await configModule();
		const home = await makeHome();
		await writeConventional(home, FILE(await makeDir("utcc-conv-state-")));
		const named = join(anchorOf(home), "other.json");
		await writeFile(named, JSON.stringify({ ...FILE("/named/state"), key: "named-key" }));
		await chmod(named, 0o600);
		const settings = resolveSettings({ env: { UT_CC_CONFIG: named }, passwdHome: home, uid: UID });
		expect(settings).toMatchObject({ key: "named-key", configSource: "variable" });
	});

	it("a conventional file that fails its checks is REFUSED while UT_* are set: key-less, never the UT_* in its place", async () => {
		const { resolveSettings, refusalNote } = await configModule();
		const home = await makeHome();
		const path = await writeConventional(home, FILE(await makeDir("utcc-conv-state-")));
		await chmod(path, 0o644);
		const env = { UT_SERVER_URL: "http://127.0.0.1:7", UT_SERVER_KEY: "env" };
		const settings = resolveSettings({ env, passwdHome: home, uid: UID });
		// mutant: a refused conventional file falls back to the environment
		expect(settings).toMatchObject({
			configured: true,
			refused: "config: file refused (mode)",
			url: null,
			key: "",
			configSource: "conventional",
		});
		expect(refusalNote(settings.refused as string, settings.configSource)).toBe(
			"the config file ~/.config/usertrust/claude-code.json was refused (config: file refused (mode)); the UT_* variables are never used in its place",
		);
	});

	it("a dangling link at the conventional path is refused, never taken for no file", async () => {
		const { resolveSettings } = await configModule();
		const home = await makeHome();
		await mkdir(anchorOf(home), { recursive: true });
		await chmod(anchorOf(home), 0o700);
		nodeFs.symlinkSync(join(home, "nowhere.json"), conventionalOf(home));
		const settings = resolveSettings({ env: { UT_SERVER_KEY: "env" }, passwdHome: home, uid: UID });
		expect(settings.configured).toBe(true);
		expect(settings.refused).not.toBeNull();
		expect(settings.key).toBe("");
	});

	it("the ignored-variables note names the file that won and the UT_* names it ignored, never a value", async () => {
		const { ignoredVariablesNote } = await configModule();
		const env = { UT_SERVER_URL: "http://secret.example", UT_CC_MODE: "enforce", OTHER: "x" };
		const conventional = ignoredVariablesNote(env, {
			configured: true,
			configSource: "conventional",
		});
		expect(conventional).toBe(
			"usertrust: this session's settings come from ~/.config/usertrust/claude-code.json (UT_CC_CONFIG is unset); UT_SERVER_URL, UT_CC_MODE are set in the environment and IGNORED.",
		);
		expect(conventional).not.toContain("secret.example");
		expect(ignoredVariablesNote(env, { configured: true, configSource: "variable" })).toContain(
			"the config file UT_CC_CONFIG names",
		);
		expect(ignoredVariablesNote({ OTHER: "x" }, { configured: true })).toBeNull();
		expect(ignoredVariablesNote(env, { configured: false })).toBeNull();
	});
});

// ── The dead-pin re-pin ──

describe("session.mjs: SessionStart re-pins a DEAD environment pin to the conventional file, and only a dead one", () => {
	it("POSITIVE CONTROL: the empty key, no money moved, the file accepted: re-pinned, recorded, said, the old dir untouched", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const old = await oldStateDir();
		const before = await pinFromEnvironment(home, unconfigured(old));
		expect(before.settings.keyHash).toBe(EMPTY);
		const fresh = await makeDir("utcc-conv-new-");
		await writeConventional(home, FILE(fresh));
		const untouched = snapshot(old);
		const now = Date.parse("2026-11-08T03:00:00.000Z");
		const session = sessionSettings({
			env: unconfigured(old),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			now,
			repin: true,
		});
		expect(session.kind).toBe("configured");
		expect(session.settings).toMatchObject({ url: "http://127.0.0.1:4520", stateDir: fresh });
		expect(session.note).toContain(
			"this session was RE-PINNED to ~/.config/usertrust/claude-code.json",
		);
		expect(session.note).toContain(before.createdAt);
		const after = JSON.parse(await readFile(pinOf(home), "utf-8")) as Pin;
		expect(after).toMatchObject({ kind: "configured", settings: { configSource: "conventional" } });
		// The old pin moved aside, never deleted; the old state dir exactly as it was.
		const aside = (await readdir(join(home, ".local", "state", "usertrust", "sessions"))).filter(
			(n) => n.startsWith(`${SESSION}.json.repinned.${now}.`),
		);
		expect(aside).toHaveLength(1);
		expect(snapshot(old)).toEqual(untouched);
		// The record: old pin, new pin with its key HASHED, the reason; one line, appended.
		const text = await readFile(recordsOf(home), "utf-8");
		expect(text).not.toContain("file-key-0123");
		const lines = text.split("\n").filter((l) => l !== "");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0] as string) as {
			session: string;
			reason: string;
			old: { kind: string; settings: Record<string, unknown>; movedTo: string };
			new: { kind: string; settings: Record<string, unknown> };
		};
		expect(record.session).toBe(SESSION);
		expect(record.reason).toContain("dead environment pin");
		expect(record.old.kind).toBe("environment");
		expect(record.old.settings.keyHash).toBe(EMPTY);
		expect(record.new.kind).toBe("configured");
		expect(record.new.settings.keyHash).toBe(keyHashOf("file-key-0123"));
		expect(record.new.settings.key).toBeUndefined();
		expect(record.old.movedTo).toBe(
			join(home, ".local", "state", "usertrust", "sessions", aside[0] as string),
		);
		expect(nodeFs.statSync(recordsOf(home)).mode & 0o777).toBe(0o600);
		// Said once: the next SessionStart finds a configured pin, and says nothing.
		const again = sessionSettings({
			env: unconfigured(old),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			repin: true,
		});
		expect(again).toMatchObject({ kind: "configured", note: null });
	});

	it("a health answer (capabilities/) moves no money: the pin is still dead", async () => {
		// The positive control's old dir holds one; this asserts the rule by name, so a "fix" that
		// counts capabilities goes red here.
		const { movedNoMoney } = await sessionModule();
		const old = await oldStateDir();
		expect(nodeFs.existsSync(join(old, "capabilities"))).toBe(true);
		expect(movedNoMoney(old, SESSION, { uid: UID })).toBeNull();
	});

	it("only SessionStart re-pins: any other hook uses the dead pin as it is", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const old = await oldStateDir();
		await pinFromEnvironment(home, unconfigured(old));
		await writeConventional(home, FILE(await makeDir("utcc-conv-new-")));
		const session = sessionSettings({
			env: unconfigured(old),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
		});
		// mutant: re-pin on every hook
		expect(session).toMatchObject({ kind: "environment", note: null });
		expect(nodeFs.existsSync(recordsOf(home))).toBe(false);
	});

	/** Each clause failing ALONE keeps the pin, and (but for no config file) warns UNCONFIGURED. */
	const KEPT: Array<{
		name: string;
		env?: (old: string) => Record<string, string>;
		spoil?: (old: string, home: string) => Promise<void>;
		why: string;
		warns?: boolean;
	}> = [
		{
			name: "(1) it was pinned with a key",
			env: (old) => ({ ...unconfigured(old), UT_SERVER_KEY: "env-key" }),
			why: "it was pinned with a key",
		},
		{
			name: "(2) a hold of the session at the top level (a reserve the server accepted)",
			spoil: (old) =>
				writeFile(join(old, `${SESSION}__main__tu_1.tx_1.json`), "{}", { mode: 0o600 }),
			why: "its state dir holds a hold of it",
		},
		{
			name: "(2) a .settling hold of the session",
			spoil: (old) =>
				writeFile(join(old, `${SESSION}__main__tu_1.tx_1.json.settling`), "{}", { mode: 0o600 }),
			why: "its state dir holds a hold of it",
		},
		{
			name: "(2) a cursor with a POSTED id",
			spoil: (old) =>
				writeFile(join(old, "transcripts", `${SESSION}__main.json`), cursor({ posted: ["msg_1"] })),
			why: "its cursors record usage that may have been posted",
		},
		{
			name: "(2) a cursor with an ACCOUNTED id (a settle never seen to end: it may have posted)",
			spoil: (old) =>
				writeFile(
					join(old, "transcripts", `${SESSION}__main.json`),
					cursor({ accounted: ["msg_1"] }),
				),
			why: "its cursors record usage that may have been posted",
		},
		{
			name: "(2) a cursor with an UNRESOLVED settle",
			spoil: (old) =>
				writeFile(
					join(old, "transcripts", `${SESSION}__main.json`),
					cursor({ unresolved: { k: { ids: ["msg_1"] } } }),
				),
			why: "its cursors record usage that may have been posted",
		},
		{
			name: "(2) a cursor with an id ASSIGNED to a hold",
			spoil: (old) =>
				writeFile(
					join(old, "transcripts", `${SESSION}__main.json`),
					cursor({ assigned: { msg_1: "tu_1" } }),
				),
			why: "its cursors record usage that may have been posted",
		},
		{
			name: "(2) a cursor of a shape not known here (v1)",
			spoil: (old) =>
				writeFile(join(old, "transcripts", `${SESSION}__main.json`), cursor({ v: 1 })),
			why: "its cursors record usage that may have been posted",
		},
		{
			name: "(2) a cursor that cannot be read",
			spoil: (old) => chmod(join(old, "transcripts", `${SESSION}__main.json`), 0o000),
			why: "its cursors record usage that may have been posted",
		},
		{
			name: "(2) a watch record of a server's answer (would_block)",
			spoil: (old) =>
				appendFile(
					join(old, "watch.jsonl"),
					`${JSON.stringify({ kind: "would_block", session: SESSION, status: 402 })}\n`,
				),
			why: "a server answered it",
		},
		{
			name: "(2) a state dir that cannot be read",
			spoil: async (old) => {
				await chmod(old, 0o000);
			},
			why: "its state dir is unreadable",
		},
		{
			name: "(4) the conventional file names the SAME state dir (the README's default layout)",
			spoil: async (old, home) => {
				await writeConventional(home, FILE(old));
			},
			why: SAME_DIR,
		},
		{
			name: "(4) the conventional file names a link to the same state dir",
			spoil: async (old, home) => {
				const link = join(await makeDir("utcc-conv-link-"), "state");
				nodeFs.symlinkSync(old, link);
				await writeConventional(home, FILE(link));
			},
			why: SAME_DIR,
		},
		{
			name: "(3) the conventional file refused",
			spoil: async (_old, home) => chmod(conventionalOf(home), 0o644),
			why: "the config file ~/.config/usertrust/claude-code.json was refused (config: file refused (mode)); the UT_* variables are never used in its place",
		},
		{
			name: "(3) no conventional file",
			spoil: async (_old, home) => {
				nodeFs.renameSync(conventionalOf(home), `${conventionalOf(home)}.away`);
			},
			why: "",
			warns: false,
		},
	];

	for (const row of KEPT) {
		it(`kept: ${row.name}`, async () => {
			const { sessionSettings } = await sessionModule();
			const home = await makeHome();
			const old = await oldStateDir();
			const env = (row.env ?? unconfigured)(old);
			await pinFromEnvironment(home, env);
			await writeConventional(home, FILE(await makeDir("utcc-conv-new-")));
			await row.spoil?.(old, home);
			let session: Session;
			try {
				session = sessionSettings({
					env,
					payload: { session_id: SESSION },
					passwdHome: home,
					uid: UID,
					repin: true,
				});
			} finally {
				await chmod(old, 0o700);
				const main = join(old, "transcripts", `${SESSION}__main.json`);
				if (nodeFs.existsSync(main)) await chmod(main, 0o600);
			}
			expect(session.kind).toBe("environment");
			expect(nodeFs.existsSync(recordsOf(home))).toBe(false);
			expect((JSON.parse(await readFile(pinOf(home), "utf-8")) as Pin).kind).toBe("environment");
			if (row.warns === false) {
				expect(session.note).toBeNull();
			} else {
				expect(session.note).toContain("usertrust: WARNING: this session is UNCONFIGURED.");
				expect(session.note).toContain(`It is not re-pinned: ${row.why}.`);
			}
		});
	}

	it("kept: (2) UT_CC_CONFIG names an accepted file now, with a state dir of its own: no re-pin, for it is not the conventional file", async () => {
		// The KEPT rows' "no conventional file" leaves the pin's own state dir as the resolved one,
		// which clause (4) refuses too; this row resolves elsewhere, so only clause (2) keeps it.
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const old = await oldStateDir();
		await pinFromEnvironment(home, unconfigured(old));
		await writeConventional(home, FILE(await makeDir("utcc-conv-new-")));
		const named = join(anchorOf(home), "other.json");
		await writeFile(named, JSON.stringify(FILE(await makeDir("utcc-conv-named-"))));
		await chmod(named, 0o600);
		const session = sessionSettings({
			env: { ...unconfigured(old), UT_CC_CONFIG: named },
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			repin: true,
		});
		// mutant: any accepted source re-pins
		expect(session.kind).toBe("environment");
		expect(nodeFs.existsSync(recordsOf(home))).toBe(false);
		expect((JSON.parse(await readFile(pinOf(home), "utf-8")) as Pin).kind).toBe("environment");
		expect(session.note).toContain(
			"It is not re-pinned: ~/.config/usertrust/claude-code.json is not where a new session's settings come from.",
		);
	});

	it("a session whose sibling moved money is still dead: the rule is read for THIS session only", async () => {
		const { movedNoMoney } = await sessionModule();
		const old = await oldStateDir();
		await writeFile(join(old, "sess-other__main__tu_1.tx_1.json"), "{}", { mode: 0o600 });
		await writeFile(join(old, "transcripts", "sess-other__main.json"), cursor({ posted: ["m"] }));
		await appendFile(
			join(old, "watch.jsonl"),
			`${JSON.stringify({ kind: "would_block", session: "sess-other" })}\n`,
		);
		expect(movedNoMoney(old, SESSION, { uid: UID })).toBeNull();
		expect(movedNoMoney(old, "sess-other", { uid: UID })).not.toBeNull();
	});

	it("no record, no re-pin: an unwritable record keeps the old pin, and says so", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const old = await oldStateDir();
		await pinFromEnvironment(home, unconfigured(old));
		await writeConventional(home, FILE(await makeDir("utcc-conv-new-")));
		// The record's directory is a file: nothing can be appended under it.
		await writeFile(join(home, ".local", "state", "usertrust", "repins"), "", { mode: 0o600 });
		const session = sessionSettings({
			env: unconfigured(old),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			repin: true,
		});
		// mutant: publish the new pin whether or not the record was written
		expect(session.kind).toBe("environment");
		expect(session.note).toMatch(
			/^usertrust: WARNING: this session is UNCONFIGURED, and could not/,
		);
		expect(session.note).toContain("the re-pin record could not be written");
		expect((JSON.parse(await readFile(pinOf(home), "utf-8")) as Pin).kind).toBe("environment");
		// The record comes first: the old pin was never touched, not even kept aside.
		expect((await readdir(PINS(home))).filter((n) => n.includes(".repinned."))).toEqual([]);
	});

	/** A job log of the session: its session-start, and a job still open. */
	const JOB_LOG = [
		{ sid: SESSION, ts: "2026-11-07T23:50:00.000Z", op: "session-start", job: null },
		{ sid: SESSION, ts: "2026-11-07T23:51:00.000Z", op: "start", job: "job-1" },
	]
		.map((line) => `${JSON.stringify(line)}\n`)
		.join("");

	/** A dead pin whose old state dir holds `JOB_LOG`, and the conventional file naming `fresh`. */
	async function deadWithJobLog(home: string, fresh: string): Promise<string> {
		const old = await oldStateDir();
		await pinFromEnvironment(home, unconfigured(old));
		await mkdir(join(old, "jobs"), { mode: 0o700 });
		await writeFile(join(old, "jobs", `${SESSION}.jsonl`), JOB_LOG, { mode: 0o600 });
		await writeConventional(home, FILE(fresh));
		return old;
	}

	it("the job log is carried to the new state dir byte for byte, its open job with it; the old one is only read", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const fresh = await makeDir("utcc-conv-new-");
		const old = await deadWithJobLog(home, fresh);
		const untouched = snapshot(old);
		const session = sessionSettings({
			env: unconfigured(old),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			repin: true,
		});
		expect(session.kind).toBe("configured");
		// mutant: no carry → usertrust-job finds no log in the new dir, and job-1 loses its attribution
		const carried = join(fresh, "jobs", `${SESSION}.jsonl`);
		expect(await readFile(carried, "utf-8")).toBe(JOB_LOG);
		expect(nodeFs.statSync(carried).mode & 0o777).toBe(0o600);
		expect(snapshot(old)).toEqual(untouched);
	});

	it("an earlier carry, a beginning of the log, is brought up to date", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const fresh = await makeDir("utcc-conv-new-");
		const old = await deadWithJobLog(home, fresh);
		await mkdir(join(fresh, "jobs"), { mode: 0o700 });
		const first = `${JOB_LOG.split("\n")[0]}\n`;
		await writeFile(join(fresh, "jobs", `${SESSION}.jsonl`), first, { mode: 0o600 });
		const session = sessionSettings({
			env: unconfigured(old),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			repin: true,
		});
		expect(session.kind).toBe("configured");
		expect(await readFile(join(fresh, "jobs", `${SESSION}.jsonl`), "utf-8")).toBe(JOB_LOG);
	});

	it("another job log of the session already in the new state dir refuses the re-pin, before any record", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const fresh = await makeDir("utcc-conv-new-");
		const old = await deadWithJobLog(home, fresh);
		await mkdir(join(fresh, "jobs"), { mode: 0o700 });
		const other = `${JSON.stringify({ sid: SESSION, op: "session-start", job: null })}\n`;
		await writeFile(join(fresh, "jobs", `${SESSION}.jsonl`), other, { mode: 0o600 });
		const session = sessionSettings({
			env: unconfigured(old),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			repin: true,
		});
		// mutant: overwrite the log that is there
		expect(session.kind).toBe("environment");
		expect(session.note).toContain(
			"could not be re-pinned to ~/.config/usertrust/claude-code.json: the new state dir already holds another job log of this session.",
		);
		expect(await readFile(join(fresh, "jobs", `${SESSION}.jsonl`), "utf-8")).toBe(other);
		expect(nodeFs.existsSync(recordsOf(home))).toBe(false);
		expect((JSON.parse(await readFile(pinOf(home), "utf-8")) as Pin).kind).toBe("environment");
	});

	it("a hook that runs inside the re-pin reads the OLD pin, never none: the record is written before the pin is touched", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const old = await oldStateDir();
		await pinFromEnvironment(home, unconfigured(old));
		await writeConventional(home, FILE(await makeDir("utcc-conv-new-")));
		let recordFd: number | undefined;
		let inside: Session | undefined;
		// The other hook runs at the record's fsync: after the record is written, before it returns.
		const fs = {
			...nodeFs,
			openSync: (
				path: nodeFs.PathLike,
				flags: nodeFs.OpenMode = "r",
				mode?: nodeFs.Mode | null,
			) => {
				const fd = nodeFs.openSync(path, flags, mode);
				if (String(path).endsWith("repins.jsonl")) recordFd = fd;
				return fd;
			},
			fsyncSync: (fd: number) => {
				nodeFs.fsyncSync(fd);
				if (fd !== recordFd || inside !== undefined) return;
				inside = sessionSettings({
					env: unconfigured(old),
					payload: { session_id: SESSION },
					passwdHome: home,
					uid: UID,
				});
			},
		} as typeof nodeFs;
		const session = sessionSettings({
			env: unconfigured(old),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			repin: true,
			fs,
		});
		// mutant: move the old pin aside before the record → the hook inside finds none, and pins anew
		expect(inside).toMatchObject({ kind: "environment" });
		expect(session.kind).toBe("configured");
		expect(session.note).toContain("this session was RE-PINNED");
		const lines = (await readFile(recordsOf(home), "utf-8")).split("\n").filter((l) => l !== "");
		expect(lines).toHaveLength(1);
	});

	it("a swap that fails after its record: the old pin stays, an abandoned record names the first, and SessionStart says UNCONFIGURED", async () => {
		const { sessionSettings } = await sessionModule();
		const home = await makeHome();
		const old = await oldStateDir();
		await pinFromEnvironment(home, unconfigured(old));
		await writeConventional(home, FILE(await makeDir("utcc-conv-new-")));
		const fs = {
			...nodeFs,
			renameSync: (from: nodeFs.PathLike, to: nodeFs.PathLike) => {
				if (String(to) === pinOf(home)) {
					throw Object.assign(new Error("injected"), { code: "EIO" });
				}
				nodeFs.renameSync(from, to);
			},
		} as typeof nodeFs;
		const session = sessionSettings({
			env: unconfigured(old),
			payload: { session_id: SESSION },
			passwdHome: home,
			uid: UID,
			repin: true,
			fs,
		});
		expect(session.kind).toBe("environment");
		expect(session.note).toContain(
			"could not be re-pinned to ~/.config/usertrust/claude-code.json: the new pin could not be published.",
		);
		expect((JSON.parse(await readFile(pinOf(home), "utf-8")) as Pin).kind).toBe("environment");
		const [first, second, ...rest] = (await readFile(recordsOf(home), "utf-8"))
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as { id?: string; abandoned?: string; why?: string });
		expect(rest).toEqual([]);
		expect(first?.id).toMatch(/^[0-9a-f]{16}$/);
		// mutant: no follow-up record → the first reads as a re-pin that happened
		expect(second).toMatchObject({
			abandoned: first?.id,
			why: "the new pin could not be published",
		});
		// No temp file is left among the pins.
		expect((await readdir(PINS(home))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});
});

// ── Through the hooks ──

const servers: Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
});

/** A usertrust server that records every request, each authorize a fresh hold. */
async function recordingServer() {
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	let next = 0;
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const path = req.url ?? "";
			const body = JSON.parse(raw || "{}") as Record<string, unknown>;
			requests.push({ path, body });
			let json: unknown = { settled: true, released: true, cost: 1, budgetRemaining: 9 };
			if (path === "/v1/health") {
				json = {
					status: "ok",
					capabilities: ["principal", "authorize-cache-tiers", "hold-expiry", "release"],
				};
			} else if (path === "/v1/authorize") {
				next += 1;
				json = { transferId: `tx_${next}`, estimatedCost: 1, model: MODEL, createdAt: 1 };
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(json));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		charged: () =>
			requests
				.filter((r) => r.path === "/v1/settle")
				.reduce(
					(sum, r) => sum + Number(r.body.inputTokens ?? 0) + Number(r.body.outputTokens ?? 0),
					0,
				),
	};
}

function responseEntries(
	id: string,
	input: number,
	output: number,
	timestamp = new Date().toISOString(),
): string[] {
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

const systemMessage = (stdout: string) =>
	(JSON.parse(stdout) as { systemMessage: string }).systemMessage;

/**
 * The old state dir's stamps, written ahead of the hooks at fixed times (lib.mjs
 * `sessionFirstRunAt` keeps a stamp it finds): the clock the test injects, so that the old stamp
 * < `OLD_ENTRY_AT` < the new dir's stamp (made at SessionStart, now) <= the next entry (made after
 * SessionStart returned) holds by construction, with no sleep.
 */
const OLD_STAMP_AT = "2026-11-01T00:00:00.000Z";
const OLD_ENTRY_AT = "2026-11-01T01:00:00.000Z";
async function stampOld(stateDir: string): Promise<void> {
	const dir = join(stateDir, "transcripts");
	await mkdir(join(dir, "since-session"), { recursive: true, mode: 0o700 });
	await writeFile(join(dir, "since"), OLD_STAMP_AT, { mode: 0o600 });
	await writeFile(join(dir, "since-session", SESSION), OLD_STAMP_AT, { mode: 0o600 });
}

describe("through the hooks: (b) the warning, the ignored UT_* note, and a re-pinned session that posts nothing old", () => {
	it("a re-pinned session posts NOTHING older than its first metered hook: the old usage stays the backfill's", async () => {
		const home = await makeHome();
		const old = await makeDir("utcc-conv-old-");
		const project = await mkdtemp(join(tmpdir(), "utcc-conv-project-"));
		const transcript = join(project, `${SESSION}.jsonl`);
		await writeFile(transcript, `${JSON.stringify({ type: "user", sessionId: SESSION })}\n`);
		const env = { ...unconfigured(old), TEST_PASSWD_HOME: home };
		const stop = (more: Record<string, string> = {}) =>
			runHook(
				hook("stop"),
				{ session_id: SESSION, transcript_path: transcript },
				{ ...env, ...more },
			);
		// Unconfigured, with no server: every response a gap, never posted.
		await stampOld(old);
		expect((await stop()).code).toBe(0);
		await append(transcript, [...responseEntries("msg_old", 100, 20, OLD_ENTRY_AT)]);
		expect((await stop()).code).toBe(0);
		const pinned = JSON.parse(await readFile(pinOf(home), "utf-8")) as Pin;
		expect(pinned).toMatchObject({ kind: "environment", settings: { keyHash: EMPTY } });
		// The conventional file appears; the session is resumed.
		const server = await recordingServer();
		const fresh = await makeDir("utcc-conv-new-");
		await writeConventional(home, { ...FILE(fresh), url: server.url });
		const start = await runHook(
			hook("session-start"),
			{ session_id: SESSION, source: "resume" },
			env,
		);
		expect(start.code).toBe(0);
		// mutant: no re-pin at SessionStart → "UNCONFIGURED" instead
		expect(systemMessage(start.stdout)).toContain("this session was RE-PINNED");
		// The old stamp is the injected one; the new dir's is its own, later than msg_old.
		expect(await readFile(join(old, "transcripts", "since-session", SESSION), "utf-8")).toBe(
			OLD_STAMP_AT,
		);
		const stamped = await readFile(join(fresh, "transcripts", "since-session", SESSION), "utf-8");
		expect(Date.parse(stamped)).toBeGreaterThan(Date.parse(OLD_ENTRY_AT));
		await append(transcript, [...responseEntries("msg_new", 300, 60)]);
		expect((await stop()).code).toBe(0);
		// Only what came after the re-pin: 360, never msg_old's 120 too.
		expect(server.charged()).toBe(360);
		expect(await readdir(old)).toContain("transcripts");
	});

	it("a re-pin into the SAME state dir is refused: UNCONFIGURED, loudly, and nothing old is charged", async () => {
		// The README's layout: the conventional file's stateDir is the environment default. That dir
		// already holds the session's first-metered stamp and its cursors, so a re-pin there would post
		// the unconfigured session's usage (msg_old) under the new key.
		const home = await makeHome();
		const old = await makeDir("utcc-conv-old-");
		const project = await mkdtemp(join(tmpdir(), "utcc-conv-project-"));
		const transcript = join(project, `${SESSION}.jsonl`);
		await writeFile(transcript, `${JSON.stringify({ type: "user", sessionId: SESSION })}\n`);
		const env = { ...unconfigured(old), TEST_PASSWD_HOME: home };
		const stop = () =>
			runHook(hook("stop"), { session_id: SESSION, transcript_path: transcript }, env);
		expect((await stop()).code).toBe(0);
		await append(transcript, [...responseEntries("msg_old", 100, 20)]);
		expect((await stop()).code).toBe(0);
		const server = await recordingServer();
		await writeConventional(home, { ...FILE(old), url: server.url });
		const start = await runHook(
			hook("session-start"),
			{ session_id: SESSION, source: "resume" },
			env,
		);
		expect(start.code).toBe(0);
		const message = systemMessage(start.stdout);
		// mutant: re-pin whatever dir the file names
		expect(message).toMatch(/^usertrust: WARNING: this session is UNCONFIGURED\./);
		expect(message).toContain(`It is not re-pinned: ${SAME_DIR}.`);
		expect(nodeFs.existsSync(recordsOf(home))).toBe(false);
		await append(transcript, [...responseEntries("msg_new", 300, 60)]);
		expect((await stop()).code).toBe(0);
		// Still the environment pin, key-less, at a server that never answered: 0 charged, not 480.
		expect(server.charged()).toBe(0);
		expect((JSON.parse(await readFile(pinOf(home), "utf-8")) as Pin).kind).toBe("environment");
	});

	it("(b) SessionStart says UNCONFIGURED, loudly, for a kept environment pin while the conventional file exists", async () => {
		const home = await makeHome();
		const old = await oldStateDir();
		const env = { ...unconfigured(old), UT_SERVER_KEY: "env-key", TEST_PASSWD_HOME: home };
		const first = await runHook(
			hook("session-start"),
			{ session_id: SESSION, source: "startup" },
			env,
		);
		expect(systemMessage(first.stdout)).not.toContain("UNCONFIGURED");
		await writeConventional(home, FILE(await makeDir("utcc-conv-new-")));
		const resumed = await runHook(
			hook("session-start"),
			{ session_id: SESSION, source: "resume" },
			env,
		);
		const message = systemMessage(resumed.stdout);
		// mutant: no warning for a kept environment pin
		expect(message).toMatch(/^usertrust: WARNING: this session is UNCONFIGURED\./);
		expect(message).toContain("It is not re-pinned: it was pinned with a key.");
	});

	it("a configured session started with UT_* set says which file won and the names it ignored, never a value", async () => {
		const home = await makeHome();
		await writeConventional(home, FILE(await makeDir("utcc-conv-new-")));
		const start = await runHook(
			hook("session-start"),
			{ session_id: SESSION, source: "startup" },
			{ TEST_PASSWD_HOME: home, UT_SERVER_URL: "http://elsewhere.example", UT_CC_MODE: "enforce" },
		);
		const message = systemMessage(start.stdout);
		// mutant: no ignored-variables note
		expect(message).toContain(
			"this session's settings come from ~/.config/usertrust/claude-code.json (UT_CC_CONFIG is unset); UT_SERVER_URL, UT_CC_MODE are set in the environment and IGNORED.",
		);
		expect(message).not.toContain("elsewhere.example");
		expect(message).toContain("watch-only");
	});

	it("a refused conventional file while UT_* are set: SessionStart says it was refused, and that the UT_* are never used", async () => {
		const home = await makeHome();
		const path = await writeConventional(home, FILE(await makeDir("utcc-conv-new-")));
		await chmod(path, 0o644);
		const start = await runHook(
			hook("session-start"),
			{ session_id: SESSION, source: "startup" },
			{ TEST_PASSWD_HOME: home, UT_SERVER_URL: "http://127.0.0.1:7", UT_SERVER_KEY: "env" },
		);
		const message = systemMessage(start.stdout);
		expect(message).toContain("watch-only and key-less");
		expect(message).toContain(
			"the config file ~/.config/usertrust/claude-code.json was refused (config: file refused (mode)); the UT_* variables are never used in its place",
		);
	});
});

const append = (path: string, lines: string[]) => appendFile(path, `${lines.join("\n")}\n`);
