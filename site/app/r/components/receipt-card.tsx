import type { ReceiptCardModel } from "../lib/card-model";
import {
	ANCHOR_BINDING_RESOLVER_ASSERTED,
	CHAIN_CLOCK_CLAIM_LABEL,
	CHAIN_CLOCK_CLAIM_NOTE,
	CUSTOM_MODEL_MEANING,
	LADDER,
	MINTED_AT_LABEL,
	MINTED_AT_NOTE,
	PLAIN_VERDICT_VERIFIED,
	PROOF_ID_IS_A_HANDLE,
	REPO_NAME_IS_NOT_SCOPE,
	type ReceiptClaims,
	RUNG_EARNED_BY,
	RUNG_SHORT_NAME,
	rungDisclaimers,
	TRAILER_CITES_GENERATION_ONE,
	UNDISCLOSED_PRIVATE_REPO,
} from "../lib/claims";
import type { LadderStatus, ReceiptDocument } from "../lib/wire";
import HashValue from "./hash-value";
import PostureChips, { AmountScope, ScopeChip, SessionHeadlineScope } from "./posture-chips";

/**
 * The receipt is a glance: the verdict, the amount, what it covers, when, and
 * a short ID. Everything else (the ladder's reasoning, the postures, the check
 * ledger, the CLI command) is in {@link ReceiptDetails}, folded behind ONE
 * "Details" disclosure by the page. Nothing was removed; it moved.
 *
 * What the glance carries of the spec's honesty rules (amended 2026-10-05, see
 * `docs/specs/receipt-amount-framing.md`): the amount's posture LABEL as one
 * chip beside the figure (R38), and a level strip whose anchored level says
 * "resolver-asserted" (R41). The full R38-R41 sentences and R6-R8's verbatim
 * disclaimers are in the Details, one disclosure away.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-08-10T14:00:00.000Z` and its end, as "Aug 10 · 14:00–14:12 UTC". Falls back to the raw values. */
export function timeSpan(startedAt: string, endedAt: string): string {
	const a = new Date(startedAt);
	const b = new Date(endedAt);
	if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${startedAt} → ${endedAt}`;
	// A span across a year boundary names both years; "same day" is the full UTC date.
	const crossesYear = a.getUTCFullYear() !== b.getUTCFullYear();
	const day = (d: Date) =>
		`${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${crossesYear ? `, ${d.getUTCFullYear()}` : ""}`;
	const clock = (d: Date) =>
		`${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
	return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
		? `${day(a)} · ${clock(a)}–${clock(b)} UTC`
		: `${day(a)} ${clock(a)} → ${day(b)} ${clock(b)} UTC`;
}

/** "1 commit · 4 transfers · claude-sonnet-4-6" — what the receipt covers, in one line. */
export function coversLine(claims: ReceiptClaims): string {
	const { work, models } = claims;
	const unit =
		work.kind === "commit"
			? "1 commit"
			: work.kind === "session"
				? "1 session"
				: work.kind === "pr"
					? `PR #${work.number}`
					: `Issue #${work.number}`;
	const n = claims.projection.spend.transferCount;
	const names = [...models.catalog];
	const shown = names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
	return [
		unit,
		`${n} transfer${n === 1 ? "" : "s"}`,
		shown ?? (models.hasCustom ? "custom model" : undefined),
	]
		.filter((x): x is string => x !== undefined)
		.join(" · ");
}

export default function ReceiptCard({
	model,
	claims,
	receipt,
	rung,
}: {
	model: ReceiptCardModel;
	claims: ReceiptClaims;
	receipt: ReceiptDocument;
	rung: LadderStatus;
}) {
	const projection = receipt.event.data;
	const reachedIndex = LADDER.indexOf(rung);

	return (
		<div data-testid="receipt-card">
			<section className="ut-card" data-testid="receipt-card-body">
				<header className="flex items-center gap-2.5 border-b border-white/[0.09] bg-white/[0.03] px-6 py-3.5">
					<span className="size-[7px] shrink-0 rounded-full bg-ut shadow-[0_0_0_3px_rgba(48,209,88,0.16)]" />
					<span className="text-[13px] font-semibold tracking-tight text-ut">Receipt</span>
					<span className="ml-auto font-mono text-[12.5px]" data-testid="receipt-short-id">
						<HashValue value={model.receiptId} label="receipt ID" head={10} />
					</span>
				</header>

				<div className="flex flex-col gap-5 px-6 pt-6 pb-6">
					<div className="flex flex-col gap-2">
						<h1
							className="text-[34px] leading-none font-bold tracking-[-0.03em] text-ut"
							data-testid="verdict"
						>
							{PLAIN_VERDICT_VERIFIED}
						</h1>
						<ol
							className="ut-levels m-0 list-none p-0"
							aria-label="verification level"
							data-testid="levels"
						>
							{LADDER.map((step, index) => {
								const state =
									index === reachedIndex ? "reached" : index < reachedIndex ? "cleared" : "above";
								return (
									<li
										key={step}
										data-rung={step}
										data-rung-state={state}
										className={`text-[13px] ${state === "above" ? "text-paper/38" : "text-paper"}`}
									>
										<span className={state === "above" ? "" : "text-ut"}>
											{state === "above" ? "○" : "✓"}
										</span>{" "}
										{RUNG_SHORT_NAME[step].toLowerCase()}
										{step === "verified_anchored" ? " · resolver-asserted" : ""}
									</li>
								);
							})}
						</ol>
					</div>

					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<div
							className="font-mono text-[44px] leading-none font-semibold tracking-[-0.04em] text-paper"
							data-testid="amount-usd"
						>
							${model.amountUsd}
						</div>
						<ScopeChip claims={claims} />
					</div>

					<dl className="m-0 flex flex-col gap-1 text-[13.5px]" data-testid="glance-facts">
						<div className="flex justify-between gap-4">
							<dt className="text-paper/38">Covers</dt>
							<dd className="m-0 text-right text-paper" data-testid="covers">
								{coversLine(claims)}
							</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="text-paper/38">When</dt>
							<dd className="m-0 text-right text-paper" data-testid="time-span">
								{timeSpan(projection.startedAt, projection.endedAt)}
							</dd>
						</div>
					</dl>
				</div>
			</section>
		</div>
	);
}

/** Everything that is not the glance, for the page's single Details disclosure. */
export function ReceiptDetails({
	model,
	claims,
	receipt,
	rung,
}: {
	model: ReceiptCardModel;
	claims: ReceiptClaims;
	receipt: ReceiptDocument;
	rung: LadderStatus;
}) {
	const { repo, transfers, work } = claims;
	const projection = receipt.event.data;

	return (
		<div className="flex flex-col gap-6" data-testid="receipt-details">
			<div>
				<p className="mb-2.5 text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">
					Action
				</p>
				<h2 className="mb-2 text-[24px] leading-[1.22] font-semibold tracking-[-0.028em] text-paper/70">
					{model.action.parts.map((part) =>
						part.kind === "hash" ? (
							<span key={part.full} className="text-paper">
								<HashValue value={part.full} label={part.label} head={part.head} />
							</span>
						) : part.emphasis ? (
							<span key={part.text} className="text-paper">
								{part.text}
							</span>
						) : (
							<span key={part.text}>{part.text}</span>
						),
					)}
				</h2>
				<p className="m-0 text-[13.5px] text-paper/62">{model.action.byline}</p>
				{work.kind === "session" ? (
					<div className="mt-3 rounded-[var(--r-row)] border border-[var(--line)] bg-white/[0.03] p-3 text-ink">
						<SessionHeadlineScope claims={claims} tone="paper" />
					</div>
				) : null}
				{claims.predecessor !== undefined ? (
					<p className="mt-2 text-[13px] text-paper/62" data-testid="predecessor-linkage">
						{claims.predecessor}. {TRAILER_CITES_GENERATION_ONE}
					</p>
				) : null}
				<p className="mt-2 text-[13px] text-paper/62">
					<span data-repo-label={repo.undisclosed ? "undisclosed" : "disclosed"}>
						{repo.undisclosed ? UNDISCLOSED_PRIVATE_REPO : (repo.displayName ?? repo.repoId)}
					</span>
					{" — "}
					{REPO_NAME_IS_NOT_SCOPE}
				</p>
				{claims.membership !== undefined ? (
					<p className="mt-2 text-[13px] text-paper/62" data-membership={claims.membership.status}>
						{claims.membership.status} · {PROOF_ID_IS_A_HANDLE}
					</p>
				) : null}
				{claims.fallbackOrigin !== undefined ? (
					<p className="mt-2 text-[13px] text-paper/62">
						{claims.fallbackOrigin.note}{" "}
						<a
							className="ut-link font-mono"
							href={`/r/${claims.fallbackOrigin.sourceReservationReceiptId}`}
						>
							{claims.fallbackOrigin.sourceReservationReceiptId}
						</a>
					</p>
				) : null}
				<p className="mt-2 font-mono text-xs text-paper/38">{model.publicUrl}</p>
			</div>

			{model.authority.length > 0 ? (
				<div className="rounded-[var(--r-row)] border border-white/[0.09] bg-white/[0.03] px-4 py-3.5">
					<div className="mb-2.5 text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">
						Authority
					</div>
					{model.authority.map((row) => (
						<div
							key={row.label}
							className="flex justify-between gap-4 py-1 text-[13px]"
							data-authority={row.label}
						>
							<span className="text-paper/62">{row.label}</span>
							<span className="text-right font-mono text-xs text-paper">{row.value}</span>
						</div>
					))}
				</div>
			) : null}

			<div>
				<p className="mb-2.5 text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">
					Proven
				</p>
				<ul className="m-0 list-none p-0">
					{model.rungs.map((item) => {
						const pending = item.state === "pending";
						return (
							<li
								key={item.id}
								className={`flex flex-col gap-1 border-b border-white/[0.09] py-2.5 last:border-b-0 last:pb-0 ${
									pending ? "text-paper/38" : ""
								}`}
								data-proof={item.id}
								{...(item.specRung === undefined
									? {}
									: { "data-rung": item.specRung, "data-rung-state": item.specState })}
							>
								<div className="flex items-baseline gap-3">
									<span
										className={`w-3.5 shrink-0 text-center font-mono text-xs ${
											pending ? "text-paper/38" : "text-ut"
										}`}
									>
										{pending ? "○" : "✓"}
									</span>
									<span
										className={`min-w-0 flex-1 text-[14.5px] tracking-tight ${
											pending ? "font-normal" : "font-medium"
										}`}
									>
										{item.label}
										<small className="float-right font-mono text-xs font-normal text-paper/38">
											{item.detail}
										</small>
									</span>
								</div>
								{item.specRung !== undefined && item.specState === "above" ? (
									<p className="ml-[26px] text-[13px] leading-relaxed text-paper/62">
										earned by: {RUNG_EARNED_BY[item.specRung]}
									</p>
								) : null}
								{item.specRung === "verified_anchored" ? (
									<p
										className="ml-[26px] text-[13px] leading-relaxed text-paper/62"
										data-testid="anchor-binding-disclosure"
										data-anchor-binding="resolver-asserted"
									>
										{ANCHOR_BINDING_RESOLVER_ASSERTED}
									</p>
								) : null}
							</li>
						);
					})}
				</ul>
				<div
					data-testid="rung-disclaimers"
					className="mt-4 flex flex-col gap-2 border-l-2 border-ut/30 pl-4"
				>
					{rungDisclaimers(rung).map((line) => (
						<p key={line} className="text-[13px] leading-relaxed text-paper/62">
							{line}
						</p>
					))}
				</div>
			</div>

			<div className="flex flex-col gap-3">
				<h3 className="text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">Invoice</h3>
				<div className="rounded-[var(--r-row)] border border-[var(--line)] bg-white/[0.03] p-4 text-ink">
					<AmountScope claims={claims} />
					<div className="mt-4">
						<PostureChips claims={claims} />
					</div>
					{claims.models.hasCustom ? (
						<p className="mt-3 font-mono text-xs text-ink/70" data-custom-literal="">
							custom — {CUSTOM_MODEL_MEANING}
						</p>
					) : null}
					<p className="mt-3 text-[13px] text-ink/70">
						<span data-transfer-set={transfers.rootIsCommitment ? "commitment" : "list"}>
							transfer-set root
						</span>
						{" — "}
						{transfers.rootMeaning}
					</p>
					<div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="timestamps">
						<div data-clock-claim="minter-asserted" className="flex flex-col gap-1">
							<span className="font-mono text-xs uppercase tracking-[0.12em] text-paper-amber">
								mintedAt — {MINTED_AT_LABEL}
							</span>
							<span className="font-mono text-[13px]">{receipt.mintedAt}</span>
							<span className="text-xs leading-relaxed text-ink/70">{MINTED_AT_NOTE}</span>
						</div>
						<div data-clock-claim="chain-committed" className="flex flex-col gap-1">
							<span className="font-mono text-xs uppercase tracking-[0.12em] text-paper-steel">
								startedAt / endedAt — {CHAIN_CLOCK_CLAIM_LABEL}
							</span>
							<span className="font-mono text-[13px]">
								{projection.startedAt} → {projection.endedAt}
							</span>
							<span className="text-xs leading-relaxed text-ink/70">{CHAIN_CLOCK_CLAIM_NOTE}</span>
						</div>
					</div>
				</div>
				<div className="border-t border-dashed border-white/14 pt-3">
					{model.lines.map((line) => (
						<div
							key={line.label}
							className={`flex justify-between gap-3.5 py-1 text-[13px] ${
								line.kind === "total" ? "mt-2 border-t border-white/14 pt-2.5 font-semibold" : ""
							}`}
							data-invoice={line.label}
						>
							<span className="text-paper/62">{line.label}</span>
							<span className="font-mono text-[12.5px] text-paper">{line.value}</span>
						</div>
					))}
				</div>
			</div>

			<pre
				className="overflow-x-auto rounded-lg border border-white/[0.09] bg-black/40 px-3.5 py-3 font-mono text-xs whitespace-pre text-paper/62"
				data-testid="verify-command"
			>
				npx <span className="font-normal text-paper">usertrust-verify</span> receipt{" "}
				{model.receiptId}.json --trust {"<snapshot.json>"}
			</pre>
		</div>
	);
}
