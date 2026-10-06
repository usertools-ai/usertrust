import { Fragment } from "react";
import { proofRungs } from "../lib/card-model";
import {
	ANCHOR_BINDING_RESOLVER_ASSERTED,
	CHAIN_CLOCK_CLAIM_LABEL,
	CUSTOM_MODEL_MEANING,
	LADDER,
	MINTED_AT_LABEL,
	MINTED_AT_NOTE,
	NEVER_ARTIFACT_VERIFIED,
	PLAIN_VERDICT_VERIFIED,
	RUNG_EARNED_BY,
	RUNG_SHORT_NAME,
	rungDisclaimers,
} from "../lib/claims";
import {
	CLUSTER_COMPLETENESS_TRUST,
	CLUSTER_LEDGER_ROWS,
	CLUSTER_OFFLINE_VERIFIER_PENDING,
	CLUSTER_SIGNED_BYTES_LABEL,
	type ClusterReceiptClaims,
	clusterReceiptClaims,
	LEDGER_TIME_LABEL,
	LEDGER_TIME_NOTE,
	SETTLEMENT_TIMES_NOTE,
	SKIPPED_NOTE,
} from "../lib/cluster-claims";
import type { LadderStatus, VerifiedClusterState } from "../lib/wire";
import AdvisoryBands from "./advisory-bands";
import AnchorEvidencePanels from "./anchor-evidence";
import CheckLedger from "./check-ledger";
import Details from "./details";
import DisplayAnnex from "./display-annex";
import HashValue from "./hash-value";
import PostureChips, { AmountScope, ScopeChip } from "./posture-chips";

/**
 * A verified CLUSTER receipt (receipt-spec v0.10 §15): every charge to one
 * agent key inside one ledger window. Same brief layout, markup and classes as
 * the session receipt (`verified-receipt.tsx`): a glance card, then the page's
 * ONE Details disclosure holding everything else. Five rules are specific to
 * this kind, each to stop a concrete overclaim or leak:
 *
 *   - Nothing that ties the receipt back to whoever it charged renders
 *     ANYWHERE on the page: not the account handle, not the previous
 *     receipt's ID or a link to it, not the repository. The parser still
 *     validates those signed fields; the page only declines to surface them,
 *     and `predecessorLinkage` reports its result with no ID. The glance's
 *     header says "Receipt": the kind is technical metadata, in Details.
 *
 *   - The refused windows (`skippedSincePrevious`) render IN THE GLANCE, always
 *     visible, never inside a `<details>`: "this key spent and got no receipt"
 *     folded away would read as "this key was idle".
 *   - `windowTransfersRoot` renders as a commitment with no pass mark. Nothing
 *     on the page can recompute it, so a tick beside it would claim a check
 *     that never ran.
 *   - No `usertrust-verify receipt` command: the offline verifier refuses
 *     `scope: "cluster"` today, so the verify block offers the signed bytes and
 *     says the command is pending, instead of one that fails in the terminal.
 *   - No session sentence (a governed session, an association posture, a
 *     generation): the receipt makes none of those claims.
 */
export default function VerifiedClusterReceipt({ state }: { state: VerifiedClusterState }) {
	const { envelope } = state;
	const claims = clusterReceiptClaims(
		envelope.receipt,
		envelope.verification.steps.derivations.result,
	);

	return (
		<article className="flex flex-col gap-8 py-7" data-state="verified" data-scope="cluster">
			<AdvisoryBands advisories={envelope.advisories} withholdIdentifiers />
			<ClusterReceiptCard receiptId={state.receiptId} claims={claims} rung={state.rung} />
			<Details>
				<div className="flex flex-col gap-8">
					<ClusterReceiptDetails state={state} claims={claims} />
					<CheckLedger verification={envelope.verification} rows={CLUSTER_LEDGER_ROWS} />
					<AnchorEvidencePanels
						anchorEvidence={envelope.anchorEvidence}
						checkpointHistory={envelope.checkpointHistory}
						checks={envelope.verification.checks}
						rung={state.rung}
					/>
					<ClusterComparison claims={claims} />
					<DisplayAnnex display={envelope.display} />
				</div>
			</Details>
		</article>
	);
}

/** The glance: verdict, level strip, amount and its scope chip, the window's facts, the skipped windows. */
function ClusterReceiptCard({
	receiptId,
	claims,
	rung,
}: {
	receiptId: string;
	claims: ClusterReceiptClaims;
	rung: LadderStatus;
}) {
	const providerCount = claims.projection.providers.length;
	return (
		<div data-testid="cluster-receipt-card">
			<section className="ut-card">
				{/* One row from 320px up: the label never shrinks, the ID sits inside its copy chip and ellipsizes there. */}
				<header
					className="flex flex-nowrap items-center gap-2.5 border-b border-white/[0.09] bg-white/[0.03] px-6 py-3.5"
					data-testid="card-header"
				>
					<span className="size-[7px] shrink-0 rounded-full bg-ut shadow-[0_0_0_3px_rgba(48,209,88,0.16)]" />
					<span className="shrink-0 text-[13px] font-semibold tracking-tight text-ut">Receipt</span>
					<span
						className="ml-auto flex min-w-0 font-mono text-[12.5px]"
						data-testid="receipt-short-id"
					>
						<HashValue value={receiptId} label="receipt ID" head={10} variant="chip" />
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
						<LevelStrip rung={rung} />
					</div>

					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<div
							className="font-mono text-[44px] leading-none font-semibold tracking-[-0.04em] text-paper"
							data-testid="amount-usd"
						>
							${claims.amountUsd}
						</div>
						<ScopeChip claims={claims} />
					</div>

					<dl className="m-0 flex flex-col gap-1 text-[13.5px]" data-testid="glance-facts">
						<div className="flex items-baseline justify-between gap-4">
							<dt className="shrink-0 text-paper/38">Window</dt>
							<dd
								className="m-0 flex flex-col items-end text-right text-paper"
								data-testid="cluster-window"
							>
								<span>{claims.windowSpan}</span>
								<span className="text-[12.5px] text-paper/38">
									{`${claims.duration} · closes after ${claims.idleThreshold} idle`}
								</span>
							</dd>
						</div>
						<div className="flex items-baseline justify-between gap-4">
							<dt className="shrink-0 text-paper/38">Covers</dt>
							<dd className="m-0 text-right text-paper" data-testid="covers">
								{claims.covers}
							</dd>
						</div>
						{claims.models !== "" ? (
							<div className="flex items-baseline justify-between gap-4">
								<dt className="shrink-0 text-paper/38">Models</dt>
								<dd className="m-0 text-right text-paper" data-testid="models">
									<UnbreakableList
										items={claims.catalog.catalog}
										tail={claims.catalog.customMeaning}
									/>
								</dd>
							</div>
						) : null}
						{providerCount > 0 ? (
							<div className="flex items-baseline justify-between gap-4">
								<dt className="shrink-0 text-paper/38">
									{providerCount === 1 ? "Provider" : "Providers"}
								</dt>
								<dd className="m-0 text-right text-paper" data-testid="providers">
									<UnbreakableList items={claims.projection.providers} />
								</dd>
							</div>
						) : null}
					</dl>

					{claims.skipped !== undefined ? (
						<div className="flex flex-col gap-3 border-t border-white/[0.09] pt-4">
							<SkippedWindows skipped={claims.skipped} />
						</div>
					) : null}
				</div>
			</section>
		</div>
	);
}

/**
 * A " · "-joined list whose names never break inside themselves: a hyphenated
 * model name is not one word to the browser, and at 360px "claude-opus-5-5"
 * split as "claude-opus-" / "5-5". Each name rides in a nowrap span WITH its
 * trailing separator, so the only break opportunity is the plain space after
 * a "·". `tail` (R24's custom-model sentence) is prose and wraps normally.
 * Reads exactly as `modelsLine` / the providers join.
 */
function UnbreakableList({ items, tail }: { items: string[]; tail?: string | undefined }) {
	return (
		<>
			{items.map((item, index) => {
				const more = index < items.length - 1 || tail !== undefined;
				return (
					<Fragment key={item}>
						<span className="whitespace-nowrap" data-list-unit="">
							{more ? `${item} ·` : item}
						</span>
						{more ? " " : null}
					</Fragment>
				);
			})}
			{tail === undefined ? null : <span data-list-tail="">{tail}</span>}
		</>
	);
}

/** R5 in the glance — the same strip as the session card, the anchored level tagged R41's way. */
function LevelStrip({ rung }: { rung: LadderStatus }) {
	const reachedIndex = LADDER.indexOf(rung);
	return (
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
	);
}

/**
 * §15.6's refused windows, in the amber register the page keeps for notes that
 * are neither a pass nor a failure. A `role="note"` block, not a disclosure:
 * the page's one `<details>` is Details, and this must never be behind it.
 */
function SkippedWindows({ skipped }: { skipped: NonNullable<ClusterReceiptClaims["skipped"]> }) {
	return (
		<div
			role="note"
			className="flex flex-col gap-2 rounded-[var(--r-row)] border border-warning/30 bg-warning/[0.04] px-3.5 py-3"
			data-testid="skipped-disclosure"
		>
			<p className="m-0 flex items-center gap-2.5 text-[13.5px] leading-snug text-paper">
				<span
					aria-hidden="true"
					className="size-[7px] shrink-0 rounded-full bg-warning shadow-[0_0_0_3px_rgba(255,176,32,0.16)]"
				/>
				{skipped.headline}
			</p>
			<ul className="m-0 flex list-none flex-col gap-1.5 p-0 pl-[17px]">
				{skipped.windows.map((window) => (
					<li
						key={window.startUtc}
						data-skipped-window=""
						className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12.5px]"
					>
						<span className="text-paper">{window.span}</span>
						<span className="text-paper/62">{window.duration}</span>
						<span
							className="ml-auto rounded-sm border border-white/16 px-2 text-[12px] text-ink"
							data-reason={window.reason}
						>
							{window.reason}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** Everything that is not the glance, for the page's single Details disclosure. */
function ClusterReceiptDetails({
	state,
	claims,
}: {
	state: VerifiedClusterState;
	claims: ClusterReceiptClaims;
}) {
	const receipt = state.envelope.receipt;
	const { projection, transfers, windowTransfers } = claims;
	const count = windowTransfers.count;

	return (
		<div className="flex flex-col gap-6" data-testid="cluster-receipt-details">
			<div>
				<p className="mb-2.5 text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">
					Claim
				</p>
				{/* The claim restates the amount, so its scope label sits beside it (R38). */}
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
					<h2
						className="m-0 text-[17px] leading-[1.45] font-medium tracking-[-0.01em] text-paper"
						data-testid="scope-claim"
					>
						{claims.headline}
					</h2>
					<ScopeChip claims={claims} testId="claim-scope-chip" />
				</div>
			</div>

			<div className="flex flex-col gap-4 rounded-[var(--r-row)] border border-white/[0.09] bg-white/[0.03] px-4 py-3.5">
				<div className="flex flex-col gap-1" data-clock-claim="ledger">
					<span className="font-mono text-xs uppercase tracking-[0.12em] text-paper-steel">
						window — {LEDGER_TIME_LABEL}
					</span>
					<span className="font-mono text-[13px] text-paper">
						{claims.windowStartUtc} → {claims.windowEndUtc}
					</span>
					<span className="font-mono text-xs break-all text-paper/62">
						{projection.windowStart} → {projection.windowEnd} ns
					</span>
					<span className="text-xs leading-relaxed text-ink/70">{LEDGER_TIME_NOTE}</span>
					<span className="mt-1 font-mono text-xs text-paper/62">
						idle threshold {claims.idleThreshold} · {projection.idleThresholdNs} ns
					</span>
				</div>
				<p
					className="m-0 font-mono text-xs tracking-[0.12em] text-paper/62"
					data-testid="spec-scope"
				>
					SPEC {receipt.spec} · SCOPE {receipt.scope}
				</p>
			</div>

			{claims.skipped !== undefined ? (
				<p className="m-0 text-[13px] text-paper/62">
					{claims.skipped.headline} — {SKIPPED_NOTE}
				</p>
			) : null}

			<div>
				<p className="mb-2.5 text-xs font-medium tracking-[0.15em] text-paper/38 uppercase">
					Proven
				</p>
				<ul className="m-0 list-none p-0">
					{proofRungs(state, receipt).map((item) => {
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
					{rungDisclaimers(state.rung).map((line) => (
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
						<PostureChips claims={{ usage: claims.usage, pricing: claims.pricing }} />
					</div>
					{claims.catalog.hasCustom ? (
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
					<div
						className="mt-3 flex flex-col gap-1 text-[13px] text-ink/70"
						data-testid="window-transfers"
						data-window-transfers="commitment"
					>
						<span>
							window-transfers root —{" "}
							{`${count.toLocaleString("en-US")} ledger transfer${count === 1 ? "" : "s"}`}
						</span>
						<HashValue value={windowTransfers.root} label="window-transfers root" />
						<span className="leading-relaxed">{windowTransfers.meaning}</span>
					</div>
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
							<span className="text-xs leading-relaxed text-ink/70">{SETTLEMENT_TIMES_NOTE}</span>
						</div>
					</div>
				</div>
				<div className="border-t border-dashed border-white/14 pt-3">
					{claims.lines.map((line) => (
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

			<p
				className="m-0 border-l-2 border-white/14 pl-4 text-[13px] leading-relaxed text-paper/62"
				data-testid="completeness-trust"
			>
				{CLUSTER_COMPLETENESS_TRUST}
			</p>

			<div
				className="rounded-lg border border-white/[0.09] bg-black/40 px-3.5 py-3 font-mono text-xs text-paper/62"
				data-testid="cluster-verify"
			>
				<a className="ut-link" href={`/r/${state.receiptId}/receipt.json`}>
					{CLUSTER_SIGNED_BYTES_LABEL}
				</a>
				<p className="mt-2 mb-0 font-sans text-[13px] leading-relaxed">
					{CLUSTER_OFFLINE_VERIFIER_PENDING}
				</p>
			</div>
		</div>
	);
}

/**
 * R13/R15 — "verify against your artifact", for a receipt with no artifact:
 * the claim, the page's scope sentence, and the three comparisons a reader
 * must make for themselves (non-artifact, promotion gate, completeness).
 */
function ClusterComparison({ claims }: { claims: ClusterReceiptClaims }) {
	return (
		<section
			className="lift-1 rounded-xl border border-white/10 bg-white/[0.02]"
			data-testid="work-claims"
		>
			<div className="flex h-9 items-center border-b border-white/[0.06] px-4 font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
				verify against your artifact
			</div>

			<div className="flex flex-col gap-4 p-4">
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
					<p className="text-[13px] leading-relaxed text-white/85" data-testid="comparison-claim">
						{claims.headline}
					</p>
					<ScopeChip claims={claims} testId="comparison-scope-chip" />
				</div>
				<p className="text-[13px] leading-relaxed text-white/70">{NEVER_ARTIFACT_VERIFIED}</p>

				<dl className="flex flex-col gap-4">
					{claims.comparison.map((step) => (
						<div key={step.axis} data-comparison-axis={step.axis} className="flex flex-col gap-1">
							<dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/70">
								{step.axis}
							</dt>
							<dd className="text-[13px] leading-relaxed text-white/85">{step.body}</dd>
						</div>
					))}
				</dl>
			</div>
		</section>
	);
}
