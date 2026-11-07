// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The task-limit id derivations, with no ledger code.
 *
 * `budget/task.ts` publishes a task's key without loading the ledger client (so a caller that
 * only wraps work in `withTaskLimit` never loads the native TigerBeetle binding), and the ledger
 * client creates the account under the same key. Both read these functions: the client's
 * statics delegate here, so the two cannot drift. The known-answer suites of both pin the bytes.
 *
 * Pure and total over strings: no validation, no Unicode normalization (validation lives at the
 * doors). The encoding is the one `deriveCostCenterAccountId` and `deriveTransferId` use: sha256
 * of a domain tag, then each part as a big-endian u32 UTF-8 BYTE length and its bytes, and the
 * first 16 bytes big-endian.
 */

import { createHash } from "node:crypto";

// Versioned, and prefix-free against every other domain tag in the repo and each other
// ("usertrust:task-limit:" and "usertrust:task-limit-" part at their 21st byte). The namespace
// tag is domain-separated too, rather than a bare hash of the namespace, so it cannot equal any
// other derivation's preimage. A new encoding is a new tag; these bytes never change.
const TASK_LIMIT_DOMAIN_TAG = Buffer.from("usertrust:task-limit:v1", "utf8");
const TASK_LIMIT_OPERATOR_DOMAIN_TAG = Buffer.from("usertrust:task-limit-operator:v1", "utf8");
const TASK_NAMESPACE_DOMAIN_TAG = Buffer.from("usertrust:task-namespace:v1", "utf8");

function taggedTupleId(tag: Buffer, parts: readonly string[]): bigint {
	const chunks: Buffer[] = [tag];
	for (const part of parts) {
		const bytes = Buffer.from(part, "utf8");
		const len = Buffer.alloc(4);
		len.writeUInt32BE(bytes.length);
		chunks.push(len, bytes);
	}
	const digest = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
	return BigInt(`0x${digest.slice(0, 32)}`);
}

/** A task's limit account id, which is also the task's key, from `(namespace, taskId)`. */
export function deriveTaskLimitAccountId(namespace: string, taskId: string): bigint {
	return taggedTupleId(TASK_LIMIT_DOMAIN_TAG, [namespace, taskId]);
}

/** The per-namespace account task limits are credited from. */
export function deriveTaskLimitOperatorId(namespace: string): bigint {
	return taggedTupleId(TASK_LIMIT_OPERATOR_DOMAIN_TAG, [namespace]);
}

/** The namespace tag a task-limit account carries in `user_data_128`. */
export function taskNamespaceTag(namespace: string): bigint {
	return taggedTupleId(TASK_NAMESPACE_DOMAIN_TAG, [namespace]);
}
