// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The response stage (`HttpResponsePreReturn`) classifies; it NEVER blocks: the
 * upstream call has already run and been billed. Pure: the caller applies the
 * action to the hold in a later slice.
 */

import { MAX_BODY_BYTES } from "./gate.js";

export type BodyMode = "STREAM_BYTES" | "WHOLE_BODY_BYTES";

export type ResponseAction =
	/** Non-2xx: providers do not bill these, so the hold is released. */
	| { action: "void" }
	/** The body cannot be read: settle at the hold (the ceiling), never let it expire. */
	| { action: "settle_at_hold"; finding: "usage_unreadable"; why: string }
	/** Read the body in this mode and settle to the usage it reports. */
	| { action: "read"; mode: BodyMode };

export interface ResponseHead {
	status: number;
	/** Response headers, any case. */
	headers: Record<string, string>;
	/** The request's method (a HEAD response has no body). */
	method: string;
}

/**
 * Every reason OpenShell makes a response body unavailable is checked, not only
 * content coding: a non-identity `Content-Encoding`, a partial response, no body,
 * and `Cache-Control: no-transform`. Any of them → settle at the hold.
 */
export function classifyResponse(head: ResponseHead): ResponseAction {
	if (head.status < 200 || head.status > 299) return { action: "void" };
	const h: Record<string, string> = {};
	for (const [k, v] of Object.entries(head.headers)) h[k.toLowerCase()] = v.trim();
	const unreadable = (why: string): ResponseAction => ({
		action: "settle_at_hold",
		finding: "usage_unreadable",
		why,
	});

	const encoding = (h["content-encoding"] ?? "").toLowerCase();
	if (encoding !== "" && encoding !== "identity") return unreadable(`content-encoding:${encoding}`);
	if (head.status === 206 || "content-range" in h) return unreadable("partial");
	if (head.status === 204 || head.method.toUpperCase() === "HEAD" || h["content-length"] === "0") {
		return unreadable("no-body");
	}
	if (/(^|,)\s*no-transform\s*(,|$)/i.test(h["cache-control"] ?? ""))
		return unreadable("no-transform");

	const streaming = (h["content-type"] ?? "").toLowerCase().startsWith("text/event-stream");
	if (streaming) return { action: "read", mode: "STREAM_BYTES" };
	const length = Number(h["content-length"]);
	if (Number.isFinite(length) && length > MAX_BODY_BYTES) return unreadable("too-large");
	return { action: "read", mode: "WHOLE_BODY_BYTES" };
}
