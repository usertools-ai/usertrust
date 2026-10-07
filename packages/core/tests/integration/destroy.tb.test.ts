// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle: destroy() and a release parked on its own void (#243).
 *
 * A release whose void is still on its way to the ledger when destroy() reaches its
 * deadline: destroy() records the hold and takes the record from the release. Its engine
 * sweep then reaches the same hold (the engine drops a hold's entry only when the hold's
 * own void returns) and sends a SECOND void for the one pending transfer. TigerBeetle
 * must take exactly one of the two.
 *
 * Here the release's void is held back on its way to the cluster until the sweep's void
 * for the same pending transfer has landed, and is then sent on the still-open client, so
 * both reach the real ledger. The unit suite (`tests/headless/destroy-terminals.test.ts`)
 * pins the same flow against a fake ledger, with the release's void landing after
 * destroy() returns. Self-skips (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is
 * unset.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The void flow through the client: the parked release void, and every void's answer. */
const flow = vi.hoisted(() => ({
	armed: false,
	parked: undefined as undefined | { pendingId: bigint; send: () => void; done: Promise<void> },
	voids: [] as Array<{ by: "release" | "sweep" | "other"; status: string }>,
}));

vi.mock("tigerbeetle-node", async (importOriginal) => {
	const actual = await importOriginal<typeof import("tigerbeetle-node")>();
	type Batch = Parameters<ReturnType<typeof actual.createClient>["createTransfers"]>[0];
	const statusOf = (results: ReadonlyArray<{ status: number }>): string => {
		const first = results[0];
		return first === undefined ? "created" : String(actual.CreateTransferStatus[first.status]);
	};
	return {
		...actual,
		createClient: (args: Parameters<typeof actual.createClient>[0]) => {
			const client = actual.createClient(args);
			const createTransfers = async (batch: Batch) => {
				const transfer = batch[0];
				const isVoid =
					transfer !== undefined &&
					(transfer.flags & actual.TransferFlags.void_pending_transfer) !== 0;
				if (!isVoid) return client.createTransfers(batch);
				if (flow.armed && flow.parked === undefined) {
					// The release's void: held back until the sweep's void for the same pending
					// transfer has landed, then sent.
					let send = (): void => {};
					const go = new Promise<void>((resolve) => {
						send = resolve;
					});
					let finish = (): void => {};
					const done = new Promise<void>((resolve) => {
						finish = resolve;
					});
					flow.parked = { pendingId: transfer.pending_id, send, done };
					await go;
					const results = await client.createTransfers(batch);
					flow.voids.push({ by: "release", status: statusOf(results) });
					finish();
					return results;
				}
				const results = await client.createTransfers(batch);
				const parked = flow.parked;
				const bySweep = parked !== undefined && parked.pendingId === transfer.pending_id;
				flow.voids.push({ by: bySweep ? "sweep" : "other", status: statusOf(results) });
				if (bySweep) {
					parked.send();
					await parked.done;
				}
				return results;
			};
			return new Proxy(client, {
				get(target, prop, receiver) {
					return prop === "createTransfers" ? createTransfers : Reflect.get(target, prop, receiver);
				},
			});
		},
	};
});

import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 2_000, maxOutputTokens: 500 };

const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
	flow.armed = false;
	flow.parked = undefined;
	flow.voids.length = 0;
});
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});

describe.skipIf(!TB_ADDRESS)(
	"real TigerBeetle — destroy() and a release parked on its void",
	() => {
		it("two void requests for one pending transfer: the ledger takes one; one record, destroy()'s", async () => {
			const dir = join(tmpdir(), `tb-destroy-${randomUUID()}`);
			mkdirSync(join(dir, VAULT_DIR), { recursive: true });
			writeFileSync(
				join(dir, VAULT_DIR, "usertrust.config.json"),
				JSON.stringify({
					budget: 10_000_000,
					tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 },
				}),
			);
			cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
			const gov = await createGovernor({ vaultBase: dir, _destroyDrainMs: 300 });
			cleanup.push(() => gov.destroy());

			const auth = await gov.authorize(AUTHORIZE);
			flow.armed = true;
			const ending = gov.release(auth, "given back");
			await gov.destroy();

			// The sweep's void landed first and the ledger took it; the release's, sent next for
			// the same pending transfer, was refused.
			expect(flow.voids).toEqual([
				{ by: "sweep", status: "created" },
				{ by: "release", status: "pending_transfer_already_voided" },
			]);
			// The release answers its caller from its own void.
			expect(await ending).toEqual({
				released: true,
				voidError: "pending_transfer_already_voided",
			});
			// One record for the hold, destroy()'s, with no voidError: there was no outcome yet.
			const records = readFileSync(join(dir, VAULT_DIR, "audit", "events.jsonl"), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> })
				.filter((e) => e.data.transferId === auth.transferId);
			expect(records.map((e) => [e.kind, e.data.reason, e.data.voidError])).toEqual([
				[
					"hold_released",
					"governor destroyed (terminal still in flight: its void had not completed)",
					undefined,
				],
			]);
		}, 15_000);
	},
);
