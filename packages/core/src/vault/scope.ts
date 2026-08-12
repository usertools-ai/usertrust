// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Scope Checking — validates credential access against agent, action, and expiry constraints.
 */

import type { ActionKind, CredentialScope } from "../shared/types.js";

/**
 * Check whether an accessor is allowed to use a credential given its scope.
 *
 * Rules:
 * - Agent scope: empty agents array = all agents allowed; otherwise accessor.agent must be in list.
 * - Action scope: empty actions array = all actions allowed; otherwise accessor.action must be in list.
 * - Expiry: if expiresAt is non-null and in the past, deny with "Credential expired".
 *   An expiry that is present but UNPARSEABLE denies too — see the NaN note below.
 */
export function checkScope(
	scope: CredentialScope,
	accessor: { agent: string; action: ActionKind },
): { allowed: boolean; reason?: string } {
	// Check agent scope
	if (scope.agents.length > 0 && !scope.agents.includes(accessor.agent)) {
		return {
			allowed: false,
			reason: `Agent "${accessor.agent}" is not in the allowed agents list`,
		};
	}

	// Check action scope
	if (scope.actions.length > 0 && !scope.actions.includes(accessor.action)) {
		return {
			allowed: false,
			reason: `Action "${accessor.action}" is not in the allowed actions list`,
		};
	}

	// Check expiry
	if (scope.expiresAt !== null) {
		const expiresAt = new Date(scope.expiresAt).getTime();
		// An UNPARSEABLE expiry is not an absent one. `new Date("garbage").getTime()`
		// is NaN, and every comparison against NaN is false — so `NaN <= Date.now()`
		// fell through to `{ allowed: true }` and a credential whose expiry could not
		// be read was treated as one that had not expired. The permissive branch is
		// exactly the wrong default for a value that exists precisely to revoke
		// access, so an uninterpretable expiry now denies.
		if (!Number.isFinite(expiresAt)) {
			return { allowed: false, reason: "Credential expiry is not a valid date" };
		}
		if (expiresAt <= Date.now()) {
			return { allowed: false, reason: "Credential expired" };
		}
	}

	return { allowed: true };
}
