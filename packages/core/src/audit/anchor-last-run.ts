// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The outcome of the last `usertrust anchor now --scheduled` run, kept at
 * `audit/anchors/last-run.json` so `anchor status` can say whether the timer is
 * actually working. A scheduled run has no terminal, so this file is how a failure
 * stays visible after the run is gone.
 *
 * Reason codes are a fixed list: a consumer can switch on them.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../shared/private-fs.js";
import { anchorsDir } from "./anchor.js";

export const LAST_RUN_REASONS = [
	"anchored",
	"no-new-events",
	"empty",
	"locked",
	"no-key",
	"lock-unavailable",
	"mirror-missing",
	"stale-signer-key",
	"sink-failed",
	"other",
] as const;

export type LastRunReason = (typeof LAST_RUN_REASONS)[number];

export interface LastRun {
	/** ISO-8601 time the run finished. */
	at: string;
	ok: boolean;
	reason: LastRunReason;
}

/** Reasons that are not failures: nothing to do, or another run holds the lock. */
const OK_REASONS: ReadonlySet<LastRunReason> = new Set([
	"anchored",
	"no-new-events",
	"empty",
	"locked",
]);

export function isOkReason(reason: LastRunReason): boolean {
	return OK_REASONS.has(reason);
}

/**
 * Map an emitter `reason` string (free text, may carry advice after the code) to a
 * fixed code. Anything unrecognised is "other": it is still a failure.
 */
export function classifyEmitReason(raw: string | undefined): LastRunReason {
	if (raw === undefined) return "other";
	if (raw === "no-new-events" || raw === "empty" || raw === "locked") return raw;
	if (raw.startsWith("mirror-missing")) return "mirror-missing";
	if (raw.startsWith("stale-signer-key")) return "stale-signer-key";
	return "other";
}

export function lastRunPath(rootDir: string): string {
	return join(anchorsDir(rootDir), "last-run.json");
}

/**
 * Record a run. Does nothing when the anchors directory does not exist (no
 * identity yet): recording must not create a half-made anchor setup.
 */
export function writeLastRun(rootDir: string, reason: LastRunReason, now: Date = new Date()): void {
	if (!existsSync(anchorsDir(rootDir))) return;
	const entry: LastRun = { at: now.toISOString(), ok: isOkReason(reason), reason };
	writePrivateFileAtomic(lastRunPath(rootDir), `${JSON.stringify(entry)}\n`);
}

/** Read the record back; null when absent or not a well-formed entry. */
export function readLastRun(rootDir: string): LastRun | null {
	try {
		const parsed = JSON.parse(readFileSync(lastRunPath(rootDir), "utf-8")) as Partial<LastRun>;
		if (
			typeof parsed.at === "string" &&
			typeof parsed.ok === "boolean" &&
			(LAST_RUN_REASONS as readonly string[]).includes(parsed.reason as string)
		) {
			return { at: parsed.at, ok: parsed.ok, reason: parsed.reason as LastRunReason };
		}
		return null;
	} catch {
		return null;
	}
}
