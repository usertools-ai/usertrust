import type { ReceiptCardModel } from "../lib/card-model";

/**
 * The visitor receipt — action on the stage, invoice beneath, header names
 * the artifact type rather than the rung. Visual source:
 * `usertools-stealth/docs/specs/receipt-page/receipts-both.html`.
 *
 * Every string on this card is derived in `card-model.ts` from the chain-
 * committed projection or the resolver's own verification results. The paper
 * artifact, check ledger, and work-claims stay below: this is the reading
 * order the audit motion wants, not a replacement of the honesty surface.
 */
export default function ReceiptCard({ model }: { model: ReceiptCardModel }) {
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
							part.emphasis ? (
								<span key={part.text} className="text-ut">
									{part.text}
								</span>
							) : (
								<span key={part.text}>{part.text}</span>
							),
						)}
					</h2>
					<p className="m-0 text-[13.5px] text-paper/62">{model.action.byline}</p>

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
						{model.rungs.map((rung) => {
							const pending = rung.state === "pending";
							return (
								<li
									key={rung.id}
									className={`flex items-baseline gap-3 border-b border-white/[0.09] py-2.5 last:border-b-0 last:pb-0 ${
										pending ? "text-paper/38" : ""
									}`}
									data-proof={rung.id}
								>
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
										{rung.label}
										<small className="float-right font-mono text-xs font-normal text-paper/38">
											{rung.detail}
										</small>
									</span>
								</li>
							);
						})}
					</ul>
				</div>

				<div className="border-t border-white/14 bg-[#0c0c22] px-6 pt-[22px] pb-6 shadow-[inset_0_12px_24px_-14px_rgba(0,0,0,0.75)]">
					<h3 className="mb-3 text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">
						Invoice
					</h3>
					<div
						className="font-mono text-[50px] leading-none font-semibold tracking-[-0.04em] text-paper"
						data-testid="card-amount"
					>
						${model.amountUsd}
					</div>
					<p className="mt-2.5 text-[13px] text-paper/62" data-testid="card-amount-caption">
						{model.amountCaption}
					</p>
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
						{model.receiptId}.json
					</pre>
				</div>
			</section>
		</div>
	);
}
