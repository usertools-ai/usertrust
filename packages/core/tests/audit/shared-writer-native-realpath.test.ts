// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The shared writer where realpath(3) is unavailable: on musl without `/proc`, `realpathSync.native`
 * throws even for an existing directory (the lock resolves with the JS resolver for the same reason).
 * The vault still resolves, through the JS resolver; a governor still opens; and every spelling of one
 * vault is still ONE writer, because the writer map's key is the directories' `dev:ino`.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuditWriter, openSharedAuditWriter } from "../../src/audit/chain.js";
import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { securePrivateVault } from "../../src/shared/private-fs.js";

const nativeCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const realpathSync = ((p: string, o?: unknown) =>
		(fs.realpathSync as (p: string, o?: unknown) => string)(p, o)) as typeof fs.realpathSync;
	realpathSync.native = ((p: string) => {
		nativeCalls.count++;
		throw Object.assign(new Error(`ENOENT: realpath(3) without /proc, '${p}'`), { code: "ENOENT" });
	}) as typeof fs.realpathSync.native;
	return { ...fs, realpathSync, default: { ...fs, realpathSync } };
});

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

let tempDir: string;
const handles: AuditWriter[] = [];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "shared-writer-native-"));
	nativeCalls.count = 0;
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	for (const h of handles.splice(0)) {
		try {
			h.release();
		} catch {
			/* already released */
		}
	}
	vi.restoreAllMocks();
	rmSync(tempDir, { recursive: true, force: true });
});

/** A call's outcome as a value, so that a throw fails an assertion rather than erroring the test. */
const outcome = (run: () => unknown) =>
	Promise.resolve()
		.then(run)
		.then(
			(v) => v,
			(err: unknown) => err,
		);

describe("the shared writer without realpath(3) (musl, no /proc)", () => {
	it("a vault opens through the JS resolver, and two spellings (a symlink) are still ONE writer", async () => {
		const alias = `${tempDir}-alias`;
		symlinkSync(tempDir, alias);
		try {
			securePrivateVault(join(tempDir, VAULT_DIR), { create: true });
			const a = await outcome(() => openSharedAuditWriter(tempDir));
			const b = await outcome(() => openSharedAuditWriter(alias));
			expect(a).not.toBeInstanceOf(Error);
			expect(b).not.toBeInstanceOf(Error);
			handles.push(a as AuditWriter, b as AuditWriter);
			const appended = [
				await outcome(() =>
					(a as AuditWriter).appendEvent({ kind: "test.a", actor: "sys", data: {} }),
				),
				await outcome(() =>
					(b as AuditWriter).appendEvent({ kind: "test.b", actor: "sys", data: {} }),
				),
			];
			expect(appended.filter((r) => r instanceof Error)).toEqual([]);
			// The control: realpath(3) was asked, and refused, every time.
			expect(nativeCalls.count).toBeGreaterThan(0);
			const log = readFileSync(join(tempDir, VAULT_DIR, "audit", "events.jsonl"), "utf-8");
			expect(log.trim().split("\n")).toHaveLength(2);
		} finally {
			unlinkSync(alias);
		}
	});

	it("a portable answer that names ANOTHER directory than the path opens (`..` in a link's target) is refused at open", async () => {
		// .usertrust -> <tmp>/a/link/../vault, with <tmp>/a/link -> <tmp>/b/subdir: the OS opens
		// <tmp>/b/vault; the JS resolver folds the `..` first and names <tmp>/a/vault.
		for (const d of ["a/vault/audit", "b/vault/audit", "b/subdir", "proj"]) {
			mkdirSync(join(tempDir, d), { recursive: true, mode: 0o700 });
		}
		symlinkSync(join(tempDir, "b", "subdir"), join(tempDir, "a", "link"));
		symlinkSync(`${join(tempDir, "a", "link")}/../vault`, join(tempDir, "proj", VAULT_DIR));
		const opened = await outcome(() => openSharedAuditWriter(join(tempDir, "proj")));
		expect(opened).toBeInstanceOf(Error);
		expect(String((opened as Error).message)).toMatch(/names another directory/);
		for (const v of ["a", "b"]) {
			expect(readdirSync(join(tempDir, v, "vault", "audit"))).toEqual([]);
		}
	});

	it("a headless governor constructs and settles", async () => {
		const governor = await outcome(() =>
			createGovernor({ dryRun: true, vaultBase: tempDir, budget: 100_000 }),
		);
		expect(governor).not.toBeInstanceOf(Error);
		const g = governor as Awaited<ReturnType<typeof createGovernor>>;
		const hold = await g.authorize({ model: "gpt-4o", estimatedInputTokens: 10 });
		const settled = await g.settle(hold, { inputTokens: 10, outputTokens: 5 });
		await g.destroy();
		expect(settled.auditDegraded).toBeUndefined();
		expect(nativeCalls.count).toBeGreaterThan(0);
	});
});
