// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * FIRST-RUN-A — a PROVIDER auth failure must not read as "usertrust is broken".
 *
 * `dryRun: true` skips the LEDGER, not the PROVIDER, so a quickstart run with no
 * valid `ANTHROPIC_API_KEY` surfaces a raw `AuthenticationError: 401` whose stack
 * names `interceptCall (usertrust/dist/govern.js…)`. Governance worked; the key
 * did not. The hint says so — by APPENDING to the original error instance, never
 * by wrapping or reconstructing it, because consumers key retry logic on
 * `instanceof Anthropic.AuthenticationError` and `err.status === 401`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_looksLikeProviderAuthFailure as looksLikeProviderAuthFailure,
	trust,
} from "../../src/govern.js";

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

describe("looksLikeProviderAuthFailure", () => {
	it("matches a 401 from any provider shape", () => {
		expect(looksLikeProviderAuthFailure({ status: 401 })).toBe(true);
		expect(looksLikeProviderAuthFailure({ statusCode: 401 })).toBe(true);
		expect(
			looksLikeProviderAuthFailure(
				Object.assign(new Error("401 authentication_error: API key is invalid."), {}),
			),
		).toBe(true);
		expect(looksLikeProviderAuthFailure({ error: { type: "authentication_error" } })).toBe(true);
	});

	it("does NOT match unrelated failures", () => {
		expect(looksLikeProviderAuthFailure({ status: 500 })).toBe(false);
		expect(looksLikeProviderAuthFailure({ status: 403 })).toBe(false); // valid key, no access
		expect(
			looksLikeProviderAuthFailure(
				new Proxy(
					{},
					{
						get() {
							throw new Error("hostile getter");
						},
					},
				),
			),
		).toBe(false); // must not throw out of the catch path
		expect(looksLikeProviderAuthFailure({ status: 429 })).toBe(false);
		expect(looksLikeProviderAuthFailure(new Error("socket hang up"))).toBe(false);
		expect(looksLikeProviderAuthFailure(new Error("overloaded_error"))).toBe(false);
		expect(looksLikeProviderAuthFailure(null)).toBe(false);
		expect(looksLikeProviderAuthFailure(undefined)).toBe(false);
	});
});

/** The exact text appended to the provider's own message. */
const HINT = " — usertrust is running; set a provider key to complete the call.";

function makeTmpVault(): string {
	const dir = join(tmpdir(), `harden-auth-hint-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("FIRST-RUN-A: the hint rides the ORIGINAL provider error", () => {
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

	/** One governed call against a client whose `messages.create` throws `thrown`. */
	async function callThrowing(thrown: unknown): Promise<{ caught: unknown; destroy: () => void }> {
		const client = {
			messages: {
				create: async () => {
					throw thrown;
				},
			},
		};
		const governed = await trust(client, { dryRun: true, budget: 50_000, vaultBase: tmpVault });
		const caught = await governed.messages
			.create({
				model: "claude-fable-5",
				max_tokens: 16,
				messages: [{ role: "user", content: "hi" }],
			})
			.catch((e: unknown) => e);
		return { caught, destroy: () => void governed.destroy() };
	}

	it("appends the hint to the ORIGINAL error instance, preserving identity", async () => {
		class AuthenticationError extends Error {
			status = 401;
		}
		const thrown = new AuthenticationError('401 {"type":"authentication_error"}');
		const { caught, destroy } = await callThrowing(thrown);

		expect(caught).toBe(thrown); // SAME object — not wrapped
		expect(caught).toBeInstanceOf(AuthenticationError); // prototype intact
		expect((caught as { status: number }).status).toBe(401); // status intact
		expect((caught as Error).message).toContain("authentication_error"); // provider text kept
		expect((caught as Error).message).toContain("usertrust is running");
		destroy();
	});

	it("does not touch an unrelated provider error", async () => {
		const thrown = Object.assign(new Error("overloaded_error"), { status: 529 });
		const { caught, destroy } = await callThrowing(thrown);

		expect(caught).toBe(thrown);
		expect((caught as Error).message).toBe("overloaded_error"); // byte-identical
		destroy();
	});

	it("appends the hint at most once", async () => {
		// The SAME instance thrown by two successive governed calls: an SDK that
		// caches its auth error, or a caller retrying with the object it caught.
		const thrown = Object.assign(new Error("401 invalid x-api-key"), { status: 401 });
		const first = await callThrowing(thrown);
		expect(first.caught).toBe(thrown);
		first.destroy();
		const second = await callThrowing(thrown);
		expect(second.caught).toBe(thrown);
		second.destroy();

		const occurrences = (thrown.message.match(/usertrust is running/g) ?? []).length;
		expect(occurrences).toBe(1);
		expect(thrown.message).toBe(`401 invalid x-api-key${HINT}`);
	});

	it("an un-hintable error propagates UNCHANGED rather than becoming a different throw", async () => {
		// A read-only `message`: the append throws TypeError under ESM's strict mode.
		// The hint is cosmetic — losing it is acceptable, replacing the provider's
		// error with our TypeError is the exact failure this whole fix exists to
		// prevent. The guard is inside the try for the same reason `instanceof` can
		// be trapped on a hostile error.
		const thrown = new Error("placeholder");
		Object.defineProperty(thrown, "message", {
			value: "401 invalid x-api-key",
			writable: false,
			configurable: false,
		});
		Object.defineProperty(thrown, "status", { value: 401 });
		const { caught, destroy } = await callThrowing(thrown);

		expect(caught).toBe(thrown);
		expect((caught as Error).message).toBe("401 invalid x-api-key");
		expect(caught).not.toBeInstanceOf(TypeError);
		destroy();
	});

	it("the audit chain keeps the provider's VERBATIM text, un-hinted", async () => {
		const thrown = Object.assign(new Error("401 invalid x-api-key"), { status: 401 });
		const { caught, destroy } = await callThrowing(thrown);
		expect((caught as Error).message).toContain("usertrust is running");
		destroy();

		// The `llm_call_failed` event is appended BEFORE the message is mutated, so
		// the chain records wire truth and only the human-facing message carries the
		// hint. A chain that carried the hint would be recording our prose as the
		// provider's.
		const chain = await readFile(
			join(tmpVault, ".usertrust", "audit", "events.jsonl"),
			"utf-8",
		).catch(() => "");
		const failed = chain
			.split("\n")
			.filter((l) => l.includes('"llm_call_failed"'))
			.join("\n");
		expect(failed).toContain("invalid x-api-key");
		expect(failed).not.toContain("usertrust is running");
	});
});
