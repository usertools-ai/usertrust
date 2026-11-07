// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * budget/task.ts: the `withTaskLimit()` scope.
 *
 * A governed call belongs to a task because it ran inside `withTaskLimit(taskId, limit, fn)`,
 * directly or through any await, timer or promise `fn` started, propagated by `AsyncLocalStorage`
 * as the cost-center scope is (`attribution.ts`). Nothing a request carries can name or change
 * the task: the store follows the calling code's own async context.
 *
 * This file is ledger-free, like `attribution.ts`: it derives the task key through
 * `shared/derive.ts`, never the ledger client, so a caller that only wraps work in
 * `withTaskLimit` does not load the native TigerBeetle binding.
 *
 * ALS DISCIPLINE (the rule `attribution.ts` sets out, and why): the store is module-private, and a
 * controller calls {@link getCurrentTask} exactly ONCE per call, at the top of its own synchronous
 * entry point, then carries that read as a closure or handle capture. `AsyncLocalStorage` follows
 * a chain of async continuations; it does NOT follow an `EventEmitter` listener from its `on()`
 * context to its `emit()` context, and SDK streams deliver their events through emitters, after
 * the entry point has returned. A read inside one of those listeners sees whatever scope is active
 * when the event fires, another call's or none, and never fails loudly. The test suite pins that
 * negative case beside this primitive.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { deriveTaskLimitAccountId } from "../shared/derive.js";
import { PRINCIPAL_FIELD_PATTERN } from "../shared/principal.js";

/**
 * What a controller records about one attempt (one entry into `withTaskLimit`) beside the scope.
 * The only member of the scope record that is not frozen; later versions add to it.
 */
export interface TaskAttemptRegistry {
	/** The attempt this registry belongs to. */
	readonly attempt: string;
}

/**
 * The record threaded through one `withTaskLimit` entry. Frozen at construction, so a caller
 * holding a reference cannot change the limit or the id that a later read in the same entry
 * sees. Built field by field: nothing the caller passed but the validated id and limit is on it.
 */
export interface TaskScope {
	readonly id: string;
	/** The task's limit, in usertokens. */
	readonly limit: number;
	/** This entry's id: 32 lowercase hex characters, fresh per entry. A task has many attempts. */
	readonly attempt: string;
	/** `performance.now()` at entry, for the attempt's wall time. */
	readonly startedAtMs: number;
	readonly registry: TaskAttemptRegistry;
}

// Module-private: every read goes through getCurrentTask, under the discipline above.
const taskStorage = new AsyncLocalStorage<TaskScope>();

/**
 * Run `fn` as a task with its own limit: each governed call made inside `fn`, directly or through
 * any await, timer or promise it starts, must fit the task's limit as well as whatever pays for
 * it. The limit is in usertokens. Returns what `fn` returns (its promise, when `fn` is async), and
 * rethrows what it throws; the scope ends with it.
 *
 * The arguments are checked in this order, before `fn` runs and with no I/O:
 *  1. Exactly three arguments. A fourth is refused, `undefined` included, so options added in a
 *     later version can never change what code written today means. It is a type error as well.
 *  2. `taskId`: 1-128 characters of `[A-Za-z0-9._:-]`, the principal field rule. `/` is refused,
 *     which keeps it free for a later child grammar.
 *  3. `limit`: a positive safe integer.
 *  4. `fn`: a function.
 *  5. No task already active. Nested task limits are refused: honouring only the inner one would
 *     let the inner task escape the outer limit.
 *
 * @throws TypeError for a fourth argument or an `fn` that is not a function; Error for a bad
 * `taskId` or `limit`, or when a task limit is already active.
 */
export function withTaskLimit<T>(taskId: string, limit: number, fn: () => T, ...extra: never[]): T {
	if (extra.length > 0) {
		throw new TypeError("withTaskLimit: takes (taskId, limit, fn); options are not accepted yet");
	}
	if (typeof taskId !== "string" || !PRINCIPAL_FIELD_PATTERN.test(taskId)) {
		throw new Error(`withTaskLimit: taskId must match ${PRINCIPAL_FIELD_PATTERN.source}`);
	}
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
		throw new Error("withTaskLimit: limit must be a positive safe integer (usertokens)");
	}
	if (typeof fn !== "function") {
		throw new TypeError("withTaskLimit: fn must be a function");
	}
	const outer = taskStorage.getStore();
	if (outer !== undefined) {
		throw new Error(
			`withTaskLimit: a task limit is already active (${outer.id}); nested task limits are not supported`,
		);
	}
	const attempt = randomBytes(16).toString("hex");
	const scope: TaskScope = Object.freeze({
		id: taskId,
		limit,
		attempt,
		startedAtMs: performance.now(),
		registry: { attempt },
	});
	return taskStorage.run(scope, fn);
}

/**
 * The active task scope, or `undefined` outside any.
 *
 * INTERNAL: not exported from the package entry points. Under the discipline at the top of this
 * file, a controller calls this exactly once, at the top of its own synchronous entry point, and
 * carries the result from there; never inside a stream listener, a terminal or a `finally`.
 */
export function getCurrentTask(): TaskScope | undefined {
	return taskStorage.getStore();
}

/**
 * A task's key as it is published (on receipts and audit records): the ledger's derivation of the
 * task's limit account id, in 32 lowercase hex characters, zero-padded.
 */
export function taskKeyHex(namespace: string, taskId: string): string {
	return deriveTaskLimitAccountId(namespace, taskId).toString(16).padStart(32, "0");
}
