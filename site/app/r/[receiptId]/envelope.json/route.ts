import { jsonResourceStatus, resolveVerifyPageState } from "../../lib/resolve";
import { shellHeadline } from "../../lib/shell-copy";

/**
 * `envelope.json` — D2's second affordance: the full UNSIGNED envelope
 * (`receipt` + `verification` + `advisories` + `anchorEvidence` +
 * `checkpointHistory` + `display`) for consumers that want the extension
 * inputs. "Labeled as the ENVELOPE, not the receipt" (D2) — this route
 * never serves what `receipt.json` serves: `receipt.json`'s bytes are the
 * byte-authoritative SIGNED artifact (R4); this route's body is a
 * convenience JSON re-serialization of the parsed, unsigned convenience
 * copy plus the extension members that sit outside the signed receipt
 * entirely. The distinction is carried in the download's own filename
 * (`<receiptId>.envelope.json`, never `<receiptId>.json`) so a downloaded
 * file can never be mistaken for the one `usertrust-verify receipt` takes.
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

	// `Cache-Control: no-store` on every outcome (D1/R35).
	const headers: Record<string, string> = {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
	};

	if (state.kind === "verified") {
		const { envelope } = state;
		headers["Content-Disposition"] = `attachment; filename="${state.receiptId}.envelope.json"`;
		const body = {
			receipt: envelope.receipt,
			verification: envelope.verification,
			advisories: envelope.advisories,
			anchorEvidence: envelope.anchorEvidence,
			checkpointHistory: envelope.checkpointHistory,
			display: envelope.display,
		};
		return new Response(JSON.stringify(body), { status, headers });
	}

	if ("retryAfter" in state && state.retryAfter) {
		headers["Retry-After"] = state.retryAfter.raw;
	}
	return new Response(JSON.stringify({ error: shellHeadline(state), state: state.kind }), {
		status,
		headers,
	});
}
