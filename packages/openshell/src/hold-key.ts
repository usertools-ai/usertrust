// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";

const DOMAIN = "usertrust:openshell:hold:v1";

function lengthPrefixed(s: string): Buffer {
	const bytes = Buffer.from(s, "utf8");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(bytes.length);
	return Buffer.concat([len, bytes]);
}

/**
 * The deterministic hold key: sha256 over a domain tag and the length-prefixed
 * `sandbox_id` and `request_id` (prefix-free, so no two pairs collide by
 * concatenation). OpenShell's `request_id` links the request and response
 * evaluations, so the response stage finds the hold with no in-memory map, a
 * restart loses nothing, and a retried evaluation reserves idempotently. The
 * ledger's transfer ids are derived from this key and a role in a later slice.
 */
export function holdKey(sandboxId: string, requestId: string): string {
	if (sandboxId.length === 0 || requestId.length === 0) {
		throw new RangeError("holdKey: sandbox_id and request_id must be non-empty");
	}
	return createHash("sha256")
		.update(DOMAIN)
		.update(lengthPrefixed(sandboxId))
		.update(lengthPrefixed(requestId))
		.digest("hex");
}
