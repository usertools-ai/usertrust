/**
 * Fragment builder for the ledger ticker (Addendum O1) — the perforated
 * receipt strip that runs between the harden doctrine and the closing panel.
 *
 * Lives in sections/lib, outside the check-facts prebuild scan of
 * sections/*.tsx, for the same reason ROW_STAGGER_MS does: the prefix lengths
 * below are display geometry, not product claims, and a bare `8` in a section
 * component is exactly what that gate exists to catch.
 *
 * EVERY TOKEN A VISITOR READS ON THE STRIP COMES OUT OF A COMMITTED FIXTURE.
 * There is no authored copy here and no placeholder: `kind` is the chain
 * entry's own event type, `hash` is the head of its real chain hash, and
 * `ref` is the real TigerBeetle transfer id of the receipt that wrote the
 * entry — matched by auditHash, exactly the way exhibit A's "link N of the
 * chain" annotation is matched.
 *
 * Not every entry HAS a transfer. The published slice carries seven llm_call
 * entries and one policy_denied, while the captured receipt ledger carries
 * three receipts, so five entries have no transfer id to show. They fall back
 * to their chain LINK INDEX, which is the page's existing vocabulary for the
 * same idea and is likewise read straight off the fixture. Inventing a
 * plausible transfer id for the other five is the one thing this page exists
 * to refuse.
 */

/** Characters of a chain hash shown on the strip. */
const HASH_PREFIX_LENGTH = 8;
/** Characters of a transfer id shown on the strip — the `tx_` tag plus the
 *  time-ordered half, dropping the random suffix that would not fit anyway. */
const TX_PREFIX_LENGTH = 11;

export interface TickerEntry {
	seq: number;
	type: string;
	hash: string;
}

export interface TickerReceipt {
	transferId: string;
	auditHash: string;
}

export interface TickerFragment {
	/** Stable key — the chain hash is unique by construction. */
	key: string;
	/** The chain event's own kind, e.g. "llm_call". */
	kind: string;
	/** Transfer id prefix when this entry has a captured receipt, else "link N". */
	ref: string;
	/** Head of the chain hash, ellipsized. */
	hash: string;
}

export function hashPrefix(hash: string): string {
	return `${hash.slice(0, HASH_PREFIX_LENGTH)}…`;
}

export function txPrefix(transferId: string): string {
	return transferId.slice(0, TX_PREFIX_LENGTH);
}

/**
 * One fragment per published chain entry, in chain order.
 *
 * `receipts` is the captured ledger; an entry earns its transfer id only when
 * a captured receipt's auditHash IS this entry's hash. No fuzzy matching, no
 * positional guessing.
 */
export function tickerFragments(
	entries: TickerEntry[],
	receipts: TickerReceipt[],
): TickerFragment[] {
	const txByHash = new Map(receipts.map((r) => [r.auditHash, r.transferId]));
	return entries.map((entry) => {
		const tx = txByHash.get(entry.hash);
		return {
			key: entry.hash,
			kind: entry.type,
			ref: tx ? txPrefix(tx) : `link ${entry.seq}`,
			hash: hashPrefix(entry.hash),
		};
	});
}
