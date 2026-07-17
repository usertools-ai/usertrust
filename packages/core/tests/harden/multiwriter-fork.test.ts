// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — Same-PID lock reclaim must NOT let two in-process writers fork the
 * chain. A second live writer targeting the same vault in the same process must
 * be rejected (not silently reclaim the sibling's lock and fork the chain).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyVault } from "../../src/audit/verify.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

describe("HARDEN: two live in-process writers must not fork the chain", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "harden-multiwriter-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects a second live writer and keeps the chain intact", async () => {
		const a = createAuditWriter(root);
		const b = createAuditWriter(root);
		try {
			await a.appendEvent({ kind: "a", actor: "sys", data: { n: 1 } });

			// b is a genuine second live writer on the same vault, same process.
			await expect(b.appendEvent({ kind: "b", actor: "sys", data: { n: 2 } })).rejects.toThrow(
				/another writer in this process/,
			);

			// The real invariant: the chain never forked — only a's event persisted.
			const result = verifyVault(join(root, VAULT_DIR));
			expect(result.valid).toBe(true);
			expect(result.chainLength).toBe(1);
		} finally {
			a.release();
			b.release();
		}
	});
});
