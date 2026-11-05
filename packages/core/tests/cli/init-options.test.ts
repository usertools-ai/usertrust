// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust init` without a terminal (an agent's shell, CI, a pipe): the options it takes, the key
 * file it leaves, and what a second run does. The CLI is spawned as a shell runs it, with stdin a
 * pipe closed at once; the rows that need no process call `run()` directly.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, writeKeys } from "../../src/cli/init.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
const MAIN = join(repoRoot, "packages", "core", "src", "cli", "main.ts");

/** The parent environment with every `*_API_KEY` removed: an exported key overrides `--env-file`, and a failure would print it. */
function envWithoutKeys(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY")));
}

function runCli(cwd: string, args: string[]) {
	const r = spawnSync(TSX, [MAIN, ...args], {
		cwd,
		env: envWithoutKeys(),
		encoding: "utf-8",
		// timing: 30 s bound on one CLI start; it ran in about 1 s when measured (30x headroom)
		timeout: 30_000,
		input: "",
	});
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "trust-init-options-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const vault = (...parts: string[]) => join(dir, ".usertrust", ...parts);

describe("usertrust init refuses an option it does not have", () => {
	it.each(["--bogus", "--ledger", "--starter", "--no-install", "--no-call"])(
		"init %s: exit 2, and no vault",
		(flag) => {
			// The four named ones are unknown until the change that makes each real.
			const { code, stdout } = runCli(dir, ["init", flag]);
			expect(code).toBe(2);
			expect(stdout).toContain(`has no option "${flag}"`);
			expect(existsSync(vault())).toBe(false);
		},
		40_000, // timing: 40 s test budget over a CLI start that took about 1 s when measured
	);
});

describe("usertrust init leaves a key file", () => {
	it.skipIf(process.platform === "win32")(
		"--json makes an owner-only commented template when there is none",
		async () => {
			await run(dir, { json: true });
			const env = vault(".env");
			expect(existsSync(env)).toBe(true);
			expect(statSync(env).mode & 0o777).toBe(0o600);
			const lines = readFileSync(env, "utf-8")
				.split("\n")
				.filter((l) => l.trim() !== "");
			// Every line is a comment, so it loads as no variables at all.
			expect(lines.length).toBeGreaterThan(0);
			expect(lines.every((l) => l.startsWith("#"))).toBe(true);
		},
	);

	it("without a terminal the CLI makes the template, so --env-file can read it", () => {
		const first = runCli(dir, ["init"]);
		expect(first.code).toBe(0);
		expect(existsSync(vault(".env"))).toBe(true);
		const loaded = spawnSync(
			process.execPath,
			[
				"--env-file",
				vault(".env"),
				"-e",
				"process.stdout.write(String(process.env.ANTHROPIC_API_KEY))",
			],
			{ encoding: "utf-8", env: envWithoutKeys() },
		);
		expect(loaded.status).toBe(0);
		expect(loaded.stdout).toBe("undefined");
	}, 40_000); // timing: 40 s test budget over a CLI start that took about 1 s when measured

	it("a key file that holds a key is byte-identical after another run", async () => {
		await run(dir, { json: true });
		const env = vault(".env");
		const mine = '# mine\nANTHROPIC_API_KEY="sk-ant-existing-0000"\n';
		writeFileSync(env, mine, { mode: 0o600 });
		await run(dir, { json: true });
		await run(dir, { interactive: false });
		expect(readFileSync(env, "utf-8")).toBe(mine);
	});

	it("a vault from before the key file existed gets the template on a re-run", async () => {
		await run(dir, { json: true });
		rmSync(vault(".env"));
		const configBefore = readFileSync(vault("usertrust.config.json"), "utf-8");
		await run(dir, { json: true });
		expect(existsSync(vault(".env"))).toBe(true);
		expect(readFileSync(vault("usertrust.config.json"), "utf-8")).toBe(configBefore);
	});

	it.skipIf(process.platform === "win32")(
		"a symlink in its place is never written through",
		async () => {
			await run(dir, { json: true });
			rmSync(vault(".env"));
			const target = join(dir, "elsewhere.txt");
			symlinkSync(target, vault(".env"));
			await run(dir, { json: true });
			expect(existsSync(target)).toBe(false);
		},
	);
});

describe("running init again carries on", () => {
	it("exits 0, keeps the config as it is, and says the vault exists", () => {
		expect(runCli(dir, ["init"]).code).toBe(0);
		const config = vault("usertrust.config.json");
		writeFileSync(
			config,
			readFileSync(config, "utf-8").replace('"tier": "mini"', '"tier": "mini"'),
		);
		const before = readFileSync(config, "utf-8");
		const again = runCli(dir, ["init"]);
		expect(again.code).toBe(0);
		expect(again.stdout + again.stderr).toContain("Vault already exists");
		expect(readFileSync(config, "utf-8")).toBe(before);
	}, 60_000); // timing: 60 s test budget over two CLI starts of about 1 s each when measured

	it("--json reports success, created: false, and the config untouched", async () => {
		await run(dir, { json: true });
		const config = vault("usertrust.config.json");
		const before = readFileSync(config, "utf-8");
		const lines: string[] = [];
		const log = console.log;
		console.log = (...args: unknown[]) => {
			lines.push(args.join(" "));
		};
		try {
			await run(dir, { json: true });
		} finally {
			console.log = log;
		}
		const report = JSON.parse(lines.join("\n")) as {
			success: boolean;
			data: { created: boolean; message: string };
		};
		expect(report.success).toBe(true);
		expect(report.data.created).toBe(false);
		expect(report.data.message).toContain("already exists");
		expect(readFileSync(config, "utf-8")).toBe(before);
	});
});

describe("writing a typed key into a key file that already has lines", () => {
	const envPath = () => vault(".env");
	const seed = (content: string) => {
		mkdirSync(vault(), { recursive: true });
		writeFileSync(envPath(), content, { mode: 0o600 });
	};
	/** What a process that loads the file with Node's own loader sees for a variable. */
	const loaded = (name: string): string => {
		const r = spawnSync(
			process.execPath,
			["--env-file", envPath(), "-e", `process.stdout.write(String(process.env.${name}))`],
			{ encoding: "utf-8", env: envWithoutKeys() },
		);
		return r.stdout;
	};

	it("a variable assigned twice ends with one line, holding the new key, as Node loads it", () => {
		seed('ANTHROPIC_API_KEY="sk-ant-old-1"\nOTHER=1\nANTHROPIC_API_KEY="sk-ant-old-2"\n');
		writeKeys(vault(), { anthropic: "sk-ant-new-0000" });
		const after = readFileSync(envPath(), "utf-8");
		expect(after).toBe('ANTHROPIC_API_KEY="sk-ant-new-0000"\nOTHER=1\n');
		// Node takes the last assignment: a rotation that kept the old later line would load the old key.
		expect(loaded("ANTHROPIC_API_KEY")).toBe("sk-ant-new-0000");
	});

	it("an `export` form of the same variable is replaced or dropped too", () => {
		seed(
			"export ANTHROPIC_API_KEY=old-a\nANTHROPIC_API_KEY=old-b\n  export ANTHROPIC_API_KEY = old-c\n",
		);
		writeKeys(vault(), { anthropic: "sk-ant-new-0000" });
		expect(readFileSync(envPath(), "utf-8")).toBe('ANTHROPIC_API_KEY="sk-ant-new-0000"\n');
	});

	it("a name with pattern characters matches only itself: no throw, no other key line touched", () => {
		const other = 'ABC_API_KEY="keep-me"\nA_C_API_KEY="keep-me-too"\n';
		for (const provider of ["a.c", "a(c", "a[c", "a*c", "a+c", "a|c"]) {
			seed(other);
			expect(() => writeKeys(vault(), { [provider]: "typed-key-0000" })).not.toThrow();
			const after = readFileSync(envPath(), "utf-8");
			expect(after.startsWith(other), provider).toBe(true);
			expect(after, provider).toContain('"typed-key-0000"');
		}
	});

	it("a commented-out line for the variable is not an assignment and is kept", () => {
		seed('# ANTHROPIC_API_KEY="sk-ant-old"\n');
		writeKeys(vault(), { anthropic: "sk-ant-new-0000" });
		expect(readFileSync(envPath(), "utf-8")).toBe(
			'# ANTHROPIC_API_KEY="sk-ant-old"\nANTHROPIC_API_KEY="sk-ant-new-0000"\n',
		);
	});
});

describe("running init over a vault that already exists", () => {
	const envTemplate = () => vault(".env");

	it("a vault made by the SDK (no .gitignore) gets the ignore entries before the template", async () => {
		mkdirSync(vault(), { recursive: true, mode: 0o700 });
		await run(dir, { json: true });
		const ignore = readFileSync(vault(".gitignore"), "utf-8").split("\n");
		for (const entry of [".env", ".env.*.tmp", "dlq/", "tigerbeetle/", "*.tigerbeetle"]) {
			expect(ignore, entry).toContain(entry);
		}
		expect(existsSync(envTemplate())).toBe(true);
	});

	it("an existing .gitignore keeps its lines, gains only what is missing, and is not grown by a re-run", async () => {
		mkdirSync(vault(), { recursive: true, mode: 0o700 });
		writeFileSync(vault(".gitignore"), "mine/\n.env", { mode: 0o600 }); // no trailing newline
		await run(dir, { json: true });
		await run(dir, { json: true });
		const text = readFileSync(vault(".gitignore"), "utf-8");
		const lines = text.split("\n").filter(Boolean);
		expect(lines.slice(0, 2)).toEqual(["mine/", ".env"]);
		// The block ends the file, so nothing after it can undo it; a re-run adds nothing.
		expect(lines.slice(-5)).toEqual([
			"tigerbeetle/",
			"*.tigerbeetle",
			"dlq/",
			".env",
			".env.*.tmp",
		]);
		await run(dir, { json: true });
		expect(readFileSync(vault(".gitignore"), "utf-8")).toBe(text);
	});

	it.skipIf(process.platform === "win32")(
		"a vault that is a symlink to a directory others can read is refused, and nothing is written into it",
		async () => {
			const target = join(dir, "shared");
			mkdirSync(target, { mode: 0o755 });
			chmodSync(target, 0o755);
			symlinkSync(target, vault());
			await expect(run(dir, { json: true })).rejects.toThrow(/other users can read/);
			expect(readdirSync(target)).toEqual([]);
		},
	);

	it("a vault that is not a directory is refused", async () => {
		writeFileSync(vault(), "not a directory");
		await expect(run(dir, { json: true })).rejects.toThrow();
		expect(readFileSync(vault(), "utf-8")).toBe("not a directory");
	});
});

describe("a .gitignore that names the key file but then un-ignores it", () => {
	/** git's own verdict, with a clean environment: exit 0 means the path is ignored. */
	const ignored = (path: string): boolean =>
		spawnSync("git", ["check-ignore", "-q", path], {
			cwd: dir,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: dir,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
			},
		}).status === 0;

	for (const negation of ["!*", "!.*", "!.env", "!.env.*.tmp", " .env", "\\!.env"]) {
		it(`${negation} after .env: re-running init makes the key file and its temp files ignored again`, async () => {
			spawnSync("git", ["init", "-q"], {
				cwd: dir,
				env: { PATH: process.env.PATH ?? "", HOME: dir },
			});
			mkdirSync(vault(), { recursive: true, mode: 0o700 });
			const seed = negation.startsWith("!")
				? `mine/\n.env\n.env.*.tmp\n${negation}\n`
				: `mine/\n${negation}\n`;
			writeFileSync(vault(".gitignore"), seed, { mode: 0o600 });
			// Positive control: git, not this code, says the seeded file leaves the key stageable.
			const tmp = ".usertrust/.env.abc123.tmp";
			expect(ignored(".usertrust/.env") && ignored(tmp), "seed must not ignore both").toBe(false);

			await run(dir, { json: true });
			expect(ignored(".usertrust/.env")).toBe(true);
			expect(ignored(tmp)).toBe(true);
			// Custom lines are kept in place, and the protection comes after the negation.
			const after = readFileSync(vault(".gitignore"), "utf-8");
			expect(after.startsWith(seed)).toBe(true);
			expect(after.endsWith("tigerbeetle/\n*.tigerbeetle\ndlq/\n.env\n.env.*.tmp\n")).toBe(true);

			// A second run changes nothing.
			await run(dir, { json: true });
			expect(readFileSync(vault(".gitignore"), "utf-8")).toBe(after);
		});
	}
});
