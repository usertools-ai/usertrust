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

export interface CapturedReceipt {
	receipt: {
		transferId: string;
		cost: { estimated: number; actual: number | null };
		budgetRemaining: number;
		auditHash: string;
		settled: boolean;
		model: string;
		provider: string;
		timestamp: string;
	};
	provenance: {
		usertrustVersion: string;
		tigerbeetleVersion: string | null;
		capturedAt: string;
		mode: "ledger" | "dry-run";
		commit: string;
	};
}

export interface EvidenceFacts {
	generatedAt: string;
	commit: string;
	usertrustVersion: string;
	tigerbeetleVersion: string;
	facts: {
		transferCodes: { value: number; source: string };
		policyOperators: { value: number; source: string };
		verifierRuntimeDeps: { value: number; source: string };
		modelCount: { value: string; numeric: number; source: string };
		license: { value: "Apache 2.0"; source: string };
		commandsToFirstReceipt: { value: 2; source: string };
		quickstartMinutes: { value: 2; source: string };
		filmDurationSeconds: { value: number; source: string };
		usertokensPerFiveDollars: { value: 50000; source: string };
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
