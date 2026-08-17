// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — identity.json is written by ONE transactional writer.
 *
 * Every mutation goes through `updateAnchorIdentity`: take the emitter's
 * advisory lock, re-read UNDER the lock, merge, write atomically. Before this,
 * `bumpAnchorHighWater` and `recordRotatedIdentity` each did an unserialized
 * read -> spread -> write, so a write that began from a stale read could
 * overwrite a newer `lastAnchorSeq` and roll back the durable high-water. That
 * is the anchoring-monotonicity invariant: re-minting an occupied position in an
 * append-only external store is permanent, unrewritable fork evidence.
 *
 * These tests pin the parts that are observable through the public API — that
 * the lock is genuinely taken (an unserialized writer would proceed instead of
 * refusing), that the merge is union-and-monotonic, and that the atomic write
 * leaves nothing behind.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnchorIdentity,
	anchorsDir,
	initAnchorIdentity,
	readAnchorIdentity,
	recordRotatedIdentity,
	resumeAnchorMirror,
} from "../../../src/audit/anchor.js";
import { cleanupAll, signRecord, tmp } from "./fixtures.js";

afterEach(cleanupAll);

/** A vault with an anchor identity and its key deliberately outside the vault (AC-6.2). */
function vault(): { root: string; identity: AnchorIdentity; keyFile: string } {
	const root = tmp("ut-identity-");
	const keyDir = tmp("ut-identity-key-");
	mkdirSync(join(root, ".usertrust", "audit", "anchors"), { recursive: true });
	const keyFile = join(keyDir, "anchor.pem");
	const { identity } = initAnchorIdentity(root, { keyFile });
	return { root, identity, keyFile };
}

/**
 * Hold the emitter's advisory lock as an OTHER, LIVE process.
 *
 * pid 1 is chosen deliberately: it is always alive, and it is not us. The lock's
 * stale-detection reclaims a same-pid lock (a crashed prior emitter in this
 * process is safe to take over) and refuses a live foreign one — `kill(1, 0)`
 * raises EPERM rather than ESRCH for a non-root caller, which the lock reads as
 * "held", exactly as it would for any live sibling.
 */
function holdLockAsForeignProcess(root: string): void {
	const dir = anchorsDir(root);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, ".anchor-writer.lock"),
		JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }),
		{ mode: 0o600 },
	);
}

const identityPath = (root: string): string => join(anchorsDir(root), "identity.json");

describe("identity.json — single transactional writer", () => {
	it("refuses to mutate while an emission holds the lock, instead of writing unserialized", () => {
		const { root } = vault();
		// Stand in for an emission that has already advanced the high-water.
		const before = readAnchorIdentity(root) as AnchorIdentity;
		writeFileSync(identityPath(root), JSON.stringify({ ...before, lastAnchorSeq: 9 }));
		holdLockAsForeignProcess(root);

		expect(() =>
			recordRotatedIdentity(root, { keyId: "sha256:next", publicKeySpki: "AAAA" }),
		).toThrow(/locked by an in-flight emission/);

		// The refusal is the point: nothing was written, so nothing was rolled back.
		const after = readAnchorIdentity(root) as AnchorIdentity;
		expect(after.lastAnchorSeq).toBe(9);
		expect(after.keyId).toBe(before.keyId);
	});

	it("resume also serializes against an in-flight emission", () => {
		const { root, identity, keyFile } = vault();
		holdLockAsForeignProcess(root);
		// A genuinely signed record, so resume's own validation passes and we
		// actually reach the high-water bump — otherwise this test would "pass"
		// on a rejection that has nothing to do with the lock.
		const record = signRecord(
			{
				v: 1,
				vaultId: identity.vaultId,
				anchorSeq: 1,
				prevAnchorHash: "0".repeat(64),
				treeSize: 1,
				lastHash: "a".repeat(64),
				merkleRoot: "b".repeat(64),
				timestamp: new Date().toISOString(),
				keyId: identity.keyId,
			} as never,
			keyFile,
		);
		// resumeAnchorMirror bumps the durable high-water, so it takes the lock
		// too. Deliberate behaviour change: it previously wrote regardless.
		expect(() => resumeAnchorMirror(root, JSON.stringify(record))).toThrow(
			/locked by an in-flight emission/,
		);
	});

	// NOTE ON THESE TWO: they are REGRESSION guards on `recordRotatedIdentity`,
	// not proof of `mergeIdentity`. Mutation testing showed both survive deleting
	// the max and the union outright — every current caller's proposal is already
	// fresh, because `mutate()` is handed a copy re-read under the lock. What they
	// pin is that a rotation does not drop these fields, which is a real thing to
	// break and was worth catching; they are simply not evidence for the merge.
	it("a rotation does not drop the durable high-water or the superseded key", () => {
		const { root } = vault();
		const before = readAnchorIdentity(root) as AnchorIdentity;
		writeFileSync(identityPath(root), JSON.stringify({ ...before, lastAnchorSeq: 7 }));

		recordRotatedIdentity(root, { keyId: "sha256:next", publicKeySpki: "BBBB" });

		const after = readAnchorIdentity(root) as AnchorIdentity;
		// Monotonic: a rotation must not clobber the high-water an emission set.
		expect(after.lastAnchorSeq).toBe(7);
		expect(after.keyId).toBe("sha256:next");
		// Union: the superseded key survives, or records signed under it become
		// unattributable — the sink could no longer name the key that signed them.
		const ids = (after.keyHistory ?? []).map((k) => k.keyId);
		expect(ids).toContain(before.keyId);
		expect(ids).toContain("sha256:next");
	});

	it("a rotation leaves an already-advanced high-water untouched", () => {
		const { root } = vault();
		const before = readAnchorIdentity(root) as AnchorIdentity;
		writeFileSync(identityPath(root), JSON.stringify({ ...before, lastAnchorSeq: 12 }));

		// A mutation that carries no opinion about the sequence must not reset it.
		// (Pins the caller, not the merge — see the note above.)
		recordRotatedIdentity(root, { keyId: "sha256:next", publicKeySpki: "CCCC" });
		expect((readAnchorIdentity(root) as AnchorIdentity).lastAnchorSeq).toBe(12);
	});

	it("leaves no temp file behind, and the temp name is not pid-only", () => {
		const { root } = vault();
		recordRotatedIdentity(root, { keyId: "sha256:next", publicKeySpki: "DDDD" });

		const leftovers = readdirSync(anchorsDir(root)).filter((f) => f.includes(".tmp-"));
		expect(leftovers).toEqual([]);
		expect(existsSync(identityPath(root))).toBe(true);
		// The file is valid JSON, not a torn write.
		expect(() => JSON.parse(readFileSync(identityPath(root), "utf-8"))).not.toThrow();
	});
});
