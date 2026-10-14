// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { types as utilTypes } from "node:util";

/** This realm's AbortSignal prototype and its native `aborted` getter, captured at load. */
const abortSignalPrototype: object | undefined = globalThis.AbortSignal?.prototype;
const abortSignalAborted = Object.getOwnPropertyDescriptor(
	abortSignalPrototype ?? {},
	"aborted",
)?.get;

/**
 * Whether `value` is a real AbortSignal of this realm, decided without running caller code. Three
 * checks:
 * - no Proxy is anywhere on its prototype chain (a bounded walk);
 * - its prototype IS this realm's `AbortSignal.prototype`. A spread copy of a signal carries the
 *   signal's own state, symbols included, so the getter alone would accept it;
 * - the native `aborted` getter accepts it (it throws for anything without a signal's abort state).
 *
 * That turns away a duck-typed object, a spread copy, an object made from the prototype with no
 * state, a Proxy, and another realm's signal. It does not turn away an object made from this
 * realm's prototype that was handed a real signal's internal state (its symbols, read off a real
 * signal): only the runtime's private state could tell that one apart. Such an object passes as a
 * signal wherever this check is used, and where it lacks the rest of that state the transport
 * rejects it, as it rejects it without usertrust.
 *
 * The one predicate for "the transport's signal": the governor's serialization check and PII
 * redaction both use it, so the two cannot disagree about which value is the signal.
 */
export function isRealAbortSignal(value: unknown): boolean {
	if (abortSignalAborted === undefined || value === null || typeof value !== "object") return false;
	let o: object | null = value;
	for (let depth = 0; o !== null; depth++) {
		if (depth >= 64 || utilTypes.isProxy(o)) return false;
		o = Object.getPrototypeOf(o);
	}
	if (Object.getPrototypeOf(value) !== abortSignalPrototype) return false;
	try {
		abortSignalAborted.call(value);
		return true;
	} catch {
		return false;
	}
}
