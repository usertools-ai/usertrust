// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * two-clients-one-vault.e2e.test.ts — the README's own integration pattern, end to end:
 * `trust(new Anthropic())` AND `trust(new OpenAI())` in ONE process on ONE vault, real SDK
 * clients against an in-process HTTP provider, `dryRun`.
 *
 * Every governed call must reach the ONE hash chain: a receipt for every call, none degraded,
 * every receipt's `auditHash` an event on the chain, one linked chain of exactly that many events,
 * nothing dead-lettered. Before the shared per-vault writer, the second client's every audit write
 * failed on the vault's writer lock (it was a second writer in this process), the calls settled
 * anyway, and half the spend had no audit event — while the chain itself still verified.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVault } from "../../../verify/src/index.js";
import { run as verifyRun } from "../../src/cli/verify.js";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { TrustReceipt } from "../../src/shared/types.js";

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

/** An in-process provider answering both the Anthropic Messages and OpenAI Chat Completions routes. */
function startProvider(): Promise<{ server: Server; url: string }> {
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.setHeader("content-type", "application/json");
			if (req.url?.endsWith("/messages")) {
				res.end(
					JSON.stringify({
						id: "msg_two_clients",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-5",
						content: [{ type: "text", text: "ok" }],
						stop_reason: "end_turn",
						usage: { input_tokens: 10, output_tokens: 5 },
					}),
				);
			} else {
				res.end(
					JSON.stringify({
						id: "chatcmpl_two_clients",
						object: "chat.completion",
						created: 1,
						model: "gpt-4o",
						choices: [
							{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
						],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					}),
				);
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			resolve({ server, url: `http://127.0.0.1:${port}` });
		});
	});
}

interface ChainLine {
	hash: string;
	previousHash: string;
	sequence: number;
	kind: string;
	data: { transferId?: string };
}

function readChain(vault: string): ChainLine[] {
	const log = join(vault, VAULT_DIR, "audit", "events.jsonl");
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as ChainLine);
}

const deadLetterPath = (vault: string) => join(vault, VAULT_DIR, "dlq", "dead-letters.jsonl");
const lockPath = (vault: string) => join(vault, VAULT_DIR, "audit", ".audit-writer.lock");

/** One linked chain: sequence 1..n, each event chained from the one before it. */
function expectOneLinkedChain(chain: ChainLine[]): void {
	chain.forEach((event, i) => {
		expect(event.sequence, `event ${i}`).toBe(i + 1);
		if (i > 0) expect(event.previousHash, `event ${i}`).toBe(chain[i - 1]?.hash);
	});
}

describe("the README's two-client pattern: two trust() clients, one process, one vault", () => {
	let vault: string;
	let provider: { server: Server; url: string };
	const degradedWarnings: string[] = [];
	const onWarning = (w: Error & { code?: string }) => {
		// This test's own vault only: an earlier test's warning can land a tick later.
		if (w.code === "USERTRUST_AUDIT_DEGRADED" && w.message.includes(vault)) {
			degradedWarnings.push(w.message);
		}
	};

	beforeEach(async () => {
		vault = join(tmpdir(), `two-clients-${randomUUID()}`);
		mkdirSync(vault, { recursive: true });
		provider = await startProvider();
		degradedWarnings.length = 0;
		process.on("warning", onWarning);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(async () => {
		process.off("warning", onWarning);
		vi.restoreAllMocks();
		await new Promise<void>((r) => provider.server.close(() => r()));
		rmSync(vault, { recursive: true, force: true });
	});

	it("200 interleaved calls: every one is on the ONE chain, none degraded, nothing dead-lettered", async () => {
		const anthropic = await trust(new Anthropic({ apiKey: "test", baseURL: provider.url }), {
			dryRun: true,
			vaultBase: vault,
		});
		const openai = await trust(new OpenAI({ apiKey: "test", baseURL: `${provider.url}/v1` }), {
			dryRun: true,
			vaultBase: vault,
		});
		const receipts: TrustReceipt[] = [];
		for (let batch = 0; batch < 20; batch++) {
			const calls: Array<Promise<{ receipt: TrustReceipt }>> = [];
			for (let i = 0; i < 10; i++) {
				calls.push(
					i % 2 === 0
						? anthropic.messages.create({
								model: "claude-sonnet-4-5",
								max_tokens: 16,
								messages: [{ role: "user", content: "hi" }],
							})
						: openai.chat.completions.create({
								model: "gpt-4o",
								messages: [{ role: "user", content: "hi" }],
							}),
				);
			}
			for (const { receipt } of await Promise.all(calls)) receipts.push(receipt);
		}
		await anthropic.destroy();
		await openai.destroy();

		expect(receipts).toHaveLength(200);
		expect(receipts.filter((r) => r.auditDegraded === true)).toHaveLength(0);
		const chain = readChain(vault);
		expect(chain).toHaveLength(200);
		expect(chain.every((e) => e.kind === "llm_call")).toBe(true);
		expectOneLinkedChain(chain);
		const onChain = new Set(chain.map((e) => e.hash));
		expect(receipts.filter((r) => !onChain.has(r.auditHash))).toHaveLength(0);
		// Each receipt names its own event: the transferIds line up one to one.
		expect(new Set(chain.map((e) => e.data.transferId))).toEqual(
			new Set(receipts.map((r) => r.transferId)),
		);
		expect(existsSync(deadLetterPath(vault))).toBe(false);
		expect(degradedWarnings).toEqual([]);
		const verified = verifyVault(join(vault, VAULT_DIR));
		expect(verified.valid).toBe(true);
		expect(verified.chainLength).toBe(200);
		// Both clients destroyed: the vault's lock is released.
		expect(existsSync(lockPath(vault))).toBe(false);
	}, 60_000);

	it("destroying one client leaves the other writing to the same chain; the lock goes with the LAST", async () => {
		const anthropic = await trust(new Anthropic({ apiKey: "test", baseURL: provider.url }), {
			dryRun: true,
			vaultBase: vault,
		});
		const openai = await trust(new OpenAI({ apiKey: "test", baseURL: `${provider.url}/v1` }), {
			dryRun: true,
			vaultBase: vault,
		});
		const ask = () =>
			openai.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			});
		const a = await anthropic.messages.create({
			model: "claude-sonnet-4-5",
			max_tokens: 16,
			messages: [{ role: "user", content: "hi" }],
		});
		const b0 = await ask();
		await anthropic.destroy();
		// The other client still holds the vault's writer: its lock stays, and its calls are audited.
		expect(existsSync(lockPath(vault))).toBe(true);
		const b1 = await ask();
		expect(b1.receipt.auditDegraded).toBeUndefined();
		await openai.destroy();
		expect(existsSync(lockPath(vault))).toBe(false);
		// A client that destroys BEFORE the other first appends leaves no lock behind it, and the other's
		// first append starts the writer again on the same chain.
		const late = await trust(new OpenAI({ apiKey: "test", baseURL: `${provider.url}/v1` }), {
			dryRun: true,
			vaultBase: vault,
		});
		const early = await trust(new Anthropic({ apiKey: "test", baseURL: provider.url }), {
			dryRun: true,
			vaultBase: vault,
		});
		const c = await early.messages.create({
			model: "claude-sonnet-4-5",
			max_tokens: 16,
			messages: [{ role: "user", content: "hi" }],
		});
		await early.destroy();
		expect(existsSync(lockPath(vault))).toBe(false);
		const d = await late.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(d.receipt.auditDegraded).toBeUndefined();
		await late.destroy();
		expect(existsSync(lockPath(vault))).toBe(false);
		const chain = readChain(vault);
		expect(chain.map((e) => e.hash)).toEqual([a, b0, b1, c, d].map((r) => r.receipt.auditHash));
		expectOneLinkedChain(chain);
	});

	it("another PROCESS holding the vault: calls settle, but loudly, and every lost event is counted against its receipt", async () => {
		// One writer per vault is still the rule ACROSS processes. Another live process holds this
		// vault's lock (the parent PID stands in for it): every append here fails.
		mkdirSync(join(vault, VAULT_DIR, "audit"), { recursive: true });
		writeFileSync(
			lockPath(vault),
			JSON.stringify({ pid: process.ppid, startedAt: "2020-01-01T00:00:00Z" }),
		);
		const openai = await trust(new OpenAI({ apiKey: "test", baseURL: `${provider.url}/v1` }), {
			dryRun: true,
			vaultBase: vault,
		});
		const receipts: TrustReceipt[] = [];
		for (let i = 0; i < 4; i++) {
			const { receipt } = await openai.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			});
			receipts.push(receipt);
		}
		await new Promise((r) => setImmediate(r));
		// failClosed is false: every call settled, every receipt says its audit degraded…
		expect(receipts.every((r) => r.settled === true && r.auditDegraded === true)).toBe(true);
		// …and the process was told once, not four times, while the calls ran,
		expect(degradedWarnings).toHaveLength(1);
		await openai.destroy();
		await new Promise((r) => setImmediate(r));
		// and once more, with the count, when the client was destroyed.
		expect(degradedWarnings).toHaveLength(2);
		expect(degradedWarnings[1]).toMatch(/4 audit writes failed while this governor was open/);
		// The cross-check: every degraded receipt's transfer is a dead-lettered event missing from the
		// chain — no more, no fewer.
		// Read straight from the file (this test imports nothing this fix added, so it runs, red, on
		// the code before it).
		const deadLettered = readFileSync(deadLetterPath(vault), "utf-8")
			.trim()
			.split("\n")
			.map(
				(l) =>
					(JSON.parse(l) as { payload: { data: { transferId: string } } }).payload.data.transferId,
			);
		expect(deadLettered.sort()).toEqual(receipts.map((r) => r.transferId).sort());
		expect(readChain(vault)).toEqual([]);
		rmSync(lockPath(vault));
	});

	it('clients created with vaultBase "." stay on their vault after a chdir, sharing the writer with a client given the absolute path', async () => {
		const elsewhere = `${vault}-elsewhere`;
		mkdirSync(elsewhere);
		const cwd = process.cwd();
		process.chdir(vault);
		try {
			const relative = await trust(new Anthropic({ apiKey: "test", baseURL: provider.url }), {
				dryRun: true,
				vaultBase: ".",
			});
			const governor = await createGovernor({ dryRun: true, vaultBase: ".", budget: 100_000 });
			const ask = () =>
				relative.messages.create({
					model: "claude-sonnet-4-5",
					max_tokens: 16,
					messages: [{ role: "user", content: "hi" }],
				});
			const a = await ask();
			process.chdir(elsewhere);
			const absolute = await trust(new OpenAI({ apiKey: "test", baseURL: `${provider.url}/v1` }), {
				dryRun: true,
				vaultBase: vault,
			});
			const b = await ask();
			const c = await absolute.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			});
			const hold = await governor.authorize({ model: "gpt-4o", estimatedInputTokens: 10 });
			const settled = await governor.settle(hold, { inputTokens: 10, outputTokens: 5 });
			await relative.destroy();
			await absolute.destroy();
			await governor.destroy();
			const receipts = [a, b, c].map((r) => r.receipt);
			expect(receipts.filter((r) => r.auditDegraded === true)).toEqual([]);
			expect(settled.auditDegraded).toBeUndefined();
			const chain = readChain(vault);
			expect(chain.filter((e) => e.kind === "llm_call")).toHaveLength(4);
			expect(chain.map((e) => e.hash)).toEqual(
				expect.arrayContaining(receipts.map((r) => r.auditHash)),
			);
			expectOneLinkedChain(chain);
			// Nothing of the vault went to the new working directory: its audit trail, dead letters,
			// spend ledger, receipts and pattern memory are where the client was created.
			expect(readdirSync(elsewhere, { recursive: true })).toEqual([]);
			expect(existsSync(join(vault, VAULT_DIR, "spend-ledger.json"))).toBe(true);
		} finally {
			process.chdir(cwd);
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("a call whose event reached the chain but whose .meta update failed: its degraded receipt reconciles, and verify --receipts reads COMPLETE", async () => {
		const openai = await trust(new OpenAI({ apiKey: "test", baseURL: `${provider.url}/v1` }), {
			dryRun: true,
			vaultBase: vault,
		});
		const ask = () =>
			openai.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			});
		const first = await ask();
		// The anchor cannot be replaced (a directory in its place): the next call's event is synced to
		// the log, then its `.meta` update fails, and the append rejects for an event that IS on the chain.
		const meta = join(vault, VAULT_DIR, "audit", "events.jsonl.meta");
		rmSync(meta);
		mkdirSync(meta);
		const second = await ask();
		rmSync(meta, { recursive: true });
		const third = await ask();
		await openai.destroy();
		expect(second.receipt.auditDegraded).toBe(true);
		expect(second.receipt.auditHash).toBe("AUDIT_DEGRADED");
		const receipts = [first, second, third].map((r) => r.receipt);
		expect(readChain(vault).map((e) => e.data.transferId)).toEqual(
			receipts.map((r) => r.transferId),
		);
		const file = join(vault, "receipts.jsonl");
		writeFileSync(file, receipts.map((r) => JSON.stringify(r)).join("\n"));
		const printed: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			printed.push(args.map(String).join(" "));
		});
		try {
			await verifyRun(vault, { json: true }, ["--receipts", file]);
			const verdict = JSON.parse(printed.join("\n")) as { data: Record<string, unknown> };
			expect(verdict.data.valid).toBe(true);
			expect(verdict.data.complete).toBe(true);
			expect(verdict.data.deadLetters).toMatchObject({ missing: 0, onChain: 1 });
			expect(verdict.data.receipts).toEqual({ checked: 3, unreadable: 0, unaudited: [] });
			expect(process.exitCode ?? 0).toBe(0);
		} finally {
			process.exitCode = 0;
		}
	});

	it("a headless settle whose event reached the chain but whose .meta update failed: its degraded receipt reconciles too", async () => {
		const governor = await createGovernor({ dryRun: true, vaultBase: vault, budget: 100_000 });
		const settleOne = async () => {
			const hold = await governor.authorize({ model: "gpt-4o", estimatedInputTokens: 10 });
			return governor.settle(hold, { inputTokens: 10, outputTokens: 5 });
		};
		const first = await settleOne();
		const meta = join(vault, VAULT_DIR, "audit", "events.jsonl.meta");
		rmSync(meta);
		mkdirSync(meta);
		const second = await settleOne();
		rmSync(meta, { recursive: true });
		await governor.destroy();
		// The headless shape: degraded, with a placeholder hash rather than "AUDIT_DEGRADED".
		expect(second.auditDegraded).toBe(true);
		expect(second.auditHash).not.toBe("AUDIT_DEGRADED");
		expect(readChain(vault).map((e) => e.data.transferId)).toEqual([
			first.transferId,
			second.transferId,
		]);
		const file = join(vault, "receipts.jsonl");
		writeFileSync(file, [first, second].map((r) => JSON.stringify(r)).join("\n"));
		const printed: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			printed.push(args.map(String).join(" "));
		});
		try {
			await verifyRun(vault, { json: true }, ["--receipts", file]);
			const verdict = JSON.parse(printed.join("\n")) as { data: Record<string, unknown> };
			expect(verdict.data.complete).toBe(true);
			expect(verdict.data.receipts).toEqual({ checked: 2, unreadable: 0, unaudited: [] });
		} finally {
			process.exitCode = 0;
		}
	});

	it("through a vault link whose target holds a `..`, the writer's lock is taken beside the log it guards, not in the lexical directory", async () => {
		// <vault>/proj/.usertrust -> <vault>/a/link/../vault, and <vault>/a/link -> <vault>/b/subdir: the OS
		// opens <vault>/b/vault, while a lexical fold of the `..` names <vault>/a/vault. Both exist.
		for (const d of ["a/vault/audit", "b/vault/audit", "b/subdir", "proj"]) {
			mkdirSync(join(vault, d), { recursive: true, mode: 0o700 });
		}
		symlinkSync(join(vault, "b", "subdir"), join(vault, "a", "link"));
		symlinkSync(`${join(vault, "a", "link")}/../vault`, join(vault, "proj", VAULT_DIR));
		const governor = await createGovernor({
			dryRun: true,
			vaultBase: join(vault, "proj"),
			budget: 100_000,
		});
		try {
			const hold = await governor.authorize({ model: "gpt-4o", estimatedInputTokens: 10 });
			const settled = await governor.settle(hold, { inputTokens: 10, outputTokens: 5 });
			expect(settled.auditDegraded).toBeUndefined();
			// The handle is still open, so its lock is still held: beside the log, in the directory the
			// OS opens; nothing at all in the lexical one.
			expect(readdirSync(join(vault, "b", "vault", "audit"))).toEqual(
				expect.arrayContaining([".audit-writer.lock", "events.jsonl", "events.jsonl.meta"]),
			);
			expect(readdirSync(join(vault, "a", "vault", "audit"))).toEqual([]);
		} finally {
			await governor.destroy();
		}
	});

	it("a headless governor and a trust() client on one vault share its writer too", async () => {
		const openai = await trust(new OpenAI({ apiKey: "test", baseURL: `${provider.url}/v1` }), {
			dryRun: true,
			vaultBase: vault,
		});
		const governor = await createGovernor({ dryRun: true, vaultBase: vault, budget: 100_000 });
		for (let i = 0; i < 5; i++) {
			const hold = await governor.authorize({ model: "gpt-4o", estimatedInputTokens: 10 });
			const settled = await governor.settle(hold, { inputTokens: 10, outputTokens: 5 });
			expect(settled.auditDegraded).toBeUndefined();
			const { receipt } = await openai.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(receipt.auditDegraded).toBeUndefined();
		}
		await governor.destroy();
		await openai.destroy();
		const chain = readChain(vault);
		expectOneLinkedChain(chain);
		expect(chain.filter((e) => e.kind === "llm_call")).toHaveLength(10);
		expect(existsSync(deadLetterPath(vault))).toBe(false);
		expect(existsSync(lockPath(vault))).toBe(false);
	});
});
