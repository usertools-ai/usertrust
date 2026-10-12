import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vault's `.gitignore`, which lists `.env` and `.env.*.tmp`, is in place BEFORE `.env` is
 * written. `.env` goes through a temp file beside it (`.env.<uuid>.tmp`), so a kill between that
 * temp file's creation and its rename leaves the API key in it; with `.gitignore` written after
 * `.env`, that file was not ignored, on a fresh init or on a vault whose `.gitignore` predates the
 * pattern. Every `node:fs` call these rows care about is recorded in order, and the `.env` rename
 * can be made to fail, standing in for the kill.
 */

const fsTrace = vi.hoisted(() => ({
	events: [] as string[],
	failEnvRename: false,
	gitignoreAtRename: undefined as string | undefined,
	vault: "",
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const isEnvTemp = (p: unknown) => typeof p === "string" && /\/\.env\.[^/]+\.tmp$/.test(p);
	const openSync = ((path: unknown, flags: unknown, mode?: unknown) => {
		if (isEnvTemp(path)) fsTrace.events.push("create .env temp");
		else if (path === fsTrace.vault && flags === "r") fsTrace.events.push("open vault dir");
		return (actual.openSync as (...a: unknown[]) => number)(path, flags, mode);
	}) as typeof actual.openSync;
	const writeFileSync = ((path: unknown, ...rest: unknown[]) => {
		if (typeof path === "string" && path.endsWith("/.gitignore")) {
			fsTrace.events.push("write .gitignore");
		}
		return (actual.writeFileSync as (...a: unknown[]) => void)(path, ...rest);
	}) as typeof actual.writeFileSync;
	const renameSync = ((from: unknown, to: unknown) => {
		if (isEnvTemp(from)) {
			fsTrace.events.push("rename .env temp");
			if (fsTrace.failEnvRename) {
				const ignore = join(fsTrace.vault, ".gitignore");
				fsTrace.gitignoreAtRename = actual.existsSync(ignore)
					? actual.readFileSync(ignore, "utf-8")
					: undefined;
				throw Object.assign(new Error("injected: the process died before the rename"), {
					code: "EIO",
				});
			}
		}
		return (actual.renameSync as (...a: unknown[]) => void)(from, to);
	}) as typeof actual.renameSync;
	const overrides = { openSync, writeFileSync, renameSync };
	return { ...actual, ...overrides, default: { ...actual, ...overrides } };
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
import { writePrivateFileAtomic } from "../../src/shared/private-fs.js";

async function initWithKey(root: string, key: string, reconfigure: boolean): Promise<void> {
	vi.mocked(clack.text)
		.mockResolvedValueOnce(key) // the key
		.mockResolvedValueOnce("") // no more keys
		.mockResolvedValueOnce("50"); // budget
	vi.mocked(clack.confirm).mockResolvedValueOnce(true); // recommended rates
	await run(root, { reconfigure, skipVerify: true });
}

describe("usertrust init: .gitignore is in place before .env is written", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trust-init-order-"));
		fsTrace.vault = join(root, ".usertrust");
		fsTrace.events.length = 0;
		fsTrace.failEnvRename = false;
		fsTrace.gitignoreAtRename = undefined;
	});
	afterEach(() => {
		vi.clearAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("a fresh keyed init writes .gitignore before it creates the .env temp file", async () => {
		await initWithKey(root, "sk-ant-NEW-1", false);
		const first = fsTrace.events.indexOf("write .gitignore");
		const temp = fsTrace.events.indexOf("create .env temp");
		expect(first).toBeGreaterThanOrEqual(0);
		expect(temp).toBeGreaterThan(first);
	});

	it("a reconfigure killed before the .env rename leaves the pattern in .gitignore and no temp file", async () => {
		await initWithKey(root, "sk-ant-OLD-0000", false);
		// A .gitignore written before `.env.*.tmp` was listed.
		const ignore = join(fsTrace.vault, ".gitignore");
		writeFileSync(ignore, "tigerbeetle/\n*.tigerbeetle\ndlq/\n.env\n");
		fsTrace.events.length = 0;
		fsTrace.failEnvRename = true;

		await expect(initWithKey(root, "sk-ant-NEW-2", true)).rejects.toThrow(/injected/);

		// At the moment the rename failed, the temp file holding the key was already ignored.
		expect(fsTrace.gitignoreAtRename).toBeDefined();
		const lines = (fsTrace.gitignoreAtRename ?? "").split("\n");
		expect(lines).toContain(".env.*.tmp");
		expect(lines).toContain(".env");
		expect(fsTrace.events.indexOf("write .gitignore")).toBeLessThan(
			fsTrace.events.indexOf("create .env temp"),
		);
		expect(readdirSync(fsTrace.vault).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		expect(readFileSync(join(fsTrace.vault, ".env"), "utf-8")).toContain("sk-ant-OLD-0000");
	});
});

describe("writePrivateFileAtomic on Windows", () => {
	it("opens no directory to sync, and warns nothing", () => {
		const dir = mkdtempSync(join(tmpdir(), "private-atomic-win-"));
		fsTrace.vault = dir;
		fsTrace.events.length = 0;
		fsTrace.failEnvRename = false;
		const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
		const warnings: string[] = [];
		Object.defineProperty(process, "platform", { ...real, value: "win32" });
		try {
			writePrivateFileAtomic(join(dir, ".env"), "NEW\n", (message) => warnings.push(message));
		} finally {
			Object.defineProperty(process, "platform", real);
		}
		try {
			expect(readFileSync(join(dir, ".env"), "utf-8")).toBe("NEW\n");
			expect(fsTrace.events).toContain("rename .env temp");
			expect(fsTrace.events).not.toContain("open vault dir");
			expect(warnings).toEqual([]);
			expect(existsSync(join(dir, ".env"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
