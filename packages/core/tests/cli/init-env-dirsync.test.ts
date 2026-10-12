import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vault directory's sync AFTER `.env` is renamed into place fails (as flushing a read-only
 * directory handle can on Windows, with EPERM or EBADF). `.env` is already replaced and
 * owner-only by then, so init must warn and carry on: it used to throw there, before writing
 * `.gitignore`. The failure is injected on the directory open that follows the rename.
 */

const failDirOpen = vi.hoisted(() => ({ dir: undefined as string | undefined, code: "" }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const openSync = ((path: unknown, flags: unknown, mode?: unknown) => {
		if (failDirOpen.dir !== undefined && path === failDirOpen.dir && flags === "r") {
			throw Object.assign(new Error(`${failDirOpen.code}: injected, open '${path}'`), {
				code: failDirOpen.code,
			});
		}
		return (actual.openSync as (...a: unknown[]) => number)(path, flags, mode);
	}) as typeof actual.openSync;
	return { ...actual, default: { ...actual, openSync }, openSync };
});

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

async function initWithKey(root: string, key: string, reconfigure: boolean): Promise<void> {
	vi.mocked(clack.text)
		.mockResolvedValueOnce(key) // the key
		.mockResolvedValueOnce("") // no more keys
		.mockResolvedValueOnce("50"); // budget
	vi.mocked(clack.confirm).mockResolvedValueOnce(true); // recommended rates
	await run(root, { reconfigure, skipVerify: true });
}

describe.skipIf(process.platform === "win32")(
	"usertrust init: a failed directory sync after .env is replaced",
	() => {
		let root: string;
		let vault: string;
		beforeEach(async () => {
			root = mkdtempSync(join(tmpdir(), "trust-init-dirsync-"));
			vault = join(root, ".usertrust");
			await initWithKey(root, "sk-ant-OLD-0000", false);
		});
		afterEach(() => {
			failDirOpen.dir = undefined;
			vi.restoreAllMocks();
			rmSync(root, { recursive: true, force: true });
		});

		for (const code of ["EPERM", "EBADF"]) {
			it(`${code}: the reconfigure completes, writes .gitignore, and warns that .env was replaced`, async () => {
				// .gitignore is written AFTER .env: its absence would show init stopped there.
				unlinkSync(join(vault, ".gitignore"));
				const stderr: string[] = [];
				vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
					stderr.push(String(chunk));
					return true;
				});
				failDirOpen.dir = vault;
				failDirOpen.code = code;

				await initWithKey(root, "sk-ant-NEW-1", true);

				expect(existsSync(join(vault, ".gitignore"))).toBe(true);
				expect(readFileSync(join(vault, ".gitignore"), "utf-8")).toContain(".env.*.tmp");
				const envPath = join(vault, ".env");
				expect(statSync(envPath).mode & 0o777).toBe(0o600);
				expect(readFileSync(envPath, "utf-8")).toContain("sk-ant-NEW-1");
				const warnings = stderr.filter((line) => line.includes("was replaced"));
				expect(warnings).toHaveLength(1);
				expect(warnings[0]).toContain(".env was replaced and is owner-only");
				expect(warnings[0]).toContain(code);
			});
		}
	},
);
