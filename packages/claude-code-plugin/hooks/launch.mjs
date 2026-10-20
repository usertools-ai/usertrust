// Every hook's entry point (hooks.json): `node launch.mjs <hook>`.
//
// THE PARENT, the process Claude Code starts, reads the hook's input and resolves its
// session's settings from the session's pin (session.mjs, which makes the pin when
// the session has none). Then:
// - An `environment` session and a refused one run the hook here, in this process. So does
//   SessionStart, which makes no governed request itself: its one probe (does the server list
//   `job-type`?) is made, for a configured session, by a child of the kind below
//   (`probeInChild`, session-probe.mjs), and the answer is a token the child writes to a pipe.
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
//   the parent's start (`--ut-started`). Its passwd home, under which the host's breaker
//   lives (breaker.mjs), is the one the parent read (`--ut-home`): the child's environment
//   holds nothing to find it by.
// - It refuses to run, exit `CHILD_REFUSED`, when its environment holds anything
//   else (config.mjs `isChildEnv`) or its pin is unusable.
// - Its stdout and stderr are the parent's, and exit codes 0 and 2 pass through.
// - Anything else is the hook failing: no child, a signal, a refusal or another exit
//   code. PreToolUse treats it as an outage (a gap, or a block in enforce mode); the
//   other hooks record a gap (`childOutcome`).
// - So is anything the parent throws that nothing caught (`launcherFailed`). It never
//   exits 1, which Claude Code reads as a non-blocking error: the call would run, and
//   in enforce mode ungoverned, with no gap.
// - On Windows the child does not run at all (config.mjs `childUnsupported`).
//
// What this does not stop is CODE in the parent. A variable that loads code
// (NODE_OPTIONS, PATH) runs before any of this, and can read the config file too.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { useBreakerHome } from "./breaker.mjs";
import {
	childEnv,
	childUnsupported,
	claudeDirsEnv,
	howToSet,
	isChildEnv,
	managedSettingsFile,
	passwdHome,
	refusedSettings,
	settings as resolvedSettings,
	useSession,
} from "./config.mjs";
import { PROBE_READ_MAX, PROBE_TOKEN, setChildProbe } from "./job-log.mjs";
import { launch, readStdin, recordWatchEvent, say } from "./lib.mjs";
import {
	alsoEnabledWarning,
	peerMeter,
	setPeerWarning,
	settingsDirs,
	unknownWarning,
} from "./peer-meter.mjs";
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
/** The probe child (session-probe.mjs): not a hook of hooks.json, so only ever started as a child. */
const PROBE = "session-probe";
/** The longest the parent waits for the probe child: the probe's own bound (1.5 s) plus its start. */
const PROBE_KILL_MS = 3_000;
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
		// PreToolUse's call began when this hook did. What any other hook was to settle began
		// earlier, at a time this process never reads: unknown.
		started: hook === "pre-tool-use" ? new Date(STARTED).toISOString() : null,
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
function runInChild(hook, text, input, session, home) {
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
				[
					LAUNCH,
					hook,
					CHILD,
					`--ut-started=${STARTED}`,
					`--ut-pin=${session.path}`,
					...(home === null ? [] : [`--ut-home=${home}`]),
				],
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
		// A spawn that fails for want of descriptors (EMFILE, ENFILE) returns a child with
		// no stdin, and says so only by a later `error`: the input goes in once it exists.
		child.once("spawn", () => {
			child.stdin?.on("error", () => {});
			child.stdin?.end(text);
		});
		child.on("close", (code, signal) => {
			if (signal !== null) void finish(`signal ${signal}`);
			else if (code === 0 || code === 2) void finish(null, code);
			else if (code === CHILD_REFUSED) void finish("its child refused to run");
			else void finish(`exit ${code}`);
		});
	});
}

/** What the parent knows so far, for `launcherFailed`: the hook's input and its session's settings. */
const known = { input: null, settings: null };

/**
 * SessionStart only: look for `usertrust-claude-code` in the settings files and, when it looks
 * enabled or cannot be told, leave a warning for SessionStart's line (peer-meter.mjs). It
 * NEVER stops this plugin metering: settings files are only evidence of what Claude Code
 * loaded (--settings and --setting-sources, a mid-session change and a different home all
 * make them wrong), and a wrong "enabled" would be a silent zero meter, where a wrong
 * warning costs one line. A check that throws is "unknown".
 */
async function warnOfPeer(input) {
	let peer;
	try {
		peer = await peerMeter({
			...settingsDirs({ env: claudeDirsEnv(), payload: input }),
			managed: managedSettingsFile(),
		});
	} catch (err) {
		peer = { state: "unknown", why: err?.code ?? "check failed" };
	}
	if (peer.state === "enabled") setPeerWarning(alsoEnabledWarning(peer.file, peer.key));
	else if (peer.state === "unknown") setPeerWarning(unknownWarning(peer.why));
}

/**
 * SessionStart's one request, for a configured session, from the same isolated child its other
 * hooks send from: no node options, cwd `/`, nothing of the environment. Resolves to whether the
 * server lists `job-type`. A child that cannot run, fails, is refused or outlives the bound is
 * `false` (no instruction), and the banner is the parent's, announced once either way. Its
 * stdout is not the parent's (SessionStart prints one JSON object, from here), and the answer
 * is the token it writes to a pipe (session-probe.mjs), read here with exit 0, never relayed.
 */
export function probeInChild(session, home) {
	return new Promise((resolve) => {
		let child;
		let output = "";
		let over = false;
		// The probe child dies with this launcher, as `runInChild`'s does: a signal to the
		// launcher is forwarded, and the launcher's own exit takes the child with it.
		const forward = (signal) => child?.kill(signal);
		const onExit = () => child?.kill("SIGKILL");
		const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
		const cleanup = () => {
			clearTimeout(timer);
			for (const signal of signals) process.off(signal, handlers[signal]);
			process.off("exit", onExit);
		};
		const handlers = Object.fromEntries(signals.map((s) => [s, () => forward(s)]));
		let timer;
		try {
			child = spawn(
				process.execPath,
				[
					LAUNCH,
					PROBE,
					CHILD,
					`--ut-started=${Date.now()}`,
					`--ut-pin=${session.path}`,
					...(home === null ? [] : [`--ut-home=${home}`]),
				],
				{ ...childOptions(), stdio: ["ignore", "pipe", "inherit"] },
			);
		} catch {
			resolve(false);
			return;
		}
		for (const signal of signals) process.on(signal, handlers[signal]);
		process.on("exit", onExit);
		timer = setTimeout(() => child.kill("SIGKILL"), PROBE_KILL_MS);
		// A bounded read, never relayed: SessionStart's stdout is one JSON object, this process's.
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => {
			if (over) return;
			if (output.length + chunk.length > PROBE_READ_MAX) {
				// More than the token can be: not an answer. Stop reading and stop the child.
				over = true;
				child.kill("SIGKILL");
			} else output += chunk;
		});
		child.stdout.on("error", () => {});
		child.on("error", () => {
			cleanup();
			resolve(false);
		});
		child.on("close", (code, signal) => {
			cleanup();
			// ONLY a clean exit 0 together with exactly the token line is "listed".
			resolve(code === 0 && signal === null && !over && output === `${PROBE_TOKEN}\n`);
		});
	});
}

/** The parent: resolve the session, then run the hook here or as a child. */
async function parent(hook) {
	const text = await readStdin();
	const input = parsePayload(text);
	known.input = input;
	const home = passwdHome();
	if (hook === "session-start") await warnOfPeer(input);
	const uid = currentUid();
	const session = sessionSettings({ payload: input, passwdHome: home, uid });
	useSession(session.settings);
	known.settings = session.settings;
	if (session.path !== null) touchPin(session.path);
	if (hook === "session-start") sweep({ passwdHome: home, uid });
	const configured = session.kind === "configured" && session.settings.refused === null;
	if (hook === "session-start" && configured) {
		// The parent prints SessionStart's banner; only the request leaves, and from the child.
		setChildProbe(childUnsupported() === null ? await probeInChild(session, home) : false);
	}
	if (configured && hook !== "session-start") {
		const unsupported = childUnsupported();
		if (unsupported !== null) await childFailed(hook, session.settings, input, unsupported);
		else await runInChild(hook, text, input, session, home);
		return;
	}
	launch({ payload: text, startedAt: STARTED });
	await import(`./${hook}.mjs`);
}

let failure;

/**
 * Anything the parent throws that nothing caught, here or in the hook it runs, ends as a
 * failed child does (`childFailed`, by `childOutcome`): exit 2 for an enforce PreToolUse
 * without failOpen, else exit 0 and a gap. Never exit 1: Claude Code reads it as a
 * non-blocking error, and lets the call run with no gap. Before the session is known, its
 * settings are resolved as they were before pins, and refused if even that fails. One
 * outcome per process: a second throw waits for the first's.
 */
function launcherFailed(hook, err) {
	failure ??= (async () => {
		let current = known.settings;
		if (current === null) {
			try {
				current = resolvedSettings();
			} catch {
				current = refusedSettings("launch: no settings", passwdHome());
			}
		}
		const what = `an unexpected ${err?.code ?? err?.name ?? "error"}`;
		try {
			await childFailed(hook, current, known.input, what);
		} catch {
			// The gap or the note could not be written: the exit still follows the table.
			const { mode, failOpen } = current;
			process.exitCode = childOutcome({ hook, mode, failOpen, what }).exitCode;
		}
	})();
	return failure;
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
	const home = flag("home");
	useBreakerHome(typeof home === "string" && isAbsolute(home) ? home : null);
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
	if (!HOOKS.has(hook) && !(hook === PROBE && process.argv.includes(CHILD))) {
		say("usertrust: launch.mjs runs a hook: session-start, pre-tool-use, ...");
		process.exitCode = 1;
	} else if (process.argv.includes(CHILD)) {
		await child(hook);
	} else {
		// A throw in a callback, or a rejection nothing awaits, never reaches the catch.
		const failed = (err) => launcherFailed(hook, err).finally(() => process.exit());
		process.on("uncaughtException", failed);
		process.on("unhandledRejection", failed);
		try {
			await parent(hook);
		} catch (err) {
			await launcherFailed(hook, err);
		}
	}
}
