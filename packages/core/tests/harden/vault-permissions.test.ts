// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A vault holds audit trails, spend records and (with content capture on) prompts and tool
 * inputs. Every directory usertrust creates under it must be 0700 and every file 0600, whatever
 * the process umask: a umask can only REMOVE bits, so the modes are passed explicitly at
 * creation, never left to `0o777 & ~umask` / `0o666 & ~umask`. And a governor given a vault base
 * writes nothing outside it — no `.usertrust/patterns/` in the process working directory.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	constants as fsConstants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnchorEmitter, initAnchorIdentity } from "../../src/audit/anchor.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { createBoard } from "../../src/board/board.js";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { ScopeManager } from "../../src/resilience/scope.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { looseVaultWarning, securePrivateVault } from "../../src/shared/private-fs.js";
import { createSnapshot, restoreSnapshot } from "../../src/snapshot/checkpoint.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

/**
 * Sees every `mkdirSync` before it runs, while a test sets `before`: the seam for asserting which
 * mkdir creates a vault, and for racing a directory into place ahead of it. Pass-through otherwise.
 */
const mkdirHook = vi.hoisted(() => ({
	before: undefined as ((path: string, opts: unknown) => void) | undefined,
}));

/** While a test sets `fail`, `realpathSync.native` throws what it returns: realpath(3) unusable. */
const nativeHook = vi.hoisted(() => ({
	fail: undefined as ((path: string) => NodeJS.ErrnoException | undefined) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const mkdirSync = ((path: import("node:fs").PathLike, opts?: unknown) => {
		mkdirHook.before?.(String(path), opts);
		return real.mkdirSync(path, opts as Parameters<typeof real.mkdirSync>[1]);
	}) as typeof real.mkdirSync;
	const native = ((path: import("node:fs").PathLike, opts?: unknown) => {
		const err = nativeHook.fail?.(String(path));
		if (err !== undefined) throw err;
		return real.realpathSync.native(path, opts as Parameters<typeof real.realpathSync.native>[1]);
	}) as typeof real.realpathSync.native;
	const realpathSync = Object.assign(
		(...args: Parameters<typeof real.realpathSync>) => real.realpathSync(...args),
		{ native },
	) as typeof real.realpathSync;
	// The default export too, for a module that imports `fs` whole.
	return {
		...real,
		mkdirSync,
		realpathSync,
		default: { ...real, mkdirSync, realpathSync },
	};
});

/**
 * On Windows usertrust neither sets nor checks a mode or an owner (POSIX modes do not describe
 * an ACL), so every row that asserts a mode, a uid, or uses a POSIX-only tool (`geteuid`,
 * `mkfifo`, unprivileged symlinks) is skipped there; the native-Windows row covers that platform.
 */
const onWindows = process.platform === "win32";

interface Walk {
	dirs: number;
	files: number;
	/** Every entry with a group or other bit, as `path mode`. */
	loose: string[];
}

/** Every directory and file under `root` (root included), and the ones not owner-only. */
function walkModes(root: string): Walk {
	const out: Walk = { dirs: 0, files: 0, loose: [] };
	const visit = (p: string): void => {
		const st = lstatSync(p);
		if (st.isDirectory()) out.dirs++;
		else out.files++;
		if ((st.mode & 0o077) !== 0) {
			out.loose.push(`${relative(root, p) || "."} ${(st.mode & 0o777).toString(8)}`);
		}
		if (st.isDirectory()) for (const name of readdirSync(p)) visit(join(p, name));
	};
	visit(root);
	return out;
}

const tracked: string[] = [];
function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tracked.push(d);
	return d;
}

function anthropicMock() {
	return {
		messages: {
			create: vi.fn(async (_params: unknown) => ({
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 100, output_tokens: 50 },
			})),
		},
	};
}

let savedCwd: string;
let savedUmask: number;
let cwd: string;

beforeEach(() => {
	savedCwd = process.cwd();
	savedUmask = process.umask();
	cwd = tmp("ut-perm-cwd-");
	process.chdir(cwd);
});

afterEach(() => {
	mkdirHook.before = undefined;
	nativeHook.fail = undefined;
	process.chdir(savedCwd);
	process.umask(savedUmask);
	for (const d of tracked.splice(0)) {
		try {
			chmodSync(d, 0o700);
		} catch {
			/* already gone */
		}
		rmSync(d, { recursive: true, force: true });
	}
});

describe.skipIf(onWindows).each([
	["022", 0o022],
	["000", 0o000],
])("vault writers under umask %s", (label, mask) => {
	it("every directory is 0700 and every file 0600, and nothing lands in the working directory", async () => {
		process.umask(mask);
		// A vault base that does not exist yet: usertrust creates it, so it is usertrust's to close.
		const root = join(tmp("ut-perm-vault-"), "tenant");
		const vaultPath = join(root, VAULT_DIR);

		// Headless governor: audit log, .meta, lock, spend ledger, receipts, patterns.
		const gov = await createGovernor({ vaultBase: root, dryRun: true, budget: 100_000 });
		const a1 = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 100,
		});
		await gov.settle(a1, { inputTokens: 80, outputTokens: 40 });
		const a2 = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 100,
		});
		await gov.abort(a2, new Error("provider failed"));
		// While the governor lives, its audit lock is in the vault too.
		expect(statSync(join(vaultPath, "audit", ".audit-writer.lock")).isFile()).toBe(true);
		expect.soft(walkModes(root).loose).toEqual([]);
		await gov.destroy();

		// trust(): the same vault through the wrapping governor.
		const client = await trust(anthropicMock(), { vaultBase: root, dryRun: true, budget: 100_000 });
		await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "hi" }],
		});
		await client.destroy();

		// Board, snapshots (create AND restore), scope leases, anchoring.
		createBoard(vaultPath).reviewNow("vp_decision", "agent-1", "refactor", { scope: ["a.ts"] });
		await createSnapshot(vaultPath, "s1");
		await restoreSnapshot(vaultPath, "s1");
		new ScopeManager({ storeDir: join(vaultPath, "scope") }).acquireLease({
			actor: "agent-1",
			scope: ["src/**"],
			intent: "edit",
		});
		const keyDir = tmp("ut-perm-key-");
		const storeFile = join(keyDir, "store.jsonl");
		writeFileSync(storeFile, "");
		initAnchorIdentity(root, { keyFile: join(keyDir, "key.pem") });
		const emitter = createAnchorEmitter(root, {
			signer: { type: "pem", file: join(keyDir, "key.pem") },
			sinks: [{ type: "file", path: storeFile }],
		});
		const anchored = await emitter.anchorNow();
		await emitter.stop();
		expect(anchored.emitted).toBe(true);

		const walk = walkModes(root);
		console.log(
			`umask ${label}: ${walk.dirs} dirs, ${walk.files} files, ${walk.loose.length} not owner-only`,
		);
		expect.soft(walk.loose).toEqual([]);
		// The run reached every writer it names: these are present, so the zero above is informative.
		for (const rel of [
			"audit/events.jsonl",
			"audit/events.jsonl.meta",
			"spend-ledger.json",
			"patterns/memory.json",
			"audit/index.json",
			"board/session.json",
			"board/history.jsonl",
			"snapshots/s1.json",
			"scope/leases.json",
			"audit/anchors/identity.json",
			"audit/anchors/anchors.jsonl",
		]) {
			expect.soft(existsSync(join(vaultPath, rel)), rel).toBe(true);
		}
		expect(statSync(join(vaultPath, "audit", "anchors", "outbox")).isDirectory()).toBe(true);
		expect(readdirSync(join(vaultPath, "audit", "llm_call")).length).toBeGreaterThan(0);

		// Nothing outside the vault base: the stray cwd-relative `.usertrust/patterns/` is gone.
		expect(readdirSync(cwd)).toEqual([]);
	});

	it("a dead letter is written owner-only", async () => {
		process.umask(mask);
		const root = tmp("ut-perm-dlq-");
		const writer = createAuditWriter(root);
		// A log path that is a directory makes every append fail into the dead-letter queue.
		mkdirSync(join(root, VAULT_DIR, "audit", "events.jsonl"), { mode: 0o700 });
		await expect(writer.appendEvent({ kind: "x", actor: "sys", data: {} })).rejects.toThrow();
		writer.release();
		const dlq = join(root, VAULT_DIR, "dlq");
		expect(statSync(join(dlq, "dead-letters.jsonl")).isFile()).toBe(true);
		expect.soft(walkModes(dlq).loose).toEqual([]);
		expect(walkModes(join(root, VAULT_DIR, "audit")).loose).toEqual([]);
	});
});

describe.skipIf(onWindows).each([
	[
		"createGovernor",
		async (root: string) => {
			const gov = await createGovernor({ vaultBase: root, dryRun: true, budget: 100_000 });
			await gov.destroy();
		},
	],
	[
		"trust",
		async (root: string) => {
			const client = await trust(anthropicMock(), { vaultBase: root, dryRun: true });
			await client.destroy();
		},
	],
])("a pre-existing vault opened by %s", (_name, open) => {
	it("is closed when group/world-readable, and the vault base is left alone", async () => {
		process.umask(0o022);
		// The shape an earlier version left behind: .usertrust/ 0755 with 0644 files in it.
		const root = tmp("ut-perm-old-");
		chmodSync(root, 0o755);
		const vaultPath = join(root, VAULT_DIR);
		mkdirSync(join(vaultPath, "audit"), { recursive: true, mode: 0o755 });
		writeFileSync(join(vaultPath, "spend-ledger.json"), JSON.stringify({ budgetSpent: 0 }), {
			mode: 0o644,
		});

		await open(root);

		expect(statSync(vaultPath).mode & 0o777).toBe(0o700);
		// The directory the caller owns and named is not usertrust's to change.
		expect(statSync(root).mode & 0o777).toBe(0o755);
	});
});

/** Opens the vault at `root` and makes one governed call, so its audit log and ledger exist. */
const openers: [string, (root: string) => Promise<void>][] = [
	[
		"createGovernor",
		async (root) => {
			const gov = await createGovernor({ vaultBase: root, dryRun: true, budget: 100_000 });
			try {
				const auth = await gov.authorize({
					model: "claude-sonnet-4-6",
					estimatedInputTokens: 100,
					maxOutputTokens: 100,
				});
				await gov.settle(auth, { inputTokens: 80, outputTokens: 40 });
			} finally {
				await gov.destroy();
			}
		},
	],
	[
		"trust",
		async (root) => {
			const client = await trust(anthropicMock(), { vaultBase: root, dryRun: true });
			try {
				await client.messages.create({
					model: "claude-sonnet-4-6",
					max_tokens: 100,
					messages: [{ role: "user", content: "hi" }],
				});
			} finally {
				await client.destroy();
			}
		},
	],
];

describe.each(openers)("a vault that is a symbolic link, opened by %s", (_name, open) => {
	/** `<root>/.usertrust` -> a directory elsewhere, made with `mode`. */
	function linkedVault(mode: number): { root: string; link: string; target: string } {
		process.umask(0o022);
		const root = tmp("ut-perm-link-");
		const target = join(tmp("ut-perm-target-"), "vault");
		mkdirSync(target, { mode });
		chmodSync(target, mode);
		const link = join(root, VAULT_DIR);
		symlinkSync(target, link);
		return { root, link, target: realpathSync(target) };
	}

	it.skipIf(onWindows)(
		"refuses a target other users can read, names the fix, and never changes the target",
		async () => {
			const { root, link, target } = linkedVault(0o755);
			const refused = await open(root).then(
				() => undefined,
				(err: unknown) => err as Error,
			);
			expect.soft(refused).toBeInstanceOf(Error);
			expect.soft(refused?.message).toContain(link);
			expect.soft(refused?.message).toContain(target);
			expect.soft(refused?.message).toContain("mode 755");
			expect.soft(refused?.message).toContain(`chmod 700 ${target}`);
			// Never changed through the link, and nothing written into it.
			expect(statSync(target).mode & 0o777).toBe(0o755);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readdirSync(target)).toEqual([]);
		},
	);

	it.skipIf(onWindows)("uses an owner-only target, and writes it owner-only", async () => {
		const { root, link, target } = linkedVault(0o700);
		await open(root);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(existsSync(join(target, "audit", "events.jsonl"))).toBe(true);
		expect(existsSync(join(target, "spend-ledger.json"))).toBe(true);
		expect(walkModes(target).loose).toEqual([]);
	});

	it.skipIf(onWindows)(
		"refuses a dangling link by name, and creates nothing at its target",
		async () => {
			process.umask(0o022);
			const root = tmp("ut-perm-dangling-");
			const missing = join(realpathSync(tmp("ut-perm-gone-")), "vault");
			const link = join(root, VAULT_DIR);
			symlinkSync(missing, link);
			const refused = await open(root).then(
				() => undefined,
				(err: unknown) => err as Error,
			);
			expect(refused?.message).toBe(
				`usertrust: the vault ${link} is a symbolic link to ${missing}, which does not exist; remove the link or create the target owner-only (mkdir -m 700 ${missing})`,
			);
			expect(existsSync(missing)).toBe(false);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
		},
	);

	it("refuses a .usertrust that is a regular file by name", async () => {
		process.umask(0o022);
		const root = tmp("ut-perm-file-");
		const vaultPath = join(root, VAULT_DIR);
		writeFileSync(vaultPath, "not a vault");
		const refused = await open(root).then(
			() => undefined,
			(err: unknown) => err as Error,
		);
		expect(refused?.message).toBe(
			`usertrust: the vault ${vaultPath} is a regular file, not a directory; move it aside and the vault is created owner-only`,
		);
		expect(statSync(vaultPath).isFile()).toBe(true);
	});
});

/**
 * Makes this process look like ANOTHER user to the vault checks: `geteuid` answers our uid + 1, so
 * a directory we really own is, to them, someone else's. A real foreign owner needs root to make.
 * `owner` is who really owns what the test creates; `euid` is who the checks think we are.
 */
function asAnotherUser(): { owner: number; euid: number; restore: () => void } {
	const owner = process.geteuid?.() as number;
	const spy = vi.spyOn(process, "geteuid").mockReturnValue(owner + 1);
	return { owner, euid: owner + 1, restore: () => spy.mockRestore() };
}

/** The refusal for a vault `owner` owns, opened by `euid`; `target` for a symbolic link. */
function foreignRefusal(vault: string, owner: number, euid: number, target?: string): string {
	const what =
		target === undefined
			? `${vault} is owned by uid ${owner}`
			: `${vault} is a symbolic link to ${target}, which is owned by uid ${owner}`;
	return `the vault ${what}, not by this process (uid ${euid}); usertrust only uses a vault its own user owns. Run as uid ${owner}, or give it to this user with: chown ${euid} ${target ?? vault}`;
}

describe.skipIf(onWindows).each(openers)(
	"a vault another user owns, opened by %s",
	(_name, open) => {
		/** Opens `root` as another user; the refusal, or `undefined` when it opened. */
		async function openAsAnotherUser(root: string): Promise<Error | undefined> {
			const as = asAnotherUser();
			try {
				return await open(root).then(
					() => undefined,
					(err: unknown) => err as Error,
				);
			} finally {
				as.restore();
			}
		}

		it.each([
			["an owner-only", 0o700],
			["a group/world-readable", 0o755],
		])("refuses %s directory, changes nothing and writes nothing", async (_label, mode) => {
			process.umask(0o022);
			const root = tmp("ut-perm-foreign-");
			const vaultPath = join(root, VAULT_DIR);
			mkdirSync(vaultPath, { mode });
			chmodSync(vaultPath, mode);
			const owner = process.geteuid?.() as number;
			const refused = await openAsAnotherUser(root);
			expect
				.soft(refused?.message)
				.toBe(`usertrust: ${foreignRefusal(vaultPath, owner, owner + 1)}`);
			// Never chmod'ed (even a loose one is not "fixed" for its owner), and nothing written in it.
			expect(statSync(vaultPath).mode & 0o777).toBe(mode);
			expect(statSync(vaultPath).uid).toBe(owner);
			expect(readdirSync(vaultPath)).toEqual([]);
		});

		it("refuses a link to an owner-only directory another user owns, and never changes the target", async () => {
			process.umask(0o022);
			const root = tmp("ut-perm-foreign-link-");
			const made = join(tmp("ut-perm-foreign-target-"), "vault");
			mkdirSync(made, { mode: 0o700 });
			const target = realpathSync(made);
			const link = join(root, VAULT_DIR);
			symlinkSync(target, link);
			const owner = process.geteuid?.() as number;
			const refused = await openAsAnotherUser(root);
			expect
				.soft(refused?.message)
				.toBe(`usertrust: ${foreignRefusal(link, owner, owner + 1, target)}`);
			expect(statSync(target).mode & 0o777).toBe(0o700);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readdirSync(target)).toEqual([]);
		});

		it("uses a vault this process's own user owns (control)", async () => {
			process.umask(0o022);
			const root = tmp("ut-perm-own-");
			const vaultPath = join(root, VAULT_DIR);
			mkdirSync(vaultPath, { mode: 0o700 });
			// The real effective uid, unmocked: the owner check passes on the directory's real owner.
			expect(statSync(vaultPath).uid).toBe(process.geteuid?.());
			await open(root);
			expect(existsSync(join(vaultPath, "audit", "events.jsonl"))).toBe(true);
			expect(walkModes(vaultPath).loose).toEqual([]);
		});
	},
);

describe.skipIf(onWindows).each(openers)(
	"a vault the governor creates, opened by %s",
	(_name, open) => {
		/** `path` is the vault or something inside it. */
		const within = (vault: string, path: string): boolean =>
			path === vault || path.startsWith(`${vault}${sep}`);

		it("creates an absent vault itself, exclusively, before any writer touches it", async () => {
			process.umask(0o022);
			// Neither the vault nor its base exists yet.
			const root = join(tmp("ut-perm-fresh-"), "tenant");
			const vaultPath = join(root, VAULT_DIR);
			const mkdirs: { path: string; recursive: boolean }[] = [];
			mkdirHook.before = (path, opts) => {
				if (!within(vaultPath, path)) return;
				mkdirs.push({ path, recursive: (opts as { recursive?: boolean })?.recursive === true });
			};
			await open(root);
			mkdirHook.before = undefined;
			// The first mkdir to reach the vault is the governor's exclusive create of the vault
			// itself: no writer's `mkdir -p` got there first and created it unchecked.
			expect(mkdirs[0]).toEqual({ path: vaultPath, recursive: false });
			expect(statSync(vaultPath).mode & 0o777).toBe(0o700);
			expect(statSync(vaultPath).uid).toBe(process.geteuid?.());
			expect(existsSync(join(vaultPath, "audit", "events.jsonl"))).toBe(true);
			expect(walkModes(root).loose).toEqual([]);
		});

		it("refuses a directory another user creates first, changes nothing and writes nothing", async () => {
			process.umask(0o022);
			const root = tmp("ut-perm-race-");
			const vaultPath = join(root, VAULT_DIR);
			const owner = process.geteuid?.() as number;
			// The race: the moment anything is about to create the vault, "another user" creates it
			// first, owner-only. From then on this process answers to a different uid, so the
			// directory that appeared is someone else's.
			let as: ReturnType<typeof asAnotherUser> | undefined;
			mkdirHook.before = (path) => {
				if (as !== undefined || !within(vaultPath, path)) return;
				as = asAnotherUser();
				mkdirSync(vaultPath, { mode: 0o700 });
			};
			let refused: Error | undefined;
			try {
				refused = await open(root).then(
					() => undefined,
					(err: unknown) => err as Error,
				);
			} finally {
				mkdirHook.before = undefined;
				as?.restore();
			}
			expect(as).toBeDefined();
			expect
				.soft(refused?.message)
				.toBe(`usertrust: ${foreignRefusal(vaultPath, owner, owner + 1)}`);
			expect(statSync(vaultPath).mode & 0o777).toBe(0o700);
			expect(readdirSync(vaultPath)).toEqual([]);
		});

		it.each(["ERR_ACCESS_DENIED", "EPERM"])(
			"opens an existing vault whose parent it may not write to (%s), never creating the parent",
			async (code) => {
				process.umask(0o022);
				const root = tmp("ut-perm-ro-parent-");
				const vaultPath = join(root, VAULT_DIR);
				mkdirSync(vaultPath, { mode: 0o700 });
				// The parent refuses every mkdir, as Node's permission model does when writes are
				// granted to the vault alone (ERR_ACCESS_DENIED), or a drive root does (EPERM).
				const parentMkdirs: string[] = [];
				mkdirHook.before = (path) => {
					if (path !== root) return;
					parentMkdirs.push(path);
					throw Object.assign(new Error(`${code}: mkdir '${path}'`), { code });
				};
				await open(root);
				mkdirHook.before = undefined;
				expect(parentMkdirs).toEqual([]);
				expect(statSync(vaultPath).mode & 0o777).toBe(0o700);
				expect(existsSync(join(vaultPath, "audit", "events.jsonl"))).toBe(true);
			},
		);

		it("creates a fresh vault whose parents are missing: the parents 0700, then the vault exclusively", async () => {
			process.umask(0o022);
			const top = join(tmp("ut-perm-deep-"), "a");
			const root = join(top, "b");
			const vaultPath = join(root, VAULT_DIR);
			const mkdirs: { path: string; recursive: boolean }[] = [];
			mkdirHook.before = (path, opts) => {
				if (path !== root && !within(vaultPath, path)) return;
				mkdirs.push({ path, recursive: (opts as { recursive?: boolean })?.recursive === true });
			};
			await open(root);
			mkdirHook.before = undefined;
			// The exclusive mkdir finds a parent missing (ENOENT); the parents are made; the vault is
			// then created exclusively, before any writer's mkdir reaches it.
			expect(mkdirs.slice(0, 3)).toEqual([
				{ path: vaultPath, recursive: false },
				{ path: root, recursive: true },
				{ path: vaultPath, recursive: false },
			]);
			expect(statSync(vaultPath).uid).toBe(process.geteuid?.());
			expect(existsSync(join(vaultPath, "audit", "events.jsonl"))).toBe(true);
			expect(walkModes(top).loose).toEqual([]);
		});
	},
);

describe.skipIf(onWindows).each(openers)(
	"a linked vault whose target has `..` after another link, opened by %s",
	(_name, open) => {
		/**
		 * `<a>/link -> <b>/subdir`, and `.usertrust -> <a>/link/../vault`. The OS resolves `..`
		 * after following `link`, so it opens `<b>/vault`; a lexical resolve (JS realpath) names
		 * `<a>/vault`. The two candidates get the modes given.
		 */
		function dotDotVault(bMode: number, aMode: number) {
			process.umask(0o022);
			const base = realpathSync(tmp("ut-perm-dotdot-"));
			const a = join(base, "a");
			const b = join(base, "b");
			mkdirSync(join(b, "subdir"), { recursive: true });
			mkdirSync(a);
			symlinkSync(join(b, "subdir"), join(a, "link"));
			const opened = join(b, "vault");
			const lexical = join(a, "vault");
			mkdirSync(opened);
			chmodSync(opened, bMode);
			mkdirSync(lexical);
			chmodSync(lexical, aMode);
			const root = tmp("ut-perm-dotdot-root-");
			const link = join(root, VAULT_DIR);
			symlinkSync(`${a}/link/../vault`, link);
			return { root, link, opened, lexical };
		}

		it("refuses when what the OS opens is loose, though the lexical path is owner-only", async () => {
			const { root, link, opened, lexical } = dotDotVault(0o755, 0o700);
			expect
				.soft(looseVaultWarning(link))
				.toContain(`${opened}, which is readable by other users (mode 755)`);
			const refused = await open(root).then(
				() => undefined,
				(err: unknown) => err as Error,
			);
			expect(refused?.message).toBe(
				`usertrust: the vault ${link} is a symbolic link to ${opened}, which other users can read (mode 755). usertrust does not change a directory through a link; make it owner-only with: chmod 700 ${opened}`,
			);
			expect(statSync(opened).mode & 0o777).toBe(0o755);
			expect(readdirSync(opened)).toEqual([]);
			expect(readdirSync(lexical)).toEqual([]);
		});

		it("uses what the OS opens when it is owner-only, though the lexical path is loose", async () => {
			const { root, link, opened, lexical } = dotDotVault(0o700, 0o755);
			expect.soft(looseVaultWarning(link)).toBeUndefined();
			await open(root);
			// Written where the OS opens. (Not audit/events.jsonl: the audit writer's lock resolves
			// the vault with JS realpath, the same lexical `..`, so the chain degrades through such
			// a link; that writer is outside this check.)
			expect(existsSync(join(opened, "spend-ledger.json"))).toBe(true);
			expect(readdirSync(lexical)).toEqual([]);
			expect(statSync(lexical).mode & 0o777).toBe(0o755);
		});
	},
);

/** Root ignores permission bits: nothing is unreachable or unwritable for it. */
const isRoot = process.geteuid?.() === 0;

describe.skipIf(onWindows).each(openers)(
	"a linked vault and this process's permissions on its target, opened by %s",
	(_name, open) => {
		/** `.usertrust` -> `<realpath tmp>/<dir>/vault`, the target made 0700 then given `mode`. */
		function linkedTo(mode: number, dirMode = 0o700) {
			process.umask(0o022);
			const dir = join(realpathSync(tmp("ut-perm-access-")), "dir");
			const target = join(dir, "vault");
			mkdirSync(target, { recursive: true, mode: 0o700 });
			const root = tmp("ut-perm-access-root-");
			const link = join(root, VAULT_DIR);
			symlinkSync(target, link);
			chmodSync(target, mode);
			chmodSync(dir, dirMode);
			const restore = (): void => {
				chmodSync(dir, 0o700);
				chmodSync(target, 0o700);
			};
			return { root, link, dir, target, restore };
		}

		/** Opens `root`; the refusal, or `undefined` when it opened. */
		const attempt = (root: string): Promise<Error | undefined> =>
			open(root).then(
				() => undefined,
				(err: unknown) => err as Error,
			);

		it("uses a write-and-search-only target (0300): reading the directory is not needed", async () => {
			const { root, target, restore } = linkedTo(0o300);
			let refused: Error | undefined;
			try {
				refused = await attempt(root);
				expect(statSync(target).mode & 0o777).toBe(0o300);
			} finally {
				restore();
			}
			expect(refused).toBeUndefined();
			expect(existsSync(join(target, "audit", "events.jsonl"))).toBe(true);
			expect(existsSync(join(target, "spend-ledger.json"))).toBe(true);
			// No write failed into the dead-letter queue.
			expect(existsSync(join(target, "dlq"))).toBe(false);
			// Everything written under it is owner-only (the target itself was put back to 0700).
			expect(walkModes(target).loose).toEqual([]);
		});

		it.skipIf(isRoot)(
			"refuses by name a search-only target (0100) it cannot write to (skipped as root)",
			async () => {
				const { root, link, target, restore } = linkedTo(0o100);
				let refused: Error | undefined;
				try {
					refused = await attempt(root);
					expect(statSync(target).mode & 0o777).toBe(0o100);
				} finally {
					restore();
				}
				expect(refused?.message).toBe(
					`usertrust: the vault ${link} is a symbolic link to ${target}, which this process cannot write to (mode 100); usertrust does not change a directory through a link; make it usable with: chmod 700 ${target}`,
				);
				expect(readdirSync(target)).toEqual([]);
			},
		);

		it.skipIf(isRoot)(
			"refuses by name a target it cannot search its way to (skipped as root)",
			async () => {
				const { root, link, dir, target, restore } = linkedTo(0o700, 0o000);
				let refused: Error | undefined;
				try {
					refused = await attempt(root);
					expect(lstatSync(dir).mode & 0o777).toBe(0o000);
				} finally {
					restore();
				}
				expect(refused?.message).toBe(
					`usertrust: the vault ${link} is a symbolic link to ${target}, which this process cannot reach (EACCES); give this user search permission on every directory on the way to it, or point the link elsewhere`,
				);
				expect(readdirSync(target)).toEqual([]);
			},
		);
	},
);

describe.skipIf(onWindows).each(openers)(
	"a real vault directory and this process's permissions on it, opened by %s",
	(_name, open) => {
		/** `<root>/.usertrust`, a real directory made 0700 and then given `mode`. */
		function realVault(mode: number): { root: string; vaultPath: string } {
			process.umask(0o022);
			const root = tmp("ut-perm-real-access-");
			const vaultPath = join(root, VAULT_DIR);
			mkdirSync(vaultPath, { mode: 0o700 });
			chmodSync(vaultPath, mode);
			return { root, vaultPath };
		}

		it.skipIf(isRoot)(
			"refuses by name an owner-only vault it cannot write to (0100), changing nothing (skipped as root)",
			async () => {
				const { root, vaultPath } = realVault(0o100);
				let refused: Error | undefined;
				try {
					refused = await open(root).then(
						() => undefined,
						(err: unknown) => err as Error,
					);
					expect(statSync(vaultPath).mode & 0o777).toBe(0o100);
				} finally {
					chmodSync(vaultPath, 0o700);
				}
				expect(refused?.message).toBe(
					`usertrust: the vault ${vaultPath} is owned by this user but this process cannot write to it (mode 100); make it usable with: chmod 700 ${vaultPath}`,
				);
				expect(readdirSync(vaultPath)).toEqual([]);
			},
		);

		it("uses an owner-only vault it can write to but not read (0300), and leaves its mode", async () => {
			const { root, vaultPath } = realVault(0o300);
			let refused: Error | undefined;
			try {
				refused = await open(root).then(
					() => undefined,
					(err: unknown) => err as Error,
				);
				// Owner-only already: never chmod'ed.
				expect(statSync(vaultPath).mode & 0o777).toBe(0o300);
			} finally {
				chmodSync(vaultPath, 0o700);
			}
			expect(refused).toBeUndefined();
			expect(existsSync(join(vaultPath, "audit", "events.jsonl"))).toBe(true);
			expect(existsSync(join(vaultPath, "spend-ledger.json"))).toBe(true);
			// No write failed into the dead-letter queue, and everything written is owner-only.
			expect(existsSync(join(vaultPath, "dlq"))).toBe(false);
			expect(walkModes(vaultPath).loose).toEqual([]);
		});
	},
);

/**
 * The same, under Node's real permission model: a child process may write to the vault alone.
 * Runs where this Node strips TypeScript types by default (22.18+), so the child can import the
 * module's source directly.
 */
describe.skipIf(onWindows || !process.features.typescript)(
	"an existing vault under Node's permission model, writes granted to the vault alone",
	() => {
		it("opens without creating its parent", () => {
			const root = tmp("ut-perm-node-permission-");
			const vaultPath = join(realpathSync(root), VAULT_DIR);
			mkdirSync(vaultPath, { mode: 0o700 });
			const source = join(import.meta.dirname, "..", "..", "src", "shared", "private-fs.ts");
			const child = spawnSync(
				process.execPath,
				[
					"--permission",
					"--allow-fs-read=*",
					`--allow-fs-write=${vaultPath}`,
					"--input-type=module",
					"-e",
					`import { securePrivateVault } from ${JSON.stringify(source)};
securePrivateVault(process.argv[1], { create: true });
process.stdout.write("opened");`,
					vaultPath,
				],
				{ encoding: "utf-8", timeout: 30_000 },
			);
			expect(child.stderr).not.toContain("ERR_ACCESS_DENIED");
			expect(child.status).toBe(0);
			expect(child.stdout).toBe("opened");
			// Nothing was created beside the vault.
			expect(readdirSync(root)).toEqual([VAULT_DIR]);
		});
	},
);

describe.skipIf(onWindows).each(openers)(
	"a vault another user owns is refused before anything in it is read, opened by %s",
	(_name, open) => {
		const BAD_JSON = "{ not json";
		/** Unblocks a reader stuck opening the FIFO at `path`, if one is: a writer opens it once. */
		function releaseFifo(path: string): void {
			try {
				closeSync(openSync(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
			} catch {
				/* ENXIO: no reader is waiting on it */
			}
		}

		it.each([
			[
				"a usertrust.config.json that does not parse",
				(file: string) => writeFileSync(file, BAD_JSON, { mode: 0o600 }),
				(file: string) => expect(readFileSync(file, "utf-8")).toBe(BAD_JSON),
			],
			[
				"a usertrust.config.json that is a FIFO (a read would block)",
				(file: string) => execFileSync("mkfifo", ["-m", "600", file]),
				(file: string) => expect(lstatSync(file).isFIFO()).toBe(true),
			],
		])(
			"holding %s: the owner refusal, not a config error or a hang",
			async (_label, plant, unchanged) => {
				process.umask(0o022);
				const root = tmp("ut-perm-foreign-config-");
				const vaultPath = join(root, VAULT_DIR);
				mkdirSync(vaultPath, { mode: 0o700 });
				const configFile = join(vaultPath, "usertrust.config.json");
				plant(configFile);
				const as = asAnotherUser();
				let timer: NodeJS.Timeout | undefined;
				let outcome: Error | "opened" | "hung";
				try {
					outcome = await Promise.race([
						open(root).then(
							() => "opened" as const,
							(err: unknown) => err as Error,
						),
						new Promise<"hung">((done) => {
							timer = setTimeout(() => done("hung"), 3_000);
						}),
					]);
				} finally {
					clearTimeout(timer);
					as.restore();
					releaseFifo(configFile);
				}
				expect(outcome).toBeInstanceOf(Error);
				expect((outcome as Error).message).toBe(
					`usertrust: ${foreignRefusal(vaultPath, as.owner, as.euid)}`,
				);
				unchanged(configFile);
				expect(readdirSync(vaultPath)).toEqual(["usertrust.config.json"]);
			},
		);
	},
);

describe.skipIf(onWindows)("on Windows, simulated on POSIX", () => {
	it("no mode or owner is set or checked, and the CLI never warns", () => {
		process.umask(0o022);
		const root = tmp("ut-perm-win32-");
		const vaultPath = join(root, VAULT_DIR);
		mkdirSync(vaultPath, { mode: 0o755 });
		chmodSync(vaultPath, 0o755);
		const fresh = join(root, "fresh", VAULT_DIR);
		// Foreign AND loose: on POSIX this vault is refused (owner) and warned about (both).
		const as = process.geteuid === undefined ? undefined : asAnotherUser();
		const original = process.platform;
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			expect.soft(() => securePrivateVault(vaultPath)).not.toThrow();
			expect.soft(looseVaultWarning(vaultPath)).toBeUndefined();
			securePrivateVault(fresh, { create: true });
		} finally {
			if (platform !== undefined) Object.defineProperty(process, "platform", platform);
			as?.restore();
		}
		expect(process.platform).toBe(original);
		expect(statSync(vaultPath).mode & 0o777).toBe(0o755);
		expect(statSync(fresh).isDirectory()).toBe(true);
		// Control: back on this platform, the same vault is warned about.
		expect(looseVaultWarning(vaultPath)).toContain("is readable by other users (mode 755)");
	});
});

/** A CLI command that opens an existing vault without starting a governor, run as `--json`. */
async function runCli(command: "inspect" | "health", root: string): Promise<void> {
	const { run } =
		command === "inspect"
			? await import("../../src/cli/inspect.js")
			: await import("../../src/cli/health.js");
	await run(root, { json: true });
}

describe.skipIf(onWindows).each(["inspect", "health"] as const)(
	"usertrust %s on an existing vault",
	(command) => {
		/** Runs the command; its stderr, and whether its JSON answer is a success. */
		async function capture(root: string): Promise<{ stderr: string; success: boolean }> {
			let stderr = "";
			const out: string[] = [];
			const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
				stderr += String(chunk);
				return true;
			});
			const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
				out.push(String(line));
			});
			try {
				await runCli(command, root);
			} finally {
				err.mockRestore();
				log.mockRestore();
			}
			const answer = JSON.parse(out.join("\n")) as { success?: boolean };
			return { stderr, success: answer.success === true };
		}

		/** A vault with a chain and a ledger in it, then given `mode` the way an earlier version left it. */
		async function vaultAt(mode: number): Promise<{ root: string; vaultPath: string }> {
			process.umask(0o022);
			const root = tmp("ut-perm-cli-");
			const gov = await createGovernor({ vaultBase: root, dryRun: true, budget: 100_000 });
			const auth = await gov.authorize({
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 100,
				maxOutputTokens: 100,
			});
			await gov.settle(auth, { inputTokens: 80, outputTokens: 40 });
			await gov.destroy();
			const vaultPath = join(root, VAULT_DIR);
			chmodSync(vaultPath, mode);
			return { root, vaultPath };
		}

		it("warns on a vault other users can read, succeeds, and never changes its mode", async () => {
			const { root, vaultPath } = await vaultAt(0o755);
			const { stderr, success } = await capture(root);
			expect
				.soft(stderr)
				.toContain(
					`usertrust: warning: the vault ${vaultPath} is readable by other users (mode 755); make it owner-only with: chmod 700 ${vaultPath}`,
				);
			expect.soft(success).toBe(true);
			expect(statSync(vaultPath).mode & 0o777).toBe(0o755);
		});

		it("warns with the target for a linked vault, and never changes the target", async () => {
			process.umask(0o022);
			const { vaultPath: real } = await vaultAt(0o755);
			const target = realpathSync(real);
			const root = tmp("ut-perm-cli-link-");
			const link = join(root, VAULT_DIR);
			symlinkSync(target, link);
			const { stderr, success } = await capture(root);
			expect
				.soft(stderr)
				.toContain(
					`usertrust: warning: the vault ${link} is a symbolic link to ${target}, which is readable by other users (mode 755); make it owner-only with: chmod 700 ${target}`,
				);
			expect.soft(success).toBe(true);
			expect(statSync(target).mode & 0o777).toBe(0o755);
		});

		it("warns on a vault another user owns, naming the owner and this process's uid, and changes nothing", async () => {
			const { root, vaultPath } = await vaultAt(0o700);
			const as = asAnotherUser();
			let result: { stderr: string; success: boolean };
			try {
				result = await capture(root);
			} finally {
				as.restore();
			}
			expect
				.soft(result.stderr)
				.toContain(`usertrust: warning: ${foreignRefusal(vaultPath, as.owner, as.euid)}`);
			expect.soft(result.success).toBe(true);
			expect(statSync(vaultPath).mode & 0o777).toBe(0o700);
			expect(statSync(vaultPath).uid).toBe(as.owner);
		});

		it("says nothing about an owner-only vault", async () => {
			const { root, vaultPath } = await vaultAt(0o700);
			const { stderr, success } = await capture(root);
			expect(stderr).not.toContain("usertrust: warning: the vault");
			expect(success).toBe(true);
			expect(statSync(vaultPath).mode & 0o777).toBe(0o700);
		});
	},
);

describe.skipIf(onWindows)("init (control)", () => {
	it("creates the vault 0700 / 0600 throughout", async () => {
		process.umask(0o022);
		const root = tmp("ut-perm-init-");
		const { run } = await import("../../src/cli/init.js");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await run(root, { json: true });
		} finally {
			log.mockRestore();
		}
		const walk = walkModes(join(root, VAULT_DIR));
		expect(walk.files).toBeGreaterThan(0);
		expect.soft(walk.loose).toEqual([]);
	});
});

/**
 * Native Windows only: it runs on no platform this suite is run on today, and is the only row
 * that would run on Windows itself. There usertrust sets and checks no mode or owner: a governor
 * creates the vault and uses an existing one as it is, and the CLI never warns.
 */
/** Runs `fn`; every `usertrust: vault base` line it wrote to stderr. */
async function vaultBaseLines(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		for (const line of String(chunk).split("\n")) {
			if (line.startsWith("usertrust: vault base ")) lines.push(line);
		}
		return true;
	});
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	return lines;
}

/** Runs `fn`; every raw stderr write it made that is a `usertrust: vault base` notice, unsplit. */
async function vaultBaseWrites(fn: () => Promise<void>): Promise<string[]> {
	const writes: string[] = [];
	const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		if (String(chunk).startsWith("usertrust: vault base ")) writes.push(String(chunk));
		return true;
	});
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	return writes;
}

describe.skipIf(onWindows).each(openers)(
	"a vault base with `..` after a symbolic link, opened by %s",
	(_name, open) => {
		/** In the working directory: `x/y`, and `link -> x/y`. `link/..` is `x` to the kernel. */
		function linkedCwd(): { real: string } {
			process.umask(0o022);
			mkdirSync(join(cwd, "x", "y"), { recursive: true });
			symlinkSync(join(cwd, "x", "y"), join(cwd, "link"));
			return { real: realpathSync.native(join(cwd, "x")) };
		}

		it("a relative `link/../vault` lands where the kernel resolves it, and says so once", async () => {
			const { real } = linkedCwd();
			const lines = await vaultBaseLines(() => open("link/../vault"));
			expect
				.soft(lines)
				.toEqual([`usertrust: vault base "link/../vault" resolves to "${real}/vault"`]);
			expect(existsSync(join(real, "vault", VAULT_DIR, "spend-ledger.json"))).toBe(true);
			expect(statSync(join(real, "vault", VAULT_DIR)).mode & 0o777).toBe(0o700);
			// Nothing at the lexical spelling, `<cwd>/vault`.
			expect(existsSync(join(cwd, "vault"))).toBe(false);
		});

		it("an absolute `<cwd>/link/../vault` lands where the kernel resolves it", async () => {
			const { real } = linkedCwd();
			const base = `${cwd}/link/../vault`;
			const lines = await vaultBaseLines(() => open(base));
			expect.soft(lines).toEqual([`usertrust: vault base "${base}" resolves to "${real}/vault"`]);
			expect(existsSync(join(real, "vault", VAULT_DIR, "spend-ledger.json"))).toBe(true);
			expect(existsSync(join(cwd, "vault"))).toBe(false);
		});

		it("a tail that does not exist yet is created owner-only at the kernel's location", async () => {
			const { real } = linkedCwd();
			await open(`${cwd}/link/../new/tenant`);
			expect(existsSync(join(real, "new", "tenant", VAULT_DIR, "spend-ledger.json"))).toBe(true);
			expect(statSync(join(real, "new")).mode & 0o777).toBe(0o700);
			expect(statSync(join(real, "new", "tenant")).mode & 0o777).toBe(0o700);
			expect(existsSync(join(cwd, "new"))).toBe(false);
		});

		it("refuses a `..` in the part that does not exist yet, and creates nothing", async () => {
			process.umask(0o022);
			const base = `${cwd}/missing/../t`;
			const refused = await open(base).then(
				() => undefined,
				(err: unknown) => err as Error,
			);
			expect(refused?.message).toBe(
				`usertrust: the vault base ${base} has ".." after ${cwd}/missing, which does not exist yet; create it first, or give the base without ".."`,
			);
			expect(readdirSync(cwd)).toEqual([]);
		});

		it("where realpath(3) cannot work, refuses a `..` base by name and still opens a plain one", async () => {
			linkedCwd();
			nativeHook.fail = () => Object.assign(new Error("ENOENT: realpath"), { code: "ENOENT" });
			const refused = await open("link/../vault").then(
				() => undefined,
				(err: unknown) => err as Error,
			);
			expect(refused?.message).toBe(
				`usertrust: the vault base link/../vault contains "..", and this system cannot resolve paths the way the kernel does (realpath(3) failed: ENOENT); give the base without ".." segments`,
			);
			expect(existsSync(join(cwd, "vault"))).toBe(false);
			expect(existsSync(join(cwd, "x", "vault"))).toBe(false);
			// A base with no `..` needs no resolution.
			const lines = await vaultBaseLines(() => open("plain"));
			expect(lines).toEqual([]);
			expect(existsSync(join(cwd, "plain", VAULT_DIR, "spend-ledger.json"))).toBe(true);
		});

		it("prints a newline and an ESC in the base as escapes, and still lands at the real path", async () => {
			const { real } = linkedCwd();
			// A link whose NAME carries a line break and a clear-screen sequence.
			const name = "l\nk\x1b[2J";
			symlinkSync(join(cwd, "x", "y"), join(cwd, name));
			const writes = await vaultBaseWrites(() => open(`${name}/../vault`));
			expect(writes.join("")).not.toContain("\x1b");
			expect(writes).toEqual([
				`usertrust: vault base "l\\nk\\x1b[2J/../vault" resolves to "${real}/vault"\n`,
			]);
			expect(existsSync(join(real, "vault", VAULT_DIR, "spend-ledger.json"))).toBe(true);
		});

		it("prints a C1 byte (U+009B, the 8-bit CSI) in the resolved path as an escape", async () => {
			const { real } = linkedCwd();
			const writes = await vaultBaseWrites(() => open("link/../v\u009bault"));
			expect(writes.join("")).not.toContain("\u009b");
			expect(writes).toEqual([
				`usertrust: vault base "link/../v\\x9bault" resolves to "${real}/v\\x9bault"\n`,
			]);
			// The vault is at the real name, not at the escaped one.
			expect(existsSync(join(real, "v\u009bault", VAULT_DIR, "spend-ledger.json"))).toBe(true);
		});

		it("a refusal names the base with its controls escaped", async () => {
			process.umask(0o022);
			const refused = await open(`${cwd}/mi\x1bss\ning/../t`).then(
				() => undefined,
				(err: unknown) => err as Error,
			);
			expect(refused?.message).toBe(
				`usertrust: the vault base ${cwd}/mi\\x1bss\\ning/../t has ".." after ${cwd}/mi\\x1bss\\ning, which does not exist yet; create it first, or give the base without ".."`,
			);
		});

		it("a base with no `..` keeps its spelling and is not announced (control)", async () => {
			process.umask(0o022);
			const root = tmp("ut-perm-plain-base-");
			const lines = await vaultBaseLines(() => open(root));
			expect(lines).toEqual([]);
			expect(existsSync(join(root, VAULT_DIR, "spend-ledger.json"))).toBe(true);
		});
	},
);

describe.runIf(onWindows).each(openers)("on native Windows, opened by %s", (_name, open) => {
	it("creates a fresh vault, uses an existing one unchanged, and never warns", async () => {
		const fresh = join(tmp("ut-perm-native-win-"), "tenant");
		await open(fresh);
		expect(statSync(join(fresh, VAULT_DIR)).isDirectory()).toBe(true);
		expect(looseVaultWarning(join(fresh, VAULT_DIR))).toBeUndefined();

		const root = tmp("ut-perm-native-win-existing-");
		const vaultPath = join(root, VAULT_DIR);
		mkdirSync(vaultPath);
		const before = statSync(vaultPath).mode;
		expect(() => securePrivateVault(vaultPath, { create: true })).not.toThrow();
		await open(root);
		expect(statSync(vaultPath).mode).toBe(before);
		expect(existsSync(join(vaultPath, "audit", "events.jsonl"))).toBe(true);
		expect(looseVaultWarning(vaultPath)).toBeUndefined();
	});
});
