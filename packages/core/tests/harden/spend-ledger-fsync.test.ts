// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An fsync that fails must not discard the spend.
 *
 * `sync()` is unsupported on some filesystems (EINVAL/ENOTSUP) and can fail
 * transiently on others (ENOSPC/EIO). Letting it escape sent the entire write
 * into `persistSpendLedger`'s broad catch, which unlinks the staging file and
 * returns as if the spend had persisted. On a platform without fsync that
 * silently discarded EVERY ledger write — and a FIRST write discarded that way
 * leaves no ledger at all, which the loader correctly reads as zero and
 * re-grants the whole session budget.
 *
 * The two halves of this branch combined into the exact defect the branch
 * exists to remove: the read was taught to distinguish absent from unreadable,
 * and the write was given a path that manufactures "absent".
 *
 * `node:fs/promises` is mocked here rather than in the sibling suite so the
 * mock cannot leak into tests that do real filesystem work.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Set per-test to make the mocked `FileHandle.sync()` reject. */
let syncFails: Error | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (path: string, flags: string) => {
			const handle = await actual.open(path, flags);
			return new Proxy(handle, {
				get(target, prop, receiver) {
					if (prop === "sync") {
						return async () => {
							if (syncFails !== null) throw syncFails;
							return await target.sync();
						};
					}
					const v = Reflect.get(target, prop, receiver);
					return typeof v === "function" ? v.bind(target) : v;
				},
			});
		},
	};
});

const { createGovernor } = await import("../../src/headless.js");

let root: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "usertrust-fsync-"));
	const { mkdir } = await import("node:fs/promises");
	await mkdir(join(root, ".usertrust"), { recursive: true });
	syncFails = null;
});

afterEach(() => {
	vi.restoreAllMocks();
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort; the OS reclaims the temp dir regardless.
	}
});

describe("spend ledger — a failing fsync must not discard the write", () => {
	const opts = () => ({ budget: 100_000, dryRun: true, vaultBase: root }) as never;

	/**
	 * Assert on the LEDGER FILE, not on whether some rename happened. An earlier
	 * cut of this test flagged any `rename` through the mocked module and passed
	 * with the fix reverted, because the audit writer renames too — a global flag
	 * measuring the wrong subject, which is the same mistake this whole branch is
	 * about. The file and its contents are the only honest evidence.
	 */
	async function ledgerSpend(): Promise<number | null> {
		const { readFile } = await import("node:fs/promises");
		try {
			const raw = await readFile(join(root, ".usertrust", "spend-ledger.json"), "utf-8");
			return (JSON.parse(raw) as { budgetSpent: number }).budgetSpent;
		} catch {
			return null;
		}
	}

	it("still PERSISTS the ledger when sync() is unsupported", async () => {
		// EINVAL is what a filesystem without fsync support answers. Before the fix
		// this threw past the rename into the broad catch, which unlinked the
		// staging file and returned as though the spend had been recorded — leaving
		// NO ledger, which the loader reads as zero and re-grants the whole budget.
		syncFails = Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });

		const governor = await createGovernor(opts());
		const auth = await governor.authorize({ model: "claude-sonnet-4-6", messages: [] } as never);
		await governor.settle(auth, { inputTokens: 10, outputTokens: 10 } as never);

		expect(await ledgerSpend()).not.toBeNull();
	});

	it("warns on stderr rather than degrading in silence", async () => {
		syncFails = Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const governor = await createGovernor(opts());
		const auth = await governor.authorize({ model: "claude-sonnet-4-6", messages: [] } as never);
		await governor.settle(auth, { inputTokens: 10, outputTokens: 10 } as never);

		const said = stderr.mock.calls.map((c) => String(c[0])).join("\n");
		expect(said).toMatch(/spend ledger not fsynced/i);
	});

	it("persists normally when sync() succeeds", async () => {
		const governor = await createGovernor(opts());
		const auth = await governor.authorize({ model: "claude-sonnet-4-6", messages: [] } as never);
		await governor.settle(auth, { inputTokens: 10, outputTokens: 10 } as never);
		expect(await ledgerSpend()).not.toBeNull();
	});
});
