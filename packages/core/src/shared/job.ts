// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { principalFieldRefusal } from "./principal.js";

/**
 * WHICH JOB a spend was for — a reporting label, never a payer.
 *
 * Like a principal, a job selects no account, enters no policy context and prices
 * nothing. It rides the audit records of the call it labels, so per-job cost is a
 * query over the chain. It is validated by the principal's own field rule, captured
 * ONCE at authorize, and every later record reads the capture — never the caller's
 * handle and never a later `SettleParams`.
 *
 * - `job`      — an opaque job id (1-128 of `[A-Za-z0-9._:-]`).
 * - `jobState` — `"invalid"` when the caller's job log could not be trusted, so the
 *                absence of a `job` says "unknown", not "no job". Exclusive with `job`.
 * - `usageFrom` / `usageTo` — the window of USAGE the record covers (ISO-8601 UTC),
 *                never the time the record was appended.
 */
export interface JobCapture {
	readonly job?: string;
	readonly jobState?: "invalid";
	readonly usageFrom?: string;
}

/** The audit-record spread for a captured job: absent keys for an unlabelled call. */
export type JobAudit = JobCapture & { readonly usageTo?: string };

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Why `value` is not an ISO-8601 UTC instant, or `undefined` when it is. */
export function usageTimeRefusal(value: unknown): string | undefined {
	if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) {
		return "must be an ISO-8601 UTC instant (…Z)";
	}
	return undefined;
}

function usageTime(field: string, value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const refusal = usageTimeRefusal(value);
	if (refusal !== undefined) throw new TypeError(`${field} ${refusal}`);
	return value as string;
}

/**
 * Capture the authorize-time job fields ONCE. Each is read a single time, validated,
 * and rebuilt into a frozen object; anything invalid throws a `TypeError` before any
 * I/O, so a bad label is refused before money moves.
 */
export function captureJob(input: {
	job?: unknown;
	jobState?: unknown;
	usageFrom?: unknown;
}): JobCapture {
	const job = input.job;
	const jobState = input.jobState;
	const usageFrom = usageTime("usageFrom", input.usageFrom);
	const out: { job?: string; jobState?: "invalid"; usageFrom?: string } = {};
	if (job !== undefined) {
		const refusal = principalFieldRefusal(job);
		if (refusal !== undefined) throw new TypeError(`job ${refusal}`);
		out.job = job as string;
	}
	if (jobState !== undefined) {
		if (jobState !== "invalid") throw new TypeError('jobState must be "invalid"');
		if (out.job !== undefined) throw new TypeError("jobState cannot accompany a job");
		out.jobState = "invalid";
	}
	if (usageFrom !== undefined) out.usageFrom = usageFrom;
	return Object.freeze(out);
}

/**
 * A settle's `usageTo`, read ONCE. The usage START is the authorize capture's alone
 * (`JobCapture.usageFrom`): a settle never states it, so no record can carry two
 * different "from" values. These are facts about the usage, not a label; the job
 * itself is never taken from a settle either.
 */
export function captureUsageTo(usageTo: unknown): { usageTo?: string } {
	const to = usageTime("usageTo", usageTo);
	return to === undefined ? {} : { usageTo: to };
}
