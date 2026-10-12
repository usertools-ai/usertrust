// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";
import { canonicalize } from "../audit/canonical.js";
import type { DeadLetters } from "./weekly.js";

/**
 * Read the audit writer's dead-letter queue for the one thing the report needs from it: a capped post's
 * `settlement_shortfall` whose chain append failed, with the `posted` amount the ledger actually moved.
 *
 * A dead letter is `{ source, transferId?, payload, error, timestamp, checksum, checksumAlg }` where `payload` is the
 * whole event input and `checksum` is SHA-256 over the canonical bytes of the entry WITHOUT the two checksum fields
 * (`canonicalize`, falling back to `JSON.stringify` when it throws on a NaN, as the writer does). The checksum detects
 * corruption; it is not tamper-evidence, and the queue is never part of the VERIFIED claim.
 *
 * Fails toward the upper bound: a line that does not parse, fails its checksum, or has an unknown checksum algorithm makes
 * the whole queue `unreadable`. A queue the reader cannot trust cannot rule a capped post out.
 *
 * Note: this mirrors the writer in `audit/chain.ts` (`writeDeadLetter`). A shared dead-letter reader, if the verifier
 * grows one, should replace this copy.
 */
export function parseDeadLetters(text: string): DeadLetters {
	const shortfalls = new Map<string, number>();
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let sealed: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { unreadable: true };
			}
			sealed = parsed as Record<string, unknown>;
		} catch {
			return { unreadable: true };
		}
		const { checksum, checksumAlg, ...entry } = sealed;
		if (checksumAlg !== "sha256" || typeof checksum !== "string") return { unreadable: true };
		// The writer checksums `canonicalize(entry)`, or `JSON.stringify(entry)` when canonicalize throws on a NaN/Infinity
		// (which JSON.stringify writes as null). On read that value is already null, so `canonicalize` succeeds and yields
		// a DIFFERENT string: accept either digest. JSON.parse keeps insertion order, so the second reproduces the writer's
		// fallback bytes.
		const digests: string[] = [];
		try {
			digests.push(createHash("sha256").update(canonicalize(entry)).digest("hex"));
		} catch {
			// not canonicalizable: only the fallback below can match
		}
		digests.push(createHash("sha256").update(JSON.stringify(entry)).digest("hex"));
		if (!digests.includes(checksum)) return { unreadable: true };
		const payload = entry["payload"];
		if (payload === null || typeof payload !== "object") continue;
		const input = payload as { kind?: unknown; data?: unknown };
		if (input.kind !== "settlement_shortfall") continue;
		const data = input.data;
		if (data === null || typeof data !== "object") return { unreadable: true };
		const d = data as Record<string, unknown>;
		const tid = d["transferId"];
		const posted = d["posted"];
		if (
			typeof tid !== "string" ||
			typeof posted !== "number" ||
			!Number.isFinite(posted) ||
			posted < 0
		) {
			return { unreadable: true };
		}
		shortfalls.set(tid, posted);
	}
	return { shortfalls };
}
