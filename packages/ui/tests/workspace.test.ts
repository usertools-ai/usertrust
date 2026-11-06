// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	chmodSync,
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type SettingKey,
	Workspace,
	WorkspaceRefusal,
	workspaceDir,
} from "../src/server/workspace.js";

const posix = process.platform !== "win32";

describe("Workspace", () => {
	let tempDir: string;
	let dir: string;
	let file: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-workspace-"));
		dir = join(tempDir, "ws", "abc");
		file = join(dir, "settings.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function corruptFixture(): string {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const valid = `${JSON.stringify({ at: "2026-11-01T00:00:00.000Z", key: "plan.monthlyUt", value: 42 })}\n`;
		const bytes = `${valid}{"at":"2026-`;
		writeFileSync(file, bytes, { mode: 0o600 });
		return bytes;
	}

	it.skipIf(!posix)(
		"creates dir 0700 and settings.jsonl 0600 on the first write, never on open",
		() => {
			const ws = Workspace.open(dir);
			// A read creates nothing: a directory that does not exist yet is an empty workspace.
			expect(existsSync(dir)).toBe(false);
			expect(ws.problem).toBeNull();
			expect(ws.valueAt("plan.monthlyUt", null)).toBeNull();
			expect(ws.history("plan.monthlyUt")).toEqual([]);
			expect(existsSync(dir)).toBe(false);
			ws.append("plan.monthlyUt", 1);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(ws.problem).toBeNull();
		},
	);

	it("a workspace moved away after it was opened reads as empty, and the next write recreates it", () => {
		const ws = Workspace.open(dir);
		ws.append("plan.monthlyUt", 1);
		renameSync(dir, `${dir}-gone`);
		expect(ws.problem).toBeNull();
		expect(ws.valueAt("plan.monthlyUt", null)).toBeNull();
		ws.append("plan.monthlyUt", 2);
		expect(ws.valueAt("plan.monthlyUt", null)).toBe(2);
		expect(ws.history("plan.monthlyUt")).toHaveLength(1);
	});

	it("a clock that stepped back cannot hide a new entry: it is dated 1 ms after the latest", () => {
		const ws = Workspace.open(dir);
		// An entry written before the clock stepped back an hour reads, now, as one an hour in the future.
		const ahead = new Date(Date.now() + 3_600_000);
		ws.append("plan.monthlyUt", 100, ahead);
		const fresh = ws.append("plan.monthlyUt", 200);
		expect(Date.parse(fresh.at)).toBe(ahead.getTime() + 1);
		expect(ws.valueAt("plan.monthlyUt", null)).toBe(200);
		expect(ws.history("plan.monthlyUt").map((e) => e.value)).toEqual([100, 200]);
		// The latest entry of ANY key dates the next one.
		const other = ws.append("people.rateUsdPerHour", 90);
		expect(Date.parse(other.at)).toBe(ahead.getTime() + 2);
		expect(ws.valueAt("people.rateUsdPerHour", null)).toBe(90);
	});

	it("a complete last record with no newline (a crash before it) still dates the next entry", () => {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const ahead = new Date(Date.now() + 3_600_000);
		const torn = JSON.stringify({ at: ahead.toISOString(), key: "plan.monthlyUt", value: 100 });
		writeFileSync(file, torn, { mode: 0o600 });
		const ws = Workspace.open(dir);
		// The record is whole, so it is an entry, not an unreadable line.
		expect(ws.valueAt("plan.monthlyUt", null)).toBe(100);
		expect(ws.problem).toBeNull();
		const fresh = ws.append("plan.monthlyUt", 200);
		expect(Date.parse(fresh.at)).toBe(ahead.getTime() + 1);
		expect(ws.valueAt("plan.monthlyUt", null)).toBe(200);
		expect(readFileSync(file, "utf-8")).toBe(`${torn}\n${JSON.stringify(fresh)}\n`);
	});

	it("append then valueAt now", () => {
		const ws = Workspace.open(dir);
		const entry = ws.append("plan.monthlyUt", 500000);
		expect(entry.key).toBe("plan.monthlyUt");
		expect(entry.value).toBe(500000);
		expect(entry.at).toMatch(/Z$/);
		expect(ws.valueAt("plan.monthlyUt", null)).toBe(500000);
		expect(ws.valueAt("people.rateUsdPerHour", null)).toBeNull();
	});

	it("valueAt uses the value in force at T", () => {
		const ws = Workspace.open(dir);
		ws.append("plan.monthlyUt", 100, new Date("2026-11-01T00:00:00Z"));
		ws.append("plan.monthlyUt", 200, new Date("2026-11-03T00:00:00Z"));
		expect(ws.valueAt("plan.monthlyUt", "2026-11-02T00:00:00Z")).toBe(100);
		expect(ws.valueAt("plan.monthlyUt", "2026-10-31T00:00:00Z")).toBeNull();
		expect(ws.valueAt("plan.monthlyUt", "2026-11-03T00:00:00Z")).toBe(200);
		expect(ws.history("plan.monthlyUt").map((e) => e.value)).toEqual([100, 200]);
		expect(ws.history("people.rateUsdPerHour")).toEqual([]);
	});

	it("rejects unknown key and bad values", () => {
		const ws = Workspace.open(dir);
		expect(() => ws.append("x" as SettingKey, 1)).toThrow();
		expect(() => ws.append("plan.monthlyUt", Number.NaN)).toThrow();
		expect(() => ws.append("plan.monthlyUt", -1)).toThrow();
		expect(() => ws.append("plan.monthlyUt", Number.POSITIVE_INFINITY)).toThrow();
		expect(() => ws.append("plan.monthlyUt", "5" as unknown as number)).toThrow();
		expect(ws.history("plan.monthlyUt")).toEqual([]);
		ws.append("plan.monthlyUt", 5);
		expect(ws.append("plan.monthlyUt", null).value).toBeNull();
		expect(ws.valueAt("plan.monthlyUt", null)).toBeNull();
	});

	it("corrupt settings log", () => {
		const bytes = corruptFixture();
		const ws = Workspace.open(dir);
		expect(ws.valueAt("plan.monthlyUt", null)).toBe(42);
		expect(ws.problem).toMatch(/unreadable line/);
		expect(readFileSync(file, "utf-8")).toBe(bytes);
	});

	it("append after a torn tail", () => {
		const bytes = corruptFixture();
		const ws = Workspace.open(dir);
		const entry = ws.append("plan.monthlyUt", 7);
		const reopened = Workspace.open(dir);
		expect(reopened.valueAt("plan.monthlyUt", null)).toBe(7);
		expect(readFileSync(file, "utf-8")).toBe(`${bytes}\n${JSON.stringify(entry)}\n`);
	});

	it("mixed ISO precision", () => {
		const ws = Workspace.open(dir);
		ws.append("plan.monthlyUt", 100, new Date("2026-11-02T00:00:00Z"));
		ws.append("plan.monthlyUt", 200, new Date("2026-11-02T00:00:00.500Z"));
		expect(ws.valueAt("plan.monthlyUt", "2026-11-02T00:00:00Z")).toBe(100);
		expect(ws.valueAt("plan.monthlyUt", "2026-11-02T00:00:00.500Z")).toBe(200);
		expect(ws.valueAt("plan.monthlyUt", "2026-11-02T01:00:00+01:00")).toBe(100);
	});

	it("t without a zone throws", () => {
		const ws = Workspace.open(dir);
		ws.append("plan.monthlyUt", 100, new Date("2026-11-01T00:00:00Z"));
		expect(() => ws.valueAt("plan.monthlyUt", "2026-11-02T00:00:00")).toThrow(
			/time needs Z or an offset/,
		);
		expect(() => ws.valueAt("plan.monthlyUt", "not a timeZ")).toThrow();
	});

	describe.skipIf(!posix)("unsafe dir refuses writes", () => {
		function expectRefused(ws: Workspace, reason: RegExp): void {
			expect(ws.problem).toMatch(reason);
			expect(() => ws.append("plan.monthlyUt", 1)).toThrow(WorkspaceRefusal);
			expect(() => ws.append("plan.monthlyUt", 1)).toThrow(reason);
		}

		it("the dir is a symlink", () => {
			const real = join(tempDir, "real");
			mkdirSync(real, { mode: 0o700 });
			mkdirSync(join(tempDir, "ws"));
			symlinkSync(real, dir);
			expectRefused(Workspace.open(dir), /the workspace \S+ is a symlink/);
			expect(existsSync(join(real, "settings.jsonl"))).toBe(false);
		});

		it("the dir is group- or world-writable", () => {
			mkdirSync(dir, { recursive: true });
			chmodSync(dir, 0o777);
			expectRefused(Workspace.open(dir), /the workspace \S+ has mode 0777/);
		});

		it("settings.jsonl is a symlink", () => {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const target = join(tempDir, "elsewhere.jsonl");
			writeFileSync(target, "", { mode: 0o600 });
			symlinkSync(target, file);
			expectRefused(Workspace.open(dir), /settings\.jsonl is a symlink/);
			expect(readFileSync(target, "utf-8")).toBe("");
		});

		it("settings.jsonl is mode 0644", () => {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(file, "");
			chmodSync(file, 0o644);
			expectRefused(Workspace.open(dir), /settings\.jsonl has mode 0644/);
		});

		// Handing a file to another uid needs root, so this case runs only as root.
		it.skipIf(process.getuid?.() !== 0)("the file is owned by another uid", () => {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(file, "", { mode: 0o600 });
			chownSync(file, 1, 1);
			expectRefused(Workspace.open(dir), /settings\.jsonl belongs to another user/);
		});
	});

	it("re-reads after another writer", () => {
		const a = Workspace.open(dir);
		const b = Workspace.open(dir);
		expect(b.valueAt("plan.monthlyUt", null)).toBeNull();
		a.append("plan.monthlyUt", 300);
		expect(b.valueAt("plan.monthlyUt", null)).toBe(300);
		a.append("people.rateUsdPerHour", 85);
		expect(b.history("people.rateUsdPerHour").map((e) => e.value)).toEqual([85]);
	});
});

describe("workspaceDir", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-workspace-dir-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function project(name: string): string {
		const root = join(tempDir, name);
		mkdirSync(join(root, ".usertrust"), { recursive: true });
		return root;
	}

	it("same vault, same dir; different vaults, different dirs", () => {
		const base = join(tempDir, "workspaces");
		const env = { USERTRUST_WORKSPACE_DIR: base };
		const one = project("one");
		const two = project("two");
		expect(workspaceDir(one, env)).toBe(workspaceDir(one, env));
		expect(workspaceDir(one, env)).not.toBe(workspaceDir(two, env));
		expect(workspaceDir(one, env).startsWith(base)).toBe(true);
		expect(workspaceDir(one, env)).toMatch(/[0-9a-f]{32}$/);
		// A second spelling of the same vault resolves to the same workspace.
		symlinkSync(one, join(tempDir, "alias"));
		expect(workspaceDir(join(tempDir, "alias"), env)).toBe(workspaceDir(one, env));
	});

	it("a differently cased spelling of the same project gives the same dir", (ctx) => {
		const env = { USERTRUST_WORKSPACE_DIR: join(tempDir, "workspaces") };
		const one = project("one");
		const upper = one.toUpperCase();
		// Only a case-insensitive filesystem (the macOS default) has two spellings of one directory.
		if (!existsSync(upper)) ctx.skip("the tmp filesystem is case-sensitive");
		expect(workspaceDir(upper, env)).toBe(workspaceDir(one, env));
		// A differently cased base pointed into the vault is still inside it.
		expect(() =>
			workspaceDir(one, { USERTRUST_WORKSPACE_DIR: join(one, ".usertrust", "ws").toUpperCase() }),
		).toThrow(/workspace would sit inside the vault/);
	});

	it("refuses a relative USERTRUST_WORKSPACE_DIR, which would resolve against wherever the server started", () => {
		const v = project("p");
		for (const rel of ["ws", "./ws", "../ws", "settings/here"]) {
			expect(() => workspaceDir(v, { USERTRUST_WORKSPACE_DIR: rel }), rel).toThrow(
				/USERTRUST_WORKSPACE_DIR must be an absolute path/,
			);
		}
		expect(
			workspaceDir(v, { USERTRUST_WORKSPACE_DIR: join(tempDir, "abs") }).startsWith(tempDir),
		).toBe(true);
	});

	it("a base naming the vault in another case is inside it, even before the vault exists, on any volume", () => {
		// No .usertrust yet: the vault's path cannot be resolved on disk, so its spelling is all there is. On a
		// case-insensitive filesystem (the macOS default) a first write under .USERTRUST would create the vault.
		// The check folds case on every volume, so this holds on a case-sensitive one too.
		const root = join(tempDir, "fresh");
		mkdirSync(root);
		for (const name of [".USERTRUST", ".UserTrust", ".usertrust"]) {
			expect(
				() => workspaceDir(root, { USERTRUST_WORKSPACE_DIR: join(root, name, "ws") }),
				name,
			).toThrow(/workspace would sit inside the vault/);
		}
		expect(readdirSync(root).filter((e) => e.toLowerCase() === ".usertrust")).toEqual([]);
	});

	it("a store opened with its project root refuses, before any mkdir, a write that would create the vault", () => {
		const root = join(tempDir, "fresh-store");
		mkdirSync(root);
		const ws = Workspace.open(join(root, ".USERTRUST", "ws"), root);
		expect(() => ws.append("plan.monthlyUt", 1)).toThrow(WorkspaceRefusal);
		expect(() => ws.append("plan.monthlyUt", 1)).toThrow(/workspace would sit inside the vault/);
		expect(readdirSync(root)).toEqual([]);
	});

	it("never inside the vault", () => {
		const v = project("p");
		const vault = realpathSync(join(v, ".usertrust"));
		expect(workspaceDir(v, { USERTRUST_WORKSPACE_DIR: join(tempDir, "w") }).startsWith(vault)).toBe(
			false,
		);
		// A base pointed into the vault is refused too.
		expect(() => workspaceDir(v, { USERTRUST_WORKSPACE_DIR: join(vault, "ws") })).toThrow(
			/workspace would sit inside the vault/,
		);
		// Rooted at the home directory, the vault IS ~/.usertrust, where core keeps anchor keys,
		// and the default base ~/.usertrust/workspace would sit inside it. The message is the note
		// the server shows while it runs with settings off.
		let message = "";
		try {
			workspaceDir(homedir(), {});
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toMatch(/workspace would sit inside the vault/);
		expect(message).toMatch(/settings are off for a project rooted at your home directory/);
	});
});
