// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// The workspace: a private, append-only log of dated dashboard settings,
// kept outside the vault. The vault is never written; settings live under
// ~/.usertrust/workspace/<id> (or USERTRUST_WORKSPACE_DIR/<id>), where <id>
// names the project the vault belongs to. Each line of settings.jsonl says
// "from this time on, this setting has this value", so a view of the past
// uses the value that was in force then.

import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	type Stats,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { SettingEntry, SettingKey } from "../shared/api.js";

// The wire types live with the other shared ones, so the page never imports server code.
export type { SettingEntry, SettingKey };

export const SETTING_KEYS: readonly SettingKey[] = Object.freeze([
	"plan.monthlyUt",
	"people.rateUsdPerHour",
]);

const SETTINGS_FILE = "settings.jsonl";
const ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const posix = process.platform !== "win32";
// O_NOFOLLOW does not exist on Windows; there the flag is simply absent.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * The path with its longest existing prefix resolved by the OS: symlinks
 * followed and, on a case-insensitive filesystem, letter case as stored on
 * disk. The JS realpathSync keeps the caller's case there, so two spellings
 * of one directory would get two workspaces.
 */
function canonical(p: string): string {
	const rest: string[] = [];
	let cur = resolve(p);
	for (;;) {
		try {
			return join(realpathSync.native(cur), ...rest);
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return resolve(p);
			rest.unshift(basename(cur));
			cur = parent;
		}
	}
}

function isInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * The workspace directory for the vault of the project rooted at `vaultBase`.
 * Throws when that directory would sit inside the vault itself, which is the
 * case for a project rooted at the home directory: its vault is ~/.usertrust.
 */
export function workspaceDir(vaultBase: string, env: NodeJS.ProcessEnv = process.env): string {
	const root = realpathSync.native(vaultBase);
	const id = createHash("sha256").update(root).digest("hex").slice(0, 32);
	const override = env.USERTRUST_WORKSPACE_DIR;
	const base =
		override !== undefined && override !== ""
			? override
			: join(homedir(), ".usertrust", "workspace");
	const dir = join(resolve(base), id);
	assertOutsideVault(root, dir);
	return dir;
}

/** Throws when `dir` would sit inside the vault of the project rooted at `vaultBase`. */
export function assertOutsideVault(vaultBase: string, dir: string): void {
	const root = realpathSync.native(vaultBase);
	const vault = canonical(join(root, ".usertrust"));
	if (isInside(canonical(dir), vault)) {
		const why =
			root === canonical(homedir())
				? "settings are off for a project rooted at your home directory"
				: "set USERTRUST_WORKSPACE_DIR to a directory outside it";
		throw new Error(`workspace would sit inside the vault at ${vault}: ${why}`);
	}
}

/** Epoch ms for an ISO time that carries Z or an explicit offset. */
function parseTime(t: string): number {
	if (!ZONE.test(t)) throw new Error(`time needs Z or an offset: ${t}`);
	const ms = Date.parse(t);
	if (!Number.isFinite(ms)) throw new Error(`not a valid time: ${t}`);
	return ms;
}

export function isSettingKey(key: unknown): key is SettingKey {
	return typeof key === "string" && (SETTING_KEYS as readonly string[]).includes(key);
}

/** null, or a finite number >= 0. */
export function isSettingValue(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

interface Parsed {
	entry: SettingEntry;
	ms: number;
}

function parseLine(line: string): Parsed | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { at, key, value } = raw as Record<string, unknown>;
	if (typeof at !== "string" || !isSettingKey(key) || !isSettingValue(value)) return null;
	try {
		return { entry: { at, key, value }, ms: parseTime(at) };
	} catch {
		return null;
	}
}

/** Why this owner/mode is not private to us, or null when it is. */
function notPrivate(st: Stats, name: string, forbidden: number): string | null {
	if (!posix) return null;
	const uid = process.getuid?.();
	if (uid !== undefined && st.uid !== uid) return `${name} belongs to another user`;
	if ((st.mode & forbidden) !== 0) {
		return `${name} has mode ${(st.mode & 0o777).toString(8).padStart(4, "0")}`;
	}
	return null;
}

export class Workspace {
	readonly #dir: string;
	readonly #file: string;
	#entries: Parsed[] = [];
	#seen: string | null = null;
	#unsafe: string | null = null;
	#unreadable: string | null = null;

	private constructor(dir: string) {
		this.#dir = resolve(dir);
		this.#file = join(this.#dir, SETTINGS_FILE);
	}

	/** Opens (creating the directory if needed) without throwing; see `problem`. */
	static open(dir: string): Workspace {
		const ws = new Workspace(dir);
		try {
			mkdirSync(ws.#dir, { recursive: true, mode: 0o700 });
		} catch {
			// Reported by the safety check below.
		}
		ws.#refresh();
		return ws;
	}

	/**
	 * What is wrong with the workspace, or null. An unsafe workspace (a
	 * symlink, another owner, or permissions open to others) is neither read
	 * nor written; unreadable lines are skipped and left in place.
	 */
	get problem(): string | null {
		this.#refresh();
		return this.#unsafe ?? this.#unreadable;
	}

	append(key: SettingKey, value: number | null, at: Date = new Date()): SettingEntry {
		if (!isSettingKey(key)) throw new Error(`unknown setting: ${String(key)}`);
		if (!isSettingValue(value)) throw new Error(`${key} needs a finite number >= 0, or null`);
		if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
			throw new Error("a setting needs a valid time");
		}
		const unsafe = this.#check();
		if (unsafe !== null) {
			this.#unsafe = unsafe;
			throw new Error(`settings are not saved: ${unsafe}`);
		}
		const entry: SettingEntry = { at: at.toISOString(), key, value };
		const fd = openSync(
			this.#file,
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW,
			0o600,
		);
		try {
			const st = fstatSync(fd);
			if (!st.isFile()) throw new Error(`settings are not saved: ${SETTINGS_FILE} is not a file`);
			const why = notPrivate(st, SETTINGS_FILE, 0o077);
			if (why !== null) throw new Error(`settings are not saved: ${why}`);
			// A torn last line stays as it is; the new line starts on a line of its own.
			const lead = st.size > 0 && this.#lastByte(st.size) !== 0x0a ? "\n" : "";
			const bytes = Buffer.from(`${lead}${JSON.stringify(entry)}\n`, "utf-8");
			if (writeSync(fd, bytes) !== bytes.length) {
				throw new Error("settings are not saved: short write");
			}
		} finally {
			closeSync(fd);
		}
		this.#refresh();
		return { ...entry };
	}

	/** The value in force at `t` (null = now), or null when none was set by then. */
	valueAt(key: SettingKey, t: string | null): number | null {
		if (!isSettingKey(key)) throw new Error(`unknown setting: ${String(key)}`);
		const limit = t === null ? Date.now() : parseTime(t);
		this.#refresh();
		let best: Parsed | null = null;
		for (const p of this.#entries) {
			// Ties go to the later line: the last word on a moment wins.
			if (p.entry.key === key && p.ms <= limit && (best === null || p.ms >= best.ms)) best = p;
		}
		return best === null ? null : best.entry.value;
	}

	/** Every entry for `key`, oldest first. */
	history(key: SettingKey): SettingEntry[] {
		if (!isSettingKey(key)) throw new Error(`unknown setting: ${String(key)}`);
		this.#refresh();
		return this.#entries
			.filter((p) => p.entry.key === key)
			.sort((a, b) => a.ms - b.ms)
			.map((p) => ({ ...p.entry }));
	}

	#check(): string | null {
		let d: Stats;
		try {
			d = lstatSync(this.#dir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "error";
			return `the workspace ${this.#dir} is unavailable (${code})`;
		}
		if (d.isSymbolicLink()) return `the workspace ${this.#dir} is a symlink`;
		if (!d.isDirectory()) return `the workspace ${this.#dir} is not a directory`;
		const dirWhy = notPrivate(d, `the workspace ${this.#dir}`, 0o022);
		if (dirWhy !== null) return dirWhy;
		let f: Stats;
		try {
			f = lstatSync(this.#file);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			return code === "ENOENT" ? null : `${SETTINGS_FILE} is unavailable (${code ?? "error"})`;
		}
		if (f.isSymbolicLink()) return `${SETTINGS_FILE} is a symlink`;
		if (!f.isFile()) return `${SETTINGS_FILE} is not a file`;
		return notPrivate(f, SETTINGS_FILE, 0o077);
	}

	#lastByte(size: number): number | undefined {
		const fd = openSync(this.#file, constants.O_RDONLY | NOFOLLOW);
		try {
			const one = Buffer.alloc(1);
			return readSync(fd, one, 0, 1, size - 1) === 1 ? one[0] : undefined;
		} finally {
			closeSync(fd);
		}
	}

	/** Re-reads the log when its identity, size or mtime changed. Never writes. */
	#refresh(): void {
		this.#unsafe = this.#check();
		if (this.#unsafe !== null) {
			this.#entries = [];
			this.#seen = null;
			this.#unreadable = null;
			return;
		}
		let fd: number;
		try {
			fd = openSync(this.#file, constants.O_RDONLY | NOFOLLOW);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				this.#entries = [];
				this.#seen = null;
				this.#unreadable = null;
				return;
			}
			this.#unsafe = `${SETTINGS_FILE} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`;
			this.#entries = [];
			this.#seen = null;
			return;
		}
		try {
			const st: BigIntStats = fstatSync(fd, { bigint: true });
			const seen = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
			if (seen === this.#seen) return;
			// Identity is taken before the read: bytes appended after it only
			// cause one extra re-read later, never a missed one.
			const text = readFileSync(fd, "utf-8");
			this.#seen = seen;
			this.#parse(text);
		} finally {
			closeSync(fd);
		}
	}

	#parse(text: string): void {
		const lines = text.split("\n");
		// The segment after the last newline is "" for a well-formed log, or a torn write.
		const tail = lines.pop() ?? "";
		const entries: Parsed[] = [];
		let bad = 0;
		let firstBad = 0;
		const skip = (lineNo: number): void => {
			bad++;
			if (firstBad === 0) firstBad = lineNo;
		};
		lines.forEach((line, i) => {
			if (line.trim() === "") return;
			const parsed = parseLine(line);
			if (parsed === null) skip(i + 1);
			else entries.push(parsed);
		});
		if (tail.trim() !== "") skip(lines.length + 1);
		this.#entries = entries;
		this.#unreadable =
			bad === 0
				? null
				: `${SETTINGS_FILE}: skipped ${bad} unreadable line${bad === 1 ? "" : "s"} (first at line ${firstBad})`;
	}
}
