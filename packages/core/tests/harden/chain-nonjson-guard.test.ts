// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — defense in depth for the audit line. The canonicalizer now refuses
 * every value JSON cannot represent, so no reachable input produces unparseable
 * bytes. That is exactly why `chain.ts` must not TRUST it: the canonical bytes
 * ARE the audit line, and a single unparseable line dangles the next event's
 * `previousHash` permanently. The writer parses what it is about to persist and
 * refuses at the door, BEFORE the fsync.
 *
 * The guard is unreachable through the real canonicalizer by design, so this
 * file drives it the only way it can be driven: by poisoning canonicalize.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VAULT_DIR } from "../../src/shared/constants.js";

const state = vi.hoisted(() => ({ poisoned: false }));

vi.mock("../../src/audit/canonical.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/audit/canonical.js")>();
	return {
		canonicalize: (value: unknown): string =>
			state.poisoned ? '{"broken":undefined}' : actual.canonicalize(value),
	};
});

const { createAuditWriter } = await import("../../src/audit/chain.js");

describe("HARDEN: chain.ts refuses canonical bytes that do not parse", () => {
	let root: string;
	let writer: ReturnType<typeof createAuditWriter>;
	let logPath: string;

	beforeEach(async () => {
		state.poisoned = false;
		root = mkdtempSync(join(tmpdir(), "harden-nonjson-"));
		writer = createAuditWriter(root);
		logPath = join(root, VAULT_DIR, "audit", "events.jsonl");
		await writer.appendEvent({ kind: "seed", actor: "sys", data: { ok: true } });
	});

	afterEach(() => {
		state.poisoned = false;
		writer.release();
		rmSync(root, { recursive: true, force: true });
	});

	it("throws before the fsync and persists nothing", async () => {
		const before = readFileSync(logPath, "utf-8");
		state.poisoned = true;

		await expect(writer.appendEvent({ kind: "poisoned", actor: "sys", data: {} })).rejects.toThrow(
			/refusing to persist/,
		);

		// Byte-for-byte unchanged: the refusal happened before the log was opened.
		expect(readFileSync(logPath, "utf-8")).toBe(before);
	});

	it("degrades the writer and dead-letters the refused event", async () => {
		state.poisoned = true;
		await expect(
			writer.appendEvent({ kind: "poisoned", actor: "sys", data: {} }),
		).rejects.toThrow();

		expect(writer.isDegraded()).toBe(true);
		expect(writer.getWriteFailures()).toBe(1);
		expect(existsSync(join(root, VAULT_DIR, "dlq", "dead-letters.jsonl"))).toBe(true);
	});

	it("keeps writing normally once the bytes are valid again", async () => {
		state.poisoned = true;
		await expect(
			writer.appendEvent({ kind: "poisoned", actor: "sys", data: {} }),
		).rejects.toThrow();
		state.poisoned = false;

		const event = await writer.appendEvent({ kind: "after", actor: "sys", data: { n: 2 } });
		writer.release();

		const lines = readFileSync(logPath, "utf-8")
			.split("\n")
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] as string).hash).toBe(event.hash);
	});
});
