// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The other consumers of a reading's events, on a MIXED log (some events carry a `sequence`, some
 * do not). The walk leaves a sequence-less event out; the events handed back hold every event.
 *
 *  - EVIDENCE counts only CHECKED events. A dead letter is resolved, and a receipt audited, only by
 *    an event the walk hash-checked: a sequence-less event never was, so a dead letter naming it
 *    stays missing and a receipt naming it is unaudited, in `usertrust verify` (plain and anchored)
 *    and in `usertrust health`. The figures (spend, tables) still count every event on file.
 *  - `--tx` (`verifyTransaction`): a sequence-less event's transfer is FOUND (it is on file) but
 *    reported as outside the checked chain: it has no leaf, so its receipt carries no position, no
 *    inclusion proof and no anchored claim, and the verdict is the failing vault's. A sequenced
 *    transfer in the same log keeps its own position and leaf, and a sequence-less record of a
 *    sequenced transfer cannot change that transfer's status.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyTransaction } from "../../../verify/src/index.js";
import { canonicalize } from "../../src/audit/canonical.js";
import { verifyVaultComplete } from "../../src/audit/complete.js";
import { run as healthRun } from "../../src/cli/health.js";
import { run as verifyRun } from "../../src/cli/verify.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";
import {
	anchorOnce,
	cleanupAll,
	makeAnchoredVault,
	storeRaw,
} from "../harden/anchoring/fixtures.js";

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

interface Spec {
	sequence: number | null;
	data: Record<string, unknown>;
}

function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "trust-mixed-consumers-"));
	dirs.push(d);
	return d;
}

/**
 * A vault directory (the `.usertrust` directory) whose `audit/events.jsonl` holds one `llm_call`
 * per spec, each hashed over its canonical form and linked to the one before it (the first to
 * GENESIS). A `null` sequence writes an event with no `sequence` field. Returns the vault and the
 * events as written (with their hashes). `vault` names the directory to use (a new one if absent).
 */
function vaultOf(
	specs: readonly Spec[],
	vault: string = newDir(),
): { vault: string; events: Record<string, unknown>[] } {
	const auditDir = join(vault, "audit");
	mkdirSync(auditDir, { recursive: true });
	let previousHash = GENESIS_HASH;
	const events: Record<string, unknown>[] = [];
	for (let i = 0; i < specs.length; i++) {
		const s = specs[i] as Spec;
		const event: Record<string, unknown> = {
			id: `evt-${i + 1}`,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			previousHash,
			kind: "llm_call",
			actor: "local",
			data: s.data,
		};
		if (s.sequence !== null) event.sequence = s.sequence;
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		events.push({ ...event, hash });
		previousHash = hash;
	}
	writeFileSync(
		join(auditDir, "events.jsonl"),
		`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
	return { vault, events };
}

/** A dead letter as the writer seals it: SHA-256 over the canonical record, then the checksum. */
function sealed(entry: Record<string, unknown>): string {
	const checksum = createHash("sha256").update(canonicalize(entry)).digest("hex");
	return JSON.stringify({ ...entry, checksum, checksumAlg: "sha256" });
}

/** A dead letter of the chain writer for `event`, naming `eventHash`. */
function deadLetterFor(event: Record<string, unknown>, eventHash: string): string {
	return sealed({
		source: "audit.chain.appendEvent",
		payload: { kind: event.kind, actor: event.actor, data: event.data },
		error: "meta",
		timestamp: "2026-01-01T00:00:00.000Z",
		eventHash,
	});
}

function writeDeadLetters(vault: string, lines: readonly string[]): void {
	mkdirSync(join(vault, "dlq"), { recursive: true });
	writeFileSync(join(vault, "dlq", "dead-letters.jsonl"), `${lines.join("\n")}\n`);
}

/** tx_a (1), tx_b (no sequence), tx_c (2): one sequence-less event between two sequenced ones. */
const MIXED: readonly Spec[] = [
	{ sequence: 1, data: { transferId: "tx_a", cost: 10, settled: true } },
	{ sequence: null, data: { transferId: "tx_b", cost: 20, settled: true } },
	{ sequence: 2, data: { transferId: "tx_c", cost: 30, settled: true } },
];

describe("completeness on a mixed log: a dead letter naming a logged event", () => {
	it("D1. a dead letter naming the sequence-less event stays missing: that event was never checked", () => {
		const { vault, events } = vaultOf(MIXED);
		const unsequenced = events[1] as Record<string, unknown>;
		writeDeadLetters(vault, [deadLetterFor(unsequenced, unsequenced.hash as string)]);
		const c = verifyVaultComplete(vault);
		expect(c.deadLetters).toMatchObject({ missing: 1, onChain: 0 });
		expect(c.complete).toBe(false);
		expect(c.valid).toBe(false);
		expect(c.errors).toContain("event without sequence (events.jsonl:2)");
		expect(c.errors.some((e) => e.startsWith("INCOMPLETE"))).toBe(true);
	});

	it("D2. positive control: a dead letter naming a sequenced event is on the chain", () => {
		const { vault, events } = vaultOf(MIXED);
		const sequenced = events[2] as Record<string, unknown>;
		writeDeadLetters(vault, [deadLetterFor(sequenced, sequenced.hash as string)]);
		const c = verifyVaultComplete(vault);
		expect(c.deadLetters).toMatchObject({ missing: 0, onChain: 1 });
	});

	it("D3. positive control: a dead letter naming no logged event is missing", () => {
		const { vault, events } = vaultOf(MIXED);
		const sequenced = events[2] as Record<string, unknown>;
		writeDeadLetters(vault, [deadLetterFor(sequenced, "0".repeat(64))]);
		const c = verifyVaultComplete(vault);
		expect(c.deadLetters).toMatchObject({ missing: 1, onChain: 0 });
		expect(c.complete).toBe(false);
	});
});

describe("usertrust verify and health on a mixed log: only checked events are evidence", () => {
	let out: string[];

	beforeEach(() => {
		out = [];
		process.exitCode = 0;
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			out.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	const json = () =>
		JSON.parse(out.join("\n")) as { success: boolean; data: Record<string, unknown> };

	/** A project directory whose `.usertrust` holds the MIXED log; returns it and the events. */
	function project(): { root: string; vault: string; events: Record<string, unknown>[] } {
		const root = newDir();
		const { vault, events } = vaultOf(MIXED, join(root, VAULT_DIR));
		return { root, vault, events };
	}

	/** tx_b by its hash and as a degraded receipt, both naming the sequence-less event; tx_c by hash. */
	function receiptsFile(root: string, events: readonly Record<string, unknown>[]): string {
		const file = join(root, "receipts.jsonl");
		writeFileSync(
			file,
			[
				{ transferId: "tx_b", auditHash: events[1]?.hash },
				{ transferId: "tx_b", auditHash: "AUDIT_DEGRADED" },
				{ transferId: "tx_c", auditHash: events[2]?.hash },
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		return file;
	}

	/** An empty anchors file: enough to take `usertrust verify` down its anchored path. */
	function emptyAnchors(root: string): string {
		const file = join(root, "anchors.jsonl");
		writeFileSync(file, "");
		return file;
	}

	const UNAUDITED_B = [
		{ transferId: "tx_b", reason: "its auditHash is not on the chain" },
		{
			transferId: "tx_b",
			reason: "its audit write degraded, and its llm_call event is not on the chain",
		},
	];

	it("C1. anchored verify: a dead letter naming the sequence-less event stays missing", async () => {
		const { root, vault, events } = project();
		const unsequenced = events[1] as Record<string, unknown>;
		writeDeadLetters(vault, [deadLetterFor(unsequenced, unsequenced.hash as string)]);
		await verifyRun(root, { json: true }, ["--anchor", emptyAnchors(root)]);
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data.complete).toBe(false);
		expect(r.data.deadLetters).toMatchObject({ missing: 1, onChain: 0 });
		expect(r.data.errors).toContain("event without sequence (events.jsonl:2)");
	});

	it("C2. plain verify: a receipt naming the sequence-less event is unaudited, by hash and as degraded", async () => {
		const { root, events } = project();
		await verifyRun(root, { json: true }, ["--receipts", receiptsFile(root, events)]);
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data.complete).toBe(false);
		expect(r.data.receipts).toEqual({ checked: 3, unreadable: 0, unaudited: UNAUDITED_B });
	});

	it("C3. anchored verify: the same receipts, the same unaudited list", async () => {
		const { root, events } = project();
		await verifyRun(root, { json: true }, [
			"--anchor",
			emptyAnchors(root),
			"--receipts",
			receiptsFile(root, events),
		]);
		const r = json();
		expect(r.success).toBe(false);
		expect(r.data.complete).toBe(false);
		expect(r.data.receipts).toEqual({ checked: 3, unreadable: 0, unaudited: UNAUDITED_B });
	});

	it("C4. positive control: a receipt naming a sequenced event of the same log is audited", async () => {
		const { root, events } = project();
		const file = join(root, "receipts.jsonl");
		writeFileSync(file, JSON.stringify({ transferId: "tx_c", auditHash: events[2]?.hash }));
		await verifyRun(root, { json: true }, ["--receipts", file]);
		expect(json().data.receipts).toEqual({ checked: 1, unreadable: 0, unaudited: [] });
		out = [];
		await verifyRun(root, { json: true }, ["--anchor", emptyAnchors(root), "--receipts", file]);
		expect(json().data.receipts).toEqual({ checked: 1, unreadable: 0, unaudited: [] });
	});

	it("H1. health: a dead letter naming the sequence-less event counts as a missing event", async () => {
		const { root, vault, events } = project();
		const unsequenced = events[1] as Record<string, unknown>;
		writeDeadLetters(vault, [deadLetterFor(unsequenced, unsequenced.hash as string)]);
		await healthRun(root, { json: true });
		const signals = json().data.signals as Record<string, unknown>;
		expect(signals.missingEvents).toBe(1);
		expect(signals.chainIntegrity).toBe(false);
	});

	it("H2. positive control: health resolves a dead letter naming a sequenced event", async () => {
		const { root, vault, events } = project();
		const sequenced = events[2] as Record<string, unknown>;
		writeDeadLetters(vault, [deadLetterFor(sequenced, sequenced.hash as string)]);
		await healthRun(root, { json: true });
		const signals = json().data.signals as Record<string, unknown>;
		expect(signals.missingEvents).toBe(0);
	});
});

/** Box rows print `Label.....value`: a position line is any `Event <x> of <n>`. */
const POSITION = /Event \S+ of \d+/;

describe("verifyTransaction (--tx) on a mixed log, unanchored", () => {
	it("T1. a sequence-less event's transfer is found, flagged outside the checked chain, with no position", () => {
		const { vault } = vaultOf(MIXED);
		const r = verifyTransaction(vault, "tx_b");
		expect(r.found).toBe(true);
		expect(r.valid).toBe(false);
		expect(r.inclusionVerified).not.toBe(true);
		expect(r.errors).toContain("event without sequence (events.jsonl:2)");
		expect(r.receipt).toContain("outside the checked chain");
		// No leaf, so no position: never `Event ? of 2`, and never a number it does not hold.
		expect(r.receipt).not.toMatch(POSITION);
		expect(r.receipt).not.toContain("INCLUSION VERIFIED");
		expect(r.receipt).not.toContain("CHAIN CONSISTENT");
	});

	it("T2. a sequenced transfer in the same log keeps its own position among the walked events", () => {
		const { vault } = vaultOf(MIXED);
		const r = verifyTransaction(vault, "tx_c");
		expect(r.found).toBe(true);
		expect(r.valid).toBe(false);
		expect(r.receipt).toContain("Event 2 of 2");
		expect(r.receipt).not.toContain("outside the checked chain");
	});

	it("T3. a sequence-less record of a sequenced transfer cannot change its status or position", () => {
		// tx_p: a sequenced llm_call that never settled (PENDING), then a sequence-less record of
		// the same transfer claiming it settled. The walked record decides the receipt: an unchecked
		// record must never raise a transfer's certainty.
		const specs: Spec[] = [
			{ sequence: 1, data: { transferId: "tx_a", cost: 10, settled: true } },
			{ sequence: 2, data: { transferId: "tx_p", cost: 40 } },
			{ sequence: null, data: { transferId: "tx_p", cost: 40, settled: true } },
		];
		const { vault } = vaultOf(specs);
		const r = verifyTransaction(vault, "tx_p");
		expect(r.found).toBe(true);
		expect(r.status).toBe("PENDING");
		expect(r.receipt).toContain("Event 2 of 2");
		expect(r.receipt).not.toContain("Event ? of");
		expect(r.receipt).not.toContain("outside the checked chain");
		expect(r.valid).toBe(false);
	});

	it("T4. positive control: in the same log with every event sequenced, tx_b is found at 2 of 3", () => {
		const { vault } = vaultOf(MIXED.map((s, i) => ({ ...s, sequence: i + 1 })));
		const r = verifyTransaction(vault, "tx_b");
		expect(r.found).toBe(true);
		expect(r.valid).toBe(true);
		expect(r.receipt).toContain("Event 2 of 3");
		expect(r.receipt).not.toContain("outside the checked chain");
	});
});

describe("verifyTransaction (--tx) on a mixed log, anchored", () => {
	afterEach(() => {
		cleanupAll();
	});

	/**
	 * Three writer events (tr_1..tr_3, sequences 1..3) anchored at tree size 3, then one
	 * sequence-less `llm_call` (tr_x) linked after them. The walk, the `.meta` head and the anchor
	 * all still describe the three sequenced events.
	 */
	async function anchoredMixed() {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		const log = join(s.vaultPath, "audit", "events.jsonl");
		const lines = readFileSync(log, "utf-8").trim().split("\n");
		const last = JSON.parse(lines.at(-1) as string) as { hash: string };
		const event = {
			id: "evt-unsequenced",
			timestamp: new Date().toISOString(),
			previousHash: last.hash,
			kind: "llm_call",
			actor: "sys",
			data: { cost: 1, transferId: "tr_x", settled: true },
		};
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		writeFileSync(log, `${[...lines, JSON.stringify({ ...event, hash })].join("\n")}\n`);
		const params = {
			externalAnchorsRaw: [storeRaw(s)],
			trust: s.trust,
			witness: { requested: false },
		};
		return { s, params };
	}

	it("T6. the sequence-less transfer is found but never claims inclusion against the anchor", async () => {
		const { s, params } = await anchoredMixed();
		const r = verifyTransaction(s.vaultPath, "tr_x", params);
		expect(r.found).toBe(true);
		expect(r.valid).toBe(false);
		expect(r.inclusionVerified).not.toBe(true);
		expect(r.receipt).toContain("outside the checked chain");
		expect(r.receipt).not.toMatch(POSITION);
		expect(r.receipt).not.toContain("INCLUSION VERIFIED");
		expect(r.receipt).not.toContain("* VERIFIED *");
	});

	it("T7. a sequenced transfer in the same vault keeps its own leaf: position 2 of 3, proven at its leaf", async () => {
		const { s, params } = await anchoredMixed();
		const r = verifyTransaction(s.vaultPath, "tr_2", params);
		expect(r.found).toBe(true);
		expect(r.receipt).toContain("Event 2 of 3");
		expect(r.receipt).toContain("INCLUSION VERIFIED (anchor #");
		// The vault fails (the sequence-less event), so the transfer's verdict is not a pass.
		expect(r.valid).toBe(false);
		expect(r.inclusionVerified).toBe(false);
	});
});
