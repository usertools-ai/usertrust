/**
 * journal.mts — fleet-ledger WAL journal (crash-safe seen-state).
 *
 * This journal is the seen-state SOURCE OF TRUTH for the collector: a
 * messageId is "seen" if and only if a DONE line for it is durably in this
 * file. Any state.json elsewhere is a rebuildable cache of this file.
 *
 * WRITE PROTOCOL — every append is ONE writeSync of
 * `JSON.stringify(entry) + "\n"` followed by fsyncSync on the SAME fd. The
 * trailing newline is the commit marker: a crashed write leaves a PREFIX of
 * the line on disk, and no strict prefix of a serialized JSON object is
 * itself valid JSON (the closing brace is the final byte) — so on reopen
 * "parses" ⇔ "the record is complete".
 *
 * CRASH RECOVERY (reopen), derived from that protocol:
 *  - Unterminated final line that PARSES → the record is complete, only its
 *    newline was lost; it counts, and the terminator is repaired.
 *  - Unterminated final line that does NOT parse → torn by a crash mid-write:
 *    tolerated, REPORTED (console.warn + `tornTail`), counted as neither
 *    INTENT nor DONE, and truncated away so the next append starts on a
 *    clean record boundary instead of concatenating onto garbage.
 *  - Any OTHER malformed content (interior garbage, unknown entry shape) is
 *    not a crash signature under this protocol — it means a foreign writer
 *    or real corruption, and the journal throws rather than serve wrong
 *    seen-state: a silently dropped DONE line becomes a double-ingest.
 */
import { fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface Journal {
	intent(messageId: string, sessionHash: string, meters: string): void; // fsync append
	done(messageId: string, auditHash: string, costCenter: string): void; // fsync append
	seen(): Set<string>; // messageIds with DONE entries
	pendingIntents(): { messageId: string; sessionHash: string }[]; // INTENT without DONE
	/** Torn bytes recovered from a crash mid-write, reported on reopen; null when clean. */
	readonly tornTail: string | null;
}

type JsonObject = Record<string, unknown>;

const asNonEmptyString = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

interface ReplayState {
	doneIds: Set<string>;
	/** messageId → sessionHash, in first-INTENT order (last sessionHash wins). */
	intents: Map<string, string>;
}

/** Apply one parsed line to the replay state; false = not a journal entry shape. */
function applyEntry(parsed: unknown, state: ReplayState): boolean {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	const entry = parsed as JsonObject;
	const messageId = asNonEmptyString(entry.messageId);
	if (!messageId) return false;
	if (entry.type === "INTENT") {
		const sessionHash = asNonEmptyString(entry.sessionHash);
		if (!sessionHash || typeof entry.meters !== "string") return false;
		state.intents.set(messageId, sessionHash);
		return true;
	}
	if (entry.type === "DONE") {
		if (!asNonEmptyString(entry.auditHash) || !asNonEmptyString(entry.costCenter)) return false;
		state.doneIds.add(messageId);
		return true;
	}
	return false;
}

const corrupt = (path: string, lineNo: number, why: string): Error =>
	new Error(
		`fleet journal corrupt at ${path}:${lineNo} (${why}) — refusing to serve seen-state from a damaged journal`,
	);

interface Replay {
	state: ReplayState;
	tornTail: string | null;
	/** Byte offset to truncate the file to when a torn tail was found; -1 = no truncation. */
	truncateTo: number;
	/** True when the final record was complete but missing its "\n" terminator. */
	needsTerminator: boolean;
}

function replay(path: string): Replay {
	const state: ReplayState = { doneIds: new Set(), intents: new Map() };
	let buf: Buffer;
	try {
		buf = readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { state, tornTail: null, truncateTo: -1, needsTerminator: false };
		}
		throw error;
	}
	let start = 0;
	let lineNo = 0;
	while (start < buf.length) {
		const nl = buf.indexOf(0x0a, start);
		lineNo += 1;
		if (nl === -1) {
			// Unterminated final line: either a complete record that lost only its
			// newline, or the one tolerated crash signature — a torn tail.
			const tail = buf.subarray(start).toString("utf-8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(tail);
			} catch {
				return { state, tornTail: tail, truncateTo: start, needsTerminator: false };
			}
			if (!applyEntry(parsed, state)) throw corrupt(path, lineNo, "unrecognized entry shape");
			return { state, tornTail: null, truncateTo: -1, needsTerminator: true };
		}
		const line = buf.subarray(start, nl).toString("utf-8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw corrupt(path, lineNo, "unparseable line that is not a torn tail");
		}
		if (!applyEntry(parsed, state)) throw corrupt(path, lineNo, "unrecognized entry shape");
		start = nl + 1;
	}
	return { state, tornTail: null, truncateTo: -1, needsTerminator: false };
}

/** Open (creating if needed) the WAL journal at `<dir>/journal/<month>.jsonl`. */
export function openJournal(dir: string, month: string): Journal {
	if (!/^\d{4}-\d{2}$/.test(month)) {
		throw new Error(`fleet journal: month must be YYYY-MM, got ${JSON.stringify(month)}`);
	}
	const journalDir = join(dir, "journal");
	mkdirSync(journalDir, { recursive: true });
	const path = join(journalDir, `${month}.jsonl`);

	const { state, tornTail, truncateTo, needsTerminator } = replay(path);
	const fd = openSync(path, "a"); // append-only fd, held for the journal's lifetime

	if (truncateTo >= 0) {
		// Discard the torn (uncommitted) bytes so the next append starts on a
		// clean record boundary. The content stays available via `tornTail`.
		ftruncateSync(fd, truncateTo);
		fsyncSync(fd);
		console.warn(
			`fleet journal: recovered from torn final line in ${path} — ` +
				`${Buffer.byteLength(tornTail ?? "", "utf-8")} uncommitted bytes discarded (kept in tornTail)`,
		);
	} else if (needsTerminator) {
		// Final record was complete; only the commit marker was lost. Repair it
		// so the next append cannot concatenate onto the recovered record.
		writeSync(fd, "\n");
		fsyncSync(fd);
	}

	const appendLine = (entry: JsonObject): void => {
		const line = `${JSON.stringify(entry)}\n`;
		const written = writeSync(fd, line); // ONE write of the whole line...
		if (written !== Buffer.byteLength(line, "utf-8")) {
			throw new Error(`fleet journal: short write (${written} bytes) to ${path}`);
		}
		fsyncSync(fd); // ...then fsync on the SAME fd
	};

	const requireArg = (name: string, value: string): string => {
		if (!value) throw new Error(`fleet journal: ${name} must be a non-empty string`);
		return value;
	};

	return {
		tornTail,
		intent(messageId, sessionHash, meters) {
			appendLine({
				type: "INTENT",
				messageId: requireArg("messageId", messageId),
				sessionHash: requireArg("sessionHash", sessionHash),
				meters,
			});
			state.intents.set(messageId, sessionHash);
		},
		done(messageId, auditHash, costCenter) {
			appendLine({
				type: "DONE",
				messageId: requireArg("messageId", messageId),
				auditHash: requireArg("auditHash", auditHash),
				costCenter: requireArg("costCenter", costCenter),
			});
			state.doneIds.add(messageId);
		},
		seen() {
			return new Set(state.doneIds);
		},
		pendingIntents() {
			const pending: { messageId: string; sessionHash: string }[] = [];
			for (const [messageId, sessionHash] of state.intents) {
				if (!state.doneIds.has(messageId)) pending.push({ messageId, sessionHash });
			}
			return pending;
		},
	};
}
