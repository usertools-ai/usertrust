// The agent's instruction to type its jobs is OPT-IN (`jobTypeInstruction`, `UT_CC_JOB_TYPE_INSTRUCTION=1`),
// off by default, and it never tells the agent to skip asking the user. Each test names the
// mutant it kills; the mutants were run against this file and reverted (see the pull request).

import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const HOOKS = join(import.meta.dirname, "..", "hooks");
const BANNER = "usertrust: watch-only — nothing is blocked";
const SESSION = "11111111-2222-4333-8444-555555555555";
const WITH_TYPE = JSON.stringify({
	status: "ok",
	version: "5.5.0",
	capabilities: ["principal", "job", "job-type", "release", "hold-ttl"],
});
const WITHOUT_TYPE = JSON.stringify({
	status: "ok",
	version: "5.5.0",
	capabilities: ["principal", "job", "release", "hold-ttl"],
});

const servers: Server[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) {
		s.closeAllConnections?.();
		s.close();
	}
});
function health(body: string): Promise<number> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(body);
	});
	servers.push(server);
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const a = server.address();
			resolve(typeof a === "object" && a !== null ? a.port : 0);
		}),
	);
}

async function envSession(port: number, extra: Record<string, string> = {}) {
	const state = await mkdtemp(join(tmpdir(), "utcc-optin-"));
	return runHook(
		join(HOOKS, "session-start.mjs"),
		{ hook_event_name: "SessionStart", source: "startup", session_id: SESSION },
		{
			UT_CC_STATE_DIR: state,
			UT_SERVER_URL: `http://127.0.0.1:${port}`,
			UT_SERVER_KEY: "k",
			...extra,
		},
	);
}
/** A configured session; `file` holds the config's extra fields. */
async function configuredSession(port: number, file: Record<string, unknown> = {}) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "utcc-optin-home-")));
	const anchor = join(home, ".config", "usertrust");
	await mkdir(anchor, { recursive: true, mode: 0o700 });
	const stateDir = await mkdtemp(join(tmpdir(), "utcc-optin-state-"));
	const path = join(anchor, "session.json");
	await writeFile(
		path,
		JSON.stringify({
			url: `http://127.0.0.1:${port}`,
			key: "file-key",
			mode: "watch",
			stateDir,
			...file,
		}),
		{ mode: 0o600 },
	);
	return runHook(
		join(HOOKS, "session-start.mjs"),
		{ hook_event_name: "SessionStart", source: "startup", session_id: SESSION },
		{ TEST_PASSWD_HOME: home, UT_CC_CONFIG: path },
	);
}
const out = (stdout: string) =>
	JSON.parse(stdout) as {
		systemMessage: string;
		hookSpecificOutput?: { additionalContext?: string };
	};
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

interface JobLogLib {
	JOB_TYPE_INSTRUCTION: string;
}
const instruction = async () =>
	((await import(pathToFileURL(join(HOOKS, "job-log.mjs")).href)) as JobLogLib)
		.JOB_TYPE_INSTRUCTION;

describe.each([
	[
		"an environment session",
		(port: number) => envSession(port),
		(port: number) => envSession(port, { UT_CC_JOB_TYPE_INSTRUCTION: "1" }),
	],
	[
		"a configured session",
		(port: number) => configuredSession(port),
		(port: number) => configuredSession(port, { jobTypeInstruction: true }),
	],
])("%s", (_name, byDefault, optedIn) => {
	it("default: a server that lists job-type gets NO instruction, and the banner is announced once", async () => {
		const port = await health(WITH_TYPE);
		const r = await byDefault(port);
		expect(r.code).toBe(0);
		const parsed = out(r.stdout);
		// mutant: the default flips to on
		expect(parsed.hookSpecificOutput).toBeUndefined();
		expect(Object.keys(parsed)).toEqual(["systemMessage"]);
		expect(count(r.stdout, BANNER)).toBe(1);
	});

	it("opted in: the instruction is added, once, beside the banner", async () => {
		const port = await health(WITH_TYPE);
		const r = await optedIn(port);
		const parsed = out(r.stdout);
		// mutant: the setting is read but never gates the instruction
		expect(parsed.hookSpecificOutput?.additionalContext).toBe(await instruction());
		expect(count(r.stdout, BANNER)).toBe(1);
		expect(count(r.stdout, '"systemMessage"')).toBe(1);
	});

	it("opted in against a server that does not list job-type: no instruction", async () => {
		const port = await health(WITHOUT_TYPE);
		const r = await optedIn(port);
		// mutant: the opt-in replaces the probe instead of joining it
		expect(out(r.stdout).hookSpecificOutput).toBeUndefined();
		expect(count(r.stdout, BANNER)).toBe(1);
	});
});

describe("the wording", () => {
	it("says what the call does and nothing about the conversation", async () => {
		const text = await instruction();
		// mutant: the old sentence comes back
		expect(text).not.toMatch(/\bask/i);
		expect(text).not.toMatch(/without (asking|checking|permission)/i);
		// mutant: a sentence that steers how the agent talks to the user comes back
		expect(text).not.toMatch(/discussion|mention/i);
		expect(text).toContain(
			"This call only records a label for usertrust's cost reports; it changes nothing else.",
		);
		// the rest of the instruction is as it was
		expect(text).toContain("usertrust-job.mjs start --type <type> --source agent <short-id>");
		expect(text).toContain("keep it and do not start another");
		expect(text.length).toBeLessThan(1000);
	});
});

describe("the setting", () => {
	it("only the exact spelling turns it on in the environment", async () => {
		for (const value of ["0", "true", "yes", "", "1 "]) {
			const r = await envSession(await health(WITH_TYPE), { UT_CC_JOB_TYPE_INSTRUCTION: value });
			// mutant: any non-empty value opts in
			expect(out(r.stdout).hookSpecificOutput, JSON.stringify(value)).toBeUndefined();
		}
	});

	it("a config file's value that is not a boolean refuses the file, like every other optional key", async () => {
		const { parseConfig } = (await import(pathToFileURL(join(HOOKS, "config.mjs")).href)) as {
			parseConfig(text: string): string | { jobTypeInstruction: boolean };
		};
		const base = { url: "http://127.0.0.1:1", key: "k", mode: "watch", stateDir: "/tmp/x" };
		for (const bad of ["yes", 1, null, "true"]) {
			expect(parseConfig(JSON.stringify({ ...base, jobTypeInstruction: bad }))).toBe(
				'config: field "jobTypeInstruction" invalid',
			);
		}
		expect(parseConfig(JSON.stringify(base))).toMatchObject({ jobTypeInstruction: false });
		expect(parseConfig(JSON.stringify({ ...base, jobTypeInstruction: true }))).toMatchObject({
			jobTypeInstruction: true,
		});
	});

	it("a pin made before the setting existed means off, for both kinds of pin", async () => {
		const { pinnedSettings } = (await import(pathToFileURL(join(HOOKS, "session.mjs")).href)) as {
			pinnedSettings(
				pin: unknown,
				env: Record<string, string>,
				home: string,
			): { jobTypeInstruction: boolean; refused: string | null };
		};
		const { keyHash } = (await import(pathToFileURL(join(HOOKS, "config.mjs")).href)) as {
			keyHash(key: string): string;
		};
		const settings = {
			url: "http://127.0.0.1:1",
			mode: "watch",
			failOpen: false,
			stateDir: "/tmp/x",
			usage: "transcript",
			sendContent: true,
		};
		const configuredPin = { v: 1, kind: "configured", settings: { ...settings, key: "k" } };
		const environmentPin = {
			v: 1,
			kind: "environment",
			settings: { ...settings, keyHash: keyHash("k") },
		};
		// mutant: the missing field is left undefined and read as truthy elsewhere, or defaults to on
		expect(pinnedSettings(configuredPin, {}, "/tmp").jobTypeInstruction).toBe(false);
		const env = pinnedSettings(environmentPin, { UT_SERVER_KEY: "k" }, "/tmp");
		expect(env.refused).toBeNull();
		expect(env.jobTypeInstruction).toBe(false);
	});
});
