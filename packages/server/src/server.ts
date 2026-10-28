// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type {
	AbortOutcome,
	Authorization,
	Governor,
	JobType,
	ReleaseClass,
	ReleaseOutcome,
	TypeSource,
} from "usertrust";
import { sanitizeReleaseReason } from "usertrust";
import { sanitizeMapped, scrubForStderr } from "./cli/scrub.js";
import type { ServerConfig, TenantConfig } from "./config.js";
import { DEFAULT_LEDGER_TIMEOUT_MS, maxHoldLife, resolveTenant } from "./config.js";
import { EventBus } from "./events.js";
import {
	type HealthChildSpawner,
	LedgerHealth,
	type LedgerState,
	targetKey,
	worstState,
} from "./ledger-health.js";
import { type LedgerTarget, resolveTenantTargets } from "./ledger-probe.js";
import type { GovernorFactory } from "./pool.js";
import { GovernorPool } from "./pool.js";
import type { SettleRequest } from "./wire.js";
import {
	AbortRequestSchema,
	AuthorizeRequestSchema,
	ReleaseRequestSchema,
	SettleRequestSchema,
	toHttpError,
} from "./wire.js";

const MAX_BODY_BYTES = 1024 * 1024;
const SERVER_NAME = "usertrust-server";
/** What an authorize gets once `close()` has begun: no new hold is taken, and none is delivered. */
const SHUTTING_DOWN = {
	error: "shutting_down",
	reason: "the server is shutting down and takes no new holds",
} as const;
/** Reported by /healthz — read from this package's own manifest so the
 * version can never drift from the published package again (Addendum D5). */
const SERVER_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string })
	.version;

/**
 * What this server honours beyond the base two-phase API, published on /v1/health
 * for a client that must not assume it. An older server's request schemas STRIP
 * unknown keys, so a `principal` it does not understand is dropped in silence and
 * the call is recorded as nobody's: a client checks this list before sending one.
 * A later capability is APPENDED here; the name and shape never change.
 * `hold-expiry`: an authorize answer carries `expiresInMs`, the hold's remaining life.
 * `release`: `POST /v1/release` gives a hold back without a failure: no circuit-breaker
 * failure, and a `hold_released` record rather than `llm_call_failed`.
 * `cache-write-1h`: `POST /v1/settle` accepts `cacheWrite1hTokens`, the 1-hour share of
 * `cacheWriteTokens`, and prices it at the model's 1-hour write rate. Without it a client
 * must not send the field: an older server strips it and bills those tokens at the
 * cheaper 5-minute rate.
 */
const SERVER_CAPABILITIES = Object.freeze([
	"principal",
	"authorize-cache-tiers",
	"hold-expiry",
	"release",
	"cache-write-1h",
	// `job`: authorize accepts `job`/`jobState`/`usageFrom` and settle accepts
	// `usageTo` (and a `job`/`jobState` it must agree with). All recorded verbatim on
	// the audit records, none a pricing input, none selecting a wallet.
	"job",
	// `job-type`: authorize accepts `jobType` (the closed `JOB_TYPES` list) and `typeSource`
	// (`explicit` | `agent`) beside a `job`, and settle accepts either only to be CHECKED against
	// the hold's. Both are recorded verbatim on every record that carries `job`. A type is a
	// DECLARATION, not evidence, and no pricing, policy or wallet input. An older server strips
	// both keys, so a client sends them only to a server that lists this.
	"job-type",
	// `settle-unrecoverable`: `POST /v1/settle` for a transferId this server holds no hold for no
	// longer answers a bare 404 (and drops real provider spend): it answers `410
	// settlement_unrecoverable` (recorded on the chain, counted per tenant as
	// `settlementsUnrecoverable` on the authenticated /v1/budget), `409 already_settled` for a retry of a settle that went through in
	// this process, or `409 settle_in_progress`. BREAKING for a client that read every settle 404 the
	// same way; it checks this list before relying on the new codes (see the CHANGELOG).
	"settle-unrecoverable",
	// `refused`: `POST /v1/settle` accepts a per-tier `refused` flag (a figure the client refused to state as a count) and
	// charges the estimate when any tier is flagged. Without it a client must not send zeroed counts for a refused tier: an
	// older server strips the unknown key and would price the zeros at the floor.
	"refused",
	// `hold-ttl`: `POST /v1/authorize` accepts `holdTtlMs`, how long the hold should live, clamped to
	// [`pendingTtlMs`, `maxPendingTtlMs`]: the ledger's pending timeout for that hold and the server's
	// own sweep life for it alike. /v1/health also states `maxHoldTtlMs`, the ceiling. An older server
	// strips the key, and the hold keeps the default life.
	"hold-ttl",
]);
/**
 * A dryRun server has no ledger, so it writes no `user_data` tags — but it records
 * the principal on every audit record exactly as a ledger-backed server does, so it
 * honours the same list today. Kept as its own constant because a capability that
 * needs the ledger must be left out of it.
 */
const DRY_RUN_CAPABILITIES = Object.freeze([...SERVER_CAPABILITIES]);
const SWEEP_INTERVAL_MS = 30_000;
/**
 * How many settled transferIds the server remembers to tell a RETRY of a settle that went through
 * from a settle for a hold that is gone. In-process and bounded: the oldest is forgotten first, and a
 * restart forgets all of them. A retry past that memory reads as an unknown hold and is RECORDED as
 * `settlement_unrecoverable` (410): a duplicate record of spend the ledger did charge, never a lost
 * one. That is the declared residue of having no idempotency key.
 */
export const RECENTLY_SETTLED_MEMORY = 10_000;
/** How long a settle that finds its hold mid-release waits for the release before answering 409. */
const HELD_WAIT_MS = 2_000;
const HELD_POLL_MS = 50;
/** The longest a settle waits for the sweep's release to land: past the ledger's own pending timeout. */
const RELEASE_WAIT_MAX_MS = 30_000;
/** The longest transferId a settle for an UNKNOWN hold may carry: it is hashed into an audit event. */
const MAX_RECORDED_TRANSFER_ID = 256;
/** The reason a late hold is given back under: its authorize was answered without it. */
const LATE_RELEASE_REASON = "ledger reply after the authorize was refused";
/**
 * A late hold's void refused with one of these codes is DONE: the ledger no longer holds it (its
 * pending timeout ended it, or it was voided). The names are the ones `releaseVoidError` (core)
 * gives these TigerBeetle results.
 */
const DONE_VOID_ERRORS: ReadonlySet<string> = new Set([
	"pending_transfer_expired",
	"pending_transfer_already_voided",
]);

/** Max concurrent SSE streams a single tenant may hold open at once. */
const MAX_SSE_PER_TENANT = 8;
/** Drop an SSE subscriber whose kernel send buffer backs up past this. */
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

interface PendingEntry {
	auth: Authorization;
	tenantId: string;
	/** When the authorize request arrived, in epoch ms: what an explicit `sweepExpired(now)` reads. */
	createdAt: number;
	/**
	 * The same moment on the MONOTONIC clock (`performance.now()`): what an authorize
	 * answers from and the server's own sweep reads (`monoAge`). Process-local; it never
	 * leaves the process. A later keyed replay (#205) must keep this field as it is, never
	 * overwrite it with its own request's. And it must answer from the LARGER of the
	 * hold's monotonic and wall-clock ages: the monotonic clock stops while the host
	 * sleeps, the ledger's timeout does not, and an answer given long after the hold began
	 * would otherwise state more life than the hold has.
	 */
	startedMono: number;
	/**
	 * The job labels this hold was AUTHORIZED with, kept by the server from its own
	 * parse of the authorize body: what a settle's `job` is checked against, and the
	 * floor of its `usageTo`. Never read from the handle, which is the caller's.
	 */
	labels: {
		job?: string;
		jobType?: JobType;
		typeSource?: TypeSource;
		jobState?: "invalid";
		usageFrom?: string;
	};
	/**
	 * This hold's own sweep life, in ms (`holdLife`): what its authorize asked for (`holdTtlMs`),
	 * clamped, else `pendingTtlMs`. `remainingLifeMs` reads it in place of `pendingTtlMs`.
	 */
	lifeMs: number;
}

/**
 * The sweep life of a hold whose authorize asked for `requested` ms (`holdTtlMs`, capability
 * `hold-ttl`): clamped to [`pendingTtlMs`, `maxPendingTtlMs`]. Absent, `pendingTtlMs`, as before.
 */
export function holdLife(
	requested: number | undefined,
	config: { pendingTtlMs: number; maxPendingTtlMs?: number | undefined },
): number {
	if (requested === undefined) return config.pendingTtlMs;
	return Math.min(Math.max(requested, config.pendingTtlMs), maxHoldLife(config));
}

/**
 * The longest a pending hold can still be pending once it is `ageMs` old, in whole ms,
 * never negative: the shorter of the server's own sweep (`pendingTtlMs`) and the
 * ledger's pending timeout (`auth.holdTimeoutMs`), less that age. Both lives count from
 * the request's arrival, which comes before the hold was reserved. No expiry ends the
 * hold sooner; a settle, a void or a server restart can.
 *
 * One rule, read at the hold's MONOTONIC age (`monoAge`), so no wall-clock step moves it:
 * - An authorize answers it as `expiresInMs`. The answer is a DURATION: a client on
 *   another machine adds it to its own clock reading taken before it sent the request,
 *   and gets a time no later than the hold's last moment whatever the offset between
 *   the two clocks.
 * - The server's own sweep ends the hold when it reaches 0. An explicit
 *   `sweepExpired(now)` reads the same rule at the wall-clock age `now` gives.
 *
 * Null when the life is UNKNOWN: a ledger-backed hold whose handle does not state the
 * ledger's timeout. Nothing is advertised then, so a client never reuses the hold, and
 * the sweep falls back to `pendingTtlMs` alone. In dry run there is no ledger hold, so
 * the sweep alone is the life.
 */
export function remainingLifeMs(
	auth: { holdTimeoutMs?: number | undefined },
	config: { pendingTtlMs: number; dryRun: boolean },
	ageMs: number,
): number | null {
	const ledger = auth.holdTimeoutMs;
	if (ledger === undefined && !config.dryRun) return null;
	const life = Math.min(config.pendingTtlMs, ledger ?? Number.POSITIVE_INFINITY);
	const left = Math.floor(life - ageMs);
	// Anything unusable reads as no life left: a client then never reuses the hold.
	return Number.isSafeInteger(left) && left > 0 ? left : 0;
}

/** The answer's `expiresInMs`, or nothing when the hold's life is unknown. */
function expiresIn(lifeMs: number | null): { expiresInMs?: number } {
	return lifeMs === null ? {} : { expiresInMs: lifeMs };
}

export interface UsertrustServer {
	listen(): Promise<{ port: number }>;
	close(): Promise<void>;
	readonly bus: EventBus;
	readonly pool: GovernorPool;
	pendingCount(): number;
	/**
	 * Release every pending hold whose life is spent (`remainingLifeMs`), or, for a hold
	 * of unknown life, that is `pendingTtlMs` old. With no argument (the server's own
	 * sweep), a hold's age is read on the monotonic clock (`monoAge`). An explicit `now`
	 * is epoch ms, read against each hold's arrival.
	 */
	sweepExpired(now?: number): Promise<number>;
}

type TerminalKind = "settle" | "abort" | "release" | "sweep" | "shutdown";

/** The routes a request can reach, by the server's own names: a log line never echoes a caller's URL. */
const ROUTES = [
	"GET /v1/budget",
	"GET /v1/events",
	"POST /v1/authorize",
	"POST /v1/settle",
	"POST /v1/abort",
	"POST /v1/release",
] as const;
type RouteName = (typeof ROUTES)[number] | "sweep" | "shutdown";

/** The route a request names, if it is one of the server's own; otherwise "unrouted". */
function routeOf(req: IncomingMessage): RouteName | "unrouted" {
	const named = `${req.method ?? ""} ${req.url ?? ""}`;
	return (ROUTES as readonly string[]).includes(named) ? (named as RouteName) : "unrouted";
}

/** A bearer token wherever a message quotes one: `Bearer <token>`, or `Bearer` and no token. */
const BEARER_TOKEN = /\b(Bearer)\s+([^\s"',;]*)/gi;
/** The start of an api-key style value: its name, the separator, and its opening quote, if any. */
const API_KEY_START = /\b(x-api-key|api[-_]key)(["']?\s*[:=]\s*)(["']?)/gi;
/** `BEARER_TOKEN` and `API_KEY_START` at one place, with no word boundary asked for there. */
const BEARER_AT = /(Bearer)\s+[^\s"',;]+/iy;
const API_KEY_AT = /(x-api-key|api[-_]key)(["']?\s*[:=]\s*)(["']?)/iy;
/** An unquoted api-key value: it ends at whitespace, a quote, `,`, `;` or `&`. */
const UNQUOTED_VALUE = /[^\s"',;&]+/y;
/** What a `Bearer` token, or an unquoted api-key value, can still hold from a given point on. */
const BEARER_REST = /[^\s"',;]*/y;
const UNQUOTED_REST = /[^\s"',;&]*/y;
const BACKSLASH = 0x5c;

/**
 * Where the quoted value that starts at `from` ends: just past its closing `quote`, or at the end
 * of the text when it has none. An escape is a backslash and ANY character, a line terminator
 * included: with `\\.` in the old pattern, an escaped CR or LF ended the value there, and the rest
 * of it was logged. A backslash with nothing after it is not part of the value.
 */
function quotedEnd(text: string, from: number, quote: string): number {
	const close = quote.charCodeAt(0);
	for (let i = from; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === BACKSLASH) {
			if (i + 1 === text.length) return i;
			i++;
		} else if (code === close) return i + 1;
	}
	return text.length;
}

/** A part of a text to replace, `[start, end)`, and what stands in its place. */
interface Redaction {
	start: number;
	end: number;
	replacement: string;
	/** For a token (a `Bearer` token, an unquoted api-key value): what it can still hold after `end`. */
	rest?: RegExp;
	/** For a quoted api-key value: the quote that closes it. */
	quote?: string;
	/**
	 * A marker with no credential after it (what follows ends one): replaced only with a match of the
	 * caller's key that joins it, and the credential then runs on past that match.
	 */
	bare?: true;
}

const REDACTED = "[redacted]";

/** The index of the first item of `list` (in order) that is greater than `at`. */
function after(list: readonly number[], at: number): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((list[mid] ?? 0) <= at) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** `at` put into `list`, kept in order: at its end, but for a source whose parts' ends step back. */
function insert(list: number[], at: number): void {
	let i = list.length;
	while (i > 0 && (list[i - 1] ?? 0) > at) i--;
	list.splice(i, 0, at);
}

/**
 * `text` with each part that `sources` name replaced. Each source yields its parts in order of
 * `start`. Parts that overlap, from any sources, are replaced as one, from the first one's start to
 * the furthest end, by the replacement of the part that starts first (on a tie, of the earlier
 * source). Text outside every part is kept as it is.
 *
 * A credential runs on only where a match of the caller's key taken with it holds what ended it:
 * a token's delimiter, or a quoted value's closing quote. (5.1.0 replaced the key first, and its
 * patterns then read `[redacted]` and what followed as the credential: a token holds `[` and `]`.)
 * A token then runs on from the end of what is taken (`runOn`), and a quoted value through its next
 * closing quote; what starts inside joins too, and it runs on again only once a key's match taken
 * since holds what ended it there, until the end stops growing. With the key `tenant key`,
 * `Bearer tenant keyUPSTREAM` has the token `tenant`, which ends at the key's space: replaced
 * without running on, it would print `Bearer [redacted]UPSTREAM`. With the key `k"z`,
 * `api_key="xk"zUPSTREAM"` is one value, and so is `api_key="xTENANT"UPSTREAM` with the key
 * `TENANT"`. Nothing else runs on: in `api_key="x-api-key: 's'" tail`, the inner value ends at its
 * own closing quote, and no key holds it. A token inside a quoted value ends at that value's closing
 * quote, unless a key's match holds it: with the key `&k`, `x-api-key="a.api-key=T&k"tail` keeps
 * `tail`.
 *
 * A key's match that starts exactly where a token ends joins it, since that match took what ended
 * the token: with the key `'tenant`, `Bearer x'tenantUPSTREAM`. A marker with no credential after it
 * (a bare part) is replaced only with a key's match that joins it, and its credential, which the
 * key's match ended, runs on past that match: with the key `"key,`, `Bearer "key,UPSTREAM` is
 * printed as `Bearer [redacted]`. A group of bare parts alone is kept as it is (`Bearer ,x`).
 *
 * Linear: each run on starts where the taken parts end and reads only what they have not covered,
 * and each part is taken once. What ended each credential taken is kept by kind and by source, in
 * order, and so are a key's matches, each in order of start and of end: whether a key's match holds
 * one of them is a binary search.
 */
function applyRedactions(
	text: string,
	sources: readonly Iterator<Redaction>[],
	runOn: (rest: RegExp, from: number) => number = (rest, from) => {
		rest.lastIndex = from;
		rest.test(text);
		return rest.lastIndex;
	},
): string {
	const heads = sources.map((source) => source.next());
	let out = "";
	let kept = 0;
	for (;;) {
		let first: Redaction | undefined;
		let from = -1;
		heads.forEach((head, s) => {
			if (!head.done && (first === undefined || head.value.start < first.start)) {
				first = head.value;
				from = s;
			}
		});
		if (first === undefined) return out + text.slice(kept);
		const start = first.start;
		let end = first.end;
		let bare = true;
		// For each kind of credential, where what ended each one taken stands (a token's delimiter, a
		// quoted value's closing quote), by source, and whether a key's match holds one of them.
		const runs: { through: RegExp | string; enders: Map<number, number[]>; held: boolean }[] = [];
		// Where each token taken ends, to join a key's match that starts there.
		const tokenEnds = new Set<number>();
		// Where each quoted value taken ends, just past its closing quote.
		const quotedEnds = new Set<number>();
		// The matches of the caller's key (parts with neither) taken, by source.
		const keys = new Map<number, { starts: number[]; ends: number[] }>();
		// Whether a key's match taken holds the character at `at`: of a source's matches that start at
		// or before it, the last ends furthest.
		const holds = (at: number): boolean => {
			for (const { starts, ends } of keys.values()) {
				const i = after(starts, at);
				if (i > 0 && (ends[i - 1] ?? 0) > at) return true;
			}
			return false;
		};
		const take = (part: Redaction, s: number): void => {
			end = Math.max(end, part.end);
			if (part.bare === undefined) bare = false;
			const through = part.rest ?? part.quote;
			if (through === undefined) {
				let source = keys.get(s);
				if (source === undefined) {
					source = { starts: [], ends: [] };
					keys.set(s, source);
				}
				source.starts.push(part.start);
				source.ends.push(part.end);
				for (const run of runs) {
					if (run.held) continue;
					for (const enders of run.enders.values()) {
						const i = after(enders, part.start - 1);
						if ((enders[i] ?? end) < part.end) run.held = true;
					}
				}
				return;
			}
			let run = runs.find((r) => r.through === through);
			if (run === undefined) {
				run = { through, enders: new Map(), held: false };
				runs.push(run);
			}
			const ender = typeof through === "string" ? part.end - 1 : part.end;
			if (typeof through !== "string") tokenEnds.add(part.end);
			else quotedEnds.add(part.end);
			let enders = run.enders.get(s);
			if (enders === undefined) {
				enders = [];
				run.enders.set(s, enders);
			}
			insert(enders, ender);
			if (holds(ender)) run.held = true;
		};
		take(first, from);
		heads[from] = sources[from]?.next() ?? { done: true, value: undefined };
		for (let grown = true; grown; ) {
			// Every part that starts inside this one, or where it starts, joins it, which can take it
			// further. (So an empty part found twice, in two views of a text, is replaced once.) So does
			// a key's match that starts where a token ends.
			for (let joined = true; joined; ) {
				joined = false;
				const atToken = tokenEnds.has(end);
				heads.forEach((head, s) => {
					if (
						!head.done &&
						(head.value.start < end ||
							head.value.start === start ||
							(atToken &&
								head.value.start === end &&
								head.value.rest === undefined &&
								head.value.quote === undefined))
					) {
						take(head.value, s);
						heads[s] = sources[s]?.next() ?? { done: true, value: undefined };
						joined = true;
					}
				});
			}
			grown = false;
			for (const run of runs) {
				if (!run.held) continue;
				run.held = false;
				// A token inside a quoted value ends at its closing quote, unless a key's match holds it.
				if (typeof run.through !== "string" && quotedEnds.has(end) && !holds(end - 1)) continue;
				const reach =
					typeof run.through === "string"
						? quotedEnd(text, end, run.through)
						: runOn(run.through, end);
				// The credential now ends there: it runs on again only if a key's match taken since holds
				// what ends it. And another pass looks for a key's match that starts there.
				const ender = typeof run.through === "string" ? reach - 1 : reach;
				if (typeof run.through !== "string") tokenEnds.add(reach);
				else quotedEnds.add(reach);
				let enders = run.enders.get(-1);
				if (enders === undefined) {
					enders = [];
					run.enders.set(-1, enders);
				}
				insert(enders, ender);
				end = Math.max(end, reach);
				grown = true;
			}
		}
		if (bare) continue;
		out += text.slice(kept, first.start) + first.replacement;
		kept = end;
	}
}

/**
 * Each `Bearer <token>`: the whitespace and the token, replaced by one space and `[redacted]`. The
 * search goes on from inside each match, so a token cannot hide a `Bearer` that ends it
 * (`Bearer a.Bearer <token>`). A `Bearer` with no token (a quote, `,` or `;` after the whitespace)
 * is a bare part: replaced only with a match of the caller's key that starts there (see
 * `applyRedactions`). Linear: a `Bearer` inside a token needs whitespace after it, so it ends the
 * token, and no character is read more than twice.
 */
function* bearerSpans(text: string): Generator<Redaction> {
	const bearer = new RegExp(BEARER_TOKEN);
	for (let m = bearer.exec(text); m !== null; m = bearer.exec(text)) {
		const [whole, word, token] = m as unknown as [string, string, string];
		yield {
			start: m.index + word.length,
			end: m.index + whole.length,
			replacement: ` ${REDACTED}`,
			rest: BEARER_REST,
			...(token === "" ? { bare: true as const } : {}),
		};
		bearer.lastIndex = m.index + word.length;
	}
}

/**
 * Each api-key style value: `x-api-key: <v>`, `api_key=<v>`, `"api-key": "<v>"`. A QUOTED value runs
 * through its closing quote (or to the end, unclosed), whatever it holds: `"abc;def"` is one value,
 * never `abc` followed by text. Its name, separator and opening quote are kept; the value becomes
 * `[redacted]` and the closing quote.
 *
 * A regular expression finds only where a value starts; a loop finds where a quoted one ends.
 * The single pattern this replaces held the whole value in a quantified group, and V8 throws
 * `RangeError` (call stack exhausted) running such a group over millions of characters: on an
 * unclosed run of letters in that pattern, on a run of escapes in its unrolled form. Nothing here
 * repeats a group, so it reads text of any length in one linear pass. Its matches are the old
 * pattern's, exactly (the agreement test pins that).
 *
 * `overlapping` (what the redaction uses): the search goes on from where each value starts, not
 * from where it ends, so a value cannot hide a marker inside it. Otherwise `api_key=` in
 * `Bearer x.api_key= x-api-key: "<v>"` takes `x-api-key:` for its value, and the value after that
 * is logged. (The patterns once ran one after the other, `Bearer` first, and the token's
 * replacement had already removed the inner marker.) Linear: an unquoted value that starts inside
 * the last one ends where it does, so that end is reused; and a quoted value cannot start inside
 * one with the same quote (its opening quote would close the outer one), so no character is read
 * by more than one quoted value of each kind.
 */
function* apiKeySpans(text: string, overlapping = false): Generator<Redaction> {
	const start = new RegExp(API_KEY_START);
	const unquoted = new RegExp(UNQUOTED_VALUE);
	let unquotedFrom = -1;
	let unquotedEnd = -1;
	for (let m = start.exec(text); m !== null; m = start.exec(text)) {
		const quote = m[3] ?? "";
		const valueAt = start.lastIndex;
		if (overlapping && quote === "" && valueAt >= unquotedFrom && valueAt < unquotedEnd) {
			yield { start: valueAt, end: unquotedEnd, replacement: REDACTED, rest: UNQUOTED_REST };
			continue;
		}
		const value = apiKeyValue(text, quote, valueAt, unquoted);
		// No value here (`,`, `;` or `&` follows, or nothing). The old pattern looked again from the
		// next character, but the only start inside this one (`api-key` in `x-api-key`) meets the same
		// separator and fails too. Overlapping, it is a bare part, where a match of the caller's key
		// can start the value (see `applyRedactions`).
		if (value === undefined) {
			if (overlapping) {
				yield {
					start: valueAt,
					end: valueAt,
					replacement: REDACTED,
					rest: UNQUOTED_REST,
					bare: true,
				};
			}
			continue;
		}
		if (quote === "") {
			unquotedFrom = valueAt;
			unquotedEnd = value.end;
		}
		yield value;
		if (!overlapping) start.lastIndex = value.end;
	}
}

/** The api-key value that starts at `from` after its opening `quote` (or none), if there is one. */
function apiKeyValue(
	text: string,
	quote: string,
	from: number,
	unquoted: RegExp,
): Redaction | undefined {
	if (quote !== "") {
		const end = quotedEnd(text, from, quote);
		return { start: from, end, replacement: `${REDACTED}${quote}`, quote };
	}
	unquoted.lastIndex = from;
	if (!unquoted.test(text)) return undefined;
	return { start: from, end: unquoted.lastIndex, replacement: REDACTED, rest: UNQUOTED_REST };
}

/** The UTF-16 code units a marker can start with: `B`, `b`, `X`, `x`, `A`, `a`. */
function startsMarker(code: number): boolean {
	const lower = code | 0x20;
	return lower === 0x62 || lower === 0x78 || lower === 0x61;
}

/**
 * Each `Bearer <token>` and api-key value whose marker starts exactly where a match of one of
 * `secrets` ends, with no word boundary asked for there. Replacing the key puts `]` before the
 * marker, a boundary the text did not have: with the key `tenant`, `tenantBearer <token>` would
 * print `[redacted]Bearer <token>`. So the marker is looked for there in the text itself, never in
 * redacted text. The keys' matches end in order (each is found at its end, left to right), so they
 * are merged as they come, and only where a marker could start is a pattern tried.
 *
 * Linear: no value is read twice. An unquoted value that starts inside the last one ends where it
 * does (no character in between ends a value), so that end is reused. A quoted value cannot start
 * inside one with the same quote: its opening quote follows `:`, `=` or whitespace, never a
 * backslash, so the outer value closes on it. A token after `Bearer` ends at whitespace, and
 * `Bearer` needs whitespace after it, so no token holds the next one.
 */
function* markersAfterKeys(text: string, secrets: readonly string[]): Generator<Redaction> {
	const keys = secrets.map((secret) => secretSpans(text, secret));
	const heads = keys.map((key) => key.next());
	const bearer = new RegExp(BEARER_AT);
	const apiKey = new RegExp(API_KEY_AT);
	const unquoted = new RegExp(UNQUOTED_VALUE);
	let unquotedFrom = -1;
	let unquotedEnd = -1;
	for (let last = -1; ; ) {
		let at = -1;
		let from = -1;
		heads.forEach((head, k) => {
			if (!head.done && (from === -1 || head.value.end < at)) {
				at = head.value.end;
				from = k;
			}
		});
		if (from === -1) return;
		heads[from] = keys[from]?.next() ?? { done: true, value: undefined };
		if (at === last || !startsMarker(text.charCodeAt(at))) continue;
		last = at;
		bearer.lastIndex = at;
		const token = bearer.exec(text);
		if (token !== null) {
			yield {
				start: at + (token[1] ?? "").length,
				end: at + token[0].length,
				replacement: ` ${REDACTED}`,
				rest: BEARER_REST,
			};
			continue;
		}
		apiKey.lastIndex = at;
		const name = apiKey.exec(text);
		if (name === null) continue;
		const quote = name[3] ?? "";
		const valueAt = apiKey.lastIndex;
		if (quote === "" && valueAt >= unquotedFrom && valueAt < unquotedEnd) {
			yield { start: valueAt, end: unquotedEnd, replacement: REDACTED, rest: UNQUOTED_REST };
			continue;
		}
		const value = apiKeyValue(text, quote, valueAt, unquoted);
		if (value === undefined) continue;
		if (quote === "") {
			unquotedFrom = valueAt;
			unquotedEnd = value.end;
		}
		yield value;
	}
}

/** `text` with every api-key style value replaced by `[redacted]` (see `apiKeySpans`). */
export function redactApiKeys(text: string): string {
	return applyRedactions(text, [apiKeySpans(text)]);
}

/** What `redactSecrets` returns for text its patterns could not finish reading. */
const UNREADABLE = "[redacted: the message could not be scanned]";

/**
 * Whether a UTF-16 code unit is whitespace or a control character: what `[\s\x00-\x1f\x7f-\x9f]`
 * matches (a test compares the two over every code unit).
 */
function isGap(code: number): boolean {
	return (
		code <= 0x20 ||
		(code >= 0x7f && code <= 0xa0) ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

/**
 * Each place `secret` (a bearer key, which may hold spaces) stands in `text`, including where a
 * message has whitespace or a control character anywhere inside it: in place of a space, or within
 * a word, as a hard-wrapped key in a dump has (sanitizing removes a control character and joins
 * what was on either side). A plain match misses those, and then the `Bearer` pattern, or an
 * api-key one, takes the key's first part and leaves the rest in the line.
 *
 * Whitespace and control characters are left out of both the key and the text, and the key is
 * looked for, literally, in what remains (Knuth-Morris-Pratt), each match mapped back to the text
 * from its first character to its last. Finding a key with a space removed, or added, redacts text
 * that is not quite the key, which is the safe side. No pattern is built from the key, so no key,
 * of any length or content, can make one fail to compile; the search reads each character of the
 * text once, with a fallback bounded by the key's length in all, so it is linear for any key, and
 * it holds only the key's length in memory. Overlapping places are all yielded. Nothing for a
 * secret with no other character in it.
 */
function* secretSpans(text: string, secret: string): Generator<Redaction> {
	const key: number[] = [];
	for (let i = 0; i < secret.length; i++) {
		const code = secret.charCodeAt(i);
		if (!isGap(code)) key.push(code);
	}
	const k = key.length;
	if (k === 0) return;
	// fallback[q]: the length of the longest proper prefix of the key's first q + 1 characters that
	// is also a suffix of them.
	const fallback = new Int32Array(k);
	for (let q = 1, len = 0; q < k; q++) {
		while (len > 0 && key[q] !== key[len]) len = fallback[len - 1] ?? 0;
		if (key[q] === key[len]) len++;
		fallback[q] = len;
	}
	// Where the text's last k characters that are not a gap stand: a match's first one is among them.
	const where = new Int32Array(k);
	let seen = 0;
	let matched = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (isGap(code)) continue;
		where[seen % k] = i;
		seen++;
		while (matched > 0 && code !== key[matched]) matched = fallback[matched - 1] ?? 0;
		if (code === key[matched]) matched++;
		if (matched === k) {
			yield { start: where[seen % k] ?? 0, end: i + 1, replacement: REDACTED };
			matched = fallback[k - 1] ?? 0;
		}
	}
}

/**
 * `text` with every `secret` (the caller's own bearer key, when known), every `Bearer <token>` and
 * every api-key style value replaced by `[redacted]`. Scrubbing is not redaction: `scrubForStderr`
 * removes terminal control, never a credential.
 *
 * Every kind of match is found on the SAME text, before anything is replaced, and the parts they
 * cover are replaced once, overlapping ones as one. So no match can hide another: a key that holds
 * the word `Bearer` or an api-key name does not take that marker from the token after it, and a
 * heuristic pattern cannot take a key's first part and leave the rest. Each reads the whole text
 * in one linear pass. Should a pattern still throw `RangeError`, the whole text is replaced: it
 * fails closed, never returning text it did not scan. Any other error is not caught.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
	try {
		return applyRedactions(text, spansIn(text, secrets));
	} catch (err) {
		if (err instanceof RangeError) return UNREADABLE;
		throw err;
	}
}

/**
 * Every kind of match in `text`: each `Bearer <token>`, each api-key value (also where a match of
 * one of `secrets` ends, see `markersAfterKeys`) and each of `secrets`. No match hides another:
 * each search goes on from inside its matches.
 */
function spansIn(text: string, secrets: readonly string[]): Generator<Redaction>[] {
	return [
		bearerSpans(text),
		apiKeySpans(text, true),
		markersAfterKeys(text, secrets),
		...secrets.map((secret) => secretSpans(text, secret)),
	];
}

/** The index in the sanitized text of its first unit at or after unit `i` of the original. */
function sanitizedIndex(at: Int32Array, i: number): number {
	let lo = 0;
	let hi = at.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((at[mid] ?? 0) < i) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * `spans`, found in the original text, at the same characters of the sanitized one: a part keeps
 * those of its characters sanitizing kept. One whose characters were all removed is dropped (there
 * is nothing of it to print); an empty one (an unclosed quote at the end) stays, in its place, and
 * so does a bare one (`Bearer\t"key`: a key's match can still start where it ends).
 */
function* inSanitized(spans: Generator<Redaction>, at: Int32Array): Generator<Redaction> {
	for (const part of spans) {
		const start = sanitizedIndex(at, part.start);
		const end = sanitizedIndex(at, part.end);
		if (end > start || part.end === part.start || part.bare) yield { ...part, start, end };
	}
}

/**
 * The sanitized text with one space where sanitizing removed a run between two characters it kept
 * (`Bearer\t\x1b[31m\t<token>` reads `Bearer <token>`), and, for each unit, the unit of the
 * sanitized text it stands at: a space, at the character after its run, and marked in `gap`. And,
 * for each unit of the sanitized text, its unit in this one (`of`).
 */
function withGaps(
	clean: string,
	at: Int32Array,
): { text: string; to: Int32Array; gap: Uint8Array; of: Int32Array } {
	let gaps = 0;
	for (let j = 1; j < clean.length; j++) if ((at[j] ?? 0) !== (at[j - 1] ?? 0) + 1) gaps++;
	const to = new Int32Array(clean.length + gaps);
	const gap = new Uint8Array(clean.length + gaps);
	const of = new Int32Array(clean.length);
	let text = "";
	let n = 0;
	let from = 0;
	for (let j = 0; j < clean.length; j++) {
		if (j > 0 && (at[j] ?? 0) !== (at[j - 1] ?? 0) + 1) {
			text += `${clean.slice(from, j)} `;
			from = j;
			gap[n] = 1;
			to[n++] = j;
		}
		of[j] = n;
		to[n++] = j;
	}
	return { text: text + clean.slice(from), to, gap, of };
}

/**
 * `spans`, found in the text `withGaps` made, at the same characters of the sanitized text. A
 * part's spaces stand for nothing there: one that holds only spaces is dropped; an empty one (an
 * unclosed quote at the end) stays, in its place, and so does a bare one.
 */
function* fromGaps(
	spans: Generator<Redaction>,
	{ to, gap }: { to: Int32Array; gap: Uint8Array },
	length: number,
): Generator<Redaction> {
	for (const part of spans) {
		const start = part.start < to.length ? (to[part.start] ?? length) : length;
		const last = part.end - 1;
		const end =
			part.end === part.start
				? start
				: gap[last] === 1
					? (to[last] ?? length)
					: (to[last] ?? length) + 1;
		if (end > start || part.end === part.start || part.bare) yield { ...part, start, end };
	}
}

/**
 * `spans`, at their characters in the sanitized text `clean`, with each token run on through what it
 * can still hold there. A token found in the original text or the spaced view ends at a delimiter
 * that sanitizing may remove, and what stood after it is then joined to the token:
 * `Bearer\tpart-one\tpart-two` reads `Bearerpart-onepart-two`, and redacting `part-one` alone
 * would print `Bearer [redacted]part-two`, a line the patterns read differently. Run on, a token's
 * replacement ends where the token ends in the text it is written in.
 *
 * A marker that sanitizing joined to a token's end is read there too, with no word boundary asked
 * for, and its credential, run on, is replaced with the token: in `api_key: <v>\tBea\0rer <token>`,
 * the original splits the marker, the spaced view splits it again (`Bea rer`), and the sanitized
 * text glues it to the value (`<v>Bearer`). (5.1.0 replaced the value first, and its placeholder's
 * `]` put a boundary there.) Every token's end is looked at, since in a chain each one can be glued
 * to the next marker (`Bearer <a>\tBearer <b>\tBea\0rer <c>`). Linear: a source's tokens of one
 * kind end in order, so the reach of the last one is reused for an end inside it; and the markers
 * are read as `markersAt` reads them.
 *
 * A marker glued to the end of a match of the caller's key is read there too, and its credential is
 * a part of its own, after the key's: with the key `SECRET`, in `ESC SECRETBea\0rer <token>` the
 * escape sequence `ESC S` takes the key's first character, so only the original text finds the key,
 * and only the sanitized text reads the marker whole (`ECRETBearer`). The key's matches end in order,
 * so their markers' credentials start in order, and each is yielded before the first part that
 * starts after it.
 */
function* throughTokens(spans: Iterable<Redaction>, clean: string): Generator<Redaction> {
	const reached = new Map<RegExp, { from: number; reach: number }>();
	const markerAt = markersAt(clean);
	const after: Redaction[] = [];
	let next = 0;
	for (const part of spans) {
		for (; next < after.length && (after[next]?.start ?? 0) <= part.start; next++) {
			yield after[next] as Redaction;
		}
		const rest = part.rest;
		if (rest === undefined) {
			const marker = part.quote === undefined ? markerAt(part.end) : undefined;
			if (marker !== undefined) after.push(marker);
			yield part;
			continue;
		}
		let run = reached.get(rest);
		if (run === undefined || part.end < run.from || part.end > run.reach) {
			rest.lastIndex = part.end;
			rest.test(clean);
			run = { from: part.end, reach: rest.lastIndex };
			reached.set(rest, run);
		}
		run.reach = Math.max(run.reach, markerAt(part.end)?.end ?? -1);
		yield { ...part, end: run.reach };
	}
	for (; next < after.length; next++) yield after[next] as Redaction;
}

/**
 * A reader of `clean` that gives, for a place in it, the credential whose `Bearer` or api-key marker
 * starts exactly there, with no word boundary asked for, as `markersAfterKeys` yields it; none if no
 * marker does. (A match in `clean` ends at a delimiter, so there is nothing to run on.) Linear over
 * any places, as `markersAfterKeys` is: an unquoted value that starts inside the last one ends where
 * it does, so that end is reused; a quoted value cannot start inside one with the same quote; and a
 * `Bearer` token ends at whitespace, so the next token starts past it.
 */
function markersAt(clean: string): (at: number) => Redaction | undefined {
	const bearer = new RegExp(BEARER_AT);
	const apiKey = new RegExp(API_KEY_AT);
	const unquoted = new RegExp(UNQUOTED_VALUE);
	let last = -1;
	let lastFound: Redaction | undefined;
	let unquotedFrom = -1;
	let unquotedEnd = -1;
	const find = (at: number): Redaction | undefined => {
		if (!startsMarker(clean.charCodeAt(at))) return undefined;
		bearer.lastIndex = at;
		const token = bearer.exec(clean);
		if (token !== null) {
			return {
				start: at + (token[1] ?? "").length,
				end: at + token[0].length,
				replacement: ` ${REDACTED}`,
				rest: BEARER_REST,
			};
		}
		apiKey.lastIndex = at;
		const name = apiKey.exec(clean);
		if (name === null) return undefined;
		const quote = name[3] ?? "";
		const valueAt = apiKey.lastIndex;
		if (quote === "" && valueAt >= unquotedFrom && valueAt < unquotedEnd) {
			return { start: valueAt, end: unquotedEnd, replacement: REDACTED, rest: UNQUOTED_REST };
		}
		const value = apiKeyValue(clean, quote, valueAt, unquoted);
		if (value === undefined) return undefined;
		if (quote === "") {
			unquotedFrom = valueAt;
			unquotedEnd = value.end;
		}
		return value;
	};
	return (at) => {
		if (at !== last) {
			last = at;
			lastFound = find(at);
		}
		return lastFound;
	};
}

/**
 * `text` sanitized as `scrubForStderr` sanitizes it (never clipped), with every credential in it
 * redacted: what `redactSecrets` finds in three views of it, together, replaced once in the
 * sanitized text. Each view can show what the others hide. In the ORIGINAL text, the delimiters
 * the patterns read are still there, and an escape sequence cannot take a key's first character
 * with it. In the SANITIZED text, a marker or a key a control character split is whole (`Bea\0rer`,
 * `x-api\x07-key`), and a key that would take part of the marker in the original cannot hide it
 * there. In the sanitized text with one space for each run it removed, a separator made of removed
 * characters still separates: `Bearer\t\x1b[31m\t<token>` is one word once sanitized, and in the
 * original the pattern takes the escape sequence for the token. A token from any view runs on
 * through what sanitizing joined to its end (`throughTokens`), and so does one that runs on past a
 * key's match (`runOn`): where it stops in the original text or the spaced view, a marker sanitizing
 * glued there is read, as at a token's end. With the key `k x`, in `api_key=Ak xB\tBea\0rer <token>`
 * the value runs on past the key's match to `B`, and the sanitized text glues `Bearer` to it.
 *
 * The replacement is made in the sanitized text itself, and nothing removes a character after it:
 * every character the result holds outside a placeholder stands next to the ones it stood next to
 * in the sanitized text, which was read. (Redacting the original and sanitizing after could join
 * what was apart: an OSC sequence whose terminator a redaction took runs further, and the
 * characters on either side of it meet.) No match is ever looked for in redacted text. On
 * `RangeError`, the whole text is replaced, as `redactSecrets` does.
 */
export function redactSanitized(text: string, secrets: readonly string[] = []): string {
	try {
		const { clean, at } = sanitizeMapped(text);
		const spaced = withGaps(clean, at);
		const markerAt = markersAt(clean);
		const runOn = (rest: RegExp, from: number): number => {
			rest.lastIndex = from;
			rest.test(clean);
			let reach = rest.lastIndex;
			// From just after the sanitized text's character before `from`, in each view.
			rest.lastIndex = (at[from - 1] ?? -1) + 1;
			rest.test(text);
			const original = sanitizedIndex(at, rest.lastIndex);
			rest.lastIndex = (spaced.of[from - 1] ?? -1) + 1;
			rest.test(spaced.text);
			const inSpaced = spaced.to[rest.lastIndex] ?? clean.length;
			for (const stop of [original, inSpaced]) reach = Math.max(reach, markerAt(stop)?.end ?? -1);
			return reach;
		};
		return applyRedactions(
			clean,
			[
				...spansIn(text, secrets).map((spans) => inSanitized(spans, at)),
				...spansIn(clean, secrets),
				...spansIn(spaced.text, secrets).map((spans) => fromGaps(spans, spaced, clean.length)),
			].map((spans) => throughTokens(spans, clean)),
			runOn,
		);
	} catch (err) {
		if (err instanceof RangeError) return UNREADABLE;
		throw err;
	}
}

/**
 * `text` with each whitespace run that holds a line break replaced by one space: what
 * `/\s*\n\s*\/g` replaced, read in one pass. That pattern is QUADRATIC: it retries its leading
 * `\s*` from every position of a whitespace run with no line break (500k spaces took 162 s), so it
 * must not come back. Here each run is matched once, from its start to its end.
 */
export function joinLines(text: string): string {
	return text.replace(/\s+/g, (run) => (run.includes("\n") ? " " : run));
}

/**
 * One line for the operator's log about an error a client only ever sees as the opaque
 * `500 internal`: which tenant, which route, and the error's own name and message, so a
 * tenant refused at its first request (its vault, say) says why somewhere. It carries no key,
 * header or request body of its own. The message is the server's or governor's text, which can
 * quote what a caller sent, so its escape sequences and control characters are removed and the
 * credentials in it REDACTED, in one step (`redactSanitized`, with the caller's own key in
 * `secrets`), on the WHOLE text. Its lines are then joined into one in one pass (`joinLines`; no
 * pattern reads a line break differently from other whitespace, so joining makes no new match).
 * Only then is it clipped to `MAX_PRINTED_CHARS`: a cut any earlier could keep a key's first part,
 * which no search after it can recognize.
 */
export function internalErrorLine(
	err: unknown,
	tenantId: string | undefined,
	route: RouteName | "unrouted",
	secrets: readonly string[] = [],
): string {
	const name = err instanceof Error ? err.name : typeof err;
	const message = err instanceof Error ? err.message : String(err);
	const joined = joinLines(redactSanitized(`${name}: ${message}`, secrets));
	// The clip is LAST: it only drops the end of text already redacted, so it can expose nothing.
	const text = scrubForStderr(joined);
	const tenant = tenantId === undefined ? "-" : scrubForStderr(tenantId);
	return `usertrust-server: internal error: tenant=${tenant} route=${route}: ${text}`;
}

const noop = (): void => {};

/**
 * One authorize request's state. It leaves WAITING exactly once, the first transition wins, and every
 * transition is synchronous and comes before any write: DELIVERED (the 200 was written and the hold is
 * in `pending`), ANSWERED (an error or a shadow answer was written), REFUSED (the deadline wrote the
 * 503) or ABANDONED (the client went away; nothing is written).
 */
type AuthorizeState = "waiting" | "delivered" | "answered" | "refused" | "abandoned";

/**
 * A late hold the server is giving back: its authorize was refused or abandoned, then the ledger
 * answered it. `voiding` until `release()` settles; `refused` when the ledger refused the void with a
 * code that does not mean "done", kept (and counted) until the hold's own life, counted from the late
 * reply, has run out.
 */
interface OwedEntry {
	tenantId: string;
	transferId: string;
	/**
	 * When the ledger's late reply reached the server, in epoch ms (an explicit `sweepExpired(now)`
	 * reads it). The hold's pending timeout starts when its reserve reaches the cluster, which after an
	 * outage is at recovery, not at the request's arrival; the reserve committed no later than its
	 * reply, so the hold's life counted from here is a safe upper bound.
	 */
	createdAt: number;
	/** The same moment on the monotonic clock (the server's own sweep reads it). */
	startedMono: number;
	state: "voiding" | "refused";
	code?: string;
	holdTimeoutMs?: number;
}

/** A transfer id in a log line: a short SHA-256 prefix, never the id itself. */
function idHash(transferId: string): string {
	return createHash("sha256").update(transferId, "utf-8").digest("hex").slice(0, 12);
}

/**
 * Log lines this process's servers could write nowhere: the sink failed (or there was none) and
 * the write to stderr failed too. Process-wide, never reset; served on `/v1/health`.
 */
let logLinesDropped = 0;

/**
 * `line` to stderr. It never throws, and a line stderr refuses is COUNTED in `logLinesDropped`.
 * The failure is read from THIS write's own callback, never from the stream's `'error'` event,
 * which also fires for every other writer's failed write in the process: those are not this
 * server's lines.
 */
function writeLogLine(line: string): void {
	let counted = false;
	const dropped = (): void => {
		if (counted) return;
		counted = true;
		logLinesDropped += 1;
	};
	try {
		process.stderr.write(`${line}\n`, (err) => {
			if (err) dropped();
		});
	} catch {
		dropped();
	}
}

/** Marks the `'error'` listener this module installs, so no copy of it installs a second one. */
const STDERR_CONTAINED = Symbol.for("usertrust-server.stderr-errors-contained");

/**
 * A write to a stderr whose reader has gone does not throw: Node reports EPIPE as an `'error'`
 * event on the stream, and an `'error'` with no listener is an uncaught exception that kills the
 * process. One listener, installed at most once per process and never removed, contains it. It
 * only stops the crash: each write's own callback still receives its error, and an embedder's
 * own `'error'` listeners are neither removed nor replaced.
 */
function containStderrErrors(): void {
	try {
		const stderr = process.stderr as NodeJS.WriteStream & { [STDERR_CONTAINED]?: true };
		if (stderr[STDERR_CONTAINED] === true) return;
		stderr.on("error", () => {});
		stderr[STDERR_CONTAINED] = true;
	} catch {
		/* a stderr that cannot take a listener: writeLogLine still never throws */
	}
}

/** `claim` found the entry gone or replaced: another terminal owns it, and this caller ended nothing. */
const NOT_CLAIMED = Symbol("not-claimed");

/**
 * A usertrust-server: the HTTP surface over one governor per tenant.
 *
 * PROCESS-WIDE SIDE EFFECT: the first server created in a process adds one `'error'` listener to
 * `process.stderr`, and it stays for the life of the process. Without it a write to a stderr whose
 * reader has gone (EPIPE) is an uncaught exception that ends the process at the server's first
 * logged 500. With it, an EPIPE on stderr from ANY writer in the embedding process (`console.warn`,
 * another library) is contained instead of crashing it. It is installed at most once per process,
 * and the embedder's own `'error'` listeners are neither removed nor replaced. A log line the server
 * could write nowhere is counted in `/v1/health`'s `logLinesDropped`.
 */
export function createUsertrustServer(opts: {
	config: ServerConfig;
	factory?: GovernorFactory;
	/**
	 * Where operator log lines go, one line per call. Default: stderr, as the CLI's own lines. A
	 * sink that throws or rejects is contained, and its line goes to stderr instead. Every server
	 * diagnostic goes here: internal errors, and the late-hold, expiry and shutdown notices.
	 *
	 * Contract: the sink returns nothing or a real promise. A custom thenable's OWN failures (a
	 * `then` method that is itself async and rejects, say, before calling the handler it was given)
	 * happen inside the embedder's code, outside this containment: not even `await` could observe
	 * them.
	 */
	log?: (line: string) => void;
	/**
	 * How a ledger health observer child is started (`config.ledgerHealth: "child"`). For tests:
	 * a server leaves it unset.
	 */
	spawnHealthChild?: HealthChildSpawner;
	/**
	 * The health child's keep-alive probe interval, in ms. Defaults to `HEALTH_KEEPALIVE_MS` (30 s).
	 * For tests: a server leaves it unset.
	 */
	healthKeepAliveMs?: number;
}): UsertrustServer {
	const { config } = opts;
	const sink = opts.log;
	containStderrErrors();
	/**
	 * The ONLY way this server writes a log line, and ONE containment boundary: the sink call, the
	 * test for a thenable (reading `then` included) and attaching its rejection handler all sit in
	 * one `try`, and every failure, synchronous or asynchronous, goes to one fallback,
	 * `writeLogLine`, which cannot throw and counts a line that stderr refused too. A failing sink
	 * therefore never stops a 500 from being sent, never surfaces as an unhandled rejection, and
	 * never breaks the sweep's or shutdown's best-effort release. Without a sink the line goes
	 * straight to `writeLogLine`: retrying stderr on stderr would only write it twice.
	 */
	const log = (line: string): void => {
		if (sink === undefined) {
			writeLogLine(line);
			return;
		}
		// A hostile thenable may call its rejection handler more than once: one line, one fallback.
		let fellBack = false;
		const fallBack = (): void => {
			if (fellBack) return;
			fellBack = true;
			writeLogLine(line);
		};
		try {
			const returned: unknown = sink(line);
			if (returned !== null && (typeof returned === "object" || typeof returned === "function")) {
				const then: unknown = (returned as { then?: unknown }).then;
				if (typeof then === "function") then.call(returned, undefined, fallBack);
			}
		} catch {
			fallBack();
		}
	};
	/** The internal-error line for `err`, logged; an error that cannot even be read is still logged. */
	function logInternalError(
		err: unknown,
		tenantId: string | undefined,
		route: RouteName | "unrouted",
		secrets: readonly string[] = [],
	): void {
		let line: string;
		try {
			line = internalErrorLine(err, tenantId, route, secrets);
		} catch {
			const tenant = tenantId === undefined ? "-" : scrubForStderr(tenantId);
			line = `usertrust-server: internal error: tenant=${tenant} route=${route}: (the error could not be read)`;
		}
		log(line);
	}
	/**
	 * Who each request authenticated as, by its response: the tenant, for the log line of an
	 * error, and the caller's own bearer key, so that line can redact it.
	 */
	const requestCaller = new WeakMap<ServerResponse, { tenantId: string; key: string }>();
	/**
	 * `toHttpError`, plus the operator's log line for the opaque 500. The client's answer is
	 * exactly `toHttpError`'s: the reason lands in the log, never in the response.
	 */
	function httpError(
		err: unknown,
		res: ServerResponse,
		route: RouteName | "unrouted",
	): ReturnType<typeof toHttpError> {
		const mapped = toHttpError(err);
		if (mapped.status === 500) {
			const caller = requestCaller.get(res);
			logInternalError(err, caller?.tenantId, route, caller === undefined ? [] : [caller.key]);
		}
		return mapped;
	}
	const bus = new EventBus();
	// Every governor creation is tracked for health, whichever way it is reached: an internal route, or
	// an embedder calling `server.pool.get(tenant)` itself. Tracking only in the routes would leave
	// such a governor unverified.
	const pool = new GovernorPool(config, opts.factory, trackCreation);
	const pending = new Map<string, PendingEntry>();
	// `${tenantId}\0${transferId}` of settles that completed in this process (FIFO, bounded by
	// RECENTLY_SETTLED_MEMORY) and of settles in flight, so a concurrent or repeated settle is told
	// apart from one whose hold is gone.
	// The memory is PER TENANT, so one tenant's settles can never evict another's remembered ids.
	// id -> how its settle ended: "settled" (it posted) or "ambiguous" (the ledger post's outcome is
	// unknown: it may have charged). A Map keeps insertion order, so eviction is FIFO.
	const recentlySettled = new Map<string, Map<string, "settled" | "ambiguous">>();
	// `${tenantId}\0${transferId}` -> the terminal that took the hold out of `pending` and is still running:
	// a settle, an abort, a release, the TTL sweep or a shutdown. The governor still holds the hold until that
	// terminal lands, so a settle that finds it must wait for the terminal itself (bounded by the governor's
	// own void), not for a fixed window. `claim` is the ONLY code that removes an entry from `pending`, and it
	// registers the terminal here in the same synchronous step: a route that took an entry out on its own,
	// without registering, left a settle racing it nothing to wait on (it polled 2 s and answered a 409 the
	// plugin reads as "claimed", so the usage was never charged or recorded).
	const claimed = new Map<string, { kind: TerminalKind; done: Promise<void> }>();
	/**
	 * Take an entry out of `pending` and run its terminal, registering the terminal in `claimed` in the same
	 * step. The first caller wins (the entry is gone for every later one). With `restoreOnThrow`, a terminal that
	 * THROWS puts the entry back before `done` resolves, so the hold stays retryable and a waiter that wakes sees
	 * it. Every path that ends a hold goes through here: pinned by tests/claim.test.ts, which requires exactly one
	 * delete call on `pending` and no clear call in this file, comments aside.
	 * It refuses (NOT_CLAIMED) unless `entry` is STILL the one in `pending`: a caller holding a stale reference
	 * (shutdown's snapshot of `pending`, taken before awaits) must not claim an entry a client terminal already
	 * took, overwrite its registration, or, when its terminal throws, put the entry back into `pending` on a
	 * closing server. The check lives here so every caller is safe, not only today's routes.
	 */
	function claim<T>(
		tenantId: string,
		transferId: string,
		entry: PendingEntry,
		kind: TerminalKind,
		restoreOnThrow: boolean,
		work: () => Promise<T>,
	): Promise<T | typeof NOT_CLAIMED> {
		if (pending.get(transferId) !== entry) return Promise.resolve(NOT_CLAIMED);
		pending.delete(transferId);
		const key = `${tenantId}\0${transferId}`;
		const run = (async (): Promise<T> => {
			try {
				return await work();
			} catch (err) {
				if (restoreOnThrow) pending.set(transferId, entry);
				throw err;
			} finally {
				claimed.delete(key);
			}
		})();
		claimed.set(key, { kind, done: run.then(noop, noop) });
		return run;
	}

	/**
	 * Ledger reachability (ledger-health.ts), present only with `config.ledgerHealth: "child"`
	 * outside dryRun, from `listen()` until `close()` (or a failed `listen()`).
	 */
	let health: LedgerHealth | undefined;
	/** `stopHealth()` ran: health never starts after it, even from a `listen()` already under way. */
	let healthStopped = false;
	/** `close()` has begun: a `listen()` still under way must not go on to create a listener. */
	let closeStarted = false;
	/** Each tenant's ledger target, as resolved when health started: its key. */
	let tenantTargets: Map<string, string> | undefined;
	/** Tenants whose governor is being created: they contribute `unknown` until it is verified. */
	const initializing = new Set<string>();
	/**
	 * Tenants whose governor exists, and whether the ledger it USES (`governor.config.tigerbeetle`)
	 * is the one health watches for it. A mismatch reads `unknown`: the tenant's config changed after
	 * the server started.
	 */
	const verified = new Map<string, boolean>();
	/** Each tenant's resolved governor: health re-verifies those created before it started. */
	const resolvedGovernors = new Map<string, Governor>();

	/**
	 * The pool's `onCreate`: a governor is initializing until it resolves, then verified against the
	 * target health watches for the tenant.
	 */
	function trackCreation(tenant: TenantConfig, created: Promise<Governor>): void {
		initializing.add(tenant.id);
		created.then(
			(governor) => {
				initializing.delete(tenant.id);
				resolvedGovernors.set(tenant.id, governor);
				verify(tenant, governor);
			},
			() => initializing.delete(tenant.id),
		);
	}

	function verify(tenant: TenantConfig, governor: Governor): void {
		const expected = tenantTargets?.get(tenant.id);
		if (expected === undefined) {
			verified.set(tenant.id, true);
			return;
		}
		const used = governor.config?.tigerbeetle;
		const matches =
			used !== undefined &&
			targetKey({ clusterId: used.clusterId, addresses: [...used.addresses] }) === expected;
		verified.set(tenant.id, matches);
		if (!matches) {
			log(
				`usertrust-server: tenant ${scrubForStderr(tenant.id)}'s ledger config changed after start; restart the server to watch its ledger`,
			);
		}
	}

	/** The tenant's ledger, as its `/v1/budget` reports it. */
	function tenantLedger(tenant: TenantConfig): LedgerState | "none" {
		if (config.dryRun) return "none";
		const key = tenantTargets?.get(tenant.id);
		if (health === undefined || key === undefined) return "unknown";
		if (initializing.has(tenant.id) || verified.get(tenant.id) !== true) return "unknown";
		return health.state(key);
	}

	/**
	 * Health's aggregate: the worst over the targets STILL IN USE, and `unknown` while a tenant's
	 * governor is being created or reads a ledger other than the one watched for it. A target in use
	 * is one some tenant not verified as mismatched still has: a tenant whose config moved to another
	 * ledger no longer keeps its old target in the aggregate (nobody uses it), but the mismatch itself
	 * reads `unknown`. A target another tenant still uses stays in, so an outage there reads
	 * `unreachable`.
	 */
	function aggregateLedger(): LedgerState | "none" {
		if (config.dryRun) return "none";
		if (health === undefined) return "unknown";
		const inUse = new Set<string>();
		for (const [id, key] of tenantTargets ?? []) {
			if (verified.get(id) !== false) inUse.add(key);
		}
		const states: LedgerState[] = [...inUse].map((key) => health?.state(key) ?? "unknown");
		if (initializing.size > 0) states.push("unknown");
		if ([...verified.values()].some((matches) => !matches)) states.push("unknown");
		return worstState(states);
	}

	/**
	 * Start health for `listen()`: one child per distinct target the tenants resolve to. Targets
	 * that cannot be resolved (a tenant's config cannot be read) leave health off, reading unknown,
	 * with one log line: never a throw out of `listen()`.
	 */
	async function startHealth(): Promise<void> {
		if (config.dryRun || config.ledgerHealth !== "child" || health !== undefined || healthStopped) {
			return;
		}
		let byTenant: Map<string, LedgerTarget>;
		try {
			byTenant = await resolveTenantTargets(config);
		} catch {
			log(
				"usertrust-server: ledger health is off: the tenants' ledger targets could not be resolved",
			);
			return;
		}
		if (healthStopped) return;
		tenantTargets = new Map([...byTenant].map(([id, target]) => [id, targetKey(target)]));
		// A governor created before this (through `server.pool.get`, before `listen()`) was verified
		// against no targets: check it against the ones health actually watches.
		for (const [id, governor] of resolvedGovernors) {
			const tenant = config.tenants.find((t) => t.id === id);
			if (tenant !== undefined) verify(tenant, governor);
		}
		health = new LedgerHealth([...byTenant.values()], {
			ledgerTimeoutMs,
			...(config.healthRespawnCooldownMs === undefined
				? {}
				: { respawnCooldownMs: config.healthRespawnCooldownMs }),
			...(opts.spawnHealthChild === undefined ? {} : { spawnChild: opts.spawnHealthChild }),
			...(opts.healthKeepAliveMs === undefined ? {} : { keepAliveMs: opts.healthKeepAliveMs }),
			// Through the server's one log path, as every other diagnostic of it.
			log: (line) => log(`usertrust-server: ledger health: ${line}`),
		});
		health.start();
	}

	/** The one terminal stop of health, for `close()` and a failed `listen()`: synchronous, idempotent. */
	function stopHealth(): void {
		healthStopped = true;
		health?.stop();
	}

	// Per tenant, and served only on the authenticated /v1/budget: the unauthenticated /v1/health
	// must not tell anyone when some tenant's settles are being dropped.
	const settlementsUnrecoverable = new Map<string, number>();
	/**
	 * A hold's age on the monotonic clock: what its authorize answer and the server's own
	 * sweep both read. No wall-clock step moves it, forward or back, so the sweep never
	 * ends a hold before the life it was advertised with. Declared: the monotonic clock
	 * does not count a host's sleep, which the ledger's timeout does. A hold of life L,
	 * aged a when a sleep of length D begins, keeps counting past its real end for
	 * min(D, L − a) after wake: at most one hold life, plus one sweep interval. Its budget
	 * stays reserved that long (a false denial, never an early void). From inside the
	 * process, a sleep and a forward wall-clock step look alike.
	 */
	const monoAge = (entry: PendingEntry): number => performance.now() - entry.startedMono;
	/** `remainingLifeMs`'s config for one hold: its own sweep life (`lifeMs`) as `pendingTtlMs`. */
	const entryLife = (entry: PendingEntry) => ({
		pendingTtlMs: entry.lifeMs,
		dryRun: config.dryRun,
	});
	/**
	 * Late holds being given back (see `OwedEntry`), keyed `${tenantId}\0${transferId}`. An entry is
	 * added BEFORE its `release()` starts, so a give-back waiting on the ledger is visible
	 * (`voidsOwed` on /v1/budget) from the moment it begins.
	 */
	const owed = new Map<string, OwedEntry>();
	/**
	 * Per governor (one pool entry per tenant, so keyed by tenant id): the authorizes whose request was
	 * refused or abandoned while the governor's `authorize()` had not settled. While any is in here the
	 * ledger is known not to have answered, and a new authorize on that governor is refused at once.
	 * An authorize leaves when its promise settles, however it settles.
	 */
	const unsettled = new Map<string, Set<object>>();
	const ledgerTimeoutMs = config.ledgerTimeoutMs ?? DEFAULT_LEDGER_TIMEOUT_MS;
	// Live SSE stream count per tenant id, enforcing MAX_SSE_PER_TENANT.
	const sseCounts = new Map<string, number>();
	let httpServer: Server | undefined;
	let sweeper: NodeJS.Timeout | undefined;

	function sendJson(res: ServerResponse, status: number, body: unknown): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(payload),
		});
		res.end(payload);
	}

	function readBody(req: IncomingMessage): Promise<string | null> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					// Stop buffering and let the caller answer 413; destroying the
					// socket here would reset the connection before the response
					// can be flushed to the client.
					req.removeAllListeners("data");
					req.removeAllListeners("end");
					resolve(null);
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
	}

	/** Extract the bearer key. Empty or whitespace-only tokens are rejected before hashing. */
	function bearerKey(req: IncomingMessage): string | null {
		const header = req.headers.authorization;
		if (!header?.startsWith("Bearer ")) return null;
		const token = header.slice("Bearer ".length);
		if (token.trim() === "") return null;
		return token;
	}

	/**
	 * The 503 an authorize gets when no answer came in time: from the ledger, or from this tenant's
	 * earlier authorizes queued ahead of it (the governor serves a tenant's authorizes one at a time).
	 * Nothing was authorized.
	 */
	function refuseUnavailable(tenant: TenantConfig, res: ServerResponse): void {
		const reason = `no answer came within ${ledgerTimeoutMs} ms, either from the ledger or from this tenant's earlier authorizes queued ahead of this one; nothing was authorized; retry later`;
		bus.publish(tenant.id, {
			type: "denied",
			error: "ledger_unavailable",
			reason,
			// Never a shadow, even in evaluate_only: nothing was evaluated.
			shadow: false,
			at: new Date().toISOString(),
		});
		sendJson(res, 503, { error: "ledger_unavailable", reason, retryAfterMs: ledgerTimeoutMs });
	}

	/** Today's answer to an authorize the governor refused: the mapped error, or evaluate-only's shadow 200. */
	function answerDenied(tenant: TenantConfig, err: unknown, res: ServerResponse): void {
		const mapped = httpError(err, res, "POST /v1/authorize");
		const shadow = config.enforcement === "evaluate_only" && mapped.status !== 500;
		bus.publish(tenant.id, {
			type: "denied",
			error: mapped.body.error,
			reason: mapped.body.reason,
			shadow,
			at: new Date().toISOString(),
		});
		if (shadow) {
			// Shadow ids are NOT transferIds: no reservation exists, so they can
			// never be settled or aborted (those routes 404 on unknown ids).
			sendJson(res, 200, {
				shadow: true,
				shadowId: `shadow_${randomUUID()}`,
				decision: "would_deny",
				reason: mapped.body.reason,
			});
			return;
		}
		sendJson(res, mapped.status, mapped.body);
	}

	/**
	 * Give back a hold whose authorize was answered without it (refused at the deadline, or abandoned
	 * by its client), then answered by the ledger. The obligation is registered in `owed` FIRST, then
	 * `release()` is called ONCE: the native void, submitted only after the reserve's reply, so it
	 * cannot meet `pending_transfer_not_found`. The hold never enters `pending`. If the ledger is down
	 * again, the release waits for it (the client never times out) and stays visible as `voiding`.
	 */
	function releaseLate(
		tenantId: string,
		governor: Governor,
		auth: Authorization,
		releaseClass: ReleaseClass,
	): void {
		const transferId = auth.transferId;
		const key = `${tenantId}\0${transferId}`;
		const entry: OwedEntry = {
			tenantId,
			transferId,
			// The obligation's clock starts at the late reply, never at the request's arrival (OwedEntry).
			createdAt: Date.now(),
			startedMono: performance.now(),
			state: "voiding",
			...(auth.holdTimeoutMs === undefined ? {} : { holdTimeoutMs: auth.holdTimeoutMs }),
		};
		owed.set(key, entry);
		const refused = (code: string): void => {
			entry.state = "refused";
			entry.code = code;
			log(
				`usertrust-server: a late hold's void was refused (transfer ${idHash(transferId)}, ${code}); it expires at the hold timeout`,
			);
		};
		let releasing: Promise<ReleaseOutcome>;
		try {
			releasing = governor.release(auth, LATE_RELEASE_REASON, { releaseClass });
		} catch (err) {
			refused(err instanceof Error ? err.constructor.name : "Error");
			return;
		}
		releasing.then(
			(outcome) => {
				if (owed.get(key) !== entry) return;
				if (!outcome.released) {
					// Teardown or another terminal owned the hold: never counted as a landed void.
					owed.delete(key);
					log(
						`usertrust-server: a late hold was taken by another terminal before its release (transfer ${idHash(transferId)})`,
					);
					return;
				}
				if (outcome.voidError === undefined || DONE_VOID_ERRORS.has(outcome.voidError)) {
					owed.delete(key);
					return;
				}
				refused(outcome.voidError);
			},
			(err: unknown) => {
				if (owed.get(key) !== entry) return;
				refused(err instanceof Error ? err.constructor.name : "Error");
			},
		);
	}

	async function handleAuthorize(
		tenant: TenantConfig,
		body: unknown,
		res: ServerResponse,
	): Promise<void> {
		const parsed = AuthorizeRequestSchema.safeParse(body);
		if (!parsed.success) {
			sendJson(res, 400, {
				error: "bad_request",
				reason: parsed.error.issues[0]?.message ?? "invalid",
			});
			return;
		}
		// Fast-fail: while an authorize on this governor that was refused or abandoned has not
		// settled, the ledger has not answered it, so a new one would only queue behind it.
		if (!config.dryRun && (unsettled.get(tenant.id)?.size ?? 0) > 0) {
			refuseUnavailable(tenant, res);
			return;
		}
		// The hold's clock starts NOW, before any ledger I/O this request causes: the
		// ledger's own pending timeout starts when the reserve commits, which is later.
		const createdAt = Date.now();
		const startedMono = performance.now();

		let state: AuthorizeState = "waiting";
		let timer: NodeJS.Timeout | undefined;
		/** This request's authorize, while it is running: what joins `unsettled` if the request ends first. */
		let running: object | undefined;
		const onClose = (): void => {
			if (!res.writableEnded) leave("abandoned");
		};
		/**
		 * This request's authorize joins the governor's `unsettled` set: it is past the deadline and the
		 * ledger has not answered it. Only then: a client hanging up early is no evidence of an outage.
		 */
		const joinUnsettled = (): void => {
			if (running === undefined) return;
			let set = unsettled.get(tenant.id);
			if (set === undefined) {
				set = new Set();
				unsettled.set(tenant.id, set);
			}
			set.add(running);
		};
		/** The one way out of WAITING: synchronous, first caller wins, before any write. */
		const leave = (to: Exclude<AuthorizeState, "waiting">): boolean => {
			if (state !== "waiting") return false;
			state = to;
			// An abandoned request keeps its deadline: if its authorize is still running when the deadline
			// passes, it joins `unsettled` then (with no write: the client is gone).
			if (timer !== undefined && to !== "abandoned") clearTimeout(timer);
			res.off("close", onClose);
			if (to === "refused") joinUnsettled();
			return true;
		};
		/** Is the client already gone: its socket destroyed, or the answer already ended? Read fresh each time. */
		const gone = (): boolean =>
			res.destroyed || res.socket?.destroyed === true || res.writableEnded;
		// "close" on the RESPONSE (never the request's, which fires on every completed POST body).
		res.on("close", onClose);
		if (gone()) {
			leave("abandoned");
			return;
		}
		if (!config.dryRun) {
			// tigerbeetle-node has no request timeout or cancel ("the TigerBeetle client will never time
			// out"): this deadline is the server's. A request it refuses stays queued and executes when
			// the cluster returns; its late hold is then voided (`releaseLate`), and the hold's pending
			// timeout stays the backstop.
			timer = setTimeout(() => {
				if (leave("refused")) refuseUnavailable(tenant, res);
				else if (state === "abandoned") joinUnsettled();
			}, ledgerTimeoutMs);
			timer.unref();
		}

		let governor: Governor;
		try {
			governor = await pool.get(tenant);
		} catch (err) {
			// Today's answer to a governor that could not be created; consumed if the request ended.
			if (leave("answered")) throw err;
			return;
		}
		// Acquisition finished after the request ended: its authorize is never started.
		if (state !== "waiting") return;

		const token = {};
		running = token;
		const settle = (): void => {
			running = undefined;
			if (timer !== undefined) clearTimeout(timer);
			const set = unsettled.get(tenant.id);
			if (set?.delete(token) === true && set.size === 0) unsettled.delete(tenant.id);
		};
		// The hold's life, clamped once (`holdLife`): the governor reserves it for that long, and the
		// sweep keeps it for that long. Unasked, the governor's own default, and `pendingTtlMs`.
		const { holdTtlMs: requestedLife, ...request } = parsed.data;
		const lifeMs = holdLife(requestedLife, config);
		let auth: Authorization;
		try {
			auth = await governor.authorize(
				requestedLife === undefined ? request : { ...request, holdTtlMs: lifeMs },
			);
		} catch (err) {
			settle();
			// A rejection after the request ended is consumed: no second write, no second event.
			if (leave("answered")) answerDenied(tenant, err, res);
			return;
		}
		settle();
		// The client never received this hold's transferId (the 503 was written instead, or it was
		// gone before any answer), so no call can have run under it: `unused`.
		if (state !== "waiting") {
			releaseLate(tenant.id, governor, auth, "unused");
			return;
		}
		// close() began while this authorize was in flight (it passed the check at the route, then waited
		// on its body, the governor or the ledger): its hold missed close()'s walk over the pending holds,
		// so it is not delivered. Nothing ran under it, so it is given back, and the caller is told why.
		if (closeStarted) {
			if (gone()) leave("abandoned");
			else if (leave("answered")) sendJson(res, 503, SHUTTING_DOWN);
			releaseLate(tenant.id, governor, auth, "unused");
			return;
		}
		// The client may be gone without its close event having run yet: then nothing is delivered.
		if (gone()) {
			leave("abandoned");
			releaseLate(tenant.id, governor, auth, "unused");
			return;
		}
		leave("delivered");
		const entry: PendingEntry = {
			auth,
			tenantId: tenant.id,
			createdAt,
			startedMono,
			labels: {
				...(parsed.data.job === undefined ? {} : { job: parsed.data.job }),
				...(parsed.data.jobType === undefined ? {} : { jobType: parsed.data.jobType }),
				...(parsed.data.typeSource === undefined ? {} : { typeSource: parsed.data.typeSource }),
				...(parsed.data.jobState === undefined ? {} : { jobState: parsed.data.jobState }),
				...(parsed.data.usageFrom === undefined ? {} : { usageFrom: parsed.data.usageFrom }),
			},
			lifeMs,
		};
		// The answer is written, and the hold registered, in one synchronous step: no settle for this
		// id can arrive between the two. A write that throws registers nothing: the hold is given back.
		try {
			sendJson(res, 200, {
				transferId: auth.transferId,
				estimatedCost: auth.estimatedCost,
				model: auth.model,
				createdAt: auth.createdAt,
				...expiresIn(remainingLifeMs(auth, entryLife(entry), monoAge(entry))),
			});
		} catch {
			state = "abandoned";
			// `call-unconfirmed`, not `unused`: the 200 may have reached the client. Most throws come
			// before any byte is queued (JSON.stringify, writeHead, end()'s argument checks), but end()
			// writes the payload, uncorks the socket and only then runs the response's `_finish`
			// (performance observers, a synchronous 'prefinish' emit), and a throw there follows a
			// sent answer.
			releaseLate(tenant.id, governor, auth, "call-unconfirmed");
			return;
		}
		pending.set(auth.transferId, entry);
		bus.publish(tenant.id, {
			type: "authorized",
			transferId: auth.transferId,
			model: auth.model,
			estimatedCost: auth.estimatedCost,
			at: new Date().toISOString(),
		});
	}

	async function handleSettle(
		tenant: TenantConfig,
		body: unknown,
		res: ServerResponse,
	): Promise<void> {
		const parsed = SettleRequestSchema.safeParse(body);
		if (!parsed.success) {
			sendJson(res, 400, { error: "bad_request", reason: "invalid settle request" });
			return;
		}
		// The echo fields are taken OUT of `usage`: they are checked below, never metered or passed on.
		const { transferId, job, jobState, jobType, typeSource, ...usage } = parsed.data;
		const entry = pending.get(transferId);
		if (!entry || entry.tenantId !== tenant.id) {
			await handleUnheldSettle(tenant, transferId, usage, res);
			return;
		}
		// The record carries the AUTHORIZE capture's labels. A settle that names a
		// different job (or job state) is refused BEFORE the claim, so nothing is written
		// and the hold stays settleable. A legitimate client never trips this: it settles
		// a hold under the job the hold was authorized with.
		if (
			(job !== undefined && job !== entry.labels.job) ||
			(jobState !== undefined && jobState !== entry.labels.jobState)
		) {
			sendJson(res, 400, {
				error: "bad_request",
				reason: "settle job differs from the hold's job",
			});
			return;
		}
		// The type is fixed by the authorize capture exactly as the job is: an echo that names a
		// type (or a source) the hold does not carry, including any type on an untyped hold, is
		// refused before the claim.
		if (
			(jobType !== undefined && jobType !== entry.labels.jobType) ||
			(typeSource !== undefined && typeSource !== entry.labels.typeSource)
		) {
			sendJson(res, 400, {
				error: "bad_request",
				reason: "settle job type differs from the hold's",
			});
			return;
		}
		if (
			usage.usageTo !== undefined &&
			entry.labels.usageFrom !== undefined &&
			Date.parse(entry.labels.usageFrom) > Date.parse(usage.usageTo)
		) {
			sendJson(res, 400, { error: "bad_request", reason: "usageTo precedes the hold's usageFrom" });
			return;
		}
		// Atomic claim: first concurrent caller wins; a governor failure re-inserts
		// the entry so a transient settle error stays retryable.
		try {
			const claimedNow = await claim(tenant.id, transferId, entry, "settle", true, async () => {
				const governor = await pool.get(tenant);
				const receipt = await governor.settle(entry.auth, usage);
				// A settle that reached the ledger and did not confirm (`settled: false`, recorded as
				// ambiguous) may STILL have charged: its retry is told so (409 settlement_ambiguous), never
				// "the charge stands" and never "authorize again", which could charge the call twice.
				rememberSettled(tenant.id, transferId, receipt.settled === false ? "ambiguous" : "settled");
				bus.publish(tenant.id, {
					type: "settled",
					transferId,
					cost: receipt.cost,
					budgetRemaining: receipt.budgetRemaining,
					at: new Date().toISOString(),
				});
				sendJson(res, 200, receipt);
			});
			// Another terminal took the hold between the lookup and the claim: this is an unheld settle.
			if (claimedNow === NOT_CLAIMED) await handleUnheldSettle(tenant, transferId, usage, res);
		} catch (err) {
			const mapped = httpError(err, res, "POST /v1/settle");
			sendJson(res, mapped.status, mapped.body);
		}
	}

	function rememberSettled(
		tenantId: string,
		transferId: string,
		how: "settled" | "ambiguous",
	): void {
		let map = recentlySettled.get(tenantId);
		if (map === undefined) {
			map = new Map();
			recentlySettled.set(tenantId, map);
		}
		map.set(transferId, how);
		if (map.size > RECENTLY_SETTLED_MEMORY) {
			const oldest = map.keys().next().value;
			if (oldest !== undefined) map.delete(oldest);
		}
	}

	/**
	 * Answers (and returns true) when the id is NOT an unknown hold after all: a settle for it is in flight,
	 * it was settled in this process, or its entry is back in `pending` (a release or abort that claimed it
	 * threw and put it back). Checked before EVERY record and once more after the last one: a release or abort
	 * takes the entry out of `pending` under a non-settle terminal (see `claimed`), so a settle that arrived meanwhile must not
	 * write settlement_unrecoverable and answer 410 ("authorize again") for a charge that stands.
	 */
	function answerIfKnown(tenant: TenantConfig, transferId: string, res: ServerResponse): boolean {
		const key = `${tenant.id}\0${transferId}`;
		if (claimed.get(key)?.kind === "settle") {
			sendJson(res, 409, {
				error: "settle_in_progress",
				reason: "a settle for this transferId is in progress: retry shortly",
				transferId,
			});
			return true;
		}
		const earlier = recentlySettled.get(tenant.id)?.get(transferId);
		if (earlier === "ambiguous") {
			sendJson(res, 409, {
				error: "settlement_ambiguous",
				reason:
					"the first settle's ledger post was ambiguous: it may have charged. Do not authorize again to settle it; check the ledger",
				transferId,
			});
			return true;
		}
		if (earlier === "settled") {
			sendJson(res, 409, {
				error: "already_settled",
				reason: "this transferId was already settled: the charge stands",
				transferId,
			});
			return true;
		}
		const live = pending.get(transferId);
		if (live !== undefined && live.tenantId === tenant.id) {
			sendJson(res, 409, {
				error: "hold_active",
				reason: "the hold is live again (a release or abort did not complete): retry the settle",
				transferId,
			});
			return true;
		}
		return false;
	}

	/**
	 * A settle for a transferId this server holds no hold for. It used to be a bare 404, which dropped
	 * real provider spend the ledger would never charge. Now: a settle in flight or a retry of one that
	 * went through is a 409 (nothing recorded); anything else is RECORDED on the chain as
	 * `settlement_unrecoverable` and answers 410. The record moves no money and re-opens nothing; the
	 * client re-authorizes and settles to be charged.
	 */
	async function handleUnheldSettle(
		tenant: TenantConfig,
		transferId: string,
		usage: Omit<SettleRequest, "transferId" | "job" | "jobState" | "jobType" | "typeSource">,
		res: ServerResponse,
	): Promise<void> {
		const key = `${tenant.id}\0${transferId}`;
		if (answerIfKnown(tenant, transferId, res)) return;
		// Only the RECORD of an unknown hold bounds the id (it is hashed into an audit event). The checks
		// above come first on purpose: a retry of an already-settled settle with a long id (a custom factory
		// may issue them for live holds) must still be told 409 already_settled / settlement_ambiguous, never
		// "names no hold here", which could send the client to re-authorize and charge twice.
		if (transferId.length > MAX_RECORDED_TRANSFER_ID) {
			sendJson(res, 400, {
				error: "bad_request",
				reason: `transferId longer than ${MAX_RECORDED_TRANSFER_ID} characters names no hold here`,
			});
			return;
		}
		try {
			const governor = await pool.get(tenant);
			const record = () =>
				governor.recordUnheldSettlement({
					transferId,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens,
					cacheWriteTokens: usage.cacheWriteTokens,
					cacheWrite1hTokens: usage.cacheWrite1hTokens,
					refused: usage.refused,
					chunksDelivered: usage.chunksDelivered,
					usageSource: usage.usageSource,
					computeMs: usage.computeMs,
					usageTo: usage.usageTo,
				});
			// A settle racing a sweep, a client release or a client abort: it has taken the hold out of
			// `pending` and is ending it, and the governor still holds it until that lands. Wait for it
			// (bounded: it is one ledger void) and answer what the settle then IS (a recorded 410), so the
			// race ends as it did when the answer was a 404. Only a hold that is still held after the
			// wait is a 409 hold_active.
			// The terminal is awaited directly, however long the ledger void takes: a fixed
			// window would turn a slow void into a 409 that the plugin never retries, and the spend would be
			// neither charged nor recorded. The poll below covers any other path that leaves a hold held.
			const inFlight = claimed.get(key);
			// Bounded beyond the ledger's own timeout: a terminal that never settles must not hold the settle
			// forever (it then falls through to the poll, and at worst a 409 hold_active).
			if (inFlight !== undefined && inFlight.kind !== "settle") {
				await Promise.race([
					inFlight.done,
					new Promise<void>((resolve) => setTimeout(resolve, RELEASE_WAIT_MAX_MS).unref()),
				]);
			}
			if (answerIfKnown(tenant, transferId, res)) return;
			let outcome = await record();
			for (
				let waited = 0;
				outcome.outcome === "held" && waited < HELD_WAIT_MS;
				waited += HELD_POLL_MS
			) {
				await new Promise<void>((resolve) => setTimeout(resolve, HELD_POLL_MS));
				// The state can change while we wait (a failed release puts the entry back, a settle may
				// then charge it): recheck before each record.
				if (answerIfKnown(tenant, transferId, res)) return;
				outcome = await record();
			}
			if (outcome.outcome === "held") {
				sendJson(res, 409, {
					error: "hold_active",
					reason: "the governor still holds this transferId",
					transferId,
				});
				return;
			}
			// ... and once more after the last record: if the id turned out to be known meanwhile, the charge
			// stands, so the answer is that, never "not charged, authorize again".
			if (answerIfKnown(tenant, transferId, res)) return;
			if (outcome.recorded) {
				settlementsUnrecoverable.set(tenant.id, (settlementsUnrecoverable.get(tenant.id) ?? 0) + 1);
			}
			bus.publish(tenant.id, {
				type: "settlement_unrecoverable",
				transferId,
				recorded: outcome.recorded,
				at: new Date().toISOString(),
			});
			sendJson(res, 410, {
				error: "settlement_unrecoverable",
				reason:
					"no hold for this transferId here (swept, restarted or already settled): the settle is recorded, not charged. Authorize again and settle to be charged.",
				transferId,
				recorded: outcome.recorded,
				// On the chain, but the writer reported a failure after it: said, never folded into `recorded`.
				...(outcome.auditDegraded === true ? { auditDegraded: true } : {}),
			});
		} catch (err) {
			const mapped = httpError(err, res, "POST /v1/settle");
			sendJson(res, mapped.status, mapped.body);
		}
	}

	async function handleAbort(
		tenant: TenantConfig,
		body: unknown,
		res: ServerResponse,
	): Promise<void> {
		const parsed = AbortRequestSchema.safeParse(body);
		if (!parsed.success) {
			sendJson(res, 400, { error: "bad_request", reason: "invalid abort request" });
			return;
		}
		const { transferId } = parsed.data;
		const entry = pending.get(transferId);
		if (!entry || entry.tenantId !== tenant.id) {
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		// Atomic claim with re-insert on failure (same contract as settle).
		let outcome: AbortOutcome | typeof NOT_CLAIMED;
		try {
			outcome = await claim(tenant.id, transferId, entry, "abort", true, async () => {
				const governor = await pool.get(tenant);
				return governor.abort(entry.auth, parsed.data.error);
			});
		} catch (err) {
			const mapped = httpError(err, res, "POST /v1/abort");
			sendJson(res, mapped.status, mapped.body);
			return;
		}
		if (outcome === NOT_CLAIMED || !outcome.aborted) {
			// Release's rule: the governor no longer held it, so this request aborted nothing
			// and must not say it did, and the entry stays out.
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		bus.publish(tenant.id, {
			type: "aborted",
			transferId,
			reason: parsed.data.error ?? "aborted",
			at: new Date().toISOString(),
		});
		sendJson(res, 200, {
			aborted: true,
			transferId,
			...(outcome.voidError === undefined ? {} : { voidError: outcome.voidError }),
		});
	}

	async function handleRelease(
		tenant: TenantConfig,
		body: unknown,
		res: ServerResponse,
	): Promise<void> {
		const parsed = ReleaseRequestSchema.safeParse(body);
		if (!parsed.success) {
			sendJson(res, 400, { error: "bad_request", reason: "invalid release request" });
			return;
		}
		const { transferId, reason, releaseClass } = parsed.data;
		const entry = pending.get(transferId);
		if (!entry || entry.tenantId !== tenant.id) {
			// "unknown transferId", never "unknown route": a client that could not read this
			// server's capabilities falls back to /v1/abort only on an unknown route.
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		// Abort's claim: the first caller wins, and a governor that THROWS puts the entry
		// back, so the release stays retryable.
		let outcome: ReleaseOutcome | typeof NOT_CLAIMED;
		try {
			outcome = await claim(tenant.id, transferId, entry, "release", true, async () => {
				const governor = await pool.get(tenant);
				return governor.release(entry.auth, reason, { releaseClass });
			});
		} catch (err) {
			const mapped = httpError(err, res, "POST /v1/release");
			sendJson(res, mapped.status, mapped.body);
			return;
		}
		if (outcome === NOT_CLAIMED || !outcome.released) {
			// The governor no longer held it (its settle is in flight, or it already
			// ended), so this request released nothing and must not say it did. The entry
			// stays out: a hold the governor does not own is not the sweep's to meet again.
			sendJson(res, 404, { error: "not_found", reason: "unknown transferId" });
			return;
		}
		bus.publish(tenant.id, {
			type: "released",
			transferId,
			// What the chain recorded, by the governor's own rule: never the raw body.
			reason: sanitizeReleaseReason(reason),
			at: new Date().toISOString(),
		});
		sendJson(res, 200, {
			released: true,
			transferId,
			...(outcome.voidError === undefined ? {} : { voidError: outcome.voidError }),
		});
	}

	function handleEvents(tenant: TenantConfig, req: IncomingMessage, res: ServerResponse): void {
		// Per-tenant fan-out cap: a tenant opening unbounded SSE streams would pin
		// memory and file descriptors. Reject past the cap; the slot is released
		// when the connection closes (below).
		const active = sseCounts.get(tenant.id) ?? 0;
		if (active >= MAX_SSE_PER_TENANT) {
			sendJson(res, 429, { error: "too_many_streams", reason: "SSE subscriber limit reached" });
			return;
		}
		sseCounts.set(tenant.id, active + 1);
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			const remaining = (sseCounts.get(tenant.id) ?? 1) - 1;
			if (remaining <= 0) sseCounts.delete(tenant.id);
			else sseCounts.set(tenant.id, remaining);
		};

		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(": connected\n\n");
		// SSE is best-effort operational telemetry — a broken pipe drops the
		// subscriber, it never breaks governance processing.
		const unsubscribe = bus.subscribe(tenant.id, (event) => {
			try {
				const ok = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				// Backpressure guard: a subscriber that cannot keep up (kernel send
				// buffer backed up past 1 MiB) is dropped rather than allowed to grow
				// unbounded. destroy() fires the close handler → unsubscribe + release.
				if (!ok && res.writableLength > MAX_SSE_BUFFER_BYTES) res.destroy();
			} catch {
				unsubscribe();
			}
		});
		const heartbeat = setInterval(() => {
			try {
				res.write(": heartbeat\n\n");
			} catch {
				clearInterval(heartbeat);
				unsubscribe();
			}
		}, 15_000);
		heartbeat.unref();
		req.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
			release();
		});
	}

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "/";
		if (req.method === "GET" && url === "/v1/health") {
			health?.poke();
			const ledger = aggregateLedger();
			sendJson(res, 200, {
				ok: ledger !== "unreachable",
				ledger,
				name: SERVER_NAME,
				version: SERVER_VERSION,
				capabilities: config.dryRun ? DRY_RUN_CAPABILITIES : SERVER_CAPABILITIES,
				// The longest hold an authorize may ask for (`hold-ttl`).
				maxHoldTtlMs: maxHoldLife(config),
				logLinesDropped,
			});
			return;
		}
		const key = bearerKey(req);
		const tenant = key ? resolveTenant(config, key) : null;
		if (!key || !tenant) {
			sendJson(res, 401, { error: "unauthorized", reason: "missing or invalid bearer key" });
			return;
		}
		requestCaller.set(res, { tenantId: tenant.id, key });
		if (req.method === "GET" && url === "/v1/budget") {
			const acquiring = pool.get(tenant);
			let governor: Governor | undefined;
			if (config.dryRun) {
				governor = await acquiring;
			} else {
				// Bounded as authorize is: a governor that cannot be created while the ledger is down
				// must not hold the answer.
				let timer: NodeJS.Timeout | undefined;
				governor = await Promise.race([
					acquiring,
					new Promise<undefined>((resolve) => {
						timer = setTimeout(() => resolve(undefined), ledgerTimeoutMs);
						timer.unref();
					}),
				]).finally(() => clearTimeout(timer));
			}
			if (governor === undefined) {
				sendJson(res, 503, {
					error: "ledger_unavailable",
					reason: `the tenant's governor was not ready within ${ledgerTimeoutMs} ms; retry later`,
					retryAfterMs: ledgerTimeoutMs,
					ledger: tenantLedger(tenant),
				});
				return;
			}
			const key = tenantTargets?.get(tenant.id);
			sendJson(res, 200, {
				remaining: governor.budgetRemaining(),
				settlementsUnrecoverable: settlementsUnrecoverable.get(tenant.id) ?? 0,
				voidsOwed: [...owed.values()].filter((entry) => entry.tenantId === tenant.id).length,
				ledger: tenantLedger(tenant),
				ledgerObserver:
					health !== undefined && key !== undefined
						? health.observer(key)
						: { failures: 0, lastFailure: null },
			});
			return;
		}
		if (req.method === "GET" && url === "/v1/events") {
			handleEvents(tenant, req, res);
			return;
		}
		if (
			req.method === "POST" &&
			(url === "/v1/authorize" ||
				url === "/v1/settle" ||
				url === "/v1/abort" ||
				url === "/v1/release")
		) {
			// Once close() has begun, no NEW hold: it would miss close()'s walk over the pending holds and
			// be voided under a caller that may already be spending it. Settles, aborts and releases stay
			// served, so a call already in flight can still report back.
			if (closeStarted && url === "/v1/authorize") {
				sendJson(res, 503, SHUTTING_DOWN);
				return;
			}
			const raw = await readBody(req);
			if (raw === null) {
				// The rest of the oversized body is never read — close the
				// connection after the response so the socket cannot be reused.
				res.setHeader("connection", "close");
				sendJson(res, 413, { error: "too_large", reason: "body exceeds 1 MiB" });
				return;
			}
			let body: unknown;
			try {
				body = JSON.parse(raw === "" ? "{}" : raw);
			} catch {
				sendJson(res, 400, { error: "bad_request", reason: "invalid JSON" });
				return;
			}
			if (url === "/v1/authorize") await handleAuthorize(tenant, body, res);
			else if (url === "/v1/settle") await handleSettle(tenant, body, res);
			else if (url === "/v1/abort") await handleAbort(tenant, body, res);
			else await handleRelease(tenant, body, res);
			return;
		}
		sendJson(res, 404, { error: "not_found", reason: "unknown route" });
	}

	/**
	 * End a hold the control plane gives up on itself (its life is spent, or the server
	 * is shutting down) through the governor's RELEASE terminal. Nothing failed, so it
	 * is no circuit-breaker failure and no `llm_call_failed` record (#238, #204).
	 * Answers what the governor did, or `undefined` when it could not be asked.
	 */
	async function releaseEntry(
		transferId: string,
		entry: PendingEntry,
		kind: "sweep" | "shutdown",
		reason: string,
	): Promise<ReleaseOutcome | undefined> {
		const tenant = config.tenants.find((t) => t.id === entry.tenantId);
		if (tenant === undefined) {
			// No tenant to ask: the entry still leaves through `claim`, never on its own.
			await claim("", transferId, entry, kind, false, async () => undefined);
			return undefined;
		}
		const ended = await claim(
			tenant.id,
			transferId,
			entry,
			kind,
			false,
			async (): Promise<ReleaseOutcome | undefined> => {
				try {
					const governor = await pool.get(tenant);
					return await governor.release(entry.auth, reason);
				} catch (err) {
					// Best-effort — the Governor's own destroy()/reconciliation voids
					// anything the control plane fails to release here. Logged, never silent.
					logInternalError(err, tenant.id, kind);
					return undefined;
				}
			},
		);
		return ended === NOT_CLAIMED ? undefined : ended;
	}

	async function sweepExpired(now?: number): Promise<number> {
		// One rule for every sweep: a hold is due when the life it was advertised with is
		// spent at its age, so the ledger's timeout, when it comes before `pendingTtlMs`,
		// frees the hold's budget then. A hold of unknown life is due at `pendingTtlMs`.
		// The server's own sweep reads the monotonic age; an explicit `now` is epoch ms.
		const due = (entry: PendingEntry): boolean => {
			const age = now === undefined ? monoAge(entry) : now - entry.createdAt;
			const left = remainingLifeMs(entry.auth, entryLife(entry), age);
			return left === null ? age >= entry.lifeMs : left === 0;
		};
		// A late hold whose void the ledger refused stays counted until the hold's own life, counted from
		// the late reply (OwedEntry), has run out (the ledger's pending timeout has ended it by then), plus
		// one sweep interval.
		for (const [key, entry] of owed) {
			if (entry.state !== "refused") continue;
			const age = now === undefined ? performance.now() - entry.startedMono : now - entry.createdAt;
			if (age < (entry.holdTimeoutMs ?? config.pendingTtlMs) + SWEEP_INTERVAL_MS) continue;
			owed.delete(key);
			log(
				`usertrust-server: a late hold whose void was refused has expired (transfer ${idHash(entry.transferId)}, ${entry.code ?? "unknown"})`,
			);
		}
		let swept = 0;
		for (const [transferId, entry] of pending) {
			if (!due(entry)) continue;
			swept += 1;
			await releaseEntry(transferId, entry, "sweep", "pending TTL expired");
			bus.publish(entry.tenantId, {
				type: "pending_expired",
				transferId,
				at: new Date().toISOString(),
			});
		}
		return swept;
	}

	return {
		bus,
		pool,
		pendingCount: () => pending.size,
		sweepExpired,
		async listen(): Promise<{ port: number }> {
			await startHealth();
			// startHealth() yields, so close() can run in that window: it finds no httpServer and
			// finishes. Creating one now would leave a listener and a sweeper nobody closes.
			if (closeStarted) {
				throw new Error("usertrust-server: close() ran before listen() finished; not listening");
			}
			return new Promise((resolve, reject) => {
				httpServer = createServer((req, res) => {
					route(req, res).catch((err: unknown) => {
						const mapped = httpError(err, res, routeOf(req));
						if (!res.headersSent) sendJson(res, mapped.status, mapped.body);
					});
				});
				httpServer.on("error", (err) => {
					// A failed listen() takes the same terminal stop as close(): no observer outlives a
					// server that never listened. An error after listening (a refused accept) is not a
					// failed listen(): health keeps running.
					if (httpServer?.listening === true) return;
					stopHealth();
					reject(err);
				});
				try {
					httpServer.listen(config.port, config.host, () => {
						sweeper = setInterval(() => {
							void sweepExpired();
						}, SWEEP_INTERVAL_MS);
						sweeper.unref();
						const address = httpServer?.address();
						const port =
							typeof address === "object" && address !== null ? address.port : config.port;
						resolve({ port });
					});
				} catch (err) {
					// A synchronous throw (ERR_SOCKET_BAD_PORT) rejects without an "error" event: it is
					// a failed listen() all the same, so it takes the same terminal stop.
					stopHealth();
					reject(err);
				}
			});
		},
		async close(): Promise<void> {
			closeStarted = true;
			// First, and synchronously: no probe, respawn or health child outlives this call.
			stopHealth();
			if (sweeper) clearInterval(sweeper);
			// What this PR leaves to the ledger's pending timeout at shutdown: authorizes still waiting
			// on the ledger after their request ended, and late holds whose void has not landed.
			const outstanding = [...unsettled.values()].reduce((n, set) => n + set.size, 0);
			const voiding = [...owed.values()].filter((entry) => entry.state === "voiding").length;
			if (outstanding > 0 || voiding > 0) {
				log(
					`usertrust-server: shutting down with ${outstanding} authorize(s) still waiting on the ledger and ${voiding} late hold void(s) not landed; their holds expire at the hold timeout`,
				);
			}
			// Release every remaining pending hold (best-effort) so the control plane
			// and the ledger stay consistent; Governor.destroy() voids at the ledger
			// layer as the backstop.
			const remaining = [...pending.entries()];
			// All at once, not one after another: a hold whose void never answers must not keep the
			// others from being voided and recorded (the command line bounds how long close() may take).
			await Promise.allSettled(
				remaining.map(async ([transferId, entry]) => {
					const outcome = await releaseEntry(transferId, entry, "shutdown", "server shutdown");
					// Announced only when the governor says it released the hold: one it no
					// longer held, or could not be asked about, was not released here.
					if (outcome?.released !== true) return;
					bus.publish(entry.tenantId, {
						type: "released",
						transferId,
						reason: "server shutdown",
						at: new Date().toISOString(),
					});
				}),
			);
			await new Promise<void>((resolve) => {
				if (!httpServer) return resolve();
				httpServer.closeAllConnections();
				httpServer.close(() => resolve());
			});
			await pool.destroyAll();
		},
	};
}
