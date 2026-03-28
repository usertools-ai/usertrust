/**
 * CLI: usertrust health — Show entropy diagnostics
 *
 * Uses entropy.ts to compute 6-signal health score from audit events.
 * Displays per-signal breakdown with status indicators.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type EntropyEventInput,
	type EntropyLevel,
	computeEntropyScore,
} from "../audit/entropy.js";
import { verifyChain } from "../audit/verify.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";

function loadEvents(vaultPath: string): AuditEvent[] {
	const logPath = join(vaultPath, "audit", "events.jsonl");
	if (!existsSync(logPath)) return [];

	try {
		const content = readFileSync(logPath, "utf-8").trim();
		if (!content) return [];

		return content
			.split("\n")
			.filter((l) => l.trim())
			.map((line) => JSON.parse(line) as AuditEvent);
	} catch {
		return [];
	}
}

function loadConfig(vaultPath: string): { budget: number } {
	const configPath = join(vaultPath, "usertrust.config.json");
	if (!existsSync(configPath)) return { budget: 0 };

	try {
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw) as { budget?: number };
		return { budget: typeof config.budget === "number" ? config.budget : 0 };
	} catch {
		return { budget: 0 };
	}
}

function levelLabel(level: EntropyLevel): string {
	switch (level) {
		case "low":
			return "healthy";
		case "elevated":
			return "elevated";
		case "critical":
			return "critical";
	}
}

function statusTag(value: number, hits: number): string {
	if (hits === 0) return "[ok]";
	if (value < 0.3) return "[low]";
	if (value < 0.6) return "[elevated]";
	return "[critical]";
}

export async function run(rootDir?: string): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);

	if (!existsSync(vaultPath)) {
		console.log("No governance vault found. Run `usertrust init` first.");
		return;
	}

	const events = loadEvents(vaultPath);
	const config = loadConfig(vaultPath);

	// Convert audit events to entropy event inputs
	const entropyEvents: EntropyEventInput[] = events.map((e) => ({
		kind: e.kind,
		data: e.data,
	}));

	const report = computeEntropyScore(entropyEvents);

	// Verify chain integrity directly
	const logPath = join(vaultPath, "audit", "events.jsonl");
	const verification = verifyChain(logPath);
	const chainLabel = verification.valid ? "verified" : "FAILED";
	const chainStatus = verification.valid ? "[ok]" : "[critical]";

	// Compute budget utilization percentage
	let spent = 0;
	for (const e of events) {
		if (e.kind !== "llm_call") continue;
		const cost = e.data.cost;
		if (typeof cost === "number") {
			spent += cost;
		}
	}
	const budgetPct = config.budget > 0 ? ((spent / config.budget) * 100).toFixed(1) : "0.0";

	console.log(`Entropy score: ${report.score}/100 (${levelLabel(report.level)})`);

	// Signal 1: Policy violations
	const policySignal = report.signals.find((s) => s.condition === "policy_violations");
	const policyHits = policySignal?.hits ?? 0;
	const policyStatus = statusTag(policySignal?.value ?? 0, policyHits);
	console.log(`  Policy violations (30d):  ${policyHits}   ${policyStatus}`);

	// Signal 2: Budget utilization
	const budgetStatus = Number.parseFloat(budgetPct) > 80 ? "[elevated]" : "[ok]";
	console.log(`  Budget utilization:      ${budgetPct}% ${budgetStatus}`);

	// Signal 3: Chain integrity
	console.log(`  Chain integrity:         ${chainLabel} ${chainStatus}`);

	// Signal 4: PII detections
	const piiSignal = report.signals.find((s) => s.condition === "pii_detections");
	const piiHits = piiSignal?.hits ?? 0;
	const piiStatus = statusTag(piiSignal?.value ?? 0, piiHits);
	console.log(`  PII detections (30d):    ${piiHits}   ${piiStatus}`);

	// Signal 5: Circuit breaker trips
	const cbSignal = report.signals.find((s) => s.condition === "circuit_breaker_trips");
	const cbHits = cbSignal?.hits ?? 0;
	const cbStatus = statusTag(cbSignal?.value ?? 0, cbHits);
	console.log(`  Circuit breaker trips:   ${cbHits}   ${cbStatus}`);

	// Signal 6: Pattern memory hits
	const pmSignal = report.signals.find((s) => s.condition === "pattern_memory_hits");
	const pmHits = pmSignal?.hits ?? 0;
	const pmStatus = statusTag(pmSignal?.value ?? 0, pmHits);
	console.log(`  Pattern memory hits:     ${pmHits}   ${pmStatus}`);
}
