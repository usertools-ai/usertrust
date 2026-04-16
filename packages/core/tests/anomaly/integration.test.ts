// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { AnomalyError } from "../../src/shared/errors.js";
import type { AuditEvent } from "../../src/shared/types.js";

// Mock tigerbeetle-node (native module, never loaded in tests)
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: {
		linked: 1,
		pending: 2,
		post_pending_transfer: 4,
		void_pending_transfer: 8,
	},
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// ── Helpers ──

function makeTmpVault(): string {
	const dir = join(tmpdir(), `trust-anomaly-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeMockEngine(overrides?: Partial<TrustEngine>): TrustEngine {
	return {
		spendPending: vi.fn(async (params: { transferId: string; amount: number }) => ({
			transferId: params.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
		...overrides,
	};
}

function makeMockAudit(overrides?: Partial<AuditWriter>): AuditWriter {
	const events: AppendEventInput[] = [];
	let prevHash = "0".repeat(64);
	return {
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
			// Simulate hash chaining: each event's hash includes the previous hash.
			const hash = `${prevHash.slice(0, 60)}${events.length.toString(16).padStart(4, "0")}`;
			const event: AuditEvent = {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: prevHash,
				hash,
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
			prevHash = hash;
			return event;
		}),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
		...overrides,
	};
}

/**
 * A "runaway" Anthropic stream that emits very high token rates.
 * Each chunk reports cumulative output_tokens that grow rapidly.
 * Optional `delayMs` injects a small inter-chunk delay so wall-clock time
 * advances enough for the detector windows to roll. When 0, all chunks
 * arrive in the same microsecond and the detector trips on in-flight rate.
 */
function makeRunawayStreamMock(totalChunks: number, tokensPerChunk: number, delayMs = 0) {
	return {
		messages: {
			create: vi.fn(async () => {
				async function* gen() {
					yield {
						type: "message_start",
						message: { usage: { input_tokens: 50 } },
					};
					let cumulative = 0;
					for (let i = 0; i < totalChunks; i++) {
						cumulative += tokensPerChunk;
						yield {
							type: "content_block_delta",
							delta: { text: "x".repeat(tokensPerChunk) },
						};
						yield {
							type: "message_delta",
							usage: { output_tokens: cumulative },
						};
						if (delayMs > 0) {
							await new Promise<void>((r) => setTimeout(r, delayMs));
						}
					}
				}
				return gen();
			}),
		},
	};
}

function makeNormalStreamMock() {
	return {
		messages: {
			create: vi.fn(async () => {
				async function* gen() {
					yield { type: "message_start", message: { usage: { input_tokens: 10 } } };
					yield { type: "content_block_delta", delta: { text: "hi" } };
					yield { type: "message_delta", usage: { output_tokens: 5 } };
				}
				return gen();
			}),
		},
	};
}

// ── Tests ──

describe("Anomaly governance integration", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault();
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("opt-in: when anomaly.enabled is false (default), behavior is unchanged", async () => {
		// Use a runaway stream that WOULD trip if enabled
		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();
		const mockClient = makeRunawayStreamMock(50, 200);

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
			// No anomaly opts → default disabled
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Stream should fully consume without throwing
		const stream = result.response as AsyncIterable<unknown>;
		const collected: unknown[] = [];
		for await (const chunk of stream) {
			collected.push(chunk);
		}
		expect(collected.length).toBeGreaterThan(0);

		// Wait for the async settlement after stream completion.
		await (result.response as { receipt: Promise<unknown> }).receipt;

		// No anomaly_detected audit event should have been emitted
		const calls = (mockAudit.appendEvent as ReturnType<typeof vi.fn>).mock.calls as Array<
			[AppendEventInput]
		>;
		const anomalyEvents = calls.filter(([e]) => e.kind === "anomaly_detected");
		expect(anomalyEvents).toHaveLength(0);

		// VOID was NOT called
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();
		// POST was called
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();

		await governed.destroy();
	});

	it(
		"runaway stream trips token-rate anomaly: VOID + AnomalyError + audit event emitted",
		{ timeout: 15_000 },
		async () => {
			// Anomaly opts go through the config file (TrustOpts has no anomaly field —
			// it would expand the public surface). Write a config file with low
			// thresholds so a synthetic runaway stream trips immediately.
			const fs = await import("node:fs");
			const path = await import("node:path");
			const vaultDir = path.join(tmpVault, ".usertrust");
			fs.mkdirSync(vaultDir, { recursive: true });
			fs.writeFileSync(
				path.join(vaultDir, "usertrust.config.json"),
				JSON.stringify({
					budget: 50_000_000,
					anomaly: {
						enabled: true,
						tokenRate: {
							thresholdTokPerSec: 10, // any rate will trip
							windowMs: 100,
							consecutiveWindows: 1,
						},
						// Disable the other signals so we know which one tripped.
						spendVelocity: { thresholdDollarsPerMin: 1_000_000 },
						injectionCascade: { eventCount: 1_000_000 },
						cooldownMs: 60_000,
					},
				}),
			);

			const engine2 = makeMockEngine();
			const audit2 = makeMockAudit();
			// Delay 30ms between chunks so two 100ms windows complete with high tokens.
			const mockClient2 = makeRunawayStreamMock(30, 1_000, 30);

			const governed2 = await trust(mockClient2, {
				vaultBase: tmpVault,
				_engine: engine2,
				_audit: audit2,
			});

			const result = await governed2.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Tell me a story" }],
			});

			// Attach a no-op catch to the receipt promise immediately so the rejection
			// (which fires synchronously when the stream throws) is handled before
			// node's unhandledRejection sniffer fires.
			const receiptP = (result.response as { receipt: Promise<unknown> }).receipt;
			receiptP.catch(() => {});

			const stream = result.response as AsyncIterable<unknown>;
			let caught: unknown = null;
			try {
				for await (const _chunk of stream) {
					// consume
				}
			} catch (err) {
				caught = err;
			}

			// Stream should have aborted with AnomalyError
			expect(caught).toBeInstanceOf(AnomalyError);
			if (caught instanceof AnomalyError) {
				expect(caught.kind).toBe("token_rate");
				expect(caught.metric).toBeGreaterThan(0);
			}

			// Wait for async callbacks (audit + void)
			await new Promise<void>((r) => setTimeout(r, 100));

			// Audit should contain anomaly_detected event
			const calls = (audit2.appendEvent as ReturnType<typeof vi.fn>).mock.calls as Array<
				[AppendEventInput]
			>;
			const anomalyEvent = calls.find(([e]) => e.kind === "anomaly_detected");
			expect(anomalyEvent).toBeDefined();
			if (anomalyEvent) {
				const data = anomalyEvent[0].data as Record<string, unknown>;
				expect(data.anomalyKind).toBe("token_rate");
				expect(typeof data.metric).toBe("number");
				expect(typeof data.threshold).toBe("number");
			}

			// VOID should have been called (PENDING hold released)
			expect(engine2.voidPendingSpend).toHaveBeenCalledOnce();
			// POST should NOT have been called
			expect(engine2.postPendingSpend).not.toHaveBeenCalled();

			// Receipt promise should reject
			await expect(receiptP).rejects.toBeInstanceOf(AnomalyError);

			await governed2.destroy();
		},
	);

	it("normal stream does NOT trip when anomaly is enabled with normal thresholds", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const vaultDir = path.join(tmpVault, ".usertrust");
		fs.mkdirSync(vaultDir, { recursive: true });
		fs.writeFileSync(
			path.join(vaultDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 50_000,
				anomaly: {
					enabled: true,
					// In synthetic streams chunks arrive in microseconds, so the rolling
					// rate is artificially huge. Use generous thresholds so a normal
					// completion never trips.
					tokenRate: { thresholdTokPerSec: 1_000_000 },
					spendVelocity: { thresholdDollarsPerMin: 1_000_000 },
				},
			}),
		);

		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();
		const mockClient = makeNormalStreamMock();

		const governed = await trust(mockClient, {
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hi" }],
		});

		const stream = result.response as AsyncIterable<unknown>;
		const collected: unknown[] = [];
		for await (const chunk of stream) {
			collected.push(chunk);
		}
		expect(collected.length).toBe(3);

		await (result.response as { receipt: Promise<unknown> }).receipt;
		const calls = (mockAudit.appendEvent as ReturnType<typeof vi.fn>).mock.calls as Array<
			[AppendEventInput]
		>;
		const anomalyEvent = calls.find(([e]) => e.kind === "anomaly_detected");
		expect(anomalyEvent).toBeUndefined();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});
});
