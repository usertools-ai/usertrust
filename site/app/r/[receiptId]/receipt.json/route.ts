import { jsonResourceStatus, resolveVerifyPageState } from "../../lib/resolve";
import { shellHeadline } from "../../lib/shell-copy";

/**
 * `receipt.json` — D2's first affordance: streams the DECODED `receiptBytes`
 * VERBATIM. "No parse/re-serialize cycle ever touches this path. This is
 * the file `usertrust-verify receipt <file>` takes."
 *
 * `state.receiptBytesText` (only present on {@link import("../../lib/wire").VerifiedState})
 * IS `wire.ts`'s R4-validated, already-decoded UTF-8 text of `receiptBytes`
 * — R4's five-stage pipeline (canonical base64 → fatal UTF-8 → strict parse
 * → structural comparison) already ran to produce a `verified` state at
 * all, so this route re-decodes nothing and re-serializes nothing: it
 * encodes that exact text back to bytes and streams them.
 */
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

interface RouteContext {
	params: Promise<{ receiptId: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
	const { receiptId } = await context.params;
	const state = await resolveVerifyPageState(receiptId);
	const status = jsonResourceStatus(state);

	// `Cache-Control: no-store` on every outcome (D1/R35) — this route's own
	// answer must never be cached as green (or as anything else) any longer
	// than the resolver's own answer was allowed to be.
	const headers: Record<string, string> = { "Cache-Control": "no-store" };

	if (state.kind === "verified") {
		headers["Content-Type"] = "application/json; charset=utf-8";
		headers["Content-Disposition"] = `attachment; filename="${state.receiptId}.json"`;
		const bytes = new TextEncoder().encode(state.receiptBytesText);
		return new Response(bytes, { status, headers });
	}

	headers["Content-Type"] = "application/json; charset=utf-8";
	if ("retryAfter" in state && state.retryAfter) {
		headers["Retry-After"] = state.retryAfter.raw;
	}
	return new Response(JSON.stringify({ error: shellHeadline(state), state: state.kind }), {
		status,
		headers,
	});
}
