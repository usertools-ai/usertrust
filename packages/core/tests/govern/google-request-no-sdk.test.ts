import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
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
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// No installed SDK pipeline: the optional peer resolves to a module without `Models`.
vi.mock("@google/genai", () => ({}));

function recordingAudit(): AuditWriter & { events: AppendEventInput[] } {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: String(events.length).padStart(64, "0"),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		},
		getWriteFailures: () => 0,
		isDegraded: () => false,
		flush: async () => {},
		release: () => {},
	};
}

describe("a Google-shaped client with no SDK pipeline anywhere is refused", () => {
	let vault: string;
	beforeEach(() => {
		vault = join(tmpdir(), `trust-google-no-sdk-${randomUUID()}`);
		mkdirSync(vault, { recursive: true });
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	for (const method of ["generateContent", "generateContentStream"] as const) {
		it(`${method}: refused naming the missing SDK, audited, the client never called`, async () => {
			const generateContent = vi.fn(async () => ({}));
			const generateContentStream = vi.fn(async () => ({}));
			const audit = recordingAudit();
			const governed = await trust(
				{ models: { generateContent, generateContentStream } },
				{ dryRun: true, budget: 500_000, vaultBase: vault, _audit: audit },
			);
			const models = governed.models as unknown as Record<string, (p: unknown) => Promise<unknown>>;
			const refused = await models[method]?.({ model: "gemini-2.5-flash", contents: "go" }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(refused).toBeInstanceOf(Error);
			const message = (refused as Error).message;
			expect(message).toContain("@google/genai could not be loaded beside usertrust");
			expect(message).toContain("as a direct dependency next to usertrust");
			expect(message).toContain("keep both external to your bundle");
			expect(message).not.toContain("could not be checked");
			await governed.destroy();
			expect(generateContent).not.toHaveBeenCalled();
			expect(generateContentStream).not.toHaveBeenCalled();
			expect(audit.events.map((e) => e.kind)).toEqual(["policy_denied"]);
		});
	}
});
