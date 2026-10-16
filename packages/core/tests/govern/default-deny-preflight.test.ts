// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Under `audit.failClosed`, a client whose audit writer is ALREADY degraded refuses a call before
 * it does anything: no gate, no append (refuseIfAuditDegradedAtStart). The Anthropic and OpenAI
 * default-deny refusals run that preflight too: a refused method rejects with AuditDegradedError
 * and appends nothing, instead of attempting its `policy_denied` append and rejecting with a
 * PolicyDeniedError marked `auditDegraded`. With failClosed off, the refusal is unchanged.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { AuditDegradedError, PolicyDeniedError } from "../../src/shared/errors.js";
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
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

describe("default-deny refusals and a pre-degraded audit writer under failClosed", () => {
	let vault: string;
	beforeEach(() => {
		vault = join(tmpdir(), `default-deny-preflight-${randomUUID()}`);
		mkdirSync(join(vault, VAULT_DIR), { recursive: true });
		writeFileSync(
			join(vault, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({ budget: 50_000, audit: { failClosed: true } }),
		);
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	function degradedWriter() {
		const appendEvent = vi.fn(
			async (input: AppendEventInput): Promise<AuditEvent> => ({
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "b".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			}),
		);
		const writer: AuditWriter = {
			appendEvent,
			getWriteFailures: vi.fn(() => 1),
			isDegraded: vi.fn(() => true),
			flush: vi.fn(async () => {}),
			release: vi.fn(),
		};
		return { writer, appendEvent };
	}

	/** A duck-typed SDK client with one governed method and one nested resource to refuse. */
	const PROVIDERS = [
		{
			name: "Anthropic",
			path: "messages.batches.create",
			make: (refused: ReturnType<typeof vi.fn>) => ({
				// An SDK resource carries the client it was built from as `_client`; that is how the
				// default-deny boundary recognises a nested resource.
				messages: { create: vi.fn(async () => ({})), batches: { _client: {}, create: refused } },
			}),
			call: (governed: unknown) =>
				(
					governed as { messages: { batches: { create(p: unknown): Promise<unknown> } } }
				).messages.batches.create({ requests: [] }),
		},
		{
			name: "OpenAI",
			path: "embeddings.create",
			make: (refused: ReturnType<typeof vi.fn>) => ({
				chat: { completions: { create: vi.fn(async () => ({})) } },
				embeddings: { _client: {}, create: refused },
			}),
			call: (governed: unknown) =>
				(governed as { embeddings: { create(p: unknown): Promise<unknown> } }).embeddings.create({
					model: "text-embedding-3-small",
					input: "hi",
				}),
		},
	];

	it.each(PROVIDERS)(
		"$name: failClosed with a pre-degraded writer → a refused method rejects with AuditDegradedError and appends nothing",
		async ({ make, call }) => {
			const { writer, appendEvent } = degradedWriter();
			const refused = vi.fn(async () => ({}));
			const governed = (await trust(make(refused), {
				dryRun: true,
				vaultBase: vault,
				_audit: writer,
			})) as unknown as { destroy(): Promise<void> };

			const err = await call(governed).then(
				() => undefined,
				(e: unknown) => e,
			);

			try {
				expect(err).toBeInstanceOf(AuditDegradedError);
				expect(err).not.toBeInstanceOf(PolicyDeniedError);
				expect(appendEvent).not.toHaveBeenCalled();
				expect(refused).not.toHaveBeenCalled();
			} finally {
				await governed.destroy();
			}
		},
	);

	it.each(PROVIDERS)(
		"$name: failClosed OFF → the refusal is still a PolicyDeniedError with exactly one policy_denied append",
		async ({ make, call, path }) => {
			writeFileSync(
				join(vault, VAULT_DIR, "usertrust.config.json"),
				JSON.stringify({ budget: 50_000, audit: { failClosed: false } }),
			);
			const { writer, appendEvent } = degradedWriter();
			const refused = vi.fn(async () => ({}));
			const governed = (await trust(make(refused), {
				dryRun: true,
				vaultBase: vault,
				_audit: writer,
			})) as unknown as { destroy(): Promise<void> };

			const err = await call(governed).then(
				() => undefined,
				(e: unknown) => e,
			);

			try {
				expect(err).toBeInstanceOf(PolicyDeniedError);
				expect((err as Error).message).toContain(path);
				expect(appendEvent).toHaveBeenCalledOnce();
				expect(appendEvent.mock.calls[0]?.[0].kind).toBe("policy_denied");
				expect(refused).not.toHaveBeenCalled();
			} finally {
				await governed.destroy();
			}
		},
	);
});
