/**
 * The visitor receipt card — derived from the same claims the verify exhibit
 * already uses. Nothing here is invented for the mockup.
 *
 * Source of the visual: `usertools-stealth/docs/specs/receipt-page/`. Source of
 * the numbers: the chain-committed projection. Token-split lines (Input /
 * Output / Cache) and trade-capital rows are NOT here: ut1 does not carry
 * them, and putting unsigned display breakdowns on the invoice would read as
 * chain-committed.
 */

import { type ReceiptClaims, truncateForDisplay } from "./claims";
import type { ReceiptDocument, VerifiedState, Work } from "./wire";

export interface ActionPart {
	text: string;
	emphasis: boolean;
}

export interface ActionHeadline {
	parts: ActionPart[];
	byline: string;
}

export interface AuthorityRow {
	label: string;
	value: string;
}

export interface ProofRung {
	id: string;
	label: string;
	detail: string;
	state: "reached" | "pending";
}

export interface InvoiceLine {
	label: string;
	value: string;
	kind: "item" | "total";
}

export interface ReceiptCardModel {
	receiptId: string;
	receiptIdShort: string;
	publicUrl: string;
	action: ActionHeadline;
	authority: AuthorityRow[];
	rungs: ProofRung[];
	amountUsd: string;
	amountCaption: string;
	lines: InvoiceLine[];
	verifyCommand: string;
}

function oidHead(oid: string): string {
	return oid.length <= 8 ? oid : oid.slice(0, 8);
}

export function actionHeadline(work: Work, claims: ReceiptClaims): ActionHeadline {
	const model = claims.models.catalog[0];
	const association =
		claims.association.weight === "attested" ? "workflow-attested" : "owner-asserted";
	const byline = model === undefined ? association : `${association} · ${model}`;

	switch (work.kind) {
		case "commit":
			return {
				parts: [
					{ text: "Committed ", emphasis: false },
					{ text: oidHead(work.oid), emphasis: true },
					{ text: " to ", emphasis: false },
					{ text: claims.repo.label, emphasis: true },
				],
				byline,
			};
		case "pr":
			return {
				parts: [
					{ text: "PR #", emphasis: false },
					{ text: String(work.number), emphasis: true },
					{ text: " in ", emphasis: false },
					{ text: claims.repo.label, emphasis: true },
				],
				byline,
			};
		case "issue":
			return {
				parts: [
					{ text: "Issue #", emphasis: false },
					{ text: String(work.number), emphasis: true },
					{ text: " in ", emphasis: false },
					{ text: claims.repo.label, emphasis: true },
				],
				byline,
			};
		case "session":
			return {
				parts: [{ text: "Governed session", emphasis: false }],
				byline,
			};
	}
}

export function authorityRows(claims: ReceiptClaims): AuthorityRow[] {
	const rows: AuthorityRow[] = [{ label: "Association", value: claims.association.label }];
	if (claims.association.workloadId !== undefined) {
		rows.push({ label: "Workload", value: claims.association.workloadId });
	}
	const modelParts = [...claims.models.catalog];
	if (claims.models.hasCustom) {
		modelParts.push(claims.models.customMeaning ?? "custom");
	}
	if (modelParts.length > 0) {
		rows.push({ label: "Models", value: modelParts.join(" · ") });
	}
	const providers = claims.providers.catalog.join(" · ");
	if (providers.length > 0) {
		rows.push({ label: "Providers", value: providers });
	}
	return rows;
}

function stepPassed(state: VerifiedState, name: "signature" | "inclusion" | "checkpoint"): boolean {
	return state.envelope.verification.steps[name].result === "passed";
}

export function proofRungs(state: VerifiedState, receipt: ReceiptDocument): ProofRung[] {
	const { signature, proof, event } = receipt;
	const history = state.envelope.verification.checks.checkpointHistory.result;
	const reachedIndex = (
		["verified_checkpoint", "verified_checkpoint_history", "verified_anchored"] as const
	).indexOf(state.rung);

	return [
		{
			id: "signed",
			label: "Signed",
			detail: `${signature.alg} · ${signature.keyId}`,
			state: stepPassed(state, "signature") ? "reached" : "pending",
		},
		{
			id: "chained",
			label: "Chained",
			detail: `#${event.sequence.toLocaleString("en-US")} · ${truncateForDisplay(proof.inclusion.root).display}`,
			state: stepPassed(state, "inclusion") ? "reached" : "pending",
		},
		{
			id: "checkpointed",
			label: "Checkpointed",
			detail: `tree ${proof.inclusion.treeSize.toLocaleString("en-US")} · ${proof.checkpoint.segmentId}`,
			state: stepPassed(state, "checkpoint") ? "reached" : "pending",
		},
		{
			id: "history",
			label: "History",
			detail:
				history === "passed"
					? "genesis → head"
					: history === "notApplicable"
						? "n/a"
						: history === "unavailable"
							? "unavailable"
							: "pending",
			state: reachedIndex >= 1 ? "reached" : "pending",
		},
		{
			id: "anchored",
			label: "Anchored",
			detail: reachedIndex >= 2 ? "resolver-asserted" : "pending",
			state: reachedIndex >= 2 ? "reached" : "pending",
		},
	];
}

export function invoiceLines(claims: ReceiptClaims): InvoiceLine[] {
	const spend = claims.projection.spend;
	const versions = claims.projection.pricing.tableVersions.join(" · ");
	return [
		{ label: "Transfers", value: String(spend.transferCount), kind: "item" },
		{
			label: "Pricing",
			value: versions.length > 0 ? `${claims.pricing.value} · ${versions}` : claims.pricing.value,
			kind: "item",
		},
		{
			label: "Total",
			value: `${spend.assessedUsertokens.toLocaleString("en-US")} ut`,
			kind: "total",
		},
	];
}

export function receiptCardModel(state: VerifiedState, claims: ReceiptClaims): ReceiptCardModel {
	const receipt = state.envelope.receipt;
	const short = truncateForDisplay(state.receiptId);
	return {
		receiptId: state.receiptId,
		receiptIdShort: short.display,
		publicUrl: `usertrust.ai/r/${state.receiptId}`,
		action: actionHeadline(claims.work, claims),
		authority: authorityRows(claims),
		rungs: proofRungs(state, receipt),
		amountUsd: claims.amountUsd,
		amountCaption: claims.amountCaption,
		lines: invoiceLines(claims),
		verifyCommand: `npx usertrust-verify receipt ${state.receiptId}.json`,
	};
}
