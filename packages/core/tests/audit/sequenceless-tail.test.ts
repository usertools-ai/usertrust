// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A LOG WHOSE LAST LINE IS NOT AN EVENT WITH A SEQUENCE is never continued. Every release writes
 * a numeric `sequence` on every event, so such a tail comes from a hand-built or foreign log.
 * Continuing it put sequenced events after it, and a log where only some events carry a sequence
 * fails `usertrust verify` for good. The writer refuses instead, with
 * `AuditSequencelessTailError` naming the log and the line (1-based, counting non-blank lines as
 * verify numbers them), and writes nothing:
 *  - at OPEN, in each public entry point (`createAuditWriter`, `createUnleasedAuditWriter`, and the
 *    shared writer behind `trust()` and `createGovernor()`), before any lock is taken;
 *  - again at each read of the tail by an append, for a log that changed after the open.
 * A non-object last line (`42`, `[]`, `"x"`, `true`, `null`) is refused the same way. Before,
 * `42`, `[]`, `"x"` and `true` were continued with a first link to GENESIS (their missing hash read
 * as no previous event) and the line count plus one as the sequence, and `null` fell back to the
 * `.meta` anchor (to GENESIS and sequence 1 when there was none).
 *
 * Unchanged, and held here as positive controls: an absent, empty or blank log starts at 1; a
 * sequenced tail is continued; a sequenced tail after an earlier sequence-less line is continued
 * (that log already fails verify, and refusing it would need a full check at open); a last line
 * that does not parse falls back to the `.meta` anchor; and a log ending in a torn line still opens
 * (the quarantine repair opens a writer on one), its appends refused as torn.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import {
	AuditSequencelessTailError,
	AuditTornTailError,
	type AuditWriter,
	createAuditWriter,
	createUnleasedAuditWriter,
} from "../../src/audit/chain.js";
import { verifyVault } from "../../src/audit/verify.js";
import { trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";

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
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const dirs: string[] = [];
const writers: AuditWriter[] = [];

afterEach(() => {
	for (const w of writers.splice(0)) {
		try {
			w.release();
		} catch {
			/* already released */
		}
	}
	vi.restoreAllMocks();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * One line per event, each hashed over its canonical form and linked to the one before it; the
 * first links to GENESIS. `null` in `sequences` builds an event with no `sequence` field at all.
 */
function buildChain(sequences: readonly (number | null)[]): string[] {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	for (let i = 0; i < sequences.length; i++) {
		const seq = sequences[i];
		const event: Record<string, unknown> = {
			id: `evt-${i + 1}`,
			kind: "test.event",
			actor: "sys",
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			previousHash,
			data: { n: i + 1 },
		};
		if (typeof seq === "number") event.sequence = seq;
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(JSON.stringify({ ...event, hash }));
		previousHash = hash;
	}
	return lines;
}

const hashOf = (line: string): string => (JSON.parse(line) as { hash: string }).hash;

interface Vault {
	root: string;
	auditDir: string;
	logPath: string;
}

/** A new vault whose `events.jsonl` holds exactly `text` (no log at all when `text` is null). */
function vaultWith(text: string | null): Vault {
	const root = mkdtempSync(join(tmpdir(), "trust-seqless-tail-"));
	dirs.push(root);
	const auditDir = join(root, VAULT_DIR, "audit");
	mkdirSync(auditDir, { recursive: true });
	const logPath = join(auditDir, "events.jsonl");
	if (text !== null) writeFileSync(logPath, text);
	return { root, auditDir, logPath };
}

/** `lines`, each terminated by a newline, as the writer leaves a log. */
const terminated = (lines: readonly string[]): string => `${lines.join("\n")}\n`;

/** What an open must leave exactly as it was. */
function snapshot(v: Vault): { log: Buffer; meta: Buffer | null } {
	const metaPath = `${v.logPath}.meta`;
	return {
		log: readFileSync(v.logPath),
		meta: existsSync(metaPath) ? readFileSync(metaPath) : null,
	};
}

/** Nothing was written: the log and its anchor keep their bytes; no dead letter, no lock. */
function expectNothingWritten(v: Vault, before: { log: Buffer; meta: Buffer | null }): void {
	const now = snapshot(v);
	expect(now.log.equals(before.log)).toBe(true);
	if (before.meta === null) expect(now.meta).toBeNull();
	else expect(now.meta?.equals(before.meta)).toBe(true);
	expect(existsSync(join(v.root, VAULT_DIR, "dlq"))).toBe(false);
	expect(existsSync(join(v.auditDir, ".audit-writer.lock"))).toBe(false);
}

/** What `fn` throws, or undefined. A writer it returns instead is released after the test. */
function thrownBy(fn: () => AuditWriter): unknown {
	try {
		writers.push(fn());
		return undefined;
	} catch (err) {
		return err;
	}
}

/** The events of the log, parsed. */
const events = (v: Vault) =>
	readFileSync(v.logPath, "utf-8")
		.trim()
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as { sequence?: unknown; previousHash?: unknown; hash?: unknown });

describe("the writer refuses at open a log whose last event has no sequence", () => {
	it("createAuditWriter refuses a sequence-less log, naming the log and the line; nothing is written", () => {
		const v = vaultWith(terminated(buildChain([null, null, null])));
		const before = snapshot(v);
		const err = thrownBy(() => createAuditWriter(v.root));
		expect(err).toBeInstanceOf(AuditSequencelessTailError);
		expect(err).toBeInstanceOf(Error);
		expect(err).toMatchObject({ name: "AuditSequencelessTailError", logPath: v.logPath, line: 3 });
		const message = (err as Error).message;
		expect(message).toContain(v.logPath);
		expect(message).toContain("not an event with a sequence (line 3)");
		expect(message).toContain("Nothing was written");
		expect(message).toContain("new vault");
		expect(message).toContain("read-only");
		expectNothingWritten(v, before);
	});

	it("createAuditWriter refuses a sequenced log whose last event has no sequence", () => {
		const v = vaultWith(terminated(buildChain([1, 2, null])));
		const before = snapshot(v);
		const err = thrownBy(() => createAuditWriter(v.root));
		expect(err).toBeInstanceOf(AuditSequencelessTailError);
		expect(err).toMatchObject({ logPath: v.logPath, line: 3 });
		expectNothingWritten(v, before);
	});

	it("an agreeing .meta anchor does not make a sequence-less tail continuable", () => {
		const chain = buildChain([null, null, null]);
		const v = vaultWith(terminated(chain));
		writeFileSync(
			`${v.logPath}.meta`,
			JSON.stringify({ lastHash: hashOf(chain[2] as string), sequence: 3 }),
		);
		const before = snapshot(v);
		const err = thrownBy(() => createAuditWriter(v.root));
		expect(err).toBeInstanceOf(AuditSequencelessTailError);
		expectNothingWritten(v, before);
	});

	it("the line counts non-blank lines, as verify numbers them", () => {
		const chain = buildChain([null, null]);
		// A blank line between the two events: the tail is the 3rd physical line, the 2nd event.
		const v = vaultWith(`${chain[0]}\n\n${chain[1]}\n`);
		const err = thrownBy(() => createAuditWriter(v.root));
		expect(err).toBeInstanceOf(AuditSequencelessTailError);
		expect(err).toMatchObject({ line: 2 });
	});

	it("createUnleasedAuditWriter refuses the same log; nothing is written", () => {
		const v = vaultWith(terminated(buildChain([null, null, null])));
		const before = snapshot(v);
		const err = thrownBy(() => createUnleasedAuditWriter(v.root));
		expect(err).toBeInstanceOf(AuditSequencelessTailError);
		expect(err).toMatchObject({ logPath: v.logPath, line: 3 });
		expectNothingWritten(v, before);
	});

	it("with lockAtCreate the refusal comes before the lock: no lock is left behind", () => {
		const v = vaultWith(terminated(buildChain([null, null, null])));
		const before = snapshot(v);
		for (const make of [
			() => createAuditWriter(v.root, { lockAtCreate: true }),
			() => createUnleasedAuditWriter(v.root, { lockAtCreate: true }),
		]) {
			expect(thrownBy(make)).toBeInstanceOf(AuditSequencelessTailError);
			expectNothingWritten(v, before);
		}
	});
});

describe("a last line that is not an event is refused the same way", () => {
	// Before: 42, [], "x" and true were continued at 4, linked to GENESIS; null used .meta.
	for (const tail of ["42", "[]", '"x"', "true", "null"]) {
		it(`a log ending in ${tail} is refused at open, naming its line; nothing is written`, () => {
			const v = vaultWith(terminated([...buildChain([1, 2]), tail]));
			const before = snapshot(v);
			const err = thrownBy(() => createAuditWriter(v.root));
			expect(err).toBeInstanceOf(AuditSequencelessTailError);
			expect(err).toMatchObject({ logPath: v.logPath, line: 3 });
			expectNothingWritten(v, before);
		});
	}

	it("a log ending in null with an agreeing .meta anchor is refused too", () => {
		const chain = buildChain([1, 2]);
		const v = vaultWith(terminated([...chain, "null"]));
		writeFileSync(
			`${v.logPath}.meta`,
			JSON.stringify({ lastHash: hashOf(chain[1] as string), sequence: 2 }),
		);
		const before = snapshot(v);
		expect(thrownBy(() => createAuditWriter(v.root))).toBeInstanceOf(AuditSequencelessTailError);
		expectNothingWritten(v, before);
	});
});

describe("trust() and createGovernor() refuse at creation, before any event", () => {
	const anthropicLike = () => ({
		messages: {
			create: vi.fn(async () => ({
				id: "msg_seqless",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			})),
		},
	});

	it("trust() rejects with the error; the log keeps its bytes", async () => {
		const v = vaultWith(terminated(buildChain([null, null, null])));
		const before = snapshot(v);
		const created = trust(anthropicLike(), { dryRun: true, budget: 50_000, vaultBase: v.root });
		const outcome = await created.catch((e: unknown) => e);
		if (!(outcome instanceof Error)) await (await created).destroy();
		expect(outcome).toBeInstanceOf(AuditSequencelessTailError);
		expect(outcome).toMatchObject({ line: 3 });
		expectNothingWritten(v, before);
	});

	it("createGovernor() rejects with the error; the log keeps its bytes", async () => {
		const v = vaultWith(terminated(buildChain([null, null, null])));
		const before = snapshot(v);
		const created = createGovernor({ dryRun: true, budget: 100_000, vaultBase: v.root });
		const outcome = await created.catch((e: unknown) => e);
		if (!(outcome instanceof Error)) await (await created).destroy();
		expect(outcome).toBeInstanceOf(AuditSequencelessTailError);
		expect(outcome).toMatchObject({ line: 3 });
		expectNothingWritten(v, before);
	});
});

describe("positive controls: these logs are continued exactly as before", () => {
	async function appendOne(v: Vault) {
		const w = createAuditWriter(v.root);
		writers.push(w);
		return w.appendEvent({ kind: "test.next", actor: "sys", data: {} });
	}

	it("no log at all: the first event has sequence 1 and links to GENESIS", async () => {
		const v = vaultWith(null);
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: 1, previousHash: GENESIS_HASH });
	});

	it("an empty log: the first event has sequence 1 and links to GENESIS", async () => {
		const v = vaultWith("");
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: 1, previousHash: GENESIS_HASH });
	});

	it("a log of blank lines: the first event has sequence 1 and links to GENESIS", async () => {
		const v = vaultWith("\n\n");
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: 1, previousHash: GENESIS_HASH });
	});

	it("a log the writer wrote is continued by a new writer", async () => {
		const v = vaultWith(null);
		const first = createAuditWriter(v.root);
		const a = await first.appendEvent({ kind: "test.a", actor: "sys", data: {} });
		const b = await first.appendEvent({ kind: "test.b", actor: "sys", data: {} });
		first.release();
		const c = await appendOne(v);
		expect(a).toMatchObject({ sequence: 1 });
		expect(b).toMatchObject({ sequence: 2 });
		expect(c).toMatchObject({ sequence: 3, previousHash: b.hash });
		expect(verifyVault(join(v.root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
	});

	it("a hand-built sequenced log is continued at the next sequence", async () => {
		const chain = buildChain([1, 2, 3]);
		const v = vaultWith(terminated(chain));
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: 4, previousHash: hashOf(chain[2] as string) });
		expect(verifyVault(join(v.root, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 4 });
	});

	it("OUT OF SCOPE, pinned: a sequenced tail after an earlier sequence-less line is continued", async () => {
		// The log already fails verify for its first line; refusing it would need a full check at open.
		const chain = buildChain([null, 1, 2]);
		const v = vaultWith(terminated(chain));
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: 3, previousHash: hashOf(chain[2] as string) });
		expect(events(v)).toHaveLength(4);
	});

	it("a last line that does not parse falls back to the .meta anchor", async () => {
		const chain = buildChain([1, 2]);
		const v = vaultWith(terminated([...chain, "NOT_VALID_JSON"]));
		const lastHash = hashOf(chain[1] as string);
		writeFileSync(`${v.logPath}.meta`, JSON.stringify({ lastHash, sequence: 2 }));
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: 3, previousHash: lastHash });
	});

	it("a log ending in a torn line still opens, unleased and locked too; its appends refuse as torn", async () => {
		const v = vaultWith(`${terminated(buildChain([1, 2]))}{"id":"half-writ`);
		const before = readFileSync(v.logPath);

		// The quarantine repair opens a writer this way on a torn log.
		const repair = createUnleasedAuditWriter(v.root, { lockAtCreate: true });
		expect(existsSync(join(v.auditDir, ".audit-writer.lock"))).toBe(true);
		repair.release();
		expect(existsSync(join(v.auditDir, ".audit-writer.lock"))).toBe(false);

		vi.spyOn(console, "warn").mockImplementation(() => {});
		const w = createAuditWriter(v.root);
		writers.push(w);
		const err = await w
			.appendEvent({ kind: "test.next", actor: "sys", data: {} })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuditTornTailError);
		expect(readFileSync(v.logPath).equals(before)).toBe(true);
	});

	it("a sequence-less event with no newline after it is a torn tail, not this refusal", async () => {
		const [unsequenced] = buildChain([null]);
		const v = vaultWith(`${terminated(buildChain([1, 2]))}${unsequenced}`);
		const before = readFileSync(v.logPath);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const w = createAuditWriter(v.root);
		writers.push(w);
		const err = await w
			.appendEvent({ kind: "test.next", actor: "sys", data: {} })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuditTornTailError);
		expect((err as Error).name).not.toBe("AuditSequencelessTailError");
		expect(readFileSync(v.logPath).equals(before)).toBe(true);
	});
});
