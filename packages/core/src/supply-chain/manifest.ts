// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";
import { canonicalize } from "../audit/canonical.js";
import type { SkillManifest, SkillPermission } from "../shared/types.js";
import { SkillManifestSchema } from "../shared/types.js";

/**
 * Validates a raw manifest object against the SkillManifest Zod schema.
 * Returns the typed manifest or throws a ZodError.
 */
export function validateManifest(raw: unknown): SkillManifest {
	return SkillManifestSchema.parse(raw) as SkillManifest;
}

/**
 * Creates an unsigned manifest with the entryHash computed from the source code.
 */
export function createUnsignedManifest(opts: {
	id: string;
	name: string;
	publisher: string;
	permissions: SkillPermission[];
	entrySource: string;
}): Omit<SkillManifest, "signature" | "publicKey" | "signedAt"> {
	const entryHash = createHash("sha256").update(opts.entrySource).digest("hex");
	return {
		version: 1,
		id: opts.id,
		name: opts.name,
		publisher: opts.publisher,
		permissions: opts.permissions,
		entryHash,
	};
}

/**
 * Computes a deterministic SHA-256 hash of the manifest fields (excluding signature),
 * using canonical JSON serialization.
 */
export function hashManifest(manifest: Omit<SkillManifest, "signature">): string {
	// Extract only the fields that contribute to the hash (everything except signature)
	const hashable = {
		version: manifest.version,
		id: manifest.id,
		name: manifest.name,
		publisher: manifest.publisher,
		permissions: manifest.permissions,
		entryHash: manifest.entryHash,
		signedAt: (manifest as SkillManifest).signedAt,
		publicKey: (manifest as SkillManifest).publicKey,
	};
	const canonical = canonicalize(hashable);
	return createHash("sha256").update(canonical).digest("hex");
}
