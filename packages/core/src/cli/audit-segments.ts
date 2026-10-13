// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Name what a vault's `Sequence gap:` errors are about.
 *
 * `verifyVault` reports a deleted segment as `Sequence gap: event N follows M`, which reads like one
 * deleted event: it does not say how many events are gone, or between which two files. Each such error
 * is named here from ITS OWN sequences, not from each file's first and last lines: the range M+1..N-1 and
 * the files that hold M and N, as the vault reading's own snapshot read them (`sequenceSegments`). If
 * either sequence is not held by exactly one line of that snapshot (absent, unreadable, or held twice),
 * the file names are omitted rather than guessed. A segment holding 1, 4, 2 therefore cannot make a
 * neighbouring gap read "3..5 absent" when 4 exists.
 *
 * A DESCRIPTION, NEVER A VERDICT. The caller passes the errors and the segments of its own vault reading
 * and appends the lines beside them; `valid` stays that reading's. Nothing is read again: the files are
 * never opened a second time, so a FIFO or an oversized file in a segment's place cannot block or crash
 * the description of a verdict that already named it.
 *
 * CORE-ONLY, NOT A MIRRORED PAIR. `usertrust-verify` (which never imports core) names a gap in the same
 * words with its own code for its `--tx` receipt; no parity test holds the two together.
 *
 * NOT SCRUBBED HERE. Segment file names come from the audited vault and can carry an escape sequence
 * or a bidi override, but scrubbing is a property of the RENDER: the caller scrubs each line it prints
 * at a terminal, while --json keeps the vault's own bytes (escaped by `toSafeJson`) as evidence.
 */

/** One line per `Sequence gap:` in `errors`, in the order the vault reading reported them (none when it reported none). */
export function describeMissingSegments(
	errors: readonly string[],
	sequenceSegments: ReadonlyMap<number, string | null>,
): string[] {
	const lines: string[] = [];
	for (const e of errors) {
		const m = /^Sequence gap: event (\d+) follows (\d+)/.exec(e);
		if (m === null) continue;
		const [x, y] = [Number(m[1]), Number(m[2])];
		// A duplicated sequence reads "event 3 follows 3": nothing is absent, so only the verdict's own error stands.
		if (!(x > y + 1)) continue;
		// `null`: more than one line holds the sequence, so no one file can be named.
		const [fileY, fileX] = [
			sequenceSegments.get(y) ?? undefined,
			sequenceSegments.get(x) ?? undefined,
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
