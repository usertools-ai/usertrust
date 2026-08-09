// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The denial event's `promptHash` claims a JOIN to PATTERN MEMORY — a retry
 * storm's five refusals and the eventual success are the same prompt. That
 * claim is only true if both hashes come out of the same construction, so this
 * pins the denial hash against the value the RUNTIME hands to `recordPattern`
 * for the identical prompt, rather than against a formula copied into the test.
 *
 * It lives in its own file because pinning it requires mocking the pattern-
 * memory module, which is hoisted per-file.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { trust } from "../../src/govern.js";
import type { AuditEvent } from "../../src/shared/types.js";

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
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 34 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const recordedPromptHashes: string[] = [];

vi.mock("../../src/memory/patterns.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/memory/patterns.js")>();
	return {
		...actual,
		recordPattern: vi.fn(async (entry: { promptHash: string }) => {
			recordedPromptHashes.push(entry.promptHash);
		}),
	};
});

const VAULT_DIR = ".usertrust";

describe("denial promptHash joins to pattern memory", () => {
	let vault: string;
	beforeEach(() => {
		recordedPromptHashes.length = 0;
		vault = join(tmpdir(), `harden-denial-hash-${randomUUID()}`);
		mkdirSync(join(vault, VAULT_DIR, "policies"), { recursive: true });
		writeFileSync(
			join(vault, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({
				budget: 1_000_000,
				policies: "./policies/deny.json",
				patterns: { enabled: true },
			}),
		);
		writeFileSync(
			join(vault, VAULT_DIR, "policies", "deny.json"),
			JSON.stringify({
				rules: [
					{
						id: "no-frontier",
						name: "No frontier models",
						effect: "deny",
						enforcement: "hard",
						conditions: [{ field: "model", operator: "eq", value: "forbidden-model" }],
					},
				],
			}),
		);
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("hashes an identical prompt to the same value on both paths", async () => {
		const events: AppendEventInput[] = [];
		const writer: AuditWriter = {
			appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
				events.push(input);
				return {
					id: randomUUID(),
					timestamp: new Date().toISOString(),
					previousHash: "0".repeat(64),
					hash: "c".repeat(64),
					kind: input.kind,
					actor: input.actor,
					data: input.data,
				};
			}),
			getWriteFailures: vi.fn(() => 0),
			isDegraded: vi.fn(() => false),
			flush: vi.fn(async () => {}),
			release: vi.fn(),
		};

		const governed = await trust(
			{
				messages: {
					create: vi.fn(async () => ({ id: "x", usage: { input_tokens: 1, output_tokens: 1 } })),
				},
			},
			{ dryRun: true, vaultBase: vault, _audit: writer },
		);

		const shared = [{ role: "user", content: "the very same prompt" }];
		// Allowed: the settle path records a pattern-memory entry.
		await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 64,
			messages: shared,
		});
		// Denied: the boundary appends a chain event for the SAME prompt.
		await governed.messages
			.create({ model: "forbidden-model", max_tokens: 64, messages: shared })
			.catch(() => {});
		await governed.destroy();

		const denial = events.find((e) => e.kind === "policy_denied");
		expect(denial).toBeDefined();
		expect(recordedPromptHashes).toHaveLength(1);
		expect(denial?.data.promptHash).toBe(recordedPromptHashes[0]);
	});
});
