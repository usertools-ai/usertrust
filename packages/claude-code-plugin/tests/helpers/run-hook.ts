import { spawn } from "node:child_process";

export interface HookRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run a hook script the way Claude Code does: spawn node, write the JSON
 * payload to stdin, collect stdout/stderr and the exit code. Promisified
 * execFile has no `input` option, hence spawn. The plugin's own `UT_*`
 * variables are never inherited from the shell running the tests (a developer
 * with `UT_CC_MODE=enforce` exported would otherwise flip every mode-dependent
 * test): each test passes the ones it means. `nodeArgs` go before the hook's path
 * (a test-only `--import` preload, say).
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
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...nodeArgs, hookPath], {
			env: { ...inherited, ...env },
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
			resolve({ code: code ?? 1, stdout, stderr });
		});
		child.stdin.write(JSON.stringify(input));
		child.stdin.end();
	});
}
