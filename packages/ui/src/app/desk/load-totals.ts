// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The request for the whole-vault totals (`GET /api/totals`) that the desk's colours rank by. It is a plain function
 * of a `fetch` and a timeout so it can be tested without a browser, and it never throws: anything but a good answer
 * in time is `null`, and the caller falls back to the rows the page holds.
 */

import type { TotalsPayload } from "../../shared/api.js";
import type { Dimension } from "../../shared/breakdown.js";

/** Every dimension once: the object must name each `Dimension` exactly, so a new one cannot be missed here. */
const DIMENSIONS = Object.keys({
	lane: 0,
	role: 0,
	model: 0,
	kind: 0,
	provider: 0,
} satisfies Record<Dimension, 0>) as Dimension[];

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when `v` has the shape of a `TotalsPayload`: both numbers, and an array and a count for each dimension. */
function isTotalsPayload(v: unknown): v is TotalsPayload {
	if (!isObject(v)) return false;
	if (typeof v.epoch !== "number" || typeof v.records !== "number") return false;
	const { dims, more } = v;
	if (!isObject(dims) || !isObject(more)) return false;
	return DIMENSIONS.every((d) => Array.isArray(dims[d]) && typeof more[d] === "number");
}

/**
 * Read the totals, or `null` on a network error, a status other than 200, a body of the wrong shape, or no answer
 * within `timeoutMs` (the request is aborted then).
 */
export async function loadTotals(
	fetchFn: typeof fetch,
	timeoutMs: number,
): Promise<TotalsPayload | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchFn("/api/totals", { cache: "no-store", signal: controller.signal });
		if (res.status !== 200) return null;
		const body: unknown = await res.json();
		return isTotalsPayload(body) ? body : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
