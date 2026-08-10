/**
 * Types for the committed evidence fixtures under site/app/evidence/.
 *
 * The fixtures are produced by scripts/capture-evidence.mts at the REPO ROOT —
 * a maintainer step that runs real usertrust from the workspace. The site
 * build only imports the committed JSON (resolveJsonModule is on); components
 * cast at the import site, e.g.:
 *   import factsJson from "./facts.json";
 *   const facts = factsJson as EvidenceFacts;
 */

/**
 * One captured call. `receipt` is the TrustReceipt object EXACTLY as the SDK
 * returned it — `cost` is the scalar number, and the optional #85 blocks
 * (`usage`, `pricing`) are present whenever the settle was provider-metered.
 * The pre-call estimate is deliberately OUTSIDE the receipt, on `capture`: it
 * is an input to the hold, and a receipt field named "estimated" would be an
 * API this SDK does not have.
 */
export interface CapturedReceipt {
	receipt: {
		transferId: string;
		cost: number;
		budgetRemaining: number;
		auditHash: string;
		chainPath: string;
		receiptUrl: string | null;
		settled: boolean;
		model: string;
		provider: string;
		timestamp: string;
		usageSource?: "provider" | "estimated";
		usage?: {
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
		};
		endpoint?: { class: string; runtime: string };
		meter?: { costBasis: string; rateSource: string };
		pricing?: {
			appliedRates: {
				inputPer1k: number;
				outputPer1k: number;
				cacheReadPer1k: number;
				cacheWritePer1k: number;
			};
			tableVersion: string;
		};
	};
	capture: {
		estimatedCost: number;
		clientShape: string;
	};
}

export interface CaptureProvenance {
	usertrustVersion: string;
	tigerbeetleVersion: string | null;
	capturedAt: string;
	mode: "ledger" | "dry-run";
	commit: string;
}

/** receipt-ledger.json — the three frontier captures from one ledger vault. */
export interface LedgerCaptures {
	captures: CapturedReceipt[];
	provenance: CaptureProvenance;
}

/** receipt-dryrun.json — the single no-TigerBeetle capture. */
export interface DryRunCapture extends CapturedReceipt {
	provenance: CaptureProvenance;
}

/**
 * denial-event.json — the two halves of a denial's evidence, both real: the
 * error the caller receives, and the chain event the governor wrote before
 * rethrowing it (#87). `data` is typed loosely on purpose — the payload is
 * denial-class dependent and the page reads only the fields it names.
 */
export interface DenialEvidence {
	error: { name: string; message: string };
	event: {
		kind: string;
		hash: string;
		previousHash: string;
		timestamp: string;
		actor: string;
		sequence: number;
		seq: number;
		data: {
			schemaVersion: number;
			decision: string;
			denialClass: string;
			model?: string;
			policyRules?: Array<{ id?: string; name: string }>;
			budget?: { estimatedCost: number; budgetRemaining: number };
			promptHash?: string;
			promptHashAlg?: string;
			transferId?: string;
			endpointClass?: string;
			error: string;
		};
	};
	provenance: CaptureProvenance;
	reproduce: string;
}

export interface EvidenceFacts {
	generatedAt: string;
	commit: string;
	usertrustVersion: string;
	tigerbeetleVersion: string;
	facts: {
		transferCodes: { value: number; source: string };
		accountCodes: { value: number; source: string };
		policyOperators: { value: number; source: string };
		verifierRuntimeDeps: { value: number; source: string };
		modelCount: { value: string; numeric: number; source: string };
		license: { value: "Apache 2.0"; source: string };
		commandsToFirstReceipt: { value: 2; source: string };
		quickstartMinutes: { value: 2; source: string };
		filmDurationSeconds: { value: number; source: string };
		usertokensPerFiveDollars: { value: 50000; source: string };
		invariantCount: { value: number; source: string };
		hardenSuiteCount: { value: number; source: string };
		testCaseCount: { value: number; source: string };
		expectAssertionCount: { value: number; source: string };
		verifierSharedLines: { value: 0; source: string };
		caseFileCalls: { value: number; source: string };
		caseFileDollars: { value: number; source: string };
	};
}

export interface ChainEntry {
	seq: number;
	type: string;
	hash: string;
	prevHash: string;
	timestamp: string;
	summary: string;
}

export interface ChainSlice {
	entries: ChainEntry[];
}

export interface VerifyTranscript {
	command: string;
	lines: string[];
	exitCode: 0;
}

/**
 * Mirrors the AnchorState union at packages/core/src/audit/anchor-verify.ts.
 * ANCHORED_VERIFIED rows are the corpus's happy paths — the fixture records
 * whatever verdict the harden test pins, pass or fail.
 */
export type AnchorVerdict =
	| "UNANCHORED"
	| "ANCHORED_VERIFIED"
	| "ANCHOR_STALE"
	| "ANCHOR_UNVERIFIABLE"
	| "ANCHOR_INVALID"
	| "ANCHOR_MISMATCH";

export interface AttackCorpus {
	attacks: Array<{ name: string; verdict: AnchorVerdict }>;
}
