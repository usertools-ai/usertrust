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
	/**
	 * The SessionEnd deadline in force for this run, in ms from spawn: the run's
	 * `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` when it carries a readable one, else the host's
	 * default of 1,500 ms. Undefined for any other hook.
	 */
	hostDeadlineMs: number | undefined;
	/**
	 * True when `runHook` killed the hook at that deadline, as Claude Code does. What a test
	 * asserts of such a run's records is an exit a real host never lets the hook reach.
	 */
	killedAtHostDeadline: boolean;
}

/**
 * Fail a test that read a SessionEnd hook's exit from a run the host would have killed. The
 * message names the deadline, so the failure says why the records it would have asserted
 * are not the evidence they look like.
 */
export function assertNotKilledAtHostDeadline(result: HookRunResult): HookRunResult {
	if (result.killedAtHostDeadline) {
		throw new Error(
			`the SessionEnd hook was still running at the host deadline of ${result.hostDeadlineMs} ms (CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS) and was killed there, as Claude Code kills it: what this test asserts of the hook's exit never happens in production`,
		);
	}
	return result;
}

/** How long a killed hook gets to exit on SIGTERM before SIGKILL (launch.mjs forwards SIGTERM to its child). */
const KILL_GRACE_MS = 1_000;

/**
 * The host's default SessionEnd deadline, in ms from spawn. From Claude Code's hooks reference,
 * https://code.claude.com/docs/en/hooks, section "SessionEnd": "SessionEnd hooks have a default
 * timeout of 1.5 seconds. It applies when you exit, run `/clear`, or switch sessions with
 * interactive `/resume`." and "Timeouts set on plugin-provided hooks don't raise the budget."
 * Written from the documentation, not from the hook's own constant, so a drift in the hook's
 * default cannot move the deadline the hook is tested against.
 */
export const HOST_SESSION_END_DEFAULT_MS = 1_500;

/**
 * The deadline Claude Code enforces on a SessionEnd hook, from the env the hook runs with:
 * the value of `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` when it reads as one (digits only, the
 * same reading as the hook's, lib.mjs `sessionEndBudgetMs`), else the host's default
 * (`HOST_SESSION_END_DEFAULT_MS`) for a variable that is absent, empty or unreadable. Any other
 * hook has no deadline here. The documentation gives the default only for a variable that is not
 * set; it says nothing of an empty or unreadable value, and the harness assumes the host falls
 * back to its default there too, as the hook itself does.
 */
function hostDeadlineFor(script: string[], env: Record<string, string | undefined>) {
	const isSessionEnd =
		script.length === 2
			? script[1] === "session-end"
			: basename(script[0] ?? "") === "session-end.mjs";
	if (!isSessionEnd) return undefined;
	const raw = env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS ?? "";
	return /^[0-9]{1,9}$/.test(raw) ? Number(raw) : HOST_SESSION_END_DEFAULT_MS;
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
 *   mode-dependent test. Each test passes the ones it means. Nor is
 *   `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`: one exported in the shell would set the
 *   budget and the host deadline of every SessionEnd run; only a test's own value counts.
 * - Every run gets the passwd-home preload (`passwdHomeFor`). `nodeArgs` go before
 *   launch.mjs's path (another test-only `--import` preload, say).
 * - `timeoutMs`, when given, kills a hook that runs longer (exit code 1): a test of a
 *   hook that must never hang reports the hang as a failure instead of hanging itself.
 * - SessionEnd's host deadline is enforced as Claude Code enforces it: a session-end hook
 *   still running `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` ms after spawn is killed (SIGTERM,
 *   then SIGKILL), or the host's default of 1,500 ms when the run's env leaves the variable
 *   absent, empty or unreadable, and the result says so
 *   (`killedAtHostDeadline`, with the deadline in `hostDeadlineMs`). The earlier of that and
 *   `timeoutMs` applies. A test of a SessionEnd exit passes the result through
 *   `assertNotKilledAtHostDeadline`, so a path a real host kills cannot pass on its records.
 */
export function runHook(
	hookPath: string,
	input: unknown,
	env: Record<string, string>,
	nodeArgs: string[] = [],
	{ timeoutMs }: { timeoutMs?: number } = {},
): Promise<HookRunResult> {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !name.startsWith("UT_") && name !== "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS",
		),
	);
	const script =
		dirname(hookPath) === HOOKS && basename(hookPath) !== "launch.mjs"
			? [LAUNCH, basename(hookPath, ".mjs")]
			: [hookPath];
	const preload = nodeArgs.includes(PASSWD_HOME_PRELOAD) ? [] : ["--import", PASSWD_HOME_PRELOAD];
	const hostDeadlineMs = hostDeadlineFor(script, { ...inherited, ...env });
	// The earlier of the host's deadline and the caller's own: the host's is ours to enforce
	// only when it comes first, so a kill is attributed to the one that made it.
	const hostFirst =
		hostDeadlineMs !== undefined && (timeoutMs === undefined || hostDeadlineMs < timeoutMs);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...preload, ...nodeArgs, ...script], {
			env: {
				...inherited,
				// Never the developer's own Claude Code settings (peer-meter.mjs reads
				// `enabledPlugins` from them): a home and a project of the run's own.
				CLAUDE_CONFIG_DIR: join(passwdHomeFor(env), ".claude"),
				CLAUDE_PROJECT_DIR: join(passwdHomeFor(env), "project"),
				...env,
				TEST_PASSWD_HOME: passwdHomeFor(env),
			},
			stdio: ["pipe", "pipe", "pipe"],
			...(timeoutMs === undefined || hostFirst ? {} : { timeout: timeoutMs }),
		});
		let killedAtHostDeadline = false;
		let hardKill: NodeJS.Timeout | undefined;
		const hostKill = hostFirst
			? setTimeout(() => {
					killedAtHostDeadline = true;
					child.kill("SIGTERM");
					hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
				}, hostDeadlineMs)
			: undefined;
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
			clearTimeout(hostKill);
			clearTimeout(hardKill);
			resolve({
				code: code ?? 1,
				stdout,
				stderr,
				pid: child.pid,
				hostDeadlineMs,
				killedAtHostDeadline,
			});
		});
		child.stdin.write(JSON.stringify(input));
		child.stdin.end();
	});
}
