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
		};
	}

	const allowed = new Set<SkillPermission>(sc.allowedPermissions);
	const denied = manifest.permissions.filter((p) => !allowed.has(p));

	return {
		valid: true,
		permissionsAllowed: denied.length === 0,
		deniedPermissions: denied,
		manifestHash,
	};
}

/**
 * Full verification pipeline: validate schema, verify signature, check permissions, check trusted publishers.
 * Returns a SkillVerification result. Throws SkillVerificationError on hard failures.
 */
export function enforceSkillLoad(manifest: SkillManifest, config: TrustConfig): SkillVerification {
	const sc = config.supplyChain;

	// Guard: if supply chain is disabled, allow everything
	if (!sc.enabled) {
		return {
			valid: true,
			permissionsAllowed: true,
			deniedPermissions: [],
			manifestHash: computeManifestHash(manifest),
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

	// Step 2: Verify signature
	// Always verify signature for trusted publishers (prevent publisher forgery)
	// Also verify if requireSignature is true
	const isTrusted = sc.trustedPublishers.includes(manifest.publisher);
	if (sc.requireSignature || isTrusted) {
		const sigValid = verifySignature(manifest);
		if (!sigValid) {
			const manifestHash = computeManifestHash(manifest);
			return {
				valid: false,
				permissionsAllowed: false,
				deniedPermissions: manifest.permissions,
				manifestHash,
				error: "Invalid manifest signature",
			};
		}
	}

	// Step 3: Check permissions and trusted publishers
	const result = checkPermissions(manifest, config);

	if (!result.permissionsAllowed) {
		return {
			...result,
			valid: false,
			error: `Denied permissions: ${result.deniedPermissions.join(", ")}`,
		};
	}

	return result;
}
