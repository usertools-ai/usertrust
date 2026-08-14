import ReceiptPaper from "../../components/receipt/receipt-paper";
import { barcodeBars } from "../../lib/barcode";
import {
	type CatalogRendering,
	CHAIN_CLOCK_CLAIM_LABEL,
	CHAIN_CLOCK_CLAIM_NOTE,
	CUSTOM_MODEL_MEANING,
	MINTED_AT_LABEL,
	MINTED_AT_NOTE,
	PROOF_ID_IS_A_HANDLE,
	REPO_NAME_IS_NOT_SCOPE,
	type ReceiptClaims,
	TRAILER_CITES_GENERATION_ONE,
	UNDISCLOSED_PRIVATE_REPO,
} from "../lib/claims";
import type { ReceiptDocument } from "../lib/wire";
import HashValue from "./hash-value";
import PostureChips, { AmountScope } from "./posture-chips";

/**
 * §6.2 — the receipt artifact: the human-readable CHAIN-COMMITTED claim set,
 * rendered as the printed receipt it is.
 *
 * Everything on this paper is chain-committed. That is the whole reason the
 * unsigned material lives in a separate annex under its own label (R28-R31):
 * the paper is the boundary, and a reader who learns "if it is on the paper,
 * the chain committed it" has learned something true. `mintedAt` is the ONE
 * exception and it is labeled as one (R27) — the only minter-asserted clock
 * claim, set apart from `startedAt`/`endedAt`, which are chain clock claims.
 *
 * On-paper accents use the paper-ink variants only; the bright dark-ground
 * accents are forbidden here (globals.css, §6.2). The barcode footer reuses
 * `app/lib/barcode.ts` per §6.2, over the mint event hash — honest decoration
 * whose pattern is a deterministic function of the hash printed beside it.
 */

function Field({
	label,
	children,
	note,
}: {
	label: string;
	children: React.ReactNode;
	note?: string;
}) {
	return (
		<div className="flex flex-col gap-1" data-field={label}>
			<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-ink/70">{label}</span>
			<div className="text-[13px] leading-relaxed text-ink">{children}</div>
			{note ? <p className="text-[12px] leading-relaxed text-ink/70">{note}</p> : null}
		</div>
	);
}

/** R24 — catalog identifiers as themselves; `"custom"` named and explained. */
function Catalog({ label, rendering }: { label: string; rendering: CatalogRendering }) {
	return (
		<Field label={label}>
			<ul className="flex flex-wrap gap-2">
				{rendering.catalog.map((entry) => (
					<li
						key={entry}
						className="rounded-sm border border-ink/20 px-2 py-0.5 font-mono text-[12px]"
					>
						{entry}
					</li>
				))}
				{rendering.hasCustom ? (
					<li
						data-custom-literal=""
						className="rounded-sm border border-paper-amber/60 px-2 py-0.5 font-mono text-[12px] text-paper-amber"
					>
						custom — {CUSTOM_MODEL_MEANING}
					</li>
				) : null}
			</ul>
		</Field>
	);
}

/** R13's headline plus the per-kind work block (R17/R18/R26). */
function WorkBlock({ claims }: { claims: ReceiptClaims }) {
	const { work, repo } = claims;
	return (
		<div className="flex flex-col gap-4" data-testid="work-block">
			<Field label="repository scope" note={REPO_NAME_IS_NOT_SCOPE}>
				<div className="flex flex-col gap-1">
					<span data-repo-label={repo.undisclosed ? "undisclosed" : "disclosed"}>
						{repo.undisclosed ? UNDISCLOSED_PRIVATE_REPO : repo.displayName}
					</span>
					<HashValue value={repo.repoId} label="repoId" tone="paper" head={28} />
				</div>
			</Field>

			{work.kind === "commit" ? (
				<>
					<Field label={`commit oid (${work.oidAlg})`}>
						<HashValue value={work.oid} label="commit oid" tone="paper" />
					</Field>
					<Field label="object sha-256">
						<HashValue value={work.objectSha256} label="objectSha256" tone="paper" />
					</Field>
				</>
			) : null}

			{work.kind === "pr" || work.kind === "issue" ? (
				<>
					<Field label={`${work.kind} number`}>#{work.number}</Field>
					<Field label="provider artifact id">
						<HashValue value={work.providerArtifactId} label="providerArtifactId" tone="paper" />
					</Field>
					<Field label="observed revision (frozen)">
						<HashValue value={work.observedRevision} label="observedRevision" tone="paper" />
					</Field>
					<Field label={`content binding — ${work.contentBinding.kind}`}>
						<HashValue
							value={
								work.contentBinding.kind === "publicSha256"
									? work.contentBinding.sha256
									: work.contentBinding.commitment
							}
							label="contentBinding"
							tone="paper"
						/>
					</Field>
				</>
			) : null}

			{claims.membership ? (
				<Field label="repository membership" note={PROOF_ID_IS_A_HANDLE}>
					<div className="flex flex-col gap-1" data-membership={claims.membership.status}>
						<span className="font-mono text-[13px]">{claims.membership.status}</span>
						<HashValue value={claims.membership.proofId} label="membership proofId" tone="paper" />
					</div>
				</Field>
			) : null}

			{claims.fallbackOrigin ? (
				<Field label="origin — billed, unfinalized" note={claims.fallbackOrigin.note}>
					<a
						className="focus-ring font-mono text-[13px] underline decoration-ink/30 underline-offset-2"
						href={`/r/${claims.fallbackOrigin.sourceReservationReceiptId}`}
					>
						{claims.fallbackOrigin.sourceReservationReceiptId}
					</a>
				</Field>
			) : null}
		</div>
	);
}

/** R23/R24/R25 plus the postures (R20-R22). */
function SpendBlock({ claims }: { claims: ReceiptClaims }) {
	const { projection, transfers } = claims;
	const spend = projection.spend;
	return (
		<div className="flex flex-col gap-4" data-testid="spend-block">
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
					<span className="font-display text-3xl leading-none text-ink" data-testid="amount-usd">
						${claims.amountUsd}
					</span>
					<span className="font-mono text-[13px] text-ink/70" data-testid="assessed-usertokens">
						{spend.assessedUsertokens} ut assessed
					</span>
				</div>
				{/* R38/R39/R40 — the amount's bound and its scope, inside the same
				    container as the figure. "Beside the amount, never a footnote and
				    never behind interaction": moving this below the spend fields
				    would satisfy neither. */}
				<AmountScope claims={claims} />
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<Field label="posted usertokens">{spend.postedUsertokens}</Field>
				<Field label="rounding adjustment">{spend.roundingAdjustment}</Field>
				<Field label="transfer count">{spend.transferCount}</Field>
				<Field label="pricing table versions">{projection.pricing.tableVersions.join(", ")}</Field>
			</div>

			<Catalog label="models" rendering={claims.models} />
			<Catalog label="providers" rendering={claims.providers} />

			{/* R25 — the two cases render DIFFERENTLY; the root's MEANING is the
			    difference, so it is rendered as the field's own note. */}
			<Field
				label={transfers.rootIsCommitment ? "transfer-set root — COMMITMENT" : "transfer-set root"}
				note={transfers.rootMeaning}
			>
				<span data-transfer-set={transfers.rootIsCommitment ? "commitment" : "list"}>
					<HashValue value={transfers.root} label="transferSetRoot" tone="paper" />
				</span>
			</Field>

			{transfers.pairs ? (
				<Field label={`transfer pairs (${transfers.pairs.length})`}>
					<ul className="flex flex-col gap-1 font-mono text-[12px] text-ink/70">
						{transfers.pairs.map((pair) => (
							<li key={pair.authorizationTransferId} className="break-all">
								{pair.authorizationTransferId} → {pair.settlementTransferId}
							</li>
						))}
					</ul>
				</Field>
			) : null}

			<PostureChips claims={claims} />
		</div>
	);
}

/** R27 — the header's attested-vs-asserted split, made visible. */
function Timestamps({ receipt }: { receipt: ReceiptDocument }) {
	const projection = receipt.event.data;
	return (
		<div className="grid gap-4 sm:grid-cols-2" data-testid="timestamps">
			<div
				data-clock-claim="minter-asserted"
				className="flex flex-col gap-1 border-l-2 border-paper-amber/60 pl-3"
			>
				<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-paper-amber">
					mintedAt — {MINTED_AT_LABEL}
				</span>
				<span className="font-mono text-[13px] text-ink">{receipt.mintedAt}</span>
				<span className="text-[12px] leading-relaxed text-ink/70">{MINTED_AT_NOTE}</span>
			</div>
			<div
				data-clock-claim="chain-committed"
				className="flex flex-col gap-1 border-l-2 border-paper-steel/60 pl-3"
			>
				<span className="font-mono text-[12px] uppercase tracking-[0.12em] text-paper-steel">
					startedAt / endedAt — {CHAIN_CLOCK_CLAIM_LABEL}
				</span>
				<span className="font-mono text-[13px] text-ink">
					{projection.startedAt} → {projection.endedAt}
				</span>
				<span className="text-[12px] leading-relaxed text-ink/70">{CHAIN_CLOCK_CLAIM_NOTE}</span>
			</div>
		</div>
	);
}

/**
 * §6.2 — the receipt ID as the barcode footer.
 *
 * The BARS are drawn over the mint `event.hash`, not the receipt ID, for a
 * mechanical reason: `barcodeBars` maps HEX NIBBLES to bar widths and throws on
 * anything else, and a `ut1_` ID is base58. The ID is the footer's LABEL (with
 * its copy affordance, R17); the bars are provenance-as-texture over the hash
 * the receipt's whole proof hangs from.
 */
function BarcodeFooter({ receipt }: { receipt: ReceiptDocument }) {
	const prefix = receipt.event.hash.slice(0, 24);
	const { bars, total } = barcodeBars(prefix);
	return (
		<div className="flex flex-col gap-2" data-testid="barcode-footer">
			<svg
				viewBox={`0 0 ${total} 10`}
				preserveAspectRatio="none"
				role="img"
				aria-label={`mint event hash ${prefix}`}
				className="h-8 w-full text-ink"
			>
				{bars.map((bar) => (
					<rect key={bar.x} x={bar.x} y="0" width={bar.width} height="10" fill="currentColor" />
				))}
			</svg>
			<HashValue value={receipt.receiptId} label="receipt ID" tone="paper" head={26} />
		</div>
	);
}

export default function ReceiptArtifact({
	receipt,
	claims,
}: {
	receipt: ReceiptDocument;
	claims: ReceiptClaims;
}) {
	const provenance = `chain ${receipt.proof.chain} · segment ${receipt.proof.checkpoint.segmentId} · sequence ${receipt.event.sequence}`;
	return (
		<ReceiptPaper provenance={provenance}>
			<div className="flex flex-col gap-6">
				<p className="font-display text-2xl leading-tight text-ink" data-testid="headline-claim">
					{claims.headline}
				</p>

				{claims.predecessor ? (
					<p className="text-[13px] leading-relaxed text-ink/70" data-testid="predecessor-linkage">
						{claims.predecessor} — {TRAILER_CITES_GENERATION_ONE}
					</p>
				) : null}

				<WorkBlock claims={claims} />
				<hr className="border-ink/15" />
				<SpendBlock claims={claims} />
				<hr className="border-ink/15" />
				<Timestamps receipt={receipt} />
				<hr className="border-ink/15" />
				<BarcodeFooter receipt={receipt} />
			</div>
		</ReceiptPaper>
	);
}
