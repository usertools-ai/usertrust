// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * FINDING (open): under `audit.failClosed`, a client whose audit writer is ALREADY degraded
 * refuses a call before it does anything: no gate, no append (refuseIfAuditDegradedAtStart).
 * The Anthropic and OpenAI default-deny refusals (`refuseUngovernedMethod`) do not run that
 * preflight: a refused method there still attempts its `policy_denied` append and rejects with
 * a PolicyDeniedError marked `auditDegraded`, instead of an AuditDegradedError with no append.
 * The Google refusals do run it. This row pins the expected behaviour; it is `it.fails` until
 * the default-deny refusals run the preflight too.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { AuditDegradedError } from "../../src/shared/errors.js";
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

	it.fails("Anthropic: a refused ungoverned method rejects with AuditDegradedError and appends nothing", async () => {
		const { writer, appendEvent } = degradedWriter();
		const batchesCreate = vi.fn(async () => ({}));
		const client = {
			// An SDK resource carries the client it was built from as `_client`; that is how the
			// default-deny boundary recognises a nested resource.
			messages: {
				create: vi.fn(async () => ({})),
				batches: { _client: {}, create: batchesCreate },
			},
		};
		const governed = (await trust(client, {
			dryRun: true,
			vaultBase: vault,
			_audit: writer,
		})) as unknown as {
			messages: { batches: { create(p: unknown): Promise<unknown> } };
			destroy(): Promise<void>;
		};

		const err = await governed.messages.batches.create({ requests: [] }).then(
			() => undefined,
			(e: unknown) => e,
		);

		try {
			expect(err).toBeInstanceOf(AuditDegradedError);
			expect(appendEvent).not.toHaveBeenCalled();
			expect(batchesCreate).not.toHaveBeenCalled();
		} finally {
			await governed.destroy();
		}
	});
});
