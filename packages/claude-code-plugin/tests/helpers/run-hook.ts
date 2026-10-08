import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface HookRunResult {
	code: number;
	stdout: string;
	stderr: string;
	/** The hook process's pid: the parent, when a configured session's hook runs as a child. */
	pid: number | undefined;
}

const HOOKS = join(import.meta.dirname, "..", "..", "hooks");
/** Every hook's entry point: `node launch.mjs <hook>`, as hooks.json runs it. */
export const LAUNCH = join(HOOKS, "launch.mjs");
/** The test-only preload that moves the passwd home (passwd-home.mjs). */
export const PASSWD_HOME_PRELOAD = join(import.meta.dirname, "passwd-home.mjs");

/**
 * The passwd home a run's hooks pin their sessions under, never the real one. It is
 * the test's own (TEST_PASSWD_HOME), else one named by the hash of UT_CC_STATE_DIR:
 * the hooks of one test share their pins (one state dir, one session), and the next
 * test starts clean. It's kept apart from the test's own directories, and given by its
 * real path, since a pin's directories may hold no symlink.
 */
export function passwdHomeFor(env: Record<string, string>): string {
	if (env.TEST_PASSWD_HOME !== undefined) return env.TEST_PASSWD_HOME;
	const state = env.UT_CC_STATE_DIR;
	if (state === undefined) return realpathSync(mkdtempSync(join(tmpdir(), "utcc-home-")));
	const home = join(
		tmpdir(),
		"utcc-homes",
		createHash("sha256").update(state).digest("hex").slice(0, 24),
	);
	mkdirSync(home, { recursive: true });
	return realpathSync(home);
}

/** The directory a run's sessions are pinned in (session.mjs), under its passwd home. */
export function pinsDir(env: Record<string, string>): string {
	return join(passwdHomeFor(env), ".local", "state", "usertrust", "sessions");
}

/**
 * Forget a run's pins, as a user deleting them by hand would: the next hook of each
 * session pins the settings then current. It's how a test changes a session's server,
 * key or state dir midway, which a pinned session otherwise never sees.
 */
export function forgetPins(env: Record<string, string>): void {
	rmSync(pinsDir(env), { recursive: true, force: true });
}

/**
 * Run a hook the way Claude Code does: spawn node on launch.mjs with the hook's name,
 * as hooks.json runs it, write the JSON payload to stdin, and collect stdout/stderr
 * and the exit code. `hookPath` names the hook by its module (`hooks/stop.mjs`).
 * Promisified execFile has no `input` option, hence spawn.
 * - The plugin's own `UT_*` variables are never inherited from the shell running the
 *   tests: a developer with `UT_CC_MODE=enforce` exported would otherwise flip every
 *   mode-dependent test. Each test passes the ones it means.
 * - Every run gets the passwd-home preload (`passwdHomeFor`). `nodeArgs` go before
 *   launch.mjs's path (another test-only `--import` preload, say).
 */
export function runHook(
	hookPath: string,
	input: unknown,
	env: Record<string, string>,
	nodeArgs: string[] = [],
): Promise<HookRunResult> {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith("UT_")),
	);
	const script =
		dirname(hookPath) === HOOKS && basename(hookPath) !== "launch.mjs"
			? [LAUNCH, basename(hookPath, ".mjs")]
			: [hookPath];
	const preload = nodeArgs.includes(PASSWD_HOME_PRELOAD) ? [] : ["--import", PASSWD_HOME_PRELOAD];
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...preload, ...nodeArgs, ...script], {
			env: { ...inherited, ...env, TEST_PASSWD_HOME: passwdHomeFor(env) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr, pid: child.pid });
		});
		child.stdin.write(JSON.stringify(input));
		child.stdin.end();
	});
}
