import type { CapturedReceipt } from "@/evidence/types";
import { formatTimestamp, formatUsertokens, truncateHash, usdFromUsertokens } from "./format";

function Row({
	field,
	label,
	value,
	highlight,
}: {
	field: string;
	label: string;
	value: string;
	highlight: boolean;
}) {
	return (
		<div
			data-field={field}
			className={`flex items-baseline gap-2 font-mono text-xs leading-6 text-ink ${
				highlight ? "receipt-row-highlight" : ""
			}`}
		>
			<span className="shrink-0 uppercase tracking-wider text-ink/70">{label}</span>
			<span aria-hidden="true" className="dotted-leader" />
			<span className="shrink-0 tabular-nums">{value}</span>
		</div>
	);
}

/**
 * The captured receipt's fields as mono rows with dotted leaders.
 * SERVER component. Rows carry data-field for the Exhibit A annotation layer;
 * `highlightField` marks one row with the steel highlight treatment.
 */
export default function ReceiptFields({
	receipt,
	highlightField,
}: {
	receipt: CapturedReceipt;
	highlightField?: string;
}) {
	const r = receipt.receipt;
	const settledClasses = r.settled
		? "border-paper-emerald text-paper-emerald"
		: "border-paper-amber text-paper-amber";
	return (
		<div>
			<Row
				field="transferId"
				label="transfer"
				value={r.transferId}
				highlight={highlightField === "transferId"}
			/>
			<Row field="model" label="model" value={r.model} highlight={highlightField === "model"} />
			<Row
				field="provider"
				label="provider"
				value={r.provider}
				highlight={highlightField === "provider"}
			/>
			<Row
				field="cost"
				label="cost est"
				value={formatUsertokens(r.cost.estimated)}
				highlight={highlightField === "cost"}
			/>
			<Row
				field="costActual"
				label="cost actual"
				value={
					r.cost.actual === null
						? "—"
						: `${formatUsertokens(r.cost.actual)} (${usdFromUsertokens(r.cost.actual)})`
				}
				highlight={highlightField === "costActual"}
			/>
			<Row
				field="budgetRemaining"
				label="budget left"
				value={formatUsertokens(r.budgetRemaining)}
				highlight={highlightField === "budgetRemaining"}
			/>
			<Row
				field="auditHash"
				label="audit"
				value={truncateHash(r.auditHash)}
				highlight={highlightField === "auditHash"}
			/>
			<Row
				field="timestamp"
				label="date"
				value={formatTimestamp(r.timestamp)}
				highlight={highlightField === "timestamp"}
			/>
			<div
				data-field="settled"
				className={`mt-4 border-y-2 py-1.5 text-center font-mono text-xs font-bold tracking-[0.3em] ${settledClasses} ${
					highlightField === "settled" ? "receipt-row-highlight" : ""
				}`}
			>
				{r.settled ? "SETTLED" : "PENDING"}
			</div>
		</div>
	);
}
