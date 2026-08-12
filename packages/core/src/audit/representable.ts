// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Boundary validation for caller-supplied values that are bound for the chain.
 *
 * THE RULE, stated here because it generalizes far past any one call site:
 *
 * > Validate everything you will need to durably record BEFORE you do anything
 * > you cannot undo. A guard that runs after the irreversible step isn't a
 * > guard, it's a notification.
 *
 * The defect that produced this module: `settle(auth, { chunksDelivered: NaN })`
 * discovered the bad value at its `appendEvent`, which runs after the
 * authorization has been deleted and after the spend has been posted. The
 * caller got a loud failure for a settlement whose money had already moved, and
 * no authorization left to retry against. Making the writer throw was right —
 * the ORDER was the defect.
 *
 * WHY THIS CALLS `canonicalize` INSTEAD OF RE-DERIVING THE RULE. The refusal
 * here and the refusal at the writer (`chain.ts`'s pre-fsync guard) must agree
 * for every input, not for the inputs someone remembered. They agree BY
 * CONSTRUCTION because they are the same function. A second predicate spelling
 * out "finite, not a function, not a symbol" would be a copy, and a copy drifts
 * the first time either side learns a new case — leaving a value the boundary
 * waves through and the writer then refuses, which is the bug all over again.
 *
 * WHAT THIS IS NOT. It is not a write-ahead. Nothing is appended, nothing is
 * persisted, no hash is computed, no sequence is claimed; the value is run
 * through the serializer and the result is discarded. An audit event must never
 * precede the fact it attests, and this precedes nothing but its own refusal.
 */

import { AuditDataInvalidError } from "../shared/errors.js";
import { canonicalize } from "./canonical.js";

/**
 * Refuse caller-supplied values that could never become an audit line.
 *
 * @param eventKind the `kind` of the event these fields are bound for — stamped
 *   onto the error so it reads the same as the writer's own refusal, and so
 *   {@link import("./chain.js").isMustRecordAuditFailure} answers `true`.
 * @param fields a map of CALLER-FACING field path → value. The key is the name
 *   the caller wrote (`"SettleParams.chunksDelivered"`), never our local
 *   variable, because the error's whole job is to tell them what to change. The
 *   map doubles as the site's manifest of which inputs are audit-bound.
 *
 * @throws {AuditDataInvalidError} naming the first offending field.
 */
export function assertAuditRepresentable(eventKind: string, fields: Record<string, unknown>): void {
	for (const field of Object.keys(fields)) {
		try {
			// THE BYTES, NOT THE ABSENCE OF A THROW. A non-throwing `canonicalize`
			// is not the writer's test — the writer parses what it is about to
			// persist (`chain.ts`'s pre-fsync guard) and refuses bytes that do not
			// read back. The two only agree BY CONSTRUCTION if this judges the same
			// thing, and the gap was reachable: canonicalize's Date branch returned
			// `JSON.stringify(value.toISOString())`, which is the JS value
			// `undefined` — not a string, its declared return type notwithstanding —
			// for a caller `Date` whose `toISOString` answers with `undefined` or a
			// function. Nothing threw, so this waved it through; the token
			// `undefined` then landed in the canonical text and only the writer
			// refused it, i.e. after `governAction()` had executed and after the
			// money moved. Which is the whole defect this module exists to prevent,
			// arriving THROUGH the guard rather than around it.
			//
			// That branch now checks its own output, so the vehicle is closed at the
			// source and this parse has no known input left to catch. It stays for
			// the reason `appendEvent` keeps its own pre-fsync parse: a guard that
			// depends on the serializer staying correct is not a guard. Same rule as
			// the writer's, one gate earlier.
			JSON.parse(canonicalize(fields[field]));
		} catch (err) {
			throw new AuditDataInvalidError(
				`${field} cannot be recorded on the audit chain: ${
					err instanceof Error ? err.message : String(err)
				}`,
				eventKind,
			);
		}
	}
}
