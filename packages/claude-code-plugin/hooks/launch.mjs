// Every hook's entry point (hooks.json): `node launch.mjs <hook>`.
//
// THE PARENT, the process Claude Code starts, reads the hook's input and resolves its
// session's settings from the session's pin (session.mjs, which makes the pin when
// the session has none). Then:
// - An `environment` session, a refused one, and SessionStart (which sends nothing)
//   run the hook here, in this process.
// - A `configured` session's other hooks, all of which can send, run as a CHILD that
//   sends: `node launch.mjs <hook> --ut-child ...`, with no node options, the
//   working directory `/`, and nothing of the environment but the host variables a
//   hook reads (config.mjs `childEnv`).
//   - So nothing the environment can set reaches the process that holds the key and
//     sends: a proxy, a CA store, OpenSSL's config, the C library's resolver, or a
//     variable no one has named yet.
//   - The parent sends nothing.
//
// The child is known by its argv (`--ut-child`): an environment cannot add a script
// argument, and the hook's argv comes from the plugin's own hooks.json.
// - It reads the pin the parent names (`--ut-pin`), and counts its time budget from
//   the parent's start (`--ut-started`).
// - It refuses to run, exit `CHILD_REFUSED`, when its environment holds anything
//   else (config.mjs `isChildEnv`) or its pin is unusable.
// - Its stdout and stderr are the parent's, and exit codes 0 and 2 pass through.
// - Anything else is the hook failing: no child, a signal, a refusal or another exit
//   code. PreToolUse treats it as an outage (a gap, or a block in enforce mode); the
//   other hooks record a gap (`childOutcome`).
//
// What this does not stop is CODE in the parent. A variable that loads code
// (NODE_OPTIONS, PATH) runs before any of this, and can read the config file too.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { childEnv, howToSet, isChildEnv, passwdHome, useSession } from "./config.mjs";
import { launch, readStdin, recordWatchEvent, say } from "./lib.mjs";
import { pinnedSettings, readPin, sessionSettings, sweep, touchPin } from "./session.mjs";

const STARTED = Date.now();
const LAUNCH = fileURLToPath(import.meta.url);
const HOOKS = new Set([
	"session-start",
	"pre-tool-use",
	"post-tool-use",
	"stop",
	"subagent-stop",
	"session-end",
]);
const CHILD = "--ut-child";
/** A child's exit when it will not run: its environment or its pin is not what it was given. */
export const CHILD_REFUSED = 3;

/** How a configured session's child is started: cwd `/`, the child environment, its stdio. */
export function childOptions(env) {
	return { cwd: "/", env: childEnv(env), stdio: ["pipe", "inherit", "inherit"] };
}

/**
 * A child's start: its parent's, from `--ut-started`, so its budget counts the time
 * the child took to start. Never later than now, nor earlier than a minute ago.
 */
export function startedAt(value, now = Date.now()) {
	const ms = Number(value);
	return Number.isFinite(ms) && ms <= now && ms >= now - 60_000 ? ms : now;
}

/**
 * What a child that failed means for its hook. PreToolUse treats it as an outage, so
 * enforce without failOpen blocks the tool call (exit 2). Every other case exits 0
 * and records a gap. `what` says how the child failed.
 */
export function childOutcome({ hook, mode, failOpen, what }) {
	const reason = `launch: the hook's process failed (${what})`;
	if (hook === "pre-tool-use" && mode === "enforce" && !failOpen) {
		return { exitCode: 2, gap: false, reason };
	}
	return { exitCode: 0, gap: true, reason };
}

/** The value of `--ut-<name>=...` in this process's argv. */
function flag(name) {
	const prefix = `--ut-${name}=`;
	return process.argv
		.slice(3)
		.find((arg) => arg.startsWith(prefix))
		?.slice(prefix.length);
}

const currentUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/** A hook's input: the parsed object, or null when it is not one. */
function parsePayload(text) {
	try {
		const value = JSON.parse(text || "{}");
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/** Record a failed child, the way its hook would have recorded an outage. */
async function childFailed(hook, settings, input, what) {
	const outcome = childOutcome({ hook, mode: settings.mode, failOpen: settings.failOpen, what });
	process.exitCode = outcome.exitCode;
	if (!outcome.gap) {
		say(
			`usertrust governance blocked this tool call because authorization failed closed: ${outcome.reason}`,
		);
		return;
	}
	const recorded = await recordWatchEvent({
		kind: "gap",
		mode: settings.mode,
		phase: hook,
		session: input?.session_id ?? "unknown",
		agent: input?.agent_id ?? "main",
		...(hook === "pre-tool-use" ? { tool: input?.tool_name ?? "unknown" } : {}),
		reason: outcome.reason,
	});
	const record = recorded ? "recorded as a gap" : "and its gap record could not be written";
	if (hook !== "pre-tool-use") {
		say(`usertrust: ${outcome.reason}; ${record}`);
	} else if (settings.mode === "watch") {
		say(`usertrust watch-only: this call is not metered (${outcome.reason}) — ${record}`);
	} else {
		say(
			`usertrust unavailable — proceeding ungoverned (${howToSet("failOpen", true)}): ${outcome.reason}`,
		);
	}
}

/** Run the hook as a child that sends, with nothing from this environment. */
function runInChild(hook, text, input, session) {
	return new Promise((resolve) => {
		let done = false;
		const finish = async (what, code) => {
			if (done) return;
			done = true;
			if (what === null) process.exitCode = code;
			else await childFailed(hook, session.settings, input, what);
			resolve();
		};
		let child;
		try {
			child = spawn(
				process.execPath,
				[LAUNCH, hook, CHILD, `--ut-started=${STARTED}`, `--ut-pin=${session.path}`],
				childOptions(),
			);
		} catch (err) {
			void finish(`no process: ${err?.code ?? "error"}`);
			return;
		}
		child.on("error", (err) => void finish(`no process: ${err?.code ?? "error"}`));
		for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
			process.on(signal, () => child.kill(signal));
		}
		child.stdin.on("error", () => {});
		child.stdin.end(text);
		child.on("close", (code, signal) => {
			if (signal !== null) void finish(`signal ${signal}`);
			else if (code === 0 || code === 2) void finish(null, code);
			else if (code === CHILD_REFUSED) void finish("its child refused to run");
			else void finish(`exit ${code}`);
		});
	});
}

/** The parent: resolve the session, then run the hook here or as a child. */
async function parent(hook) {
	const text = await readStdin();
	const input = parsePayload(text);
	const home = passwdHome();
	const uid = currentUid();
	const session = sessionSettings({ payload: input, passwdHome: home, uid });
	useSession(session.settings);
	if (session.path !== null) touchPin(session.path);
	if (hook === "session-start") sweep({ passwdHome: home, uid });
	const sends = hook !== "session-start";
	if (session.kind === "configured" && session.settings.refused === null && sends) {
		await runInChild(hook, text, input, session);
		return;
	}
	launch({ payload: text, startedAt: STARTED });
	await import(`./${hook}.mjs`);
}

/** The child: run the hook with the pinned settings, or refuse. */
async function child(hook) {
	const clean = isChildEnv();
	const read = readPin(flag("pin") ?? "", { uid: currentUid() });
	if (!clean || read.pin?.kind !== "configured") {
		say(
			`usertrust: the hook's child refused to run: ${clean ? "its pin is unusable" : "its environment holds more than it was given"}`,
		);
		process.exitCode = CHILD_REFUSED;
		return;
	}
	useSession(pinnedSettings(read.pin, {}, null));
	launch({ payload: null, startedAt: startedAt(flag("started")) });
	await import(`./${hook}.mjs`);
}

/** Whether this file is the process's script, as hooks.json runs it, not a module imported. */
function isScript() {
	try {
		return realpathSync(process.argv[1] ?? "") === realpathSync(LAUNCH);
	} catch {
		return false;
	}
}

if (isScript()) {
	const hook = process.argv[2];
	if (!HOOKS.has(hook)) {
		say("usertrust: launch.mjs runs a hook: session-start, pre-tool-use, ...");
		process.exitCode = 1;
	} else if (process.argv.includes(CHILD)) {
		await child(hook);
	} else {
		await parent(hook);
	}
}
