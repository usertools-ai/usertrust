// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — ANCHOR DIFFERENTIAL. The core verifier and the zero-dep verify
 * package must return identical anchor verdicts for the same vault + trust
 * inputs — the anchoring extension of the existing differential guarantee
 * (any change to the anchor record format / state machine must land in BOTH
 * packages or this test breaks).
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnchorVerifyParams as PkgParams,
	verifyVaultWithAnchors as pkgVerify,
} from "../../../../verify/src/index.js";
import {
	type AnchorVerifyParams as CoreParams,
	verifyVaultWithAnchors as coreVerify,
} from "../../../src/audit/verify.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	mutateAndRechain,
	storeRaw,
} from "./fixtures.js";

afterEach(() => {
	cleanupAll();
});

function verdict(result: {
	valid: boolean;
	anchorState: string;
	anchoring: {
		reasons: string[];
		warnings: string[];
		anchorCount: number;
		anchorSource: string;
		unanchoredTail: { events: number };
	};
	chainLength: number;
}): string {
	return JSON.stringify({
		valid: result.valid,
		anchorState: result.anchorState,
		reasons: [...result.anchoring.reasons].sort(),
		warnings: [...result.anchoring.warnings].sort(),
		anchorCount: result.anchoring.anchorCount,
		anchorSource: result.anchoring.anchorSource,
		tail: result.anchoring.unanchoredTail.events,
		chainLength: result.chainLength,
	});
}

function assertAgree(vaultPath: string, params: CoreParams & PkgParams): string {
	const core = coreVerify(vaultPath, params);
	const pkg = pkgVerify(vaultPath, params);
	expect(verdict(core)).toBe(verdict(pkg));
	return core.anchorState;
}

describe("HARDEN: core vs verify pkg produce identical ANCHOR verdicts", () => {
	it("agrees across the state machine: verified / stale / unverifiable / mismatch / deletion / unanchored", async () => {
		const s = await makeAnchoredVault(3);
		await anchorOnce(s);
		await appendEvents(s.root, 3, 4);
		await anchorOnce(s);

		const base = { externalAnchorsRaw: [storeRaw(s)], trust: s.trust };

		// 1. Happy path.
		expect(assertAgree(s.vaultPath, base)).toBe("ANCHORED_VERIFIED");

		// 2. Stale under a caller-supplied freshness policy.
		await appendEvents(s.root, 4, 7);
		expect(assertAgree(s.vaultPath, { ...base, maxUnanchoredEvents: 1 })).toBe("ANCHOR_STALE");

		// 3. Unverifiable: artifacts, no trust.
		expect(assertAgree(s.vaultPath, { externalAnchorsRaw: [storeRaw(s)] })).toBe(
			"ANCHOR_UNVERIFIABLE",
		);

		// 4. Witness unreachable cap.
		expect(
			assertAgree(s.vaultPath, {
				...base,
				witness: { requested: true, ok: false, error: "timeout" },
			}),
		).toBe("ANCHOR_UNVERIFIABLE");

		// 5. F1-style mutation + full re-chain.
		mutateAndRechain(s, 1);
		expect(assertAgree(s.vaultPath, base)).toBe("ANCHOR_MISMATCH");

		// 6. Whole-vault deletion (F2).
		rmSync(join(s.vaultPath, "audit"), { recursive: true, force: true });
		expect(assertAgree(s.vaultPath, base)).toBe("ANCHOR_MISMATCH");

		// 7. Legacy: nothing anchor-related at all.
		const legacy = await makeAnchoredVault(2); // identity exists but no anchors emitted...
		rmSync(join(legacy.vaultPath, "audit", "anchors"), { recursive: true, force: true });
		expect(assertAgree(legacy.vaultPath, {})).toBe("UNANCHORED");
	});
});
