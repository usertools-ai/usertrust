import { type ChildProcessByStdio, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @clack/prompts before importing init
vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	text: vi.fn(),
	confirm: vi.fn(),
	log: {
		info: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		step: vi.fn(),
		message: vi.fn(),
	},
	spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
	isCancel: vi.fn(() => false),
}));

// Mock key validation to avoid network calls
vi.mock("../../src/cli/validate-key.js", () => ({
	detectProvider: vi.fn((key: string) => {
		if (key.startsWith("sk-ant-")) return "anthropic";
		if (key.startsWith("sk-")) return "openai";
		return null;
	}),
	validateKey: vi.fn().mockResolvedValue({ valid: true }),
	maskKey: vi.fn((key: string) => `${key.slice(0, 8)}••••••••`),
}));

import * as clack from "@clack/prompts";
import { run } from "../../src/cli/init.js";

/**
 * `.usertrust/.env` holds API keys, so it must be owner-only (0600) whatever was there
 * before. A mode given to an in-place write applies only when the file is CREATED: a
 * reconfigure over an existing 0644 `.env` truncated it and wrote the new key into that
 * 0644 inode. It is now written to a fresh owner-only file and renamed over `.env`.
 */

const OLD_KEY = "sk-ant-OLD-0000";

/** One interactive init (or reconfigure) that stores `key`. */
async function initWithKey(root: string, key: string, reconfigure: boolean): Promise<void> {
	vi.mocked(clack.text)
		.mockResolvedValueOnce(key) // the key
		.mockResolvedValueOnce("") // no more keys
		.mockResolvedValueOnce("50"); // budget
	vi.mocked(clack.confirm).mockResolvedValueOnce(true); // recommended rates
	await run(root, { reconfigure, skipVerify: true });
}

/** A `.env` other users can read, holding the old key: what a reconfigure starts from. */
function readableOldEnv(envPath: string): void {
	try {
		unlinkSync(envPath);
	} catch {
		// absent
	}
	writeFileSync(envPath, `ANTHROPIC_API_KEY="${OLD_KEY}"\n`, { mode: 0o644 });
	chmodSync(envPath, 0o644);
}

const SAMPLER = join(import.meta.dirname, "..", "fixtures", "env-mode-sampler.mjs");

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Collects the sampler's stdout: `ready` resolves once it has printed "ready". */
function samplerOutput(child: ChildProcessByStdio<null, Readable, null>): {
	ready: Promise<void>;
	text: () => string;
} {
	let out = "";
	child.stdout.setEncoding("utf-8");
	const ready = new Promise<void>((resolve) => {
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
			if (out.includes("ready")) resolve();
		});
	});
	return { ready, text: () => out };
}

/**
 * Runs `body` with the sampler watching `vault`, and returns the sampler's output. The teardown
 * is in a `finally`, so a body that throws (or a test that fails) still writes the stop file,
 * kills the sampler and WAITS for it to exit: a sampler left running spins on a vault the test's
 * cleanup removes, and can keep the test worker alive.
 */
async function withSampler(
	vault: string,
	stopFile: string,
	body: (child: ChildProcessByStdio<null, Readable, null>) => Promise<void>,
): Promise<string> {
	const child = spawn(process.execPath, [SAMPLER, vault, stopFile], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const exited = new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once("exit", () => resolve());
	});
	const output = samplerOutput(child);
	try {
		await output.ready;
		await body(child);
		writeFileSync(stopFile, "");
		await exited;
		return output.text();
	} finally {
		try {
			writeFileSync(stopFile, "");
		} catch {
			// the root is gone: the sampler stops on its own
		}
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	}
}

describe("usertrust init: .env is always owner-only", () => {
	let root: string;
	let vault: string;
	let envPath: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "trust-init-env-"));
		vault = join(root, ".usertrust");
		envPath = join(vault, ".env");
		await initWithKey(root, OLD_KEY, false);
	});

	afterEach(() => {
		vi.clearAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("a reconfigure over a 0644 .env leaves a 0600 file with the new key, and the old inode untouched", async () => {
		readableOldEnv(envPath);
		const oldFd = openSync(envPath, "r");
		try {
			const oldIno = fstatSync(oldFd).ino;
			await initWithKey(root, "sk-ant-NEW-1", true);

			const st = statSync(envPath);
			expect(st.mode & 0o777).toBe(0o600);
			expect(readFileSync(envPath, "utf-8")).toContain("sk-ant-NEW-1");
			// A different file: the new key was never written into the old one.
			expect(st.ino).not.toBe(oldIno);
			const oldBytes = readFileSync(oldFd, "utf-8");
			expect(oldBytes).toContain(OLD_KEY);
			expect(oldBytes).not.toContain("sk-ant-NEW-1");
		} finally {
			closeSync(oldFd);
		}
	});

	it("no sampled instant shows a new key in a group- or other-readable file, over 100 reconfigures", async () => {
		const out = await withSampler(vault, join(root, "stop"), async () => {
			for (let i = 0; i < 100; i++) {
				readableOldEnv(envPath);
				await initWithKey(root, `sk-ant-NEW-${i}`, true);
				// Hand the sampler the post-reconfigure state as well, not only the write.
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
		});

		const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
			samples: number;
			exposed: number;
		};
		const seen = `sampler: ${JSON.stringify(result)}`;
		expect(result.samples, seen).toBeGreaterThan(100);
		expect(result.exposed, seen).toBe(0);
	}, 60_000);

	it("a reconfigure that throws still leaves no sampler running", async () => {
		let pid: number | undefined;
		const forced = new Error("forced reconfigure failure");
		await expect(
			withSampler(vault, join(root, "stop"), async (child) => {
				pid = child.pid;
				vi.mocked(clack.text).mockRejectedValueOnce(forced);
				await run(root, { reconfigure: true, skipVerify: true });
			}),
		).rejects.toBe(forced);
		expect(pid).toBeDefined();
		expect(alive(pid as number)).toBe(false);
	}, 30_000);

	it("the sampler exits by itself once the vault is gone, with no stop file", async () => {
		const child = spawn(process.execPath, [SAMPLER, vault, join(root, "never")], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		try {
			await samplerOutput(child).ready;
			rmSync(vault, { recursive: true, force: true });
			const exited = await Promise.race([
				new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
			]);
			expect(exited).toBe(true);
		} finally {
			child.kill("SIGKILL");
		}
	}, 30_000);

	it("a symlinked .env is replaced by a file; its target is never written", async () => {
		const target = join(root, "elsewhere.env");
		writeFileSync(target, "SENTINEL\n", { mode: 0o644 });
		unlinkSync(envPath);
		symlinkSync(target, envPath);

		await initWithKey(root, "sk-ant-NEW-2", true);

		const st = lstatSync(envPath);
		expect(st.isSymbolicLink()).toBe(false);
		expect(st.mode & 0o777).toBe(0o600);
		expect(readFileSync(envPath, "utf-8")).toContain("sk-ant-NEW-2");
		expect(readFileSync(target, "utf-8")).toBe("SENTINEL\n");
	});
});
