import type { ReceiptCardModel } from "../lib/card-model";
import {
	ANCHOR_BINDING_RESOLVER_ASSERTED,
	CHAIN_CLOCK_CLAIM_LABEL,
	CHAIN_CLOCK_CLAIM_NOTE,
	CUSTOM_MODEL_MEANING,
	MINTED_AT_LABEL,
	MINTED_AT_NOTE,
	PROOF_ID_IS_A_HANDLE,
	REPO_NAME_IS_NOT_SCOPE,
	type ReceiptClaims,
	RUNG_EARNED_BY,
	rungDisclaimers,
	TRAILER_CITES_GENERATION_ONE,
	UNDISCLOSED_PRIVATE_REPO,
} from "../lib/claims";
import type { LadderStatus, ReceiptDocument } from "../lib/wire";
import HashValue from "./hash-value";
import PostureChips, { AmountScope, SessionHeadlineScope } from "./posture-chips";

/**
 * The visitor receipt is the page. Action on the stage, invoice beneath,
 * header names the artifact type. Honesty-critical copy that used to live
 * on the §6 masthead and thermal paper lives here now — the stacked exhibit
 * is gone, not hidden.
 */
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
	const { repo, transfers, work } = claims;
	const projection = receipt.event.data;

	return (
		<div className="flex flex-col gap-4" data-testid="receipt-card">
			<a
				href="/"
				className="inline-flex min-h-[44px] w-fit items-center rounded-full border border-white/20 bg-white/[0.012] px-4 py-2.5 text-sm font-medium tracking-tight text-paper/85 shadow-[0_1px_0_rgba(255,255,255,0.05)_inset,0_1px_2px_rgba(0,0,0,0.35),0_6px_16px_rgba(0,0,0,0.28)] transition-all duration-300 hover:-translate-y-px hover:border-ut/50 hover:bg-ut/[0.055] hover:text-ut"
			>
				usertrust
			</a>

			<section
				className="overflow-hidden rounded-2xl border border-white/14 bg-[#10101f] shadow-[inset_0_1px_0_rgba(255,255,255,0.055),0_1px_2px_rgba(0,0,0,0.5),0_8px_20px_rgba(0,0,0,0.42),0_28px_64px_rgba(0,0,0,0.5)]"
				data-testid="receipt-card-body"
			>
				<header className="flex items-center gap-2.5 border-b border-white/[0.09] bg-[#0c0c22] px-6 py-3.5">
					<span className="size-[7px] shrink-0 rounded-full bg-ut shadow-[0_0_0_3px_rgba(52,211,153,0.14)]" />
					<span className="text-[13px] font-semibold tracking-tight text-ut">Receipt</span>
					<span className="font-mono text-[12.5px] text-paper/60">{model.receiptIdShort}</span>
					<span className="ml-auto font-mono text-xs text-paper/38">{model.publicUrl}</span>
				</header>

				<div className="px-6 pt-7 pb-6">
					<p className="mb-2.5 text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">
						Action
					</p>
					<h2 className="mb-2 text-[29px] leading-[1.22] font-semibold tracking-[-0.028em] text-paper">
						{model.action.parts.map((part) =>
							part.kind === "hash" ? (
								<span key={part.full} className="text-ut">
									<HashValue value={part.full} label={part.label} head={part.head} />
								</span>
							) : part.emphasis ? (
								<span key={part.text} className="text-ut">
									{part.text}
								</span>
							) : (
								<span key={part.text}>{part.text}</span>
							),
						)}
					</h2>
					<p className="m-0 text-[13.5px] text-paper/62">{model.action.byline}</p>
					{work.kind === "session" ? (
						<div className="mt-3 rounded-[10px] bg-paper p-3 text-ink">
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
						<p
							className="mt-2 text-[13px] text-paper/62"
							data-membership={claims.membership.status}
						>
							{claims.membership.status} · {PROOF_ID_IS_A_HANDLE}
						</p>
					) : null}
					{claims.fallbackOrigin !== undefined ? (
						<p className="mt-2 text-[13px] text-paper/62">
							{claims.fallbackOrigin.note}{" "}
							<a
								className="font-mono text-ut underline decoration-ut/40 underline-offset-2"
								href={`/r/${claims.fallbackOrigin.sourceReservationReceiptId}`}
							>
								{claims.fallbackOrigin.sourceReservationReceiptId}
							</a>
						</p>
					) : null}

					{model.authority.length > 0 ? (
						<div className="mt-[22px] rounded-[10px] border border-white/[0.09] bg-[#0c0c22] px-4 py-3.5">
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

					<p className="mt-6 mb-2.5 text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">
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

				<div className="border-t border-white/14 bg-[#0c0c22] px-6 pt-[22px] pb-6 shadow-[inset_0_12px_24px_-14px_rgba(0,0,0,0.75)]">
					<h3 className="mb-3 text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">
						Invoice
					</h3>
					<div
						className="font-mono text-[50px] leading-none font-semibold tracking-[-0.04em] text-paper"
						data-testid="amount-usd"
					>
						${model.amountUsd}
					</div>
					<div className="mt-4 rounded-[10px] bg-paper p-4 text-ink">
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
								<span className="text-xs leading-relaxed text-ink/70">
									{CHAIN_CLOCK_CLAIM_NOTE}
								</span>
							</div>
						</div>
					</div>
					<div className="mt-[18px] border-t border-dashed border-white/14 pt-3">
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

				<div className="border-t border-white/[0.09] px-6 py-[18px] pb-6">
					<pre
						className="overflow-x-auto rounded-lg border border-white/[0.09] bg-[#07071a] px-3.5 py-3 font-mono text-xs whitespace-pre text-paper/62"
						data-testid="verify-command"
					>
						npx <span className="font-normal text-ut">usertrust-verify</span> receipt{" "}
						{model.receiptId}.json --trust {"<snapshot.json>"}
					</pre>
				</div>
			</section>
		</div>
	);
}
