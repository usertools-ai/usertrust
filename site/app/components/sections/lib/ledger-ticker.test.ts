import assert from "node:assert/strict";
import test from "node:test";
import chainSliceJson from "../../../evidence/chain-slice.json" with { type: "json" };
import receiptLedgerJson from "../../../evidence/receipt-ledger.json" with { type: "json" };
import { hashPrefix, tickerFragments, txPrefix } from "./ledger-ticker";

const slice = chainSliceJson as { entries: { seq: number; type: string; hash: string }[] };
const ledger = receiptLedgerJson as {
	captures: { receipt: { transferId: string; auditHash: string } }[];
};
const receipts = ledger.captures.map((c) => ({
	transferId: c.receipt.transferId,
	auditHash: c.receipt.auditHash,
}));

test("hashPrefix ellipsizes the head of a chain hash", () => {
	assert.equal(hashPrefix("f4a15bc63fc64bcdab2dcca67718d6a8"), "f4a15bc6…");
});

test("txPrefix drops the transfer id's random suffix", () => {
	assert.equal(txPrefix("tx_msm19wxa_a107246b"), "tx_msm19wxa");
});

test("an entry with a captured receipt shows that receipt's real transfer id", () => {
	const fragments = tickerFragments(
		[{ seq: 1, type: "llm_call", hash: "abc123def456" }],
		[{ transferId: "tx_deadbeef_9999", auditHash: "abc123def456" }],
	);
	assert.equal(fragments[0].ref, txPrefix("tx_deadbeef_9999"));
	assert.equal(fragments[0].kind, "llm_call");
	assert.equal(fragments[0].hash, "abc123de…");
});

test("an entry with no captured receipt falls back to its chain link index", () => {
	const fragments = tickerFragments([{ seq: 7, type: "policy_denied", hash: "0f0f0f0f0f0f" }], []);
	assert.equal(fragments[0].ref, "link 7");
});

test("matching is by auditHash identity — never positional", () => {
	const fragments = tickerFragments(
		[
			{ seq: 1, type: "llm_call", hash: "aaaaaaaaaaaa" },
			{ seq: 2, type: "llm_call", hash: "bbbbbbbbbbbb" },
		],
		// The receipt belongs to entry TWO; a positional join would mislabel both.
		[{ transferId: "tx_second_0001", auditHash: "bbbbbbbbbbbb" }],
	);
	assert.equal(fragments[0].ref, "link 1");
	assert.equal(fragments[1].ref, txPrefix("tx_second_0001"));
});

test("every fragment token is present in the committed fixtures — no authored copy", () => {
	const fragments = tickerFragments(slice.entries, receipts);
	assert.equal(fragments.length, slice.entries.length);
	const txs = new Set(receipts.map((r) => txPrefix(r.transferId)));
	for (const [i, f] of fragments.entries()) {
		const entry = slice.entries[i];
		assert.equal(f.kind, entry.type);
		assert.ok(entry.hash.startsWith(f.hash.replace("…", "")));
		assert.ok(
			txs.has(f.ref) || f.ref === `link ${entry.seq}`,
			`fragment ${i} ref "${f.ref}" is neither a captured transfer id nor this entry's link index`,
		);
	}
});

test("the real slice yields both fragment shapes — captured and link-only", () => {
	const fragments = tickerFragments(slice.entries, receipts);
	assert.ok(fragments.some((f) => f.ref.startsWith("tx_")));
	assert.ok(fragments.some((f) => f.ref.startsWith("link ")));
});
