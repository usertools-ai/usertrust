/**
 * X7 — ID-decode vectors (receipt-spec §12; verify-page spec R2).
 *
 * "The character-count rule is NOT the ID rule": `16*22base58char` after
 * `ut1_` is necessary and nowhere near sufficient. A conformant route-param
 * check MUST, after matching the grammar:
 *   1. canonically DECODE the base58 to exactly 16 bytes (any other decoded
 *      length is a REJECT, not a truncation or a pad), and
 *   2. re-encode those 16 bytes and require BYTE-IDENTICAL output (rejects
 *      non-canonical encodings that would otherwise let two distinct
 *      trailer strings name one ID).
 *
 * Every `id` here is the FULL route-param string (`ut1_` + the base58
 * portion), matching what actually appears in `/r/<id>`. `expected: "valid"`
 * cases are the passing controls (R2's obligation is meaningless without
 * them) — one with no leading zero byte, one whose first raw byte IS zero
 * (canonically a leading `1` character).
 */
import type { IdVector } from "./types";

export const idVectors: IdVector[] = [
	// ---- passing controls ----
	{
		label: "valid — no leading zero byte",
		id: "ut1_Ly6eTFZPxTsdg1JgGyiY9b",
		expected: "valid",
		reason: "22 base58 chars, canonically decodes to exactly 16 bytes, re-encodes identically.",
	},
	{
		label: "valid — leading zero byte (canonical leading '1')",
		id: "ut1_13kqPrzsAKk786Be6mXdN",
		expected: "valid",
		reason:
			"The raw 16-byte value's first byte is 0x00, so the canonical base58 form starts with exactly one '1' " +
			"— the leading-zero-byte convention, not padding. 21 chars, decodes to exactly 16 bytes.",
	},

	// ---- grammar failures (necessary, never sufficient — checked before decode) ----
	{
		label: "invalid — fewer than 16 base58 characters",
		id: "ut1_Ab3xQ9wZ",
		expected: "invalid",
		reason: "9 chars after 'ut1_' — fails the 16*22 grammar; the resolver is never called.",
	},
	{
		label: "invalid — more than 22 base58 characters",
		id: "ut1_Ly6eTFZPxTsdg1JgGyiY9bXYZab",
		expected: "invalid",
		reason: "27 chars after 'ut1_' — fails the 16*22 grammar.",
	},

	// ---- within-grammar strings that still fail the decode rule ----
	{
		label: "invalid — decodes to fewer than 16 bytes",
		id: "ut1_6WBYSQCm72aEwckem3vLv",
		expected: "invalid",
		reason:
			"21 chars — within the 16*22 grammar — but the underlying value is only 15 raw bytes " +
			"(no leading zero byte). Character count alone would have accepted it; the decode rule rejects it.",
	},
	{
		label: "invalid — decodes to more than 16 bytes",
		id: "ut1_111ZNfp3ndcZGxiLV6r6TS",
		expected: "invalid",
		reason:
			"22 chars — within the 16*22 grammar — but three leading '1's encode three leading zero bytes over " +
			"a 14-byte body, i.e. 17 raw bytes total. Also the non-canonical-padding case: a lenient decoder that " +
			"just pads/truncates to 16 bytes instead of counting the leading-'1' run exactly would silently accept " +
			"this as an alias for a different, shorter-bodied ID — exactly the two-strings-one-ID hazard the " +
			"canonical decode+re-encode check exists to close.",
	},
	{
		label: "invalid — redundant leading-1 zero-byte padding",
		id: "ut1_1Ly6eTFZPxTsdg1JgGyiY9b",
		expected: "invalid",
		reason:
			"One '1' prepended to the first control's 16-byte, zero-leading-byte encoding. Under strict leading-run " +
			"counting this decodes to 17 bytes (1 padding byte + the original 16-byte body), so it fails the " +
			"exact-16-bytes rule — but a decoder that decodes the digit portion first and then left-pads to a fixed " +
			"16-byte width (ignoring how many '1's were actually present) would wrongly treat this string and the " +
			"first control as the SAME ID. This is the concrete non-canonical-encoding hazard §12 names.",
	},
	{
		label: "invalid — character outside the Bitcoin base58 alphabet",
		id: "ut1_Ly6eTFZPxTsdg0JgGyiY9b",
		expected: "invalid",
		reason:
			"Contains '0', which the Bitcoin base58 alphabet excludes (along with 'O', 'I', 'l') precisely to avoid " +
			"visual confusion with '1'/'o' — not a valid base58 character at all, so decode fails outright.",
	},
];
