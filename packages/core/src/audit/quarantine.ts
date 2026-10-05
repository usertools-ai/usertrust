// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Torn-tail quarantine (#194.2): the ONE repair the audit chain admits, so failing closed on a
 * torn tail has a recovery path that is not hand-editing the evidence.
 *
 * A TORN TAIL is, positively: bytes after the log's last newline that do not parse as JSON —
 * an append that never completed (a crash, a short write). Nothing else qualifies:
 *  - every line before it must verify from genesis (parse, link, sequence, hash);
 *  - the `.meta` head anchor must be absent, at the verified head, or exactly one behind it at
 *    its predecessor (the states the writer itself leaves);
 *  - the chain must be the single `events.jsonl` (no other segments);
 *  - an unterminated last line that DOES parse is not torn, and is refused (that repair is an
 *    operator's decision, not this tool's).
 *
 * The repair, under the vault's writer lock: the torn bytes are copied byte for byte to
 * `audit/quarantine/<sha256>.torn` (fsync'd), the log is truncated at the torn line's offset
 * (fsync'd), and a chained `audit.quarantine.torn_tail` event records the offset, length,
 * SHA-256 and file. A run that died between the truncation and the event is FINISHED by the
 * next run: every quarantine file without its chained event gets one.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import { canonicalize } from "./canonical.js";
import { createAuditWriter } from "./chain.js";

export const QUARANTINE_EVENT_KIND = "audit.quarantine.torn_tail";
const QUARANTINE_ACTOR = "usertrust-cli";

/** The chain is not in the one state this tool repairs; nothing was changed. */
export class AuditQuarantineRefusedError extends Error {
	constructor(why: string) {
		super(`audit quarantine refused: ${why}. Nothing was changed.`);
		this.name = "AuditQuarantineRefusedError";
	}
}

export interface TornTail {
	offset: number;
	length: number;
	sha256: string;
	file: string;
}

export interface QuarantineResult {
	dryRun: boolean;
	/** The torn tail found (and, unless a dry run, moved aside), or null when the log is clean. */
	torn: TornTail | null;
	/** Quarantine records appended (or, in a dry run, that would be) — the torn tail's, and any
	 * left unrecorded by an earlier run that died after truncating. */
	recorded: string[];
}

interface ChainEvent {
	kind?: unknown;
	data?: { sha256?: unknown };
	hash: string;
	previousHash?: unknown;
	sequence?: unknown;
}

/** Verify the complete lines `text` from genesis; returns the events (throws a refusal). */
function verifyPrefix(text: string): ChainEvent[] {
	const events: ChainEvent[] = [];
	let prev = GENESIS_HASH;
	let seq = 0;
	for (const raw of text.split("\n")) {
		if (raw === "") continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			throw new AuditQuarantineRefusedError(
				`the line after sequence ${seq} does not parse — corruption before the tail`,
			);
		}
		const { hash, ...rest } = e;
		const ok =
			typeof hash === "string" &&
			e.previousHash === prev &&
			e.sequence === seq + 1 &&
			createHash("sha256").update(canonicalize(rest)).digest("hex") === hash;
		if (!ok) {
			throw new AuditQuarantineRefusedError(
				`sequence ${seq + 1} does not verify — corruption before the tail`,
			);
		}
		events.push(e as unknown as ChainEvent);
		prev = hash as string;
		seq++;
	}
	return events;
}

function checkAnchor(metaPath: string, events: ChainEvent[]): void {
	if (!existsSync(metaPath)) return;
	let a: { lastHash?: unknown; sequence?: unknown };
	try {
		a = JSON.parse(readFileSync(metaPath, "utf-8")) as typeof a;
	} catch {
		throw new AuditQuarantineRefusedError("the .meta head anchor does not parse");
	}
	const head = events.at(-1);
	const headSeq = events.length;
	const isHead = a.sequence === headSeq && a.lastHash === (head?.hash ?? GENESIS_HASH);
	const oneBehind =
		head !== undefined && a.sequence === headSeq - 1 && a.lastHash === head.previousHash;
	if (!isHead && !oneBehind) {
		throw new AuditQuarantineRefusedError(
			`the .meta head anchor (sequence ${String(a.sequence)}) disagrees with the verified chain (sequence ${headSeq}) — a truncation, not a torn tail`,
		);
	}
}

function fsyncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Quarantine the vault's torn tail (see the module doc). `vaultRoot` is the directory holding
 * `.usertrust/`. Takes the vault's writer lock for the whole repair (another live writer:
 * `AuditWriterLockHeldError`). Throws {@link AuditQuarantineRefusedError} for any other state.
 */
export async function quarantineTornTail(
	vaultRoot: string,
	opts: { dryRun?: boolean } = {},
): Promise<QuarantineResult> {
	const dryRun = opts.dryRun === true;
	const auditDir = join(vaultRoot, VAULT_DIR, "audit");
	const logPath = join(auditDir, "events.jsonl");
	const qDir = join(auditDir, "quarantine");
	const writer = createAuditWriter(vaultRoot, { lockAtCreate: true });
	try {
		const segments = readdirSync(auditDir).filter(
			(f) => f.endsWith(".jsonl") && f !== "events.jsonl",
		);
		if (segments.length > 0) {
			throw new AuditQuarantineRefusedError(
				`the chain has other segments (${segments.join(", ")})`,
			);
		}
		const bytes = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
		const cut = bytes.lastIndexOf(0x0a) + 1; // 0 when there is no newline at all
		const tailBytes = bytes.subarray(cut);
		let torn: TornTail | null = null;
		if (tailBytes.length > 0) {
			let parses = true;
			try {
				JSON.parse(tailBytes.toString("utf-8"));
			} catch {
				parses = false;
			}
			if (parses) {
				throw new AuditQuarantineRefusedError(
					"the unterminated last line parses as JSON — it is not a torn write",
				);
			}
			const sha256 = createHash("sha256").update(tailBytes).digest("hex");
			torn = { offset: cut, length: tailBytes.length, sha256, file: `quarantine/${sha256}.torn` };
		}
		const events = verifyPrefix(bytes.subarray(0, cut).toString("utf-8"));
		checkAnchor(`${logPath}.meta`, events);

		const recordedShas = new Set(
			events
				.filter((e) => e.kind === QUARANTINE_EVENT_KIND && typeof e.data?.sha256 === "string")
				.map((e) => e.data?.sha256 as string),
		);
		const pending = existsSync(qDir)
			? readdirSync(qDir)
					.filter((f) => f.endsWith(".torn"))
					.map((f) => f.slice(0, -".torn".length))
					.filter((sha) => !recordedShas.has(sha) && sha !== torn?.sha256)
					.sort()
			: [];
		const toRecord = torn === null ? pending : [...pending, torn.sha256];
		if (dryRun) return { dryRun, torn, recorded: toRecord };

		if (torn !== null) {
			// 1. The torn bytes, aside, byte for byte (idempotent by content name).
			mkdirSync(qDir, { recursive: true, mode: 0o700 });
			const qPath = join(auditDir, torn.file);
			const qfd = openSync(qPath, "w", 0o600);
			try {
				let off = 0;
				while (off < tailBytes.length) {
					const n = writeSync(qfd, tailBytes, off, tailBytes.length - off);
					if (n <= 0) throw new Error("quarantine write made no progress");
					off += n;
				}
				fsyncSync(qfd);
			} finally {
				closeSync(qfd);
			}
			fsyncPath(qDir);
			// 2. The log, cut back to its last complete line.
			const lfd = openSync(logPath, "r+");
			try {
				ftruncateSync(lfd, torn.offset);
				fsyncSync(lfd);
			} finally {
				closeSync(lfd);
			}
		}
		// 3. A chained record per quarantined tail not yet on the chain.
		for (const sha of toRecord) {
			const file = `quarantine/${sha}.torn`;
			const length = readFileSync(join(auditDir, file)).length;
			await writer.appendEvent({
				kind: QUARANTINE_EVENT_KIND,
				actor: QUARANTINE_ACTOR,
				data: {
					sha256: sha,
					length,
					file,
					...(torn !== null && sha === torn.sha256 ? { offset: torn.offset } : {}),
				},
			});
		}
		return { dryRun, torn, recorded: toRecord };
	} finally {
		writer.release();
	}
}
