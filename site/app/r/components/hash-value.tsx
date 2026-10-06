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
 *
 * `variant="chip"` puts the truncated value INSIDE its copy chip, on one row
 * that never wraps and ellipsizes the value when the row runs out. That is the
 * card header's shape: at 360-390px the split layout wrapped, and the ID
 * floated above a "receipt ID copy" chip instead of beside it.
 */
export default function HashValue({
	value,
	label,
	head,
	tone = "dark",
	copy = true,
	variant = "split",
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
	variant?: "split" | "chip";
}) {
	const { full, display, truncated } = truncateForDisplay(value, head);
	const ink = tone === "paper" ? "text-ink" : "text-white/85";
	if (variant === "chip") {
		return (
			<span className="flex min-w-0 flex-nowrap items-center" title={full} data-hash-chip="">
				{truncated ? <span className="sr-only">{`${label}, in full: ${full}`}</span> : null}
				<CopyChip text={full} label={label} display={display} tone={tone} />
			</span>
		);
	}
	return (
		<span className="inline-flex flex-wrap items-center gap-2 align-middle">
			<code className={`font-mono text-[13px] break-all ${ink}`} title={full}>
				{display}
			</code>
			{truncated ? <span className="sr-only">{`${label}, in full: ${full}`}</span> : null}
			{copy ? <CopyChip text={full} label={label} tone={tone} /> : null}
		</span>
	);
}
