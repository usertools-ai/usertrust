/**
 * Tests for Task 3 — route + transport (verify-page spec D1, D2, D4, R35-R37).
 *
 * Scope: the SSR fetch discipline (`no-store`, the `?include=checkpointHistory`
 * opt-in, the timeout/network-failure mapping), D4's fetch-skip on a
 * malformed ID, the two JSON download routes (`receipt.json` byte-for-byte,
 * `envelope.json` labeled distinctly), the dark-ship metadata (`noindex` +
 * `Cache-Control: no-store`), and the protocol-error-shell-vs-503 copy
 * distinction R37/D1 requires. `wire.ts`'s own rules (the §3 table, the §4
 * schema, R1/R4) are Task 2's tested contract and are not re-asserted here —
 * this file proves the TRANSPORT layer hands `parseResolverResponse`
 * trustworthy inputs, and does the right thing with its outputs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GET as envelopeJsonGET } from "./[receiptId]/envelope.json/route";
import { GET as receiptJsonGET } from "./[receiptId]/receipt.json/route";
import { idVectors } from "./fixtures/id-vectors";
import { verifyPageMetadata } from "./lib/metadata";
import {
	DEFAULT_RESOLVER_BASE_URL,
	DEFAULT_TRANSPORT_TIMEOUT_MS,
	jsonResourceStatus,
	resolverUrl,
	resolveVerifyPageState,
} from "./lib/resolve";
import {
	INVALID_ID_HEADLINE,
	PROTOCOL_ERROR_HEADLINE,
	shellHeadline,
	VERIFICATION_UNAVAILABLE_HEADLINE,
} from "./lib/shell-copy";
import { decodeReceiptBytes } from "./lib/wire";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(relPath: string): {
	routeParamId: string;
	wire: { httpStatus: number; headers: Record<string, string>; body: unknown };
} {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, relPath), "utf-8"));
}

function fixtureResponse(fixture: ReturnType<typeof loadFixture>): Response {
	const { httpStatus, headers, body } = fixture.wire;
	const raw = body === null ? "" : typeof body === "string" ? body : JSON.stringify(body);
	return new Response(raw, { status: httpStatus, headers });
}

/** A `fetch`-shaped spy that always answers with `fixture`, recording every call. */
function spyFetch(fixture: ReturnType<typeof loadFixture>) {
	const calls: [string | URL, RequestInit | undefined][] = [];
	const impl = async (input: string | URL, init?: RequestInit) => {
		calls.push([input, init]);
		return fixtureResponse(fixture);
	};
	return { impl: impl as typeof fetch, calls };
}

// ===========================================================================
// D4 — malformed ID never fetches
// ===========================================================================

test("D4: a malformed route param never calls fetch", async () => {
	let called = false;
	const fetchImpl = (async () => {
		called = true;
		throw new Error("must not be called");
	}) as typeof fetch;

	const state = await resolveVerifyPageState("not-a-ut1-id", { fetchImpl });

	assert.equal(called, false, "fetchImpl must never be invoked for an invalid ID");
	assert.equal(state.kind, "invalidId");
});

test("D4: every X7 invalid vector never fetches (reused, not re-hand-picked)", async () => {
	for (const vector of idVectors) {
		if (vector.expected !== "invalid") continue;
		let called = false;
		const fetchImpl = (async () => {
			called = true;
			throw new Error("must not be called");
		}) as typeof fetch;

		const state = await resolveVerifyPageState(vector.id, { fetchImpl });

		assert.equal(called, false, `${vector.label}: fetchImpl must never be invoked`);
		assert.equal(state.kind, "invalidId", vector.label);
	}
});

test("D4: an X7-valid ID DOES reach the resolver (the guard is not overzealous)", async () => {
	const valid = idVectors.find((v) => v.expected === "valid");
	if (!valid) throw new Error("fixture corpus must include at least one valid control");
	let called = false;
	const fetchImpl = (async () => {
		called = true;
		return new Response("", { status: 404 });
	}) as typeof fetch;

	await resolveVerifyPageState(valid.id, { fetchImpl });

	assert.equal(called, true, "a valid ID must still reach the resolver");
});

// ===========================================================================
// The SSR fetch discipline (D1/R35 no-store; the checkpointHistory opt-in)
// ===========================================================================

test("D1: the SSR fetch requests no-store and the checkpointHistory extension", async () => {
	const fixture = loadFixture("commit-checkpoint.json");
	const { impl, calls } = spyFetch(fixture);

	await resolveVerifyPageState(fixture.routeParamId, { fetchImpl: impl });

	assert.equal(calls.length, 1);
	const [url, init] = calls[0];
	assert.equal(init?.cache, "no-store", "the SSR fetch option itself must be no-store (D1)");
	assert.match(String(url), /\?include=checkpointHistory\b/);
	assert.match(String(url), new RegExp(`^${DEFAULT_RESOLVER_BASE_URL.replace(/[.]/g, "\\.")}/`));
	assert.match(String(url), new RegExp(encodeURIComponent(fixture.routeParamId)));
});

test("resolverUrl always appends the checkpointHistory opt-in", () => {
	const url = resolverUrl("ut1_WskkNFGvdE3dwzwzFyxcNC", "https://example.test/v1/receipts");
	assert.equal(
		url,
		"https://example.test/v1/receipts/ut1_WskkNFGvdE3dwzwzFyxcNC?include=checkpointHistory",
	);
});

test("a conforming fixture resolves to its exact verified PageState", async () => {
	const fixture = loadFixture("commit-checkpoint.json");
	const { impl } = spyFetch(fixture);

	const state = await resolveVerifyPageState(fixture.routeParamId, { fetchImpl: impl });

	assert.equal(state.kind, "verified");
	if (state.kind === "verified") {
		assert.equal(state.rung, "verified_checkpoint");
		assert.equal(state.receiptId, fixture.routeParamId);
	}
});

test("the 429 exemption reaches rateLimited without protocol-error contamination", async () => {
	const fixture = loadFixture("rate-limited.json");
	const { impl } = spyFetch(fixture);

	const state = await resolveVerifyPageState(fixture.routeParamId, { fetchImpl: impl });

	assert.equal(state.kind, "rateLimited");
	if (state.kind === "rateLimited") {
		assert.equal(state.retryAfter?.raw, "10");
	}
});

test("a 429 whose body read fails still resolves to rateLimited — the body is never even attempted", async () => {
	let textCalled = false;
	const fetchImpl = (async () => {
		return {
			status: 429,
			headers: new Headers({ "Retry-After": "10" }),
			text: async () => {
				textCalled = true;
				throw new Error("stream reset");
			},
		} as unknown as Response;
	}) as typeof fetch;

	const state = await resolveVerifyPageState("ut1_WskkNFGvdE3dwzwzFyxcNC", { fetchImpl });

	assert.equal(textCalled, false, "the 429 body must never be read, not merely discarded");
	assert.equal(state.kind, "rateLimited");
	if (state.kind === "rateLimited") {
		assert.equal(state.retryAfter?.raw, "10");
	}
});

test("a 503 verificationUnavailable body resolves to the operational state, not protocol error", async () => {
	const fixture = loadFixture("verification-unavailable.json");
	const { impl } = spyFetch(fixture);

	const state = await resolveVerifyPageState(fixture.routeParamId, { fetchImpl: impl });

	assert.equal(state.kind, "verificationUnavailable");
	if (state.kind === "verificationUnavailable") {
		assert.equal(state.retryAfter?.raw, "30");
	}
});

// ===========================================================================
// R37/D1 — transport failures fail closed, distinct from 503's copy
// ===========================================================================

test("a resolver timeout maps to the protocol-error shell (transportTimeout)", async () => {
	const fetchImpl = (async (_url, init) => {
		return new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			signal?.addEventListener("abort", () => {
				const err = new Error("The operation was aborted");
				err.name = "AbortError";
				reject(err);
			});
		});
	}) as typeof fetch;

	const state = await resolveVerifyPageState("ut1_WskkNFGvdE3dwzwzFyxcNC", {
		fetchImpl,
		timeoutMs: 5,
	});

	assert.equal(state.kind, "protocolError");
	if (state.kind === "protocolError") {
		assert.equal(state.reason, "transportTimeout");
	}
});

// The per-test timeout is deliberate: if this regresses, the deadline never
// fires and the awaited promise never settles, so an unbounded test would HANG
// CI instead of failing it. Bounded, a regression is a red check in seconds.
test("the deadline stays ARMED through the body: headers promptly, then a stalled stream, still times out", {
	timeout: 5_000,
}, async () => {
	// The failure this pins: clearing the timer once the headers arrive
	// disarms the deadline before the body is read, so a resolver that
	// answers and then stalls mid-stream hangs the SSR request forever —
	// a page that never renders instead of one that renders a shell.
	const fetchImpl = (async (_url, init) => {
		const signal = init?.signal;
		return {
			status: 200,
			headers: new Headers({ "Content-Type": "application/json" }),
			text: () =>
				new Promise<string>((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						const err = new Error("The operation was aborted");
						err.name = "AbortError";
						reject(err);
					});
				}),
		} as unknown as Response;
	}) as typeof fetch;

	const state = await resolveVerifyPageState("ut1_WskkNFGvdE3dwzwzFyxcNC", {
		fetchImpl,
		timeoutMs: 5,
	});

	assert.equal(state.kind, "protocolError");
	if (state.kind === "protocolError") {
		assert.equal(
			state.reason,
			"transportTimeout",
			"a stalled BODY is a timeout, like a stalled header",
		);
	}
});

test("a network failure (fetch rejects, not aborted) maps to the protocol-error shell (networkFailure)", async () => {
	const fetchImpl = (async () => {
		throw new TypeError("fetch failed");
	}) as typeof fetch;

	const state = await resolveVerifyPageState("ut1_WskkNFGvdE3dwzwzFyxcNC", { fetchImpl });

	assert.equal(state.kind, "protocolError");
	if (state.kind === "protocolError") {
		assert.equal(state.reason, "networkFailure");
	}
});

test("a body that fails to read (stream error) also fails closed as networkFailure", async () => {
	const fetchImpl = (async () => {
		return {
			status: 200,
			headers: new Headers(),
			text: async () => {
				throw new Error("stream reset");
			},
		} as unknown as Response;
	}) as typeof fetch;

	const state = await resolveVerifyPageState("ut1_WskkNFGvdE3dwzwzFyxcNC", { fetchImpl });

	assert.equal(state.kind, "protocolError");
	if (state.kind === "protocolError") {
		assert.equal(state.reason, "networkFailure");
	}
});

test("R37/D1: the protocol-error shell and 503's copy are pinned, verbatim, and distinct", () => {
	// The exact spec §7 quotes.
	assert.equal(PROTOCOL_ERROR_HEADLINE, "could not obtain a trustworthy answer from the resolver");
	assert.equal(
		VERIFICATION_UNAVAILABLE_HEADLINE,
		"verification is temporarily unavailable — an operational condition, not a cryptographic mismatch",
	);
	assert.notEqual(
		PROTOCOL_ERROR_HEADLINE,
		VERIFICATION_UNAVAILABLE_HEADLINE,
		"D1: 'the two never share copy'",
	);

	// And that the render path actually reaches for the right one per state.
	assert.equal(
		shellHeadline({
			kind: "protocolError",
			routeParamId: "x",
			reason: "networkFailure",
			detail: "d",
		}),
		PROTOCOL_ERROR_HEADLINE,
	);
	assert.equal(
		shellHeadline({ kind: "verificationUnavailable", routeParamId: "x" }),
		VERIFICATION_UNAVAILABLE_HEADLINE,
	);
	assert.equal(
		shellHeadline({ kind: "invalidId", routeParamId: "x", reason: "bad" }),
		INVALID_ID_HEADLINE,
	);
});

test("timeout and networkFailure are themselves distinct reasons within the protocol-error shell", async () => {
	const timeoutFetch = (async (_url, init) => {
		return new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => {
				const err = new Error("aborted");
				err.name = "AbortError";
				reject(err);
			});
		});
	}) as typeof fetch;
	const networkFetch = (async () => {
		throw new TypeError("fetch failed");
	}) as typeof fetch;

	const timeoutState = await resolveVerifyPageState("ut1_WskkNFGvdE3dwzwzFyxcNC", {
		fetchImpl: timeoutFetch,
		timeoutMs: 5,
	});
	const networkState = await resolveVerifyPageState("ut1_WskkNFGvdE3dwzwzFyxcNC", {
		fetchImpl: networkFetch,
	});

	assert.equal(timeoutState.kind, "protocolError");
	assert.equal(networkState.kind, "protocolError");
	if (timeoutState.kind === "protocolError" && networkState.kind === "protocolError") {
		assert.notEqual(timeoutState.reason, networkState.reason);
	}
});

test("DEFAULT_TRANSPORT_TIMEOUT_MS is a positive, finite budget", () => {
	assert.ok(Number.isFinite(DEFAULT_TRANSPORT_TIMEOUT_MS));
	assert.ok(DEFAULT_TRANSPORT_TIMEOUT_MS > 0);
});

// ===========================================================================
// D2 — receipt.json streams DECODED receiptBytes verbatim (byte equality)
// ===========================================================================

test("receipt.json streams receiptBytes byte-for-byte, with no parse/re-serialize", async () => {
	const fixture = loadFixture("commit-checkpoint.json");
	const body = fixture.wire.body as { receiptBytes: string };
	const expected = decodeReceiptBytes(body.receiptBytes);
	assert.ok(expected.ok);

	// The route calls `resolveVerifyPageState` with no injected `fetchImpl` —
	// exactly as it runs in production — so the GLOBAL fetch is stubbed for
	// the duration of this call rather than adding a test-only seam to the
	// route module itself.
	globalThisFetchOnce(fixture);
	try {
		const response = await receiptJsonGET(new Request("https://usertrust.ai/r/x/receipt.json"), {
			params: Promise.resolve({ receiptId: fixture.routeParamId }),
		} as never);

		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		const actualBytes = new Uint8Array(await response.arrayBuffer());
		assert.deepEqual(
			actualBytes,
			expected.ok ? expected.bytes : new Uint8Array(),
			"response bytes must equal decodeReceiptBytes(...).bytes exactly",
		);
	} finally {
		restoreGlobalFetch();
	}
});

test("receipt.json (with an injected resolver) is byte-identical to decodeReceiptBytes on every conforming fixture", async () => {
	const cases = ["commit-checkpoint.json", "commit-history.json", "commit-anchored.json"];
	for (const file of cases) {
		const fixture = loadFixture(file);
		const body = fixture.wire.body as { receiptBytes: string };
		const expected = decodeReceiptBytes(body.receiptBytes);
		assert.ok(expected.ok, `${file}: fixture receiptBytes must itself be R4-valid`);

		const state = await resolveVerifyPageState(fixture.routeParamId, {
			fetchImpl: spyFetch(fixture).impl,
		});
		assert.equal(state.kind, "verified", file);
		if (state.kind === "verified") {
			assert.equal(state.receiptBytesText, expected.text, `${file}: decoded text must match`);
			const bytes = new TextEncoder().encode(state.receiptBytesText);
			assert.deepEqual(bytes, expected.bytes, `${file}: re-encoded bytes must match exactly`);
		}
	}
});

test("receipt.json answers 404 with no-store for a receipt-less state (e.g. reserved)", async () => {
	const fixture = loadFixture("reserved.json");
	globalThisFetchOnce(fixture);
	try {
		const response = await receiptJsonGET(new Request("https://usertrust.ai/x"), {
			params: Promise.resolve({ receiptId: fixture.routeParamId }),
		} as never);
		assert.equal(response.status, 404);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
	} finally {
		restoreGlobalFetch();
	}
});

// ===========================================================================
// D2 — envelope.json is labeled ENVELOPE, distinct from receipt.json
// ===========================================================================

test("envelope.json serves the unsigned envelope, labeled distinctly from receipt.json", async () => {
	const fixture = loadFixture("commit-checkpoint.json");
	globalThisFetchOnce(fixture);
	try {
		const response = await envelopeJsonGET(new Request("https://usertrust.ai/x"), {
			params: Promise.resolve({ receiptId: fixture.routeParamId }),
		} as never);

		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		const disposition = response.headers.get("Content-Disposition") ?? "";
		assert.match(disposition, /envelope\.json/);
		assert.doesNotMatch(
			disposition,
			/^attachment; filename="[^"]*[^.]json"$/, // sanity: not literally "<id>.json"
		);

		const parsed = (await response.json()) as Record<string, unknown>;
		for (const key of ["receipt", "verification", "advisories"]) {
			assert.ok(Object.hasOwn(parsed, key), `envelope.json body must carry "${key}"`);
		}
		// D2: this route never serves the raw signed bytes receipt.json serves.
		assert.equal(Object.hasOwn(parsed, "receiptBytes"), false);
	} finally {
		restoreGlobalFetch();
	}
});

test("receipt.json and envelope.json download filenames never collide", async () => {
	const fixture = loadFixture("commit-checkpoint.json");

	globalThisFetchOnce(fixture);
	let receiptDisposition: string | null;
	try {
		const r = await receiptJsonGET(new Request("https://usertrust.ai/x"), {
			params: Promise.resolve({ receiptId: fixture.routeParamId }),
		} as never);
		receiptDisposition = r.headers.get("Content-Disposition");
	} finally {
		restoreGlobalFetch();
	}

	globalThisFetchOnce(fixture);
	let envelopeDisposition: string | null;
	try {
		const e = await envelopeJsonGET(new Request("https://usertrust.ai/x"), {
			params: Promise.resolve({ receiptId: fixture.routeParamId }),
		} as never);
		envelopeDisposition = e.headers.get("Content-Disposition");
	} finally {
		restoreGlobalFetch();
	}

	assert.ok(receiptDisposition && envelopeDisposition);
	assert.notEqual(receiptDisposition, envelopeDisposition);
	assert.equal(receiptDisposition, `attachment; filename="${fixture.routeParamId}.json"`);
	assert.equal(envelopeDisposition, `attachment; filename="${fixture.routeParamId}.envelope.json"`);
});

// ===========================================================================
// jsonResourceStatus — the download routes' status mapping
// ===========================================================================

test("jsonResourceStatus: verified is the only 2xx; everything else is an honest non-2xx", () => {
	assert.equal(jsonResourceStatus({ kind: "verified" } as never), 200);
	assert.equal(jsonResourceStatus({ kind: "invalidId" } as never), 400);
	assert.equal(jsonResourceStatus({ kind: "rateLimited" } as never), 429);
	assert.equal(jsonResourceStatus({ kind: "verificationUnavailable" } as never), 503);
	assert.equal(jsonResourceStatus({ kind: "integrityFailure" } as never), 409);
	assert.equal(jsonResourceStatus({ kind: "protocolError" } as never), 502);
	assert.equal(jsonResourceStatus({ kind: "pending" } as never), 404);
	assert.equal(jsonResourceStatus({ kind: "terminalNoReceipt" } as never), 404);
	assert.equal(jsonResourceStatus({ kind: "billedUnfinalized" } as never), 404);
	assert.equal(jsonResourceStatus({ kind: "unknownReceipt" } as never), 404);
});

// ===========================================================================
// D1/R35 — Cache-Control: no-store on the rendered page + dark-ship noindex
// ===========================================================================

test("next.config headers(): /r/:receiptId gets Cache-Control: no-store and X-Robots-Tag: noindex", async () => {
	const config = (await import("../../next.config")).default;
	const rules = await config.headers?.();
	assert.ok(rules, "next.config must export headers()");
	const rule = rules?.find((r) => r.source === "/r/:receiptId");
	assert.ok(rule, "no headers() rule matches /r/:receiptId");
	const byKey = Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
	assert.equal(byKey["Cache-Control"], "no-store");
	assert.equal(byKey["X-Robots-Tag"], "noindex, nofollow");
});

test("dark-ship: the page metadata sets robots index:false, follow:false", () => {
	assert.deepEqual(verifyPageMetadata.robots, { index: false, follow: false });
});

// ===========================================================================
// Test helpers for the two route handlers' "no injectable fetch" paths.
//
// The route handlers call `resolveVerifyPageState` with no `fetchImpl`
// override (exactly as they will run in production), so these tests stub
// the GLOBAL `fetch` for the duration of one call rather than adding a
// test-only seam to the route modules themselves.
// ===========================================================================

const realFetch = globalThis.fetch;

function globalThisFetchOnce(fixture: ReturnType<typeof loadFixture>): void {
	globalThis.fetch = (async () => fixtureResponse(fixture)) as typeof fetch;
}

function restoreGlobalFetch(): void {
	globalThis.fetch = realFetch;
}
