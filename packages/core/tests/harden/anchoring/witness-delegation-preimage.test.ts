// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — the witness-key delegation preimage (witness-key spec §3.3).
 *
 * The delegation is what stops the throwaway-key attack: submit an authentic
 * payload hash to Rekor under a one-off key, present the valid receipt, and the
 * canonical index an auditor would enumerate is empty while every other check
 * passes. Making the witness key ROOT-DELEGATED closes that — but only if two
 * different delegations can never share a preimage, because a signature is only
 * as specific as the bytes it covers.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	OPEN_ENDED_ANCHOR_SEQ,
	WITNESS_DELEGATION_TAG,
	witnessDelegationPreimage,
} from "../../../src/audit/anchor-verify.js";

const base = {
	vaultId: "vault-a",
	witnessKeyId: `sha256:${"a".repeat(64)}`,
	witnessSpkiDer: Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107", "hex"),
	delegatedByKeyId: `sha256:${"b".repeat(64)}`,
	delegationIndex: 1,
	effectiveFromAnchorSeq: 1,
	effectiveUntilAnchorSeq: OPEN_ENDED_ANCHOR_SEQ,
};

const hex = (b: Uint8Array | null): string =>
	b === null ? "null" : createHash("sha256").update(b).digest("hex");

describe("witnessDelegationPreimage", () => {
	it("is deterministic and starts with its domain tag", () => {
		const a = witnessDelegationPreimage(base) as Uint8Array;
		expect(a).not.toBeNull();
		expect(hex(a)).toBe(hex(witnessDelegationPreimage(base)));
		expect(Buffer.from(a.slice(0, WITNESS_DELEGATION_TAG.length)).toString("utf8")).toBe(
			WITNESS_DELEGATION_TAG,
		);
	});

	it("length prefixes make adjacent-field ambiguity impossible", () => {
		// THE case the prefixes exist for. Without them these two concatenate to
		// identical bytes, so one root signature would authorize both — and
		// `vaultId` is only ever validated as a non-empty string, never as a
		// UUID, so an attacker picks it freely.
		const left = witnessDelegationPreimage({ ...base, vaultId: "ab", witnessKeyId: "c" });
		const right = witnessDelegationPreimage({ ...base, vaultId: "a", witnessKeyId: "bc" });
		expect(hex(left)).not.toBe(hex(right));
	});

	it("every field is covered — changing any one changes the bytes", () => {
		const baseline = hex(witnessDelegationPreimage(base));
		const variants = [
			{ ...base, vaultId: "vault-b" },
			{ ...base, witnessKeyId: `sha256:${"c".repeat(64)}` },
			{
				...base,
				witnessSpkiDer: Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030108", "hex"),
			},
			{ ...base, delegatedByKeyId: `sha256:${"d".repeat(64)}` },
			{ ...base, delegationIndex: 2 },
			{ ...base, effectiveFromAnchorSeq: 2 },
			{ ...base, effectiveUntilAnchorSeq: 500 },
		];
		for (const v of variants) {
			expect(hex(witnessDelegationPreimage(v))).not.toBe(baseline);
		}
	});

	it("counts UTF-8 BYTES, not code units", () => {
		// A second implementation reading "length" as code units would derive
		// different bytes for every multibyte vaultId — silent cross-language
		// divergence with no error anywhere. "é" is 1 code unit, 2 bytes.
		const a = witnessDelegationPreimage({ ...base, vaultId: "é" }) as Uint8Array;
		const b = witnessDelegationPreimage({ ...base, vaultId: "ee" }) as Uint8Array;
		expect(a).not.toBeNull();
		// Same code-unit count as "ee" is 2 — but "é" is 2 BYTES too, so the
		// discriminator is the content, and the encoded length must read 2.
		const tagLen = WITNESS_DELEGATION_TAG.length;
		expect(Buffer.from(a.slice(tagLen, tagLen + 4)).readUInt32BE()).toBe(2);
		expect(hex(a)).not.toBe(hex(b));
	});

	it("refuses rather than throws on anything it cannot encode exactly", () => {
		// Fail closed: this runs on untrusted input on the verification side,
		// where throwing out of a checking function is itself the defect.
		expect(witnessDelegationPreimage({ ...base, vaultId: "" })).toBeNull();
		expect(witnessDelegationPreimage({ ...base, witnessKeyId: "" })).toBeNull();
		expect(witnessDelegationPreimage({ ...base, delegatedByKeyId: "" })).toBeNull();
		expect(witnessDelegationPreimage({ ...base, witnessSpkiDer: Buffer.alloc(0) })).toBeNull();
		// delegationIndex is 1-based: 0 would make "no delegations" and "the
		// first delegation" indistinguishable to a contiguity check.
		expect(witnessDelegationPreimage({ ...base, delegationIndex: 0 })).toBeNull();
		expect(witnessDelegationPreimage({ ...base, delegationIndex: 1.5 })).toBeNull();
		// Beyond the safe-integer range the value cannot survive a JSON
		// round-trip, so what was signed and what is stored would differ.
		expect(witnessDelegationPreimage({ ...base, effectiveUntilAnchorSeq: 2 ** 53 })).toBeNull();
		expect(witnessDelegationPreimage({ ...base, effectiveFromAnchorSeq: -1 })).toBeNull();
		expect(witnessDelegationPreimage({ ...base, effectiveFromAnchorSeq: Number.NaN })).toBeNull();
		// An inverted range authorizes nothing and is more likely a bug than intent.
		expect(
			witnessDelegationPreimage({ ...base, effectiveFromAnchorSeq: 9, effectiveUntilAnchorSeq: 8 }),
		).toBeNull();
	});

	it("lone surrogates cannot collide onto one preimage (Codex #128 F1)", () => {
		// "\uD800" and "\uD801" are DISTINCT non-empty strings that both encode
		// to U+FFFD, so before the round-trip guard they produced identical bytes
		// and one root signature authorized two different delegations. vaultId is
		// never validated as a UUID, so it is attacker-chosen.
		expect(witnessDelegationPreimage({ ...base, vaultId: "\uD800" })).toBeNull();
		expect(witnessDelegationPreimage({ ...base, vaultId: "\uD801" })).toBeNull();
		expect(witnessDelegationPreimage({ ...base, witnessKeyId: "\uDFFF" })).toBeNull();
		expect(witnessDelegationPreimage({ ...base, delegatedByKeyId: "a\uD800b" })).toBeNull();
		// A well-formed astral pair is legitimate and must still encode.
		expect(witnessDelegationPreimage({ ...base, vaultId: "\u{1F600}" })).not.toBeNull();
	});

	it("delegationIndex above u32 returns null instead of throwing (Codex #128 F7)", () => {
		// 2**32 IS a safe integer, so the safe-integer check passed it through to
		// writeUInt32BE, which throws ERR_OUT_OF_RANGE — breaking the "returns
		// null, never throws" contract on the untrusted verification path.
		expect(Number.isSafeInteger(2 ** 32)).toBe(true);
		expect(() => witnessDelegationPreimage({ ...base, delegationIndex: 2 ** 32 })).not.toThrow();
		expect(witnessDelegationPreimage({ ...base, delegationIndex: 2 ** 32 })).toBeNull();
		// The boundary itself still encodes.
		expect(witnessDelegationPreimage({ ...base, delegationIndex: 0xff_ff_ff_ff })).not.toBeNull();
	});

	it("the open-ended sentinel survives a JSON round-trip exactly", () => {
		// 2^64-1 would not; that is why the sentinel is 2^53-1.
		const parsed = JSON.parse(JSON.stringify({ n: OPEN_ENDED_ANCHOR_SEQ })).n;
		expect(parsed).toBe(OPEN_ENDED_ANCHOR_SEQ);
		expect(Number.isSafeInteger(parsed)).toBe(true);
	});
});
