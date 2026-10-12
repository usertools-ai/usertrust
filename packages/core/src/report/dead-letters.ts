// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { parseDeadLetterLine } from "../audit/dead-letters.js";
import type { DeadLetters } from "./weekly.js";

/**
 * Read the audit writer's dead-letter queue for the one thing the report needs from it: a capped post's
 * `settlement_shortfall` whose chain append failed, with the `posted` amount the ledger actually moved.
 *
 * Every line goes through the shared `parseDeadLetterLine` (the same parser `verify` and `health` use for the file), so
 * what is a readable dead letter is decided in ONE place, including the writer's `JSON.stringify` checksum fallback for a
 * NaN payload. The checksum detects corruption; it is not tamper-evidence, and the queue is never part of the VERIFIED
 * claim.
 *
 * Fails toward the upper bound: a line that does not parse or fails its checksum makes the whole queue `unreadable`. A
 * queue the reader cannot trust cannot rule a capped post out.
 */
export function parseDeadLetters(text: string): DeadLetters {
	const shortfalls = new Map<string, number>();
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const parsed = parseDeadLetterLine(line);
		if (parsed.unreadable === true) return { unreadable: true };
		const payload = parsed.entry["payload"];
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
