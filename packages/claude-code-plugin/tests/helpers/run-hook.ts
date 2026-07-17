import { spawn } from "node:child_process";

export interface HookRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run a hook script the way Claude Code does: spawn node, write the JSON
 * payload to stdin, collect stdout/stderr and the exit code. Promisified
 * execFile has no `input` option, hence spawn.
 */
export function runHook(
	hookPath: string,
	input: unknown,
	env: Record<string, string>,
): Promise<HookRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [hookPath], {
			env: { ...process.env, ...env },
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
