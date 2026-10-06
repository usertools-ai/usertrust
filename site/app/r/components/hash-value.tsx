import CopyChip from "../../components/copy-chip";
import { truncateForDisplay } from "../lib/claims";

/**
 * R17 — "a display may truncate, the projection never does" (receipt-spec §2).
 *
 * Every long opaque value on this page (oid, objectSha256, event hashes, roots,
 * signatures, receipt IDs) renders through here, so the truncation rule is
 * implemented ONCE and cannot drift field by field. Three things travel with
 * every truncated value, and the honesty of the page rests on all three:
 *
 *   1. the visible truncated head, so the layout stays readable;
 *   2. the FULL value in the accessible name (`title` + an `sr-only` span) — a
 *      screen reader and a hover both get the projection's real value, never
 *      the display's abbreviation;
 *   3. a copy affordance carrying the full value, which is what "one
 *      interaction away" means in §2's own words.
 *
 * `tone` picks the ink: `paper` for anything inside `ReceiptPaper` (the bright
 * dark-ground accents are FORBIDDEN as text on paper — globals.css), `dark`
 * everywhere else.
 */
export default function HashValue({
	value,
	label,
	head,
	tone = "dark",
	copy = true,
	compact = false,
}: {
	value: string;
	/** What this value IS — used as the copy affordance's accessible label. */
	label: string;
	head?: number;
	tone?: "dark" | "paper";
	/**
	 * Set `false` for values short enough to render whole (a `segmentId`, a
	 * `keyId`): a copy chip beside a value already fully on screen is noise, and
	 * R17's obligation is discharged by the value being there at all.
	 */
	copy?: boolean;
	/**
	 * For a header row: the value and its chip on ONE line at any width. The
	 * value ellipsizes rather than wrapping above its chip, and the chip drops
	 * its label text on narrow screens (its accessible name keeps it). The full
	 * value stays in the title, the screen-reader text and the copy.
	 */
	compact?: boolean;
}) {
	const { full, display, truncated } = truncateForDisplay(value, head);
	const ink = tone === "paper" ? "text-ink" : "text-white/85";
	return (
		<span
			className={`inline-flex items-center gap-2 align-middle ${compact ? "min-w-0 flex-nowrap" : "flex-wrap"}`}
		>
			<code
				className={`font-mono text-[13px] ${compact ? "min-w-0 truncate" : "break-all"} ${ink}`}
				title={full}
			>
				{display}
			</code>
			{truncated ? <span className="sr-only">{`${label}, in full: ${full}`}</span> : null}
			{copy ? <CopyChip text={full} label={label} tone={tone} compact={compact} /> : null}
		</span>
	);
}
