// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Tests for usertrust completions <shell> CLI command.
 * Verifies bash, zsh, and fish completion scripts are correct.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/completions.js";

const ALL_COMMANDS = ["init", "inspect", "health", "verify", "snapshot", "tb", "completions"];

describe("usertrust completions", () => {
	let logOutput: string[];
	let stdoutOutput: string[];

	beforeEach(() => {
		logOutput = [];
		stdoutOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdoutOutput.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── bash ──

	describe("bash", () => {
		it("outputs a bash completion script with _usertrust function", async () => {
			await run("bash");

			const output = stdoutOutput.join("");
			expect(output).toContain("_usertrust()");
			expect(output).toContain("COMPREPLY");
			expect(output).toContain("compgen");
			expect(output).toContain("complete -F _usertrust usertrust");
		});

		it("lists all commands in bash output", async () => {
			await run("bash");

			const output = stdoutOutput.join("");
			for (const cmd of ALL_COMMANDS) {
				expect(output).toContain(cmd);
			}
		});

		it("includes snapshot subcommands", async () => {
			await run("bash");

			const output = stdoutOutput.join("");
			expect(output).toContain("create");
			expect(output).toContain("restore");
			expect(output).toContain("list");
		});

		it("includes tb subcommands", async () => {
			await run("bash");

			const output = stdoutOutput.join("");
			expect(output).toContain("start");
			expect(output).toContain("stop");
			expect(output).toContain("status");
		});

		it("includes global flags", async () => {
			await run("bash");

			const output = stdoutOutput.join("");
			expect(output).toContain("--json");
			expect(output).toContain("--help");
		});
	});

	// ── zsh ──

	describe("zsh", () => {
		it("outputs a zsh completion script with compdef", async () => {
			await run("zsh");

			const output = stdoutOutput.join("");
			expect(output).toContain("#compdef usertrust");
			expect(output).toContain("compdef _usertrust usertrust");
		});

		it("lists all commands in zsh output", async () => {
			await run("zsh");

			const output = stdoutOutput.join("");
			for (const cmd of ALL_COMMANDS) {
				expect(output).toContain(cmd);
			}
		});

		it("includes snapshot subcommands", async () => {
			await run("zsh");

			const output = stdoutOutput.join("");
			expect(output).toContain("create");
			expect(output).toContain("restore");
			expect(output).toContain("list");
		});

		it("includes tb subcommands", async () => {
			await run("zsh");

			const output = stdoutOutput.join("");
			expect(output).toContain("start");
			expect(output).toContain("stop");
			expect(output).toContain("status");
		});

		it("includes global flags", async () => {
			await run("zsh");

			const output = stdoutOutput.join("");
			expect(output).toContain("--json");
			expect(output).toContain("--help");
		});
	});

	// ── fish ──

	describe("fish", () => {
		it("outputs a fish completion script with complete -c usertrust", async () => {
			await run("fish");

			const output = stdoutOutput.join("");
			expect(output).toContain("complete -c usertrust");
		});

		it("lists all commands in fish output", async () => {
			await run("fish");

			const output = stdoutOutput.join("");
			for (const cmd of ALL_COMMANDS) {
				expect(output).toContain(cmd);
			}
		});

		it("includes snapshot subcommands", async () => {
			await run("fish");

			const output = stdoutOutput.join("");
			expect(output).toContain("create");
			expect(output).toContain("restore");
			expect(output).toContain("list");
		});

		it("includes tb subcommands", async () => {
			await run("fish");

			const output = stdoutOutput.join("");
			expect(output).toContain("start");
			expect(output).toContain("stop");
			expect(output).toContain("status");
		});

		it("includes global flags", async () => {
			await run("fish");

			const output = stdoutOutput.join("");
			// fish uses `-l json` and `-l help` syntax for long flags
			expect(output).toContain("-l json");
			expect(output).toContain("-l help");
		});
	});

	// ── error cases ──

	describe("error handling", () => {
		it("shows usage help when no shell is given", async () => {
			await run(undefined);

			const output = logOutput.join("\n");
			expect(output).toContain("Usage:");
			expect(output).toContain("bash");
			expect(output).toContain("zsh");
			expect(output).toContain("fish");
		});

		it("shows usage help for invalid shell name", async () => {
			await run("powershell");

			const output = logOutput.join("\n");
			expect(output).toContain("Usage:");
			expect(output).toContain("bash");
			expect(output).toContain("zsh");
			expect(output).toContain("fish");
		});
	});

	// ── --json mode ──

	describe("--json flag", () => {
		it("outputs valid JSON with script for bash", async () => {
			await run("bash", { json: true });

			const result = JSON.parse(logOutput[0] ?? "{}") as {
				command: string;
				success: boolean;
				data: { shell: string; script: string };
			};
			expect(result.command).toBe("completions");
			expect(result.success).toBe(true);
			expect(result.data.shell).toBe("bash");
			expect(result.data.script).toContain("_usertrust()");
			expect(result.data.script).toContain("COMPREPLY");
		});

		it("outputs valid JSON with script for zsh", async () => {
			await run("zsh", { json: true });

			const result = JSON.parse(logOutput[0] ?? "{}") as {
				command: string;
				success: boolean;
				data: { shell: string; script: string };
			};
			expect(result.command).toBe("completions");
			expect(result.success).toBe(true);
			expect(result.data.shell).toBe("zsh");
			expect(result.data.script).toContain("#compdef usertrust");
		});

		it("outputs valid JSON with script for fish", async () => {
			await run("fish", { json: true });

			const result = JSON.parse(logOutput[0] ?? "{}") as {
				command: string;
				success: boolean;
				data: { shell: string; script: string };
			};
			expect(result.command).toBe("completions");
			expect(result.success).toBe(true);
			expect(result.data.shell).toBe("fish");
			expect(result.data.script).toContain("complete -c usertrust");
		});

		it("outputs JSON error when no shell is given", async () => {
			await run(undefined, { json: true });

			const result = JSON.parse(logOutput[0] ?? "{}") as {
				command: string;
				success: boolean;
				data: { message: string; shells: string[] };
			};
			expect(result.command).toBe("completions");
			expect(result.success).toBe(false);
			expect(result.data.message).toBe("No shell specified");
			expect(result.data.shells).toEqual(["bash", "zsh", "fish"]);
		});

		it("outputs JSON error for invalid shell", async () => {
			await run("powershell", { json: true });

			const result = JSON.parse(logOutput[0] ?? "{}") as {
				command: string;
				success: boolean;
				data: { message: string; shells: string[] };
			};
			expect(result.command).toBe("completions");
			expect(result.success).toBe(false);
			expect(result.data.message).toBe("Unknown shell: powershell");
			expect(result.data.shells).toEqual(["bash", "zsh", "fish"]);
		});

		it("contains no ANSI escape codes in JSON output", async () => {
			const ESC = String.fromCodePoint(0x1b);

			await run("bash", { json: true });
			for (const line of logOutput) {
				expect(line.includes(ESC)).toBe(false);
			}

			logOutput = [];
			await run(undefined, { json: true });
			for (const line of logOutput) {
				expect(line.includes(ESC)).toBe(false);
			}
		});
	});
});
