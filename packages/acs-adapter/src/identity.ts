import { createHash } from "node:crypto";
import { runtimeError } from "./vocabulary.js";

/**
 * Bisected action identity, adapted from the ACS input_identity /
 * enforced_identity pattern (Microsoft Agent Governance Toolkit, MIT — see
 * NOTICE): hash the action at decision time, bind approvals to that hash, and
 * re-derive immediately before execution so an action mutated after approval
 * fails closed.
 *
 * Canonicalization scope: this module defines the ACTION-IDENTITY namespace
 * only. It is unrelated to core's audit-chain canonicalization and has no
 * parity coupling with usertrust-verify. Per JSON.stringify semantics, `-0`
 * normalizes to `0` before hashing.
 */

export function canonicalJson(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "boolean":
			return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new TypeError("non-finite number in canonical JSON");
			return JSON.stringify(value);
		case "object":
			break;
		default:
			throw new TypeError(`non-JSON value in canonical JSON: ${typeof value}`);
	}
	const obj = value as object;
	if (seen.has(obj)) throw new TypeError("circular reference in canonical JSON");
	seen.add(obj);
	try {
		if (Array.isArray(obj)) {
			return `[${obj.map((item) => canonicalJson(item, seen)).join(",")}]`;
		}
		const keys = Object.keys(obj).sort();
		const parts: string[] = [];
		for (const key of keys) {
			const entry = (obj as Record<string, unknown>)[key];
			parts.push(`${JSON.stringify(key)}:${canonicalJson(entry, seen)}`);
		}
		return `{${parts.join(",")}}`;
	} finally {
		seen.delete(obj);
	}
}

export function actionIdentity(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf-8").digest("hex");
}

export interface AcsApproval {
	identity: string;
	approvedAt: string;
}

export function bindApproval(identity: string): AcsApproval {
	return { identity, approvedAt: new Date().toISOString() };
}

export class IdentityMismatchError extends Error {
	public readonly expected: string;
	public readonly actual: string;

	constructor(expected: string, actual: string) {
		super(
			`${runtimeError("approval_action_mismatch")}: approval bound to ${expected.slice(0, 12)}… but action re-derives to ${actual.slice(0, 12)}…`,
		);
		this.name = "IdentityMismatchError";
		this.expected = expected;
		this.actual = actual;
	}
}

/** Re-derive the action identity and fail closed if it no longer matches the approval. */
export function assertApprovalMatches(approval: AcsApproval, value: unknown): void {
	const actual = actionIdentity(value);
	if (actual !== approval.identity) {
		throw new IdentityMismatchError(approval.identity, actual);
	}
}
