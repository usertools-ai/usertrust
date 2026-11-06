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
	statSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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
export function canonical(p: string): string {
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
 * Throws when that directory would sit inside the project or its vault, which
 * is the case by default for a project rooted at or above the home directory:
 * the default base, ~/.usertrust/workspace, is then inside it.
 */
export function workspaceDir(vaultBase: string, env: NodeJS.ProcessEnv = process.env): string {
	const root = realpathSync.native(vaultBase);
	const id = createHash("sha256").update(root).digest("hex").slice(0, 32);
	const override = env.USERTRUST_WORKSPACE_DIR;
	// A relative override would resolve against whatever directory the server was started in, which can put
	// settings inside a repository; only an absolute one is taken.
	if (override !== undefined && override !== "" && !isAbsolute(override)) {
		throw new Error(
			`USERTRUST_WORKSPACE_DIR must be an absolute path, not ${JSON.stringify(override)}`,
		);
	}
	const base =
		override !== undefined && override !== ""
			? override
			: join(homedir(), ".usertrust", "workspace");
	const dir = join(resolve(base), id);
	assertOutsideProject(root, dir);
	return dir;
}

/**
 * Where the vault of the project at `root` (a resolved path) is, or a throw when its state rules settings out.
 * Settings need `<root>/.usertrust` to be absent, a directory, or a link that resolves to a directory. Anything
 * else (a link that does not resolve, a file, a link to something that is not a directory, an entry that cannot
 * be checked) leaves nothing that says where the vault is, so settings are off and nothing is created. The vault
 * path is never taken as written when it is a link.
 */
function resolvedVault(root: string): string {
	const vault = join(root, ".usertrust");
	const off = (why: string): Error => new Error(`settings are off: the vault ${why} (${vault})`);
	let entry: Stats;
	try {
		entry = lstatSync(vault);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "error";
		// Absent: a project before its first governed call. It can only be made where it is named.
		if (code === "ENOENT") return vault;
		throw off(`cannot be checked (${code})`);
	}
	if (entry.isDirectory()) return realpathSync.native(vault);
	if (!entry.isSymbolicLink()) throw off("is not a directory");
	let target: Stats;
	try {
		target = statSync(vault);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "error";
		if (code === "ENOENT" || code === "ELOOP") throw off("is a link that does not resolve");
		throw off(`is a link that cannot be followed (${code})`);
	}
	if (!target.isDirectory()) throw off("is a link to something that is not a directory");
	try {
		return realpathSync.native(vault);
	} catch (err) {
		throw off(
			`is a link that cannot be followed (${(err as NodeJS.ErrnoException).code ?? "error"})`,
		);
	}
}

/** The nearest ancestor of `p` (or `p` itself) that exists, as the OS resolves it. */
function existingAncestor(p: string): string {
	let cur = resolve(p);
	for (;;) {
		try {
			return realpathSync.native(cur);
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return cur;
			cur = parent;
		}
	}
}

/**
 * Throws when `dir` would sit inside the vault of the project rooted at `vaultBase`, or anywhere inside the
 * project. Nothing is created to decide it, and it is decided before anything is.
 *
 * - The vault's own state: it must be absent, a directory, or a link to one (`resolvedVault`), or settings are
 *   off. This is read again at every call, so a vault link that stops resolving after start is caught too.
 * - The vault: `dir` is resolved as far as it exists, the vault fully. A vault that is a link to a directory
 *   outside the project is still the vault, so a workspace in that directory is refused.
 * - The project: the nearest ancestor of `dir` that exists, as the OS resolves it, may not be the project root
 *   or lie under it. A path not yet on disk cannot be resolved, and a volume may treat a different spelling as
 *   the same name (case, or letters it takes as others), so a workspace that would be created anywhere in the
 *   project is refused, whatever it is called. That covers a spelling the volume would make into the vault.
 */
export function assertOutsideProject(vaultBase: string, dir: string): void {
	const root = realpathSync.native(vaultBase);
	const vault = resolvedVault(root);
	const why = isInside(canonical(homedir()), root)
		? "settings are off for a project rooted at or above your home directory"
		: "set USERTRUST_WORKSPACE_DIR to a directory outside the project";
	if (isInside(canonical(dir), vault)) {
		throw new Error(`workspace would sit inside the vault at ${vault}: ${why}`);
	}
	if (isInside(existingAncestor(dir), root)) {
		throw new Error(`workspace would sit inside the project at ${root}: ${why}`);
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

/** Why the settings file is not its only name (a hard link to another file), or null when it is. */
function hardLinked(st: Stats): string | null {
	return st.nlink === 1 ? null : `${SETTINGS_FILE} is a hard link (${st.nlink} names for one file)`;
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

/**
 * A write the workspace refused for safety (it is unsafe, or the settings file is not a private regular file).
 * Any other failure of a write is an I/O error and is thrown as it is.
 */
export class WorkspaceRefusal extends Error {
	override name = "WorkspaceRefusal";
}

export class Workspace {
	readonly #dir: string;
	readonly #file: string;
	#entries: Parsed[] = [];
	#seen: string | null = null;
	#unsafe: string | null = null;
	#unreadable: string | null = null;

	/** The project root this workspace must stay out of (and out of its vault), when the opener named one. */
	readonly #vaultBase: string | undefined;

	private constructor(dir: string, vaultBase?: string) {
		this.#vaultBase = vaultBase;
		this.#dir = resolve(dir);
		this.#file = join(this.#dir, SETTINGS_FILE);
	}

	/**
	 * Opens the workspace for reading; see `problem`. Nothing is created: a directory that does not exist yet
	 * reads as an empty workspace, and the first `append` creates it.
	 */
	static open(dir: string, vaultBase?: string): Workspace {
		const ws = new Workspace(dir, vaultBase);
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

	/**
	 * Appends an entry and returns it. Without `at`, the entry is dated now, or 1 ms after the latest entry when
	 * the clock reads earlier than that (a clock stepped back), so a new entry is always the latest word.
	 */
	append(key: SettingKey, value: number | null, at?: Date): SettingEntry {
		if (!isSettingKey(key)) throw new Error(`unknown setting: ${String(key)}`);
		if (!isSettingValue(value)) throw new Error(`${key} needs a finite number >= 0, or null`);
		if (at !== undefined && (!(at instanceof Date) || !Number.isFinite(at.getTime()))) {
			throw new Error("a setting needs a valid time");
		}
		// Containment is checked before the directory is made (making it inside the project could make the vault),
		// and again on the made directory's real path, before anything is written into it.
		this.#refuseInsideProject(this.#dir);
		// Created here, on the first write, and never by a read. A failure here is thrown with its own code.
		mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
		this.#refuseInsideProject(realpathSync.native(this.#dir));
		const unsafe = this.#check();
		if (unsafe !== null) {
			this.#unsafe = unsafe;
			throw new WorkspaceRefusal(`settings are not saved: ${unsafe}`);
		}
		// The latest entry dates this one, so the log is read first; a log that cannot be read is not written.
		this.#refresh();
		if (this.#unsafe !== null) {
			throw new WorkspaceRefusal(`settings are not saved: ${this.#unsafe}`);
		}
		const ms = at !== undefined ? at.getTime() : Math.max(Date.now(), this.#latestMs() + 1);
		const entry: SettingEntry = { at: new Date(ms).toISOString(), key, value };
		const fd = openSync(
			this.#file,
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW,
			0o600,
		);
		try {
			const st = fstatSync(fd);
			if (!st.isFile()) {
				throw new WorkspaceRefusal(`settings are not saved: ${SETTINGS_FILE} is not a file`);
			}
			// O_NOFOLLOW stops a symlink, not a hard link: a second name for one of the user's own files (one in a
			// vault, say) passes every owner and mode check, so a file with more than one link is refused.
			const linked = hardLinked(st);
			if (linked !== null) throw new WorkspaceRefusal(`settings are not saved: ${linked}`);
			const why = notPrivate(st, SETTINGS_FILE, 0o077);
			if (why !== null) throw new WorkspaceRefusal(`settings are not saved: ${why}`);
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

	/**
	 * The value in force at `t`, or null when none was set by then. `t` null is now, and now is never earlier
	 * than the latest entry: `append` dates past it when the clock has stepped back.
	 */
	valueAt(key: SettingKey, t: string | null): number | null {
		if (!isSettingKey(key)) throw new Error(`unknown setting: ${String(key)}`);
		const asked = t === null ? null : parseTime(t);
		this.#refresh();
		const limit = asked ?? Math.max(Date.now(), this.#latestMs());
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

	/** Throws a refusal when `dir` sits inside the project `#vaultBase` or its vault (or that cannot be checked). */
	#refuseInsideProject(dir: string): void {
		if (this.#vaultBase === undefined) return;
		try {
			assertOutsideProject(this.#vaultBase, dir);
		} catch (err) {
			throw new WorkspaceRefusal(
				`settings are not saved: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** The time of the latest entry, of any key; -Infinity when there is none. */
	#latestMs(): number {
		let latest = Number.NEGATIVE_INFINITY;
		for (const p of this.#entries) if (p.ms > latest) latest = p.ms;
		return latest;
	}

	#check(): string | null {
		let d: Stats;
		try {
			d = lstatSync(this.#dir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "error";
			// Not created yet (no write so far, or removed since): an empty workspace, nothing wrong.
			if (code === "ENOENT") return null;
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
		return hardLinked(f) ?? notPrivate(f, SETTINGS_FILE, 0o077);
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
		if (tail.trim() !== "") {
			// A whole record whose newline never reached the disk (a crash between the two) is an entry: it dates
			// the next one, and the next append completes its line. A fragment that does not parse is unreadable.
			const parsed = parseLine(tail);
			if (parsed === null) skip(lines.length + 1);
			else entries.push(parsed);
		}
		this.#entries = entries;
		this.#unreadable =
			bad === 0
				? null
				: `${SETTINGS_FILE}: skipped ${bad} unreadable line${bad === 1 ? "" : "s"} (first at line ${firstBad})`;
	}
}
