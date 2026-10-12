// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A vault holds audit trails, spend records and (with content capture on) prompts and tool
 * inputs. Every directory usertrust creates under it must be 0700 and every file 0600, whatever
 * the process umask: a umask can only REMOVE bits, so the modes are passed explicitly at
 * creation, never left to `0o777 & ~umask` / `0o666 & ~umask`. And a governor given a vault base
 * writes nothing outside it — no `.usertrust/patterns/` in the process working directory.
 */

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnchorEmitter, initAnchorIdentity } from "../../src/audit/anchor.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { createBoard } from "../../src/board/board.js";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { ScopeManager } from "../../src/resilience/scope.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
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

describe.each([
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

describe.each([
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

	it("refuses a target other users can read, names the fix, and never changes the target", async () => {
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
	});

	it("uses an owner-only target, and writes it owner-only", async () => {
		const { root, link, target } = linkedVault(0o700);
		await open(root);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(existsSync(join(target, "audit", "events.jsonl"))).toBe(true);
		expect(existsSync(join(target, "spend-ledger.json"))).toBe(true);
		expect(walkModes(target).loose).toEqual([]);
	});
});

describe("init (control)", () => {
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
