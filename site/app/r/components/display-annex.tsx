import {
	BREAKDOWN_ROWS_NOTE,
	CHAIN_COMMITTED_SPEND_FIELDS,
	DISPLAY_ANNEX_LABEL,
	DISPLAY_NOT_ATTESTED,
	EXECUTION_METADATA_NOTE,
	PRICING_TABLES_NOTE,
	RECOMPUTE_IS_RESOLVER_ONLINE_CHECK,
} from "../lib/claims";
import { type Bag, bagList, bool, isBag, num, str, stringList } from "../lib/unsigned-reads";
import type { Display } from "../lib/wire";
import HashValue from "./hash-value";

/**
 * §6.5 / R28-R31 — the display annex: the unsigned envelope's material, in a
 * visually SUBORDINATE section under an explicit not-chain-committed label.
 *
 * The label is the requirement — "consumers MUST NOT treat `display` content as
 * attested, the page MUST label it" (§10.1) — and the visual voice is the other
 * half of it. Nothing here shares the chain-committed fields' treatment: no
 * paper, no emerald, no display voice; a dashed border, muted ink, and a header
 * that says what this section is NOT. The reader's rule from the paper above
 * ("if it is on the paper, the chain committed it") only holds if this section
 * is unmistakably not the paper.
 *
 * The `A + roundingAdjustment` recompute is rendered as the RESOLVER'S online
 * check (R29), never as a verifier verdict — a `packages/verify` run neither
 * has these rows nor needs them.
 *
 * `display` is the UNSIGNED member par excellence: `wire.ts` validates the
 * container and nothing inside it, because R10 forbids unsigned material from
 * demoting a sound receipt. Every field below is therefore read defensively
 * (`lib/unsigned-reads.ts`) — a row, hash or flag whose shape this component
 * does not recognize is dropped, never rendered as `[object Object]` and never
 * thrown mid-render.
 */

/** One breakdown row, narrowed to the four renderable cells (R29). */
interface BreakdownRow {
	key: string;
	provider: string;
	model: string;
	tier: string;
	usertokens: string;
}

function breakdownRows(value: unknown): BreakdownRow[] {
	return bagList(value).map((row, index) => {
		const usertokens = num(row, "usertokens");
		return {
			key: `${str(row, "provider") ?? "?"}/${str(row, "model") ?? "?"}/${str(row, "tier") ?? "?"}/${index}`,
			provider: str(row, "provider") ?? "—",
			model: str(row, "model") ?? "—",
			tier: str(row, "tier") ?? "—",
			usertokens: usertokens === undefined ? "—" : String(usertokens),
		};
	});
}

/** R29's resolver recompute — rendered only when all three legs are readable. */
function recomputeLine(value: unknown): string | undefined {
	if (!isBag(value)) return undefined;
	const a = num(value, "a");
	const adjustment = num(value, "roundingAdjustment");
	const total = num(value, "total");
	if (a === undefined || adjustment === undefined || total === undefined) return undefined;
	return `${a} + ${adjustment} = ${total}`;
}

/** R31 — `agent` / `interactive` are booleans; anything else is not a flag. */
function executionFlags(value: unknown): string | undefined {
	if (!isBag(value)) return undefined;
	const parts: string[] = [];
	const agent = bool(value, "agent");
	const interactive = bool(value, "interactive");
	if (agent !== undefined) parts.push(`agent ${agent}`);
	if (interactive !== undefined) parts.push(`interactive ${interactive}`);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export default function DisplayAnnex({ display }: { display?: Display }) {
	if (!isBag(display)) return null;
	const served = display as Bag;
	const rows = breakdownRows(served.spendBreakdown);
	const recompute = recomputeLine(served.recomputedTotal);
	const pricingTables = isBag(served.pricingTables) ? served.pricingTables : undefined;
	const pricingHashes = pricingTables ? stringList(pricingTables.hashes) : [];
	const pricingDeployment = pricingTables ? str(pricingTables, "pricingDeployment") : undefined;
	const execution = executionFlags(served.execution);
	if (
		rows.length === 0 &&
		recompute === undefined &&
		pricingHashes.length === 0 &&
		pricingDeployment === undefined &&
		execution === undefined
	) {
		return null;
	}

	return (
		<section
			data-testid="display-annex"
			className="rounded-xl border border-dashed border-white/20 bg-transparent"
		>
			<div className="flex h-9 items-center border-b border-dashed border-white/20 px-4 font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
				{DISPLAY_ANNEX_LABEL}
			</div>

			<div className="flex flex-col gap-5 p-4">
				<p className="text-[13px] leading-relaxed text-white/70">{DISPLAY_NOT_ATTESTED}</p>
				<p className="text-[13px] leading-relaxed text-white/70">{CHAIN_COMMITTED_SPEND_FIELDS}</p>

				{rows.length > 0 ? (
					<div className="flex flex-col gap-2" data-testid="spend-breakdown">
						<p className="text-[13px] leading-relaxed text-white/70">{BREAKDOWN_ROWS_NOTE}</p>
						<div className="overflow-x-auto">
							<table className="w-full border-collapse text-left">
								<caption className="sr-only">
									per provider/model/tier spend rows — display data, not chain-committed
								</caption>
								<thead>
									<tr className="border-b border-white/[0.06]">
										{["provider", "model", "tier", "usertokens"].map((heading) => (
											<th
												key={heading}
												scope="col"
												className="px-3 py-2 font-mono text-[12px] font-normal uppercase tracking-[0.12em] text-white/70"
											>
												{heading}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{rows.map((row) => (
										<tr key={row.key} className="border-b border-white/[0.04]">
											<td className="px-3 py-2 font-mono text-[13px] text-white/70">
												{row.provider}
											</td>
											<td className="px-3 py-2 font-mono text-[13px] text-white/70">{row.model}</td>
											<td className="px-3 py-2 font-mono text-[13px] text-white/70">{row.tier}</td>
											<td className="px-3 py-2 font-mono text-[13px] text-white/70">
												{row.usertokens}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				) : null}

				{recompute ? (
					<div className="flex flex-col gap-1" data-testid="recomputed-total">
						<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
							resolver recompute
						</span>
						<span className="font-mono text-[13px] text-white/70">{recompute}</span>
						<p className="text-[13px] leading-relaxed text-white/70">
							{RECOMPUTE_IS_RESOLVER_ONLINE_CHECK}
						</p>
					</div>
				) : null}

				{pricingHashes.length > 0 || pricingDeployment !== undefined ? (
					<div className="flex flex-col gap-1" data-testid="pricing-tables">
						<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
							pricing tables
						</span>
						<ul className="flex flex-col gap-1">
							{pricingHashes.map((hash) => (
								<li key={hash}>
									<HashValue value={hash} label="pricing table content hash" head={20} />
								</li>
							))}
						</ul>
						{pricingDeployment ? (
							<span className="font-mono text-[13px] text-white/70">
								pricingDeployment {pricingDeployment}
							</span>
						) : null}
						<p className="text-[13px] leading-relaxed text-white/70">{PRICING_TABLES_NOTE}</p>
					</div>
				) : null}

				{execution ? (
					<div className="flex flex-col gap-1" data-testid="execution-metadata">
						<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
							execution
						</span>
						<span className="font-mono text-[13px] text-white/70">{execution}</span>
						<p className="text-[13px] leading-relaxed text-white/70">{EXECUTION_METADATA_NOTE}</p>
					</div>
				) : null}
			</div>
		</section>
	);
}
