/**
 * The verify page's TRANSPORT layer — the only place `/r/<receiptId>` (and
 * its two JSON siblings) talk to the resolver over the network.
 *
 * Sources: `docs/specs/2026-08-11-verify-page-design.md` D1 (SSR `no-store`,
 * the `?include=checkpointHistory` opt-in, the closed §3 HTTP table) and R37
 * (every transport failure fails closed to the protocol-error shell,
 * distinct from 503's own wording).
 *
 * This module owns exactly one job: turn a route param into a {@link
 * PageState} by fetching the resolver and handing the raw response to
 * `../lib/wire`'s `parseResolverResponse` — the ONLY place a resolver
 * response becomes something the page may render (wire.ts's own doc
 * comment). It never re-implements a wire rule itself.
 *
 * D4 — "the page validates the route param as a `ut1` ID BEFORE fetching...
 * a malformed ID never hits the resolver" — is why {@link validateReceiptId}
 * runs before `fetchImpl` is ever called, not merely before the response is
 * trusted: `parseResolverResponse` re-checks the same rule internally, but a
 * caller that fetched first and validated second would still have leaked a
 * request for a route param that can never name a receipt.
 */
import {
	type PageState,
	parseResolverResponse,
	type ResolverHeaders,
	transportFailureState,
	validateReceiptId,
} from "./wire";

/**
 * The resolver's one endpoint (receipt-spec resolver API, §1):
 * `GET https://api.usertools.ai/v1/receipts/{receiptId}`.
 *
 * Overridable via `USERTRUST_RESOLVER_BASE_URL` — staging/test environments
 * point this at a different host without touching code; production has no
 * env var set and gets the real resolver.
 */
export const DEFAULT_RESOLVER_BASE_URL = "https://api.usertools.ai/v1/receipts";

function resolverBaseUrl(): string {
	return process.env.USERTRUST_RESOLVER_BASE_URL?.trim() || DEFAULT_RESOLVER_BASE_URL;
}

/**
 * `?include=checkpointHistory` is OPT-IN on the resolver (D1, spec v0.5
 * correction): the resolver's default response omits `checkpointHistory`
 * entirely, and the history rung cannot render without it. The page's fetch
 * MUST request it on every call — there is no cheaper path that still lets
 * a `verified_checkpoint_history`/`verified_anchored` receipt render at its
 * warranted rung.
 */
export function resolverUrl(routeParamId: string, baseUrl: string = resolverBaseUrl()): string {
	return `${baseUrl}/${encodeURIComponent(routeParamId)}?include=checkpointHistory`;
}

/** Generous enough for a live resolver call, short enough that a hung
 * upstream doesn't hang the page render — no value is spec-mandated, so this
 * is an implementation default, not a normative one. */
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 8_000;

export interface ResolveOptions {
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Overrides {@link resolverBaseUrl} for a single call (tests). */
	baseUrl?: string;
	timeoutMs?: number;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * The only door from a route param to a {@link PageState}. Used by the page
 * route and both JSON routes (`receipt.json`, `envelope.json`) — one fetch
 * implementation, three consumers, so the transport rules (no-store, the
 * history opt-in, the timeout/network-failure mapping) can never drift
 * between them.
 *
 * Order of operations:
 *   1. **D4** — the §12 ID rule, before anything is fetched.
 *   2. **The SSR fetch** — `cache: "no-store"` (R35/D1), the resolver's one
 *      endpoint, `?include=checkpointHistory` always appended. A timeout or
 *      a network failure never reaches `parseResolverResponse` — there is no
 *      HTTP response to hand it, so the states are built directly via
 *      {@link transportFailureState} (R37's transport half), exactly as
 *      `wire.ts` documents.
 *   3. **The body** — read as text and handed, verbatim and unparsed, to
 *      `parseResolverResponse`, which owns every remaining rule (the §3 wire
 *      table, the §4 schema, R1/R4 identity and byte authority).
 */
export async function resolveVerifyPageState(
	routeParamId: string,
	options: ResolveOptions = {},
): Promise<PageState> {
	// 1 — D4: a malformed ID never reaches the resolver.
	const idCheck = validateReceiptId(routeParamId);
	if (!idCheck.valid) {
		return { kind: "invalidId", routeParamId, reason: idCheck.reason };
	}

	const fetchImpl = options.fetchImpl ?? fetch;
	const url = resolverUrl(routeParamId, options.baseUrl ?? resolverBaseUrl());
	const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			cache: "no-store",
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
	} catch (error) {
		return isAbortError(error)
			? transportFailureState(routeParamId, "timeout")
			: transportFailureState(
					routeParamId,
					"networkFailure",
					error instanceof Error ? error.message : String(error),
				);
	} finally {
		clearTimeout(timer);
	}

	let raw: string;
	try {
		raw = await response.text();
	} catch (error) {
		return transportFailureState(
			routeParamId,
			"networkFailure",
			`the resolver's response body could not be read: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	// 3 — everything else (the §3 table, the §4 schema, R1/R4) is wire.ts's.
	return parseResolverResponse({
		routeParamId,
		httpStatus: response.status,
		headers: response.headers as ResolverHeaders,
		raw,
	});
}

/**
 * The HTTP status the two JSON download routes (`receipt.json`,
 * `envelope.json`) answer with for a given {@link PageState}. Neither route
 * is named by §4/§4.2's wire table — that table is the RESOLVER's contract,
 * not this page's own download affordances (D2, §6 point 6) — so this
 * mapping is this task's own reasonable choice, not a spec-mandated one:
 * `verified` is the only kind either route has bytes for, so it is the only
 * 2xx; every other kind answers with the closest honest HTTP status for
 * "there is nothing to download," carrying the resolver's own status
 * forward where one exists (429/503) rather than inventing a new one.
 */
export function jsonResourceStatus(state: PageState): number {
	switch (state.kind) {
		case "verified":
			return 200;
		case "invalidId":
			return 400;
		case "rateLimited":
			return 429;
		case "verificationUnavailable":
			return 503;
		case "integrityFailure":
			return 409;
		case "protocolError":
			return 502;
		default:
			// pending / terminalNoReceipt / billedUnfinalized / unknownReceipt —
			// a real, understood answer, but never one with receipt bytes to serve.
			return 404;
	}
}
