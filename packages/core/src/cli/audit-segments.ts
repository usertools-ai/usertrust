// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Name what a vault's `Sequence gap:` errors are about.
 *
 * `verifyVault` reports a deleted segment as `Sequence gap: event N follows M`, which reads like one
 * deleted event: it does not say how many events are gone, or between which two files. Each such error
 * is named here from ITS OWN sequences, not from each file's first and last lines: the range M+1..N-1 and
 * the files that hold M and N (looked up in a second read of the segment files, listed by `verifyVault`'s
 * rule: `events.jsonl` first, then every other `*.jsonl`, sorted). If either sequence is not in that read,
 * the file names are omitted rather than guessed. A segment holding 1, 4, 2 therefore cannot make a
 * neighbouring gap read "3..5 absent" when 4 exists.
 *
 * A DESCRIPTION, NEVER A VERDICT. The caller passes the errors of its own vault reading and appends the
 * lines beside them; `valid` stays that reading's. A log changed between the two reads can only change how
 * an already-failed verdict is described, never turn it into a pass.
 *
 * CORE-ONLY, NOT A MIRRORED PAIR. `usertrust-verify` (which never imports core) names a gap in the same
 * words with its own code for its `--tx` receipt; no parity test holds the two together, and neither is
 * part of `verifyVault`'s byte-mirrored logic, which this module does not touch.
 *
 * NOT SCRUBBED HERE. Segment file names come from the audited vault and can carry an escape sequence
 * or a bidi override, but scrubbing is a property of the RENDER: the caller scrubs each line it prints
 * at a terminal, while --json keeps the vault's own bytes (escaped by `toSafeJson`) as evidence.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One line per `Sequence gap:` in `errors`, in the order the vault reading reported them (none when it reported none). */
export function describeMissingSegments(auditDir: string, errors: readonly string[]): string[] {
	if (!errors.some((e) => e.startsWith("Sequence gap:"))) return [];
	const names: string[] = [];
	if (existsSync(join(auditDir, "events.jsonl"))) names.push("events.jsonl");
	try {
		for (const entry of readdirSync(auditDir).sort()) {
			if (entry.endsWith(".jsonl") && entry !== "events.jsonl") names.push(entry);
		}
	} catch {
		// A directory that cannot be enumerated is the vault reading's error to report, not this
		// description's: it only names gaps between files it could list.
	}

	const seqFile = new Map<number, string>();
	// A sequence that occurs more than once (in two segments, or twice in one) has no single file to
	// name: first-wins would pin the diagnosis on whichever file happened to be read first.
	const duplicated = new Set<number>();
	for (const name of names) {
		let text: string;
		try {
			text = readFileSync(join(auditDir, name), "utf-8");
		} catch {
			// An unreadable segment is reported by the vault reading ("could not be read").
			continue;
		}
		for (const line of text.split("\n")) {
			try {
				const seq = (JSON.parse(line) as { sequence?: unknown } | null)?.sequence;
				if (!Number.isSafeInteger(seq)) continue;
				if (seqFile.has(seq as number)) duplicated.add(seq as number);
				else seqFile.set(seq as number, name);
			} catch {
				// A malformed or blank line is the vault reading's error; it carries no sequence to place.
			}
		}
	}

	const lines: string[] = [];
	for (const e of errors) {
		const m = /^Sequence gap: event (\d+) follows (\d+)/.exec(e);
		if (m === null) continue;
		const [x, y] = [Number(m[1]), Number(m[2])];
		// A duplicated sequence reads "event 3 follows 3": nothing is absent, so only the verdict's own error stands.
		if (!(x > y + 1)) continue;
		const [fileY, fileX] = [
			duplicated.has(y) ? undefined : seqFile.get(y),
			duplicated.has(x) ? undefined : seqFile.get(x),
		];
		const range = x - y === 2 ? `event ${y + 1} is` : `events ${y + 1}..${x - 1} are`;
		if (fileY === undefined || fileX === undefined) {
			lines.push(`audit events missing: ${range} absent`);
		} else if (fileY === fileX) {
			lines.push(`audit events missing: ${range} absent inside ${fileY} (between ${y} and ${x})`);
		} else {
			lines.push(
				`audit segment missing: ${range} absent between ${fileY} (ends at ${y}) and ${fileX} (starts at ${x})`,
			);
		}
	}
	return lines;
}
