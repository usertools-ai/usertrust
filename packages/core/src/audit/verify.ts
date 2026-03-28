/**
 * Audit Chain Verifier
 *
 * Reads a JSONL audit log and verifies:
 * 1. Each event's hash matches the SHA-256 of its canonical representation
 * 2. Each event's previousHash links to the prior event's hash
 * 3. The first event chains from GENESIS_HASH
 *
 * Adapted from usertools-stealth governance/audit/verifier.ts — removes
 * flushAuditWriter dependency (verifier should NOT flush the writer).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { GENESIS_HASH } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import { canonicalize } from "./canonical.js";

export interface ChainVerificationResult {
	valid: boolean;
	eventsVerified: number;
	errors: string[];
	latestHash: string;
	verifiedAt: string;
}

export function verifyChain(logPath: string): ChainVerificationResult {
	const errors: string[] = [];

	if (!existsSync(logPath)) {
		return {
			valid: true,
			eventsVerified: 0,
			errors: [],
			latestHash: GENESIS_HASH,
			verifiedAt: new Date().toISOString(),
		};
	}

	const content = readFileSync(logPath, "utf-8").trim();
	if (!content) {
		return {
			valid: true,
			eventsVerified: 0,
			errors: [],
			latestHash: GENESIS_HASH,
			verifiedAt: new Date().toISOString(),
		};
	}

	const lines = content.split("\n").filter((l) => l.trim());
	let expectedPreviousHash = GENESIS_HASH;
	let latestHash = GENESIS_HASH;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;

		let event: AuditEvent;
		try {
			event = JSON.parse(line) as AuditEvent;
		} catch (parseErr) {
			errors.push(
				`Event ${i + 1}: malformed JSON — ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
			);
			expectedPreviousHash = "";
			continue;
		}

		if (event.previousHash !== expectedPreviousHash) {
			errors.push(
				`Event ${i + 1} (${event.id}): previousHash mismatch. ` +
					`Expected ${expectedPreviousHash}, got ${event.previousHash}`,
			);
		}

		const { hash: storedHash, ...eventWithoutHash } = event;
		const canonical = canonicalize(eventWithoutHash);
		const computedHash = createHash("sha256").update(canonical).digest("hex");

		if (storedHash !== computedHash) {
			errors.push(
				`Event ${i + 1} (${event.id}): hash mismatch. ` +
					`Expected ${computedHash}, got ${storedHash}`,
			);
		}

		expectedPreviousHash = storedHash;
		latestHash = storedHash;
	}

	return {
		valid: errors.length === 0,
		eventsVerified: lines.length,
		errors,
		latestHash,
		verifiedAt: new Date().toISOString(),
	};
}
