/**
 * replay.mts — fleet-ledger dry-run replay engine (chained attribution mint).
 *
 * Replays one billing month of provider-reported usage through REAL usertrust
 * (public surface only: `trust`, `withCostCenter`) in dry-run mode, so every
 * transcript record becomes a receipt whose four-tier usage is under the
 * month vault's audit chain. One `trust()` instance per month vault.
 *
 * PRIVACY — nothing conversation-shaped enters the vault. The prompt is the
 * pinned synthetic constant below; the fake client's response text is a
 * constant; the only transcript-derived values in play are the allowlisted
 * FleetRecord fields (parse.mts owns that contract). Pattern memory is
 * explicitly OFF (`patterns.enabled: false` in the vault config — the real
 * TrustConfigSchema field): its default-on path writes CWD-relative
 * `.usertrust/patterns` state keyed by prompt hashes (r2/C7).
 *
 * TAG FORM — `fleet.<sessionHash>.<messageId>` (dots, not the spec's original
 * colons): core's COST_CENTER_PATTERN is colon-free and shared/ids.ts pins
 * that as a security boundary (the `parent::costCenter` display label stays
 * injective), so the colon form can never pass `withCostCenter`. Separator
 * amended to "." by coordinator decision 2026-08-10. The dot form stays
 * injective because sessionHash is fixed-width 12-hex: `parseFleetTag` splits
 * on position, never on separator search, and the round-trip is pinned by
 * test. `fleetTag` is also the pre-mint guard: a composed tag outside core's
 * charset/length bound aborts BEFORE any journal, vault, or store write.
 *
 * CRASH PROTOCOL (per record): journal INTENT (fsync) → governed replay call
 * (chain event + receipt) → receipt-store append → journal DONE (fsync).
 * Recovery on the next run: INTENT without DONE → search the month chain for
 * the record's tag; found ⇒ REBUILD the receipt-store row from that event if
 * the crash landed before the append, then DONE with the event's hash
 * (`recovered`); absent ⇒ the record simply goes through the mint loop again.
 * A receipt with `auditDegraded: true` aborts the whole run before DONE and
 * before the store append — fail-open audit is not acceptable for a ledger
 * whose only job is the audit, and the un-DONE INTENT leaves recovery to
 * re-replay it honestly.
 *
 * WHY RECOVERY REBUILDS THE ROW: DONE without a store row is the ledger's
 * quietest failure. The call is in the chain forever (verifiable, tagged) and
 * absent from the rollup, which reads the store — so the page undercounts and
 * nothing objects. The chain event carries every priced figure (model, cost,
 * four-tier usage, applied rates, table version), so the row can be rebuilt
 * from the chain plus the record being recovered; the rebuilt row says so
 * (`provenance.recoveredFromChain`). The publish gate now also compares the
 * month's `llm_call` count against its store-line count, so a row that cannot
 * be rebuilt refuses the publish instead of shrinking it (collect.mts).
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TrustReceipt } from "usertrust";
import { trust, withCostCenter } from "usertrust";
import type { Journal } from "./journal.mts";
import type { FleetRecord } from "./parse.mts";
import { type FleetStoreLine, readReceiptStore, repairReceiptStoreTail } from "./rollup.mts";

/** Spec-pinned sentinel budget (usertokens) — never rendered as a real limit. */
export const FLEET_SENTINEL_BUDGET = 10_000_000_000;

/**
 * The fleet governor's ledger identity. Core requires a `parentUserId` on any
 * governor that runs attributed (`withCostCenter`) calls — the envelope
 * account is derived from the (parentUserId, costCenter) tuple and
 * `resolveEnvelope` refuses attribution without it, dry-run included. The
 * spec's replay wiring omits this; one fixed collector identity is the
 * whole fleet's parent half (downstream display label:
 * `usertrust-fleet::fleet.<sessionHash>.<messageId>`).
 */
export const FLEET_PARENT_USER_ID = "usertrust-fleet";

/** Spec-pinned synthetic prompt — never derived from transcripts. */
export const FLEET_SYNTHETIC_PROMPT =
	"usertrust fleet ledger: dry-run replay of provider-reported usage; no conversation content is collected.";

/**
 * Local mirror of core's COST_CENTER_PATTERN (shared/ids.ts). Mirrored, not
 * imported: the pattern is not a public `usertrust` export and the constraint
 * bars deep dist imports. `withCostCenter` re-enforces the real one at mint
 * time, so a drift here can only over-reject, never sneak a tag through.
 */
const COST_CENTER_SAFE = /^[a-zA-Z0-9._-]{1,64}$/;

const TAG_PREFIX = "fleet.";
/** sha256(sessionId) hex, first 12 — spec-pinned width (parse.mts). */
const SESSION_HASH = /^[0-9a-f]{12}$/;

/**
 * Compose the cost-center attribution tag, refusing (with a clear error and
 * BEFORE any write) anything core's charset/length boundary would reject.
 */
export function fleetTag(sessionHash: string, messageId: string): string {
	if (!SESSION_HASH.test(sessionHash)) {
		throw new Error(
			`fleet replay: sessionHash must be 12 lowercase hex chars, got ${JSON.stringify(sessionHash)}`,
		);
	}
	const tag = `${TAG_PREFIX}${sessionHash}.${messageId}`;
	if (!COST_CENTER_SAFE.test(tag)) {
		throw new Error(
			`fleet replay: cost-center tag ${JSON.stringify(tag)} fails core's COST_CENTER_PATTERN ` +
				`(${COST_CENTER_SAFE.source}) — aborting before any vault write`,
		);
	}
	return tag;
}

/**
 * Split a fleet tag back into its parts. Positional, not separator-search:
 * sessionHash is fixed-width, so messageIds containing dots stay unambiguous.
 */
export function parseFleetTag(tag: string): { sessionHash: string; messageId: string } {
	const sessionHash = tag.slice(TAG_PREFIX.length, TAG_PREFIX.length + 12);
	const dot = tag[TAG_PREFIX.length + 12];
	const messageId = tag.slice(TAG_PREFIX.length + 13);
	if (!tag.startsWith(TAG_PREFIX) || !SESSION_HASH.test(sessionHash) || dot !== "." || !messageId) {
		throw new Error(`fleet replay: not a fleet cost-center tag: ${JSON.stringify(tag)}`);
	}
	return { sessionHash, messageId };
}

/** The INTENT `meters` string: the five allowlisted meters, fixed key order. */
export function fleetMeters(record: FleetRecord): string {
	return JSON.stringify({
		inputTokens: record.inputTokens,
		outputTokens: record.outputTokens,
		cacheReadTokens: record.cacheReadTokens,
		cacheWrite5m: record.cacheWrite5m,
		cacheWrite1h: record.cacheWrite1h,
	});
}

/** Collector-asserted sidecar stored beside each receipt (spec §3: NOT chained). */
export interface FleetProvenance {
	mode: "dry-run";
	source: "claude-code-transcript";
	occurredAt: string;
	capturedAt: string;
	sessionHash: string;
	isSidechain: boolean;
	messageId: string;
	cacheWriteTiers: { m5: number; h1: number };
	/**
	 * Present ONLY on a row crash recovery rebuilt from the chain event because
	 * the mint's own append never landed. Absent (never `false`) on a minted
	 * row, so the store says which rows the governor wrote and which the
	 * recovery reconstructed. Such a row carries only chain-derived receipt
	 * fields — no `budgetRemaining`, `transferId` or `provider`, because those
	 * were never chained and inventing them would be the fabrication this whole
	 * ledger exists to avoid.
	 */
	recoveredFromChain?: true;
}

// ── fake client (capture-evidence.mts pattern) ──
//
// Duck-typed Anthropic shape; returns the CURRENT record's meters verbatim in
// the usage block, tiers disjoint, with the nested cache_creation breakdown —
// so `fromAnthropicUsage` reports usageSource "provider" and the receipt's
// cacheWriteTokens is the tier sum (5m + 1h).
interface FakeArgs {
	model: string;
	max_tokens: number;
	messages: Array<{ role: string; content: string }>;
}

function fleetFakeClient(current: () => FleetRecord) {
	return {
		messages: {
			create: async (args: FakeArgs) => {
				const r = current();
				return {
					id: r.messageId,
					type: "message",
					role: "assistant",
					model: args.model,
					content: [{ type: "text", text: "usertrust fleet ledger: dry-run replay response" }],
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: {
						input_tokens: r.inputTokens,
						output_tokens: r.outputTokens,
						cache_read_input_tokens: r.cacheReadTokens,
						cache_creation_input_tokens: r.cacheWrite5m + r.cacheWrite1h,
						cache_creation: {
							ephemeral_5m_input_tokens: r.cacheWrite5m,
							ephemeral_1h_input_tokens: r.cacheWrite1h,
						},
					},
				};
			},
		},
	};
}

// ── chain reading (recovery's membership lookup) ──

interface TaggedChainEvent {
	hash: string;
	costCenter: string;
	/** When core wrote the event — the call's real capture time. */
	timestamp: unknown;
	/** The event's `data` block: model, cost, usage, rates, table version. */
	data: JsonObject;
}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null;

/**
 * The ONE event kind a SETTLED call writes (govern.ts / headless.ts). Recovery
 * keys on this and nothing else; the publish gate counts it (collect.mts).
 *
 * An attributed call that never settled still leaves a tagged event behind:
 * `llm_call_failed` on a throw, and (since #87) `policy_denied` /
 * `ledger_rejected` on a governance denial — all three carry
 * `data.costCenter`. Accepting a tag found on ANY kind therefore writes DONE
 * for a call that produced NO receipt, the record is filtered out of every
 * later run, and a REAL call disappears from the ledger with nothing to show
 * it ever existed. The comparison must stay an EQUALITY on the kind:
 * `llm_call_failed` starts with `llm_call`, so a prefix or substring test
 * reintroduces the same silent omission for the commonest failure kind.
 */
export const SETTLED_EVENT_KIND = "llm_call";

/**
 * Read every audit segment in the month vault and index SETTLED events by
 * their cost-center tag. Interior garbage throws (a fleet vault we cannot read
 * honestly must not drive DONE/replay decisions); only an unterminated,
 * unparseable FINAL line of a segment — the one crash signature an
 * append-only log can leave — is skipped.
 */
function readTaggedEvents(vaultBase: string): Map<string, TaggedChainEvent> {
	const byTag = new Map<string, TaggedChainEvent>();
	const auditDir = join(vaultBase, ".usertrust", "audit");
	if (!existsSync(auditDir)) return byTag;
	for (const file of readdirSync(auditDir).sort()) {
		if (!file.endsWith(".jsonl")) continue;
		const path = join(auditDir, file);
		const raw = readFileSync(path, "utf-8");
		const lines = raw.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = (lines[i] ?? "").trim();
			if (line === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				const isFinalLine = i === lines.length - 1 && !raw.endsWith("\n");
				if (isFinalLine) continue; // torn tail: not a committed event
				throw new Error(`fleet replay: unparseable audit line at ${path}:${i + 1}`);
			}
			const event = parsed as { hash?: unknown; kind?: unknown; timestamp?: unknown };
			const data = asObject((parsed as { data?: unknown }).data);
			if (
				event.kind === SETTLED_EVENT_KIND &&
				typeof event.hash === "string" &&
				data !== null &&
				typeof data.costCenter === "string"
			) {
				byTag.set(data.costCenter, {
					hash: event.hash,
					costCenter: data.costCenter,
					timestamp: event.timestamp,
					data,
				});
			}
		}
	}
	return byTag;
}

/**
 * Rebuild the receipt-store row for a call whose chain event is durable but
 * whose store append was lost to a crash. Everything priced comes from the
 * CHAIN (cost, model, the four-tier usage, the rate source, the table version
 * — the event alone is enough to reprice the call, by core's own design);
 * everything transcript-shaped comes from the record being recovered. Nothing
 * is invented: any field the event does not carry makes this THROW rather than
 * write a row the ledger cannot stand behind.
 */
export function storeLineFromChainEvent(
	event: TaggedChainEvent,
	record: FleetRecord,
): FleetStoreLine {
	const { data } = event;
	const bad: (why: string) => never = (why) => {
		throw new Error(
			`fleet replay: cannot rebuild the receipt-store row for ${record.messageId} from chain ` +
				`event ${event.hash.slice(0, 12)}… — ${why}. The call is chained but has no store row; ` +
				`the publish gate will refuse this month until that is resolved.`,
		);
	};
	const usage = asObject(data.usage);
	if (typeof data.cost !== "number") bad("event data carries no numeric cost");
	if (typeof data.model !== "string") bad("event data carries no model");
	if (data.usageSource !== "provider") {
		bad(`usageSource is ${JSON.stringify(data.usageSource)}, not "provider"`);
	}
	if (usage === null) bad("event data carries no usage block");
	if (typeof data.rateSource !== "string") bad("event data carries no rateSource");
	if (typeof data.pricingTableVersion !== "string")
		bad("event data carries no pricingTableVersion");
	if (typeof event.timestamp !== "string") bad("event carries no timestamp");
	const tier = (key: string): number => {
		const value = usage?.[key];
		if (typeof value !== "number") bad(`usage.${key} is not a number`);
		return value as number;
	};
	const cacheWriteTokens = tier("cacheWriteTokens");
	const tiers = { m5: record.cacheWrite5m, h1: record.cacheWrite1h };
	if (tiers.m5 + tiers.h1 !== cacheWriteTokens) {
		// The rollup refuses any line whose tier split disagrees with the chained
		// total; catching it here names the cause instead of failing at publish.
		bad(
			`the record's cache-write tiers (${tiers.m5} + ${tiers.h1}) do not sum to the chained ` +
				`cacheWriteTokens ${cacheWriteTokens} — the transcript no longer matches the chained call`,
		);
	}
	return {
		receipt: {
			cost: data.cost as number,
			auditHash: event.hash,
			model: data.model as string,
			usageSource: "provider",
			usage: {
				inputTokens: tier("inputTokens"),
				outputTokens: tier("outputTokens"),
				cacheReadTokens: tier("cacheReadTokens"),
				cacheWriteTokens,
			},
			meter: { rateSource: data.rateSource as string },
			pricing: { tableVersion: data.pricingTableVersion as string },
		},
		provenance: {
			mode: "dry-run",
			source: "claude-code-transcript",
			occurredAt: record.occurredAt,
			// The chain event's own timestamp: when this call really was captured.
			capturedAt: event.timestamp as string,
			sessionHash: record.sessionHash,
			isSidechain: record.isSidechain,
			messageId: record.messageId,
			cacheWriteTiers: tiers,
			recoveredFromChain: true,
		},
	};
}

// ── replay ──

type GovernedMint = { receipt: TrustReceipt };

export async function replayMonth(opts: {
	month: string; // "YYYY-MM" from occurredAt
	records: FleetRecord[]; // pre-sorted by occurredAt
	vaultRoot: string;
	journal: Journal;
	receiptStorePath: string;
}): Promise<{ minted: number; recovered: number }> {
	const { month, records, vaultRoot, journal, receiptStorePath } = opts;
	if (!/^\d{4}-\d{2}$/.test(month)) {
		throw new Error(`fleet replay: month must be YYYY-MM, got ${JSON.stringify(month)}`);
	}

	// PRE-FLIGHT — every abortable defect surfaces before ANY write anywhere:
	// wrong-month routing, and any record whose composed tag core would refuse.
	for (const record of records) {
		if (!record.occurredAt.startsWith(month)) {
			throw new Error(
				`fleet replay: record ${record.messageId} (occurredAt ${record.occurredAt}) is ` +
					`outside month ${month} — records must be routed by billing month before replay`,
			);
		}
		fleetTag(record.sessionHash, record.messageId); // throws on charset/length
	}

	const vaultBase = join(vaultRoot, month);
	let recovered = 0;

	// Bring the receipt store to a clean record boundary before the FIRST
	// append of this run, recovery's included: a previous run killed mid-write
	// leaves uncommitted bytes, and appending onto them makes the month
	// permanently unreadable (rollup.mts). Idempotent, so both call sites can
	// ask for it and only the first does the work.
	let storeReady = false;
	const ensureStoreReady = (): void => {
		if (storeReady) return;
		mkdirSync(dirname(receiptStorePath), { recursive: true });
		repairReceiptStoreTail(receiptStorePath);
		storeReady = true;
	};

	// Phase 1 — recovery: INTENT without DONE resolves from the chain when the
	// crashed run's vault write survived; otherwise the record stays pending
	// and the mint loop below replays it (it is not in seen()).
	const pending = journal.pendingIntents();
	if (pending.length > 0) {
		const byTag = readTaggedEvents(vaultBase);
		const recordsById = new Map(records.map((record) => [record.messageId, record]));
		let storedIds: Set<string> | null = null;
		for (const intent of pending) {
			const tag = fleetTag(intent.sessionHash, intent.messageId);
			const event = byTag.get(tag);
			if (event === undefined) continue; // no settled event: the mint loop replays it
			// Which side of the store append did the crash land on? Read the store
			// once, lazily — only a pending INTENT with a chain event needs it.
			if (storedIds === null) {
				ensureStoreReady();
				storedIds = new Set(readReceiptStore(receiptStorePath).map((l) => l.provenance.messageId));
			}
			if (!storedIds.has(intent.messageId)) {
				const record = recordsById.get(intent.messageId);
				if (record === undefined) {
					// Chained, no row, and no record to rebuild the row's occurrence
					// fields from (the id is deferred or gone from the corpus this
					// run). Leaving the INTENT pending is the honest state: the
					// publish gate refuses on it by name, and the next run with that
					// record in hand completes the recovery. Writing DONE here is
					// exactly the silent omission this fix exists to remove.
					console.warn(
						`fleet replay: ${intent.messageId} is in the ${month} chain but has no receipt-store ` +
							`row, and this run has no record for it — leaving the INTENT pending (publish will ` +
							`refuse until the record is back in the scan)`,
					);
					continue;
				}
				// Same order as the mint loop: store row first, DONE second — a
				// crash between them repeats this branch harmlessly next run.
				appendFileSync(
					receiptStorePath,
					`${JSON.stringify(storeLineFromChainEvent(event, record))}\n`,
				);
				storedIds.add(intent.messageId);
			}
			journal.done(intent.messageId, event.hash, tag);
			recovered += 1;
		}
	}

	// Phase 2 — mint everything not yet DONE, one trust() for the whole month.
	const seen = journal.seen();
	const toMint = records.filter((record) => !seen.has(record.messageId));
	let minted = 0;
	if (toMint.length === 0) return { minted, recovered };

	ensureStoreReady();

	// Explicit fleet config in the month vault: pattern memory OFF (r2/C7).
	// Written unconditionally — a fleet vault must never run patterns-on, and
	// the content is a deterministic constant, so the write is idempotent.
	const vaultDir = join(vaultBase, ".usertrust");
	mkdirSync(vaultDir, { recursive: true });
	writeFileSync(
		join(vaultDir, "usertrust.config.json"),
		`${JSON.stringify({ patterns: { enabled: false } }, null, "\t")}\n`,
	);

	let current: FleetRecord | null = null;
	const client = await trust(
		fleetFakeClient(() => {
			if (current === null) throw new Error("fleet replay: fake client called outside a mint");
			return current;
		}),
		{ budget: FLEET_SENTINEL_BUDGET, dryRun: true, vaultBase, parentUserId: FLEET_PARENT_USER_ID },
	);
	const governed = client as unknown as {
		messages: { create: (args: FakeArgs) => Promise<unknown> };
	};

	try {
		for (const record of toMint) {
			const tag = fleetTag(record.sessionHash, record.messageId);
			journal.intent(record.messageId, record.sessionHash, fleetMeters(record));
			current = record;
			const { receipt } = (await withCostCenter(tag, () =>
				governed.messages.create({
					model: record.model,
					max_tokens: Math.max(record.outputTokens, 1),
					messages: [{ role: "user", content: FLEET_SYNTHETIC_PROMPT }],
				}),
			)) as GovernedMint;

			if (receipt.auditDegraded === true) {
				throw new Error(
					`fleet replay: auditDegraded receipt for ${record.messageId} — aborting the run; ` +
						`a fleet ledger whose audit write fails open has nothing to publish`,
				);
			}

			const provenance: FleetProvenance = {
				mode: "dry-run",
				source: "claude-code-transcript",
				occurredAt: record.occurredAt,
				capturedAt: new Date().toISOString(),
				sessionHash: record.sessionHash,
				isSidechain: record.isSidechain,
				messageId: record.messageId,
				cacheWriteTiers: { m5: record.cacheWrite5m, h1: record.cacheWrite1h },
			};
			appendFileSync(receiptStorePath, `${JSON.stringify({ receipt, provenance })}\n`);
			journal.done(record.messageId, receipt.auditHash, tag);
			minted += 1;
		}
	} finally {
		current = null;
		await client.destroy();
	}

	return { minted, recovered };
}
