// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The denial correlation handle must be reachable from the PUBLISHED package
 * root — a caller who catches the error but cannot name `auditEventHash` has no
 * handle at all — and the new metadata argument must stay SOURCE-COMPATIBLE:
 * every existing one- and two-argument construction still compiles, and
 * `InsufficientBalanceError`'s metadata is argument FIVE, behind its `hint`.
 *
 * Compiled by `packages/core/tsconfig.type-tests.json`; a bare `tsc -b` never
 * sees this file.
 */

import type { DenialAuditMetadata } from "usertrust";
import { InsufficientBalanceError, PolicyDeniedError } from "usertrust";

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// ── PolicyDeniedError: 1, 2 and 3 arguments ──

const denied1 = new PolicyDeniedError("reason");
const denied2 = new PolicyDeniedError("reason", "custom hint");
const denied3 = new PolicyDeniedError("reason", "custom hint", {
	auditEventHash: "a".repeat(64),
	auditDegraded: true,
});

// ── InsufficientBalanceError: 3, 4 and 5 arguments — metadata is FIFTH ──

const balance3 = new InsufficientBalanceError("user", 10, 1);
const balance4 = new InsufficientBalanceError("user", 10, 1, "custom hint");
const balance5 = new InsufficientBalanceError("user", 10, 1, "custom hint", {
	auditEventHash: "b".repeat(64),
});

// ── The handle is readable, and optional (an old or hand-built error has none) ──

type _H1 = Assert<Extends<typeof denied1.auditEventHash, string | undefined>>;
type _H2 = Assert<Extends<typeof denied2.auditDegraded, boolean | undefined>>;
type _H3 = Assert<Extends<typeof denied3.auditEventHash, string | undefined>>;
type _H4 = Assert<Extends<typeof balance3.auditEventHash, string | undefined>>;
type _H5 = Assert<Extends<typeof balance4.auditDegraded, boolean | undefined>>;
type _H6 = Assert<Extends<typeof balance5.auditEventHash, string | undefined>>;

// The metadata shape itself is nameable, so a caller can build one.
const meta: DenialAuditMetadata = { auditEventHash: "c".repeat(64), auditDegraded: false };
type _M = Assert<Extends<typeof meta, DenialAuditMetadata>>;

// A `catch` narrowing still reaches the handle without a cast.
declare const thrown: unknown;
export function handle(): string | undefined {
	if (thrown instanceof PolicyDeniedError) return thrown.auditEventHash;
	if (thrown instanceof InsufficientBalanceError) return thrown.auditEventHash;
	return undefined;
}
