// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — EMITTER ROBUSTNESS regressions for the implementation review
 * findings (scheduler crash, outbox redelivery, corrupt/emptied-mirror guard,
 * signer epoch guard). These are honest-operator failure modes that would
 * otherwise silently poison the append-only store or crash the host process.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnchorSink,
	createAnchorEmitter,
	initAnchorIdentity,
	readAnchorIdentity,
} from "../../../src/audit/anchor.js";
import { parseAnchorsContent } from "../../../src/audit/anchor-verify.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	storeRecords,
	tmp,
} from "./fixtures.js";

afterEach(() => {
	cleanupAll();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("HARDEN: emitter — scheduler never crashes the host process (blocker)", () => {
	it("a rejecting signer in the scheduler surfaces as degraded+lastEmitError, not an unhandled rejection", async () => {
		const root = tmp("emit-crash-");
		await appendEvents(root, 3);
		// External signer whose sign() always rejects (simulated KMS outage).
		const { publicKeySpki, keyId } = mintExternalIdentity(root);
		const emitter = createAnchorEmitter(root, {
			signer: {
				type: "external",
				keyId,
				publicKeySpki,
				sign: () => Promise.reject(new Error("KMS unavailable")),
			},
			cadence: { everyMs: 1, everyEvents: 1 },
			sinks: [],
		});

		const rejections: unknown[] = [];
		const onRejection = (err: unknown) => rejections.push(err);
		process.on("unhandledRejection", onRejection);
		try {
			emitter.start();
			// The scheduler's internal interval is clamped to a 250ms floor;
			// wait past it so at least one tick fires and rejects.
			await sleep(600);
			await emitter.stop();
			await sleep(50);
		} finally {
			process.off("unhandledRejection", onRejection);
		}

		expect(rejections).toEqual([]);
		const status = emitter.status();
		expect(status.degraded).toBe(true);
		expect(status.lastEmitError).toContain("KMS unavailable");
	});
});

describe("HARDEN: emitter — outbox redelivery (no permanent store gaps)", () => {
	it("a stranded record is republished on the next cycle; store history has no anchorSeq gap", async () => {
		const s = await makeAnchoredVault(3);
		let failNext = true;
		const flaky: AnchorSink = {
			name: "flaky",
			publish: async (record) => {
				if (failNext) {
					failNext = false;
					throw new Error("sink down");
				}
				const line = `${JSON.stringify(record)}\n`;
				const { appendFileSync } = await import("node:fs");
				appendFileSync(s.storeFile, line);
			},
		};
		const emitter = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [flaky],
			publishRetries: 1,
		});
		const r1 = await emitter.anchorNow(); // publish of #1 fails → stranded in outbox
		expect(r1.emitted).toBe(true);
		await emitter.stop();
		expect(emitter.status().outboxDepth).toBe(1);
		expect(emitter.status().degraded).toBe(true);

		await appendEvents(s.root, 2, 4);
		const r2 = await emitter.anchorNow(); // drains #1 then publishes #2
		expect(r2.emitted).toBe(true);
		await emitter.stop();

		const stored = parseAnchorsContent(readFileSync(s.storeFile, "utf-8")).records.sort(
			(a, b) => a.anchorSeq - b.anchorSeq,
		);
		expect(stored.map((r) => r.anchorSeq)).toEqual([1, 2]); // no gap
		expect(emitter.status().outboxDepth).toBe(0);
		expect(emitter.status().degraded).toBe(false);
	});
});

describe("HARDEN: emitter — mirror-loss guards (no permanent fork evidence)", () => {
	it("emptied-but-present mirror refuses to re-mint a GENESIS anchorSeq 1 (durable high-water)", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s); // mirror + identity high-water now at seq 1
		const mirrorPath = join(s.vaultPath, "audit", "anchors", "anchors.jsonl");
		writeFileSync(mirrorPath, ""); // accidental truncation / bad restore
		await appendEvents(s.root, 2, 4);

		const emitter = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
		});
		const result = await emitter.anchorNow();
		await emitter.stop();
		expect(result.emitted).toBe(false);
		expect(result.reason).toMatch(/mirror-behind-highwater/);
		// The store still holds exactly one record (no divergent second seq 1).
		expect(storeRecords(s).map((r) => r.anchorSeq)).toEqual([1]);
	});

	it("corrupt-but-present mirror refuses to emit", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		const mirrorPath = join(s.vaultPath, "audit", "anchors", "anchors.jsonl");
		writeFileSync(mirrorPath, "{ not json\n");
		await appendEvents(s.root, 2, 4);

		const emitter = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
		});
		const result = await emitter.anchorNow();
		await emitter.stop();
		expect(result.emitted).toBe(false);
		expect(result.reason).toMatch(/mirror-corrupt/);
	});
});

describe("HARDEN: emitter — signer epoch guard", () => {
	it("anchoring with a superseded key after rotation refuses (stale-signer-key)", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 1, 4);
		// Rotate to a fresh key.
		const { mintSuccessorKey, recordRotatedIdentity } = await import(
			"../../../src/audit/anchor.js"
		);
		const identity = readAnchorIdentity(s.root);
		if (identity === null) throw new Error("no identity");
		const successor = mintSuccessorKey(identity.vaultId);
		const rotator = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
		});
		const rot = await rotator.rotate({
			keyId: successor.keyId,
			publicKeySpki: successor.publicKeySpki,
		});
		await rotator.stop();
		expect(rot.emitted).toBe(true);
		recordRotatedIdentity(s.root, {
			keyId: successor.keyId,
			publicKeySpki: successor.publicKeySpki,
		});
		await appendEvents(s.root, 1, 5);

		// The old key is still at s.keyFile; a cron `anchor now` resolving it
		// must refuse rather than mint permanent rotation-continuity evidence.
		const stale = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: s.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
		});
		const result = await stale.anchorNow();
		await stale.stop();
		expect(result.emitted).toBe(false);
		expect(result.reason).toMatch(/stale-signer-key/);

		// The successor key emits cleanly.
		const good = createAnchorEmitter(s.root, {
			signer: { type: "pem", file: successor.keyFile },
			sinks: [{ type: "file", path: s.storeFile }],
		});
		const ok = await good.anchorNow();
		await good.stop();
		expect(ok.emitted).toBe(true);
	});
});

/** Mint an identity whose key is an external (non-file) signer for crash tests. */
function mintExternalIdentity(root: string): { publicKeySpki: string; keyId: string } {
	const store = tmp("emit-extkey-");
	const keyFile = join(store, "k.pem");
	const { identity } = initAnchorIdentity(root, { keyFile });
	return { publicKeySpki: identity.publicKeySpki, keyId: identity.keyId };
}
