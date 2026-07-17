// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";
import { canonicalize } from "../audit/canonical.js";
import { SkillVerificationError } from "../shared/errors.js";
import type {
	SkillManifest,
	SkillPermission,
	SkillVerification,
	TrustConfig,
} from "../shared/types.js";
import { SkillManifestSchema } from "../shared/types.js";
import { verifySignature } from "./sign.js";

/**
 * Computes a SHA-256 hash of the full manifest for audit inclusion.
 */
function computeManifestHash(manifest: SkillManifest): string {
	const canonical = canonicalize(manifest);
	return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Checks whether a manifest's permissions are allowed by the config policy.
 * Trusted publishers bypass permission restrictions.
 *
 * NOTE: this does NOT verify identity — it is only reached from `enforceSkillLoad`
 * after the signature has been checked against a REGISTERED key, so the trusted-
 * publisher bypass here cannot be triggered by a forged-publisher manifest.
 * `integrityVerified` is set to false here; `enforceSkillLoad` overrides it once
 * source bytes have been re-hashed.
 */
export function checkPermissions(manifest: SkillManifest, config: TrustConfig): SkillVerification {
	const sc = config.supplyChain;
	const manifestHash = computeManifestHash(manifest);

	// Trusted publishers get all permissions
	if (sc.trustedPublishers.includes(manifest.publisher)) {
		return {
			valid: true,
			permissionsAllowed: true,
			deniedPermissions: [],
			manifestHash,
			integrityVerified: false,
		};
	}

	const allowed = new Set<SkillPermission>(sc.allowedPermissions);
	const denied = manifest.permissions.filter((p) => !allowed.has(p));

	return {
		valid: true,
		permissionsAllowed: denied.length === 0,
		deniedPermissions: denied,
		manifestHash,
		integrityVerified: false,
	};
}

/**
 * Full verification pipeline: validate schema, verify signature against the
 * REGISTERED publisher key(s), re-hash the loaded source against the signed
 * entryHash, then check permissions. Returns a SkillVerification result.
 * Throws SkillVerificationError on hard (schema) failures.
 *
 * @param entrySource The exact bytes to be executed. When provided, they are
 *   re-hashed and compared to the signed `entryHash` (SC-2). A call WITHOUT
 *   `entrySource` yields `integrityVerified:false` and MUST be treated by any
 *   executor as "integrity unverified — do not execute".
 */
export function enforceSkillLoad(
	manifest: SkillManifest,
	config: TrustConfig,
	entrySource?: string | Buffer,
): SkillVerification {
	const sc = config.supplyChain;

	// Guard: if supply chain is disabled, allow everything (deliberate operator
	// override — only reachable once the operator has explicitly set enabled:false).
	if (!sc.enabled) {
		return {
			valid: true,
			permissionsAllowed: true,
			deniedPermissions: [],
			manifestHash: computeManifestHash(manifest),
			integrityVerified: false,
		};
	}

	// Step 1: Validate schema
	const parseResult = SkillManifestSchema.safeParse(manifest);
	if (!parseResult.success) {
		const reason = parseResult.error.issues.map((i) => i.message).join("; ");
		throw new SkillVerificationError(
			(manifest as { id?: string }).id ?? "unknown",
			`Schema validation failed: ${reason}`,
		);
	}

	// Step 2: Verify signature against the REGISTERED key(s) for the claimed
	// publisher. The publisher->key registry is the trust anchor; an unregistered
	// publisher or a self-signed key cannot be trusted.
	const registeredKeys = sc.publisherKeys[manifest.publisher] ?? [];
	const isTrusted = sc.trustedPublishers.includes(manifest.publisher);

	if (sc.requireSignature || isTrusted) {
		if (registeredKeys.length === 0) {
			const manifestHash = computeManifestHash(manifest);
			return {
				valid: false,
				permissionsAllowed: false,
				deniedPermissions: manifest.permissions,
				manifestHash,
				integrityVerified: false,
				error: `No registered signing key for publisher "${manifest.publisher}"`,
			};
		}
		const sigValid = verifySignature(manifest, registeredKeys);
		if (!sigValid) {
			const manifestHash = computeManifestHash(manifest);
			return {
				valid: false,
				permissionsAllowed: false,
				deniedPermissions: manifest.permissions,
				manifestHash,
				integrityVerified: false,
				error: "Invalid manifest signature",
			};
		}
	}

	// Step 2b: Code integrity — the bytes being loaded MUST hash to the signed
	// entryHash. A valid signature over a manifest is worthless if it can be
	// paired with other (malicious) code.
	let integrityVerified = false;
	if (entrySource !== undefined) {
		const actualHash = createHash("sha256").update(entrySource).digest("hex");
		if (actualHash !== manifest.entryHash) {
			const manifestHash = computeManifestHash(manifest);
			return {
				valid: false,
				permissionsAllowed: false,
				deniedPermissions: manifest.permissions,
				manifestHash,
				integrityVerified: false,
				error: "entryHash mismatch — skill source does not match signed manifest",
			};
		}
		integrityVerified = true;
	}

	// Step 3: Check permissions and trusted publishers
	const result = checkPermissions(manifest, config);

	if (!result.permissionsAllowed) {
		return {
			...result,
			valid: false,
			integrityVerified,
			error: `Denied permissions: ${result.deniedPermissions.join(", ")}`,
		};
	}

	return { ...result, integrityVerified };
}
