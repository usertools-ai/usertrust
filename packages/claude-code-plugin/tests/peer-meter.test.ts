import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const { peerMeter, settingsDirs, alsoEnabledWarning, unknownWarning } = (await import(
	join(HOOKS, "peer-meter.mjs")
)) as {
	peerMeter: (args: {
		userDir: string;
		projectDir: string | null;
		managed?: string | null;
	}) => Promise<{
		state: "enabled" | "absent" | "unknown";
		why: string | null;
		file?: string;
		key?: string;
	}>;
	settingsDirs: (args: { env: Record<string, string | undefined>; payload: unknown }) => {
		userDir: string;
		projectDir: string | null;
	};
	alsoEnabledWarning: (file: string, key: string) => string;
	unknownWarning: (why: string) => string;
};

const COST_ENABLED =
	"every tool call reserves budget twice, and some of its versions can charge twice";
const COST_UNKNOWN =
	"it would reserve budget twice per tool call, and some of its versions can charge twice";

const OLD = "usertrust-claude-code@usertrust";

let root: string;
let userDir: string;
let projectDir: string;

async function settings(dir: string, file: string, body: unknown): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, file);
	await writeFile(path, typeof body === "string" ? body : JSON.stringify(body));
	return path;
}
const user = (body: unknown) => settings(userDir, "settings.json", body);
const shared = (body: unknown) => settings(join(projectDir, ".claude"), "settings.json", body);
const local = (body: unknown) => settings(join(projectDir, ".claude"), "settings.local.json", body);
const check = (managed: string | null = null) => peerMeter({ userDir, projectDir, managed });

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "utcc-peer-"));
	userDir = join(root, "home", ".claude");
	projectDir = join(root, "project");
	await mkdir(projectDir, { recursive: true });
});

describe("peerMeter: is usertrust-claude-code ENABLED", () => {
	it("both enabled: the old plugin looks enabled", async () => {
		await user({ enabledPlugins: { [OLD]: true, "usertools@usertrust": true } });
		expect((await check()).state).toBe("enabled");
	});

	it("only usertools: no entry for the old plugin", async () => {
		await user({ enabledPlugins: { "usertools@usertrust": true } });
		expect((await check()).state).toBe("absent");
	});

	it("no settings files at all: absent", async () => {
		expect((await check()).state).toBe("absent");
	});

	it("old plugin installed but disabled", async () => {
		await user({ enabledPlugins: { [OLD]: false, "usertools@usertrust": true } });
		expect((await check()).state).toBe("absent");
	});

	it("any marketplace's copy counts, and a lookalike name does not", async () => {
		await user({ enabledPlugins: { "usertrust-claude-code@elsewhere": true } });
		expect((await check()).state).toBe("enabled");
		await user({
			enabledPlugins: { "my-usertrust-claude-code@usertrust": true, "usertrust-claude-code": true },
		});
		expect((await check()).state).toBe("absent");
	});

	it("precedence: a project-local false beats the user's true, a user false loses to project true", async () => {
		await user({ enabledPlugins: { [OLD]: true } });
		await local({ enabledPlugins: { [OLD]: false } });
		expect((await check()).state).toBe("absent");
		await user({ enabledPlugins: { [OLD]: false } });
		await local({ enabledPlugins: {} });
		await shared({ enabledPlugins: { [OLD]: true } });
		expect((await check()).state).toBe("enabled");
	});

	it("names the file that decided: the highest scope that said true", async () => {
		await user({ enabledPlugins: { [OLD]: true } });
		const project = await shared({ enabledPlugins: { [OLD]: true } });
		expect((await check()).file).toBe(project);
		const managed = await settings(join(root, "managed"), "managed-settings.json", {
			enabledPlugins: { [OLD]: true },
		});
		expect((await check(managed)).file).toBe(managed);
	});

	it("managed settings stand above every file", async () => {
		await user({ enabledPlugins: { [OLD]: false } });
		const managed = await settings(join(root, "managed"), "managed-settings.json", {
			enabledPlugins: { [OLD]: true },
		});
		expect((await check(managed)).state).toBe("enabled");
	});

	it("unreadable settings: unknown, never enabled and never absent", async () => {
		await user("{ not json");
		const read = await check();
		expect(read.state).toBe("unknown");
		expect(read.why).toContain("not JSON");
	});

	it("a file that holds the old plugin's key is still unknown beside an unreadable one", async () => {
		await user({ enabledPlugins: { [OLD]: true } });
		await shared("[]");
		expect((await check()).state).toBe("unknown");
	});

	it("a value that is not true or false is ambiguous", async () => {
		await user({ enabledPlugins: { [OLD]: "yes" } });
		expect((await check()).state).toBe("unknown");
		await user({ enabledPlugins: [OLD] });
		expect((await check()).state).toBe("unknown");
	});

	it("a settings file that is a FIFO does not hang the check", async () => {
		execFileSync("mkfifo", [join(await settings(userDir, "other.json", {}), "..", "x")]);
		const fifo = join(userDir, "settings.json");
		execFileSync("mkfifo", [fifo]);
		const read = await check();
		expect(read.state).toBe("unknown");
		expect(read.why).toContain("ENOTREG");
	});

	it("no project directory: the project's files cannot be consulted, so unknown", async () => {
		await user({ enabledPlugins: { [OLD]: true } });
		expect((await peerMeter({ userDir, projectDir: null, managed: null })).state).toBe("unknown");
	});

	it("a subdirectory's root local file is the one Claude Code writes", async () => {
		await mkdir(join(projectDir, ".git"));
		const nested = join(projectDir, "src", "pkg");
		await mkdir(nested, { recursive: true });
		const file = await settings(join(projectDir, ".claude"), "settings.local.json", {
			enabledPlugins: { [OLD]: true },
		});
		const read = await peerMeter({ userDir, projectDir: nested, managed: null });
		expect(read.state).toBe("enabled");
		expect(read.file).toBe(file);
		expect(read.key).toBe(OLD);
	});

	it("a worktree reads the main checkout's local file", async () => {
		const main = join(root, "main");
		const gitdir = join(main, ".git", "worktrees", "wt");
		await mkdir(gitdir, { recursive: true });
		await writeFile(join(gitdir, "commondir"), "../..\n");
		const wt = join(root, "wt");
		await mkdir(wt);
		await writeFile(join(wt, ".git"), `gitdir: ${gitdir}\n`);
		const file = await settings(join(main, ".claude"), "settings.local.json", {
			enabledPlugins: { [OLD]: true },
		});
		const read = await peerMeter({ userDir, projectDir: wt, managed: null });
		expect(read.state).toBe("enabled");
		expect(read.file).toBe(file);
	});

	it("the root's local value wins over a legacy starting-dir file", async () => {
		await mkdir(join(projectDir, ".git"));
		const nested = join(projectDir, "src");
		await mkdir(nested);
		await settings(join(projectDir, ".claude"), "settings.local.json", {
			enabledPlugins: { [OLD]: false },
		});
		await settings(join(nested, ".claude"), "settings.local.json", {
			enabledPlugins: { [OLD]: true },
		});
		expect((await peerMeter({ userDir, projectDir: nested, managed: null })).state).toBe("absent");
		await settings(join(projectDir, ".claude"), "settings.local.json", {});
		const read = await peerMeter({ userDir, projectDir: nested, managed: null });
		expect(read.state).toBe("enabled");
		expect(read.file).toBe(join(nested, ".claude", "settings.local.json"));
	});

	it("a .git file that is not a gitdir pointer is unknown", async () => {
		await writeFile(join(projectDir, ".git"), "not a pointer\n");
		const read = await check();
		expect(read.state).toBe("unknown");
		expect(read.why).toContain(join(projectDir, ".git"));
		expect(read.why).toContain("not a gitdir pointer");
	});

	it("a .git FIFO in the walk does not hang the check", async () => {
		// readRegular cannot tell a directory from a FIFO (both ENOTREG), so the walk takes it
		// as a repository root and returns; it must not block on the pipe.
		execFileSync("mkfifo", [join(projectDir, ".git")]);
		const read = await check();
		expect(read.state).toBe("absent");
	});

	it("a worktree whose commondir is missing is unknown", async () => {
		const gitdir = join(root, "main", ".git", "worktrees", "wt");
		await mkdir(gitdir, { recursive: true });
		await writeFile(join(projectDir, ".git"), `gitdir: ${gitdir}\n`);
		const read = await check();
		expect(read.state).toBe("unknown");
		expect(read.why).toContain(join(gitdir, "commondir"));
	});

	it("names the exact winning key, the higher-precedence scope's when two are true", async () => {
		const elsewhere = "usertrust-claude-code@elsewhere";
		await user({ enabledPlugins: { [elsewhere]: true } });
		const read = await check();
		expect(read.state).toBe("enabled");
		expect(read.key).toBe(elsewhere);
		expect(alsoEnabledWarning(read.file ?? "", read.key ?? "")).toContain(
			`/plugin uninstall ${elsewhere}`,
		);
		await local({ enabledPlugins: { [OLD]: true } });
		expect((await check()).key).toBe(OLD);
	});
});

describe("settingsDirs", () => {
	it("CLAUDE_CONFIG_DIR (absolute) moves the user directory; CLAUDE_PROJECT_DIR beats the payload cwd", () => {
		expect(
			settingsDirs({
				env: { CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_PROJECT_DIR: "/proj" },
				payload: { cwd: "/elsewhere" },
			}),
		).toEqual({ userDir: "/cfg", projectDir: "/proj" });
		expect(settingsDirs({ env: {}, payload: { cwd: "/elsewhere" } })).toEqual({
			userDir: join(homedir(), ".claude"),
			projectDir: "/elsewhere",
		});
		expect(
			settingsDirs({ env: { CLAUDE_CONFIG_DIR: "rel", CLAUDE_PROJECT_DIR: "rel" }, payload: {} }),
		).toEqual({ userDir: join(homedir(), ".claude"), projectDir: null });
	});
});

describe("SessionStart warns of an enabled usertrust-claude-code, and usertools always meters", () => {
	let server: Server | undefined;
	let hits: number;
	let stateDir: string;
	let env: Record<string, string>;
	const PAYLOAD = {
		session_id: "peer1",
		tool_name: "Bash",
		tool_use_id: "tu_1",
		tool_input: { command: "ls" },
	};

	beforeEach(async () => {
		hits = 0;
		const port = await new Promise<number>((resolve) => {
			server = createServer((req, res) => {
				hits++;
				req.resume();
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ transferId: "t", budgetRemaining: 1 }));
			});
			server.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		stateDir = join(root, "state");
		env = {
			UT_CC_STATE_DIR: stateDir,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
			UT_SERVER_KEY: "k",
			UT_CC_USAGE: "estimate",
			CLAUDE_CONFIG_DIR: userDir,
			CLAUDE_PROJECT_DIR: projectDir,
		};
	});
	afterEach(() => {
		server?.close();
		server = undefined;
	});

	const run = (hook: string, id: string) =>
		runHook(join(HOOKS, `${hook}.mjs`), { ...PAYLOAD, session_id: id, cwd: projectDir }, env);

	it("both enabled: SessionStart warns word for word, and EVERY hook still meters", async () => {
		const file = await user({ enabledPlugins: { [OLD]: true } });
		const start = await run("session-start", "both-1");
		expect(start.code).toBe(0);
		const message = JSON.parse(start.stdout).systemMessage as string;
		expect(message.startsWith(`${alsoEnabledWarning(file, OLD)} usertrust: watch-only`)).toBe(true);
		expect(alsoEnabledWarning("/the/file.json", "usertrust-claude-code@sample")).toBe(
			"usertrust: usertrust-claude-code also appears to be enabled (/the/file.json); if it is, every tool call reserves budget twice, and some of its versions can charge twice. Uninstall it: /plugin uninstall usertrust-claude-code@sample",
		);
		expect(message).toContain(COST_ENABLED);
		const before = hits;
		const pre = await run("pre-tool-use", "both-1");
		expect(pre.code).toBe(0);
		expect(hits, "pre-tool-use sent its request").toBeGreaterThan(before);
		await expect(readdir(stateDir)).resolves.not.toEqual([]);
	});

	it("unknownWarning: the exact text, cost included", () => {
		expect(unknownWarning("settings.json is not JSON")).toBe(
			"usertrust: could not tell whether usertrust-claude-code is also enabled (settings.json is not JSON); usertools meters this session, so a second meter may be running: it would reserve budget twice per tool call, and some of its versions can charge twice.",
		);
	});

	it("a value that is not true or false: SessionStart warns with the cost, and meters", async () => {
		await user({ enabledPlugins: { [OLD]: "yes" } });
		const start = await run("session-start", "ambiguous-1");
		const message = JSON.parse(start.stdout).systemMessage as string;
		expect(message).toMatch(
			/^usertrust: could not tell whether usertrust-claude-code is also enabled/,
		);
		expect(message).toContain(COST_UNKNOWN);
		await run("pre-tool-use", "ambiguous-1");
		expect(hits).toBeGreaterThan(0);
	});

	it("the warning is SessionStart's alone: no other hook says it", async () => {
		await user({ enabledPlugins: { [OLD]: true } });
		for (const hook of ["pre-tool-use", "post-tool-use", "stop", "subagent-stop", "session-end"]) {
			const out = await run(hook, "both-2");
			expect(out.stdout, hook).not.toContain("also appears");
			expect(out.stderr, hook).not.toContain("also appears");
		}
	});

	it("only usertools: meters (the normal banner, a request sent)", async () => {
		await user({ enabledPlugins: { "usertools@usertrust": true } });
		const start = await run("session-start", "solo-1");
		expect(JSON.parse(start.stdout).systemMessage).toMatch(/^usertrust: watch-only/);
		await run("pre-tool-use", "solo-1");
		expect(hits).toBeGreaterThan(0);
	});

	it("old plugin disabled: meters", async () => {
		await user({ enabledPlugins: { [OLD]: false } });
		const start = await run("session-start", "off-1");
		expect(JSON.parse(start.stdout).systemMessage).toMatch(/^usertrust: watch-only/);
		await run("pre-tool-use", "off-1");
		expect(hits).toBeGreaterThan(0);
	});

	it("unreadable settings: meters AND warns first", async () => {
		await user("{ not json");
		const start = await run("session-start", "bad-1");
		const message = JSON.parse(start.stdout).systemMessage as string;
		expect(message).toMatch(
			/^usertrust: could not tell whether usertrust-claude-code is also enabled/,
		);
		expect(message).toContain("usertools meters this session");
		expect(message).toContain(COST_UNKNOWN);
		expect(message).toContain("watch-only");
		await run("pre-tool-use", "bad-1");
		expect(hits).toBeGreaterThan(0);
	});
});
