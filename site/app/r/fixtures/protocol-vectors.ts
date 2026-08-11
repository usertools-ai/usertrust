/**
 * X6 — protocol-error vectors (verify-page spec R37 / §4.1's verdict
 * algebra / §4.2's transport rules).
 *
 * Every vector here MUST fail into the protocol-error shell — never green,
 * never 503's wording, never a silently-tolerated render. Six kinds, per
 * R37's enumeration: a malformed (non-JSON) body; an HTTP status outside
 * the §3 table; an HTTP-code/body-`status` mismatch; a missing/unsupported
 * `apiVersion` (429 excepted — that vector lives in the conforming set,
 * `rate-limited.json`, because it is the ONE case that must NOT reach the
 * protocol-error shell); a §4.1 verdict-algebra violation; and a simulated
 * transport failure (timeout / network failure — nothing to parse at all).
 *
 * The verdict-algebra vectors reuse a real conforming receipt/receiptBytes
 * pair (from `commit-checkpoint.json`) and mutate only `status`/
 * `verification`, so each vector isolates exactly the one algebra rule it
 * breaks rather than also being a "missing required member" case.
 */
import commitCheckpointFixture from "./commit-checkpoint.json";
import type { ProtocolVector, SuccessEnvelope } from "./types";

const baseSuccessBody = commitCheckpointFixture.wire.body as unknown as SuccessEnvelope;
const baseRouteId = commitCheckpointFixture.routeParamId;

function cloneBase(): SuccessEnvelope {
	return JSON.parse(JSON.stringify(baseSuccessBody)) as SuccessEnvelope;
}

export const protocolVectors: ProtocolVector[] = [
	// ---- malformed body: not JSON at all ----
	{
		label: "malformed body — truncated JSON",
		kind: "malformedBody",
		routeParamId: baseRouteId,
		rawBody: '{"apiVersion":"1","receiptId":"ut1_abc123","status":',
		reason: "Truncated mid-value — not parseable JSON. Never rendered as any receipt state.",
	},
	{
		label: "malformed body — HTML error page served as the response body",
		kind: "malformedBody",
		routeParamId: baseRouteId,
		rawBody: "<html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway</body></html>",
		reason:
			"A CDN/proxy error page, not a resolver JSON body. Common in practice; must fail closed, not render as 'unknown'.",
	},
	{
		label: "malformed body — empty response body",
		kind: "malformedBody",
		routeParamId: baseRouteId,
		rawBody: "",
		reason: "Zero-length body on a 200 — nothing to parse, so nothing trustworthy to render.",
	},

	// ---- HTTP status outside the §3 table ----
	{
		label: "out-of-table HTTP status — 500 Internal Server Error",
		kind: "outOfTableHttpStatus",
		routeParamId: baseRouteId,
		wire: {
			httpStatus: 500,
			headers: {},
			body: { apiVersion: "1", receiptId: baseRouteId, status: "internalError" },
		},
		reason:
			"500 is not one of the §3 wire codes (200/202/410/404/409/503/429). Fails closed regardless of body shape.",
	},
	{
		label:
			"out-of-table HTTP status — 301 redirect with no Location semantics the page understands",
		kind: "outOfTableHttpStatus",
		routeParamId: baseRouteId,
		wire: { httpStatus: 301, headers: {}, body: null },
		reason: "301 is not in the §3 table either; the page never guesses at a redirect's meaning.",
	},

	// ---- HTTP-code / body-status mismatch ----
	{
		label: 'HTTP/status mismatch — 200 carrying status: "unverifiable"',
		kind: "httpStatusBodyMismatch",
		routeParamId: baseRouteId,
		wire: {
			httpStatus: 200,
			headers: { "cache-control": "no-cache" },
			body: { apiVersion: "1", receiptId: baseRouteId, status: "unverifiable" },
		},
		reason:
			'"unverifiable" is a 409 status (§3 table); a 200 carrying it is a resolver that disagrees with its own wire code.',
	},
	{
		label: "HTTP/status mismatch — 410 carrying a ladder status",
		kind: "httpStatusBodyMismatch",
		routeParamId: baseRouteId,
		wire: {
			httpStatus: 410,
			headers: { "cache-control": "no-store" },
			body: { apiVersion: "1", receiptId: baseRouteId, status: "verified_checkpoint" },
		},
		reason:
			'"verified_checkpoint" only ever answers a 200 (§3 table); a 410 claiming it is a protocol violation, not a green receipt.',
	},

	// ---- §4.1 verdict-algebra violations ----
	(() => {
		const body = cloneBase();
		body.verification.steps.signature = { result: "failed", failure: "SIG_INVALID" };
		return {
			label: "verdict algebra — 200 verified_checkpoint with a mandatory step failed",
			kind: "verdictAlgebraViolation",
			routeParamId: baseRouteId,
			wire: { httpStatus: 200, headers: { "cache-control": "no-cache" }, body },
			reason:
				"`signature` is a mandatory base step (§4.1 rule 1); `failed` there disqualifies EVERY verified_* status. " +
				"A resolver that computed this and still answered 200 must not have.",
		} satisfies ProtocolVector;
	})(),
	(() => {
		const body = cloneBase();
		body.verification.steps.inclusion = { result: "unavailable" };
		return {
			label: "verdict algebra — 200 verified_checkpoint with a mandatory step unavailable",
			kind: "verdictAlgebraViolation",
			routeParamId: baseRouteId,
			wire: { httpStatus: 200, headers: { "cache-control": "no-cache" }, body },
			reason:
				"Mandatory base steps require `passed`; `unavailable` disqualifies them exactly like `failed` does " +
				"(§4.1 rule 1) — a mandatory step that did not run is not a verification.",
		} satisfies ProtocolVector;
	})(),
	(() => {
		const body = cloneBase();
		body.verification.checks.registryBinding = { result: "failed", failure: "ID_MISMATCH" };
		return {
			label: "verdict algebra — registryBinding: failed on a 200",
			kind: "verdictAlgebraViolation",
			routeParamId: baseRouteId,
			wire: { httpStatus: 200, headers: { "cache-control": "no-cache" }, body },
			reason:
				"registryBinding fails only on a positive contradiction (§7); a resolver that verified a contradiction " +
				"has no business serving the receipt as verified (§4.1 rule 2).",
		} satisfies ProtocolVector;
	})(),
	(() => {
		const body = cloneBase();
		body.verification.checks.registryBinding = { result: "unavailable" };
		return {
			label:
				"verdict algebra — registryBinding: unavailable on a 200 (v0.4 actor-conflation correction)",
			kind: "verdictAlgebraViolation",
			routeParamId: baseRouteId,
			wire: { httpStatus: 200, headers: { "cache-control": "no-cache" }, body },
			reason:
				"The registry IS the resolver's backing store (§6 writes receiptId->event.hash and " +
				"event.hash->bytes in the same atomic write), so a resolver that read the bytes could have " +
				"read the binding; `unavailable` on a 200 would assert 'I read the registry for the bytes " +
				"but not for the binding'. registryBinding (step 3(b)) MUST be `passed` on a resolver-issued " +
				"200 (§4.1 rule 2, v0.4) — `unavailable`/`notApplicable` are offline-verification report " +
				"values only.",
		} satisfies ProtocolVector;
	})(),
	(() => {
		const body = cloneBase();
		body.verification.checks.predecessorLinkage = { result: "failed", failure: "ID_MISMATCH" };
		return {
			label: "verdict algebra — predecessorLinkage: failed on a 200",
			kind: "verdictAlgebraViolation",
			routeParamId: baseRouteId,
			wire: { httpStatus: 200, headers: { "cache-control": "no-cache" }, body },
			reason:
				"Same rule as registryBinding (§4.1 rule 2) — a positive-contradiction failure here is also disqualifying.",
		} satisfies ProtocolVector;
	})(),
	(() => {
		const body = cloneBase();
		body.status = "verified_anchored";
		body.verification.checks.checkpointHistory = { result: "passed" };
		body.verification.checks.anchorEvidence = { result: "notApplicable" };
		return {
			label:
				"verdict algebra — status above its extension cap (verified_anchored without anchor evidence)",
			kind: "verdictAlgebraViolation",
			routeParamId: baseRouteId,
			wire: { httpStatus: 200, headers: { "cache-control": "no-cache" }, body },
			reason:
				"verified_anchored REQUIRES anchorEvidence: passed (§4.1 rule 3, cumulative ladder); notApplicable caps " +
				"the status at verified_checkpoint_history. A status above its warranted cap is a protocol error.",
		} satisfies ProtocolVector;
	})(),
	(() => {
		const body = cloneBase();
		body.status = "verified_checkpoint_history";
		body.verification.checks.checkpointHistory = { result: "unavailable" };
		return {
			label:
				"verdict algebra — status above its extension cap (checkpoint_history without a passed history check)",
			kind: "verdictAlgebraViolation",
			routeParamId: baseRouteId,
			wire: { httpStatus: 200, headers: { "cache-control": "no-cache" }, body },
			reason:
				"verified_checkpoint_history REQUIRES checkpointHistory: passed; unavailable caps the status at the floor rung.",
		} satisfies ProtocolVector;
	})(),
	(() => {
		const body = cloneBase();
		// A failure code legal only on `anchorEvidence` (step 9) attached to
		// `signature` (step 4) — the closed union is per-step, not free text.
		body.verification.steps.signature = { result: "failed", failure: "ANCHOR_INVALID" };
		return {
			label: "verdict algebra — misplaced failure code (ANCHOR_INVALID on the signature step)",
			kind: "verdictAlgebraViolation",
			routeParamId: baseRouteId,
			wire: { httpStatus: 200, headers: { "cache-control": "no-cache" }, body },
			reason:
				"`ANCHOR_INVALID` is reserved for the anchorEvidence extension check (§4.1's closed failure-code union); " +
				"an unknown-or-misplaced code on another step is itself a schema failure (R37).",
		} satisfies ProtocolVector;
	})(),
	(() => {
		const body = cloneBase() as unknown as Record<string, unknown>;
		delete body.apiVersion;
		return {
			label: "missing apiVersion — key entirely absent",
			kind: "missingApiVersion",
			routeParamId: baseRouteId,
			wire: { httpStatus: 200, headers: { "cache-control": "no-cache" }, body },
			reason:
				"Every body carries apiVersion (§4.2); one without it fails closed (R37) exactly like an unsupported " +
				"version does — this is the OTHER half of 'missing or unsupported', distinct from unsupported-apiversion.json.",
		} satisfies ProtocolVector;
	})(),

	// ---- transport failures: nothing to parse at all ----
	{
		label: "transport failure — resolver request timeout",
		kind: "transportFailure",
		routeParamId: baseRouteId,
		simulate: "timeout",
		reason: "The resolver never answered within the deadline; there is no body to evaluate.",
	},
	{
		label: "transport failure — network failure reaching the resolver",
		kind: "transportFailure",
		routeParamId: baseRouteId,
		simulate: "networkFailure",
		reason:
			"DNS/connection failure before any HTTP response existed; there is no body to evaluate.",
	},
];
