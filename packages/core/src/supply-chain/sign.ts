// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
	verify,
} from "node:crypto";
import { canonicalize } from "../audit/canonical.js";
import type { SkillManifest } from "../shared/types.js";

/**
 * Generates an Ed25519 keypair. Returns hex-encoded public and private keys.
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "der" },
	});
	// Ed25519 SPKI DER is 44 bytes: 12-byte prefix + 32-byte raw key
	const rawPublic = (publicKey as Buffer).subarray(12).toString("hex");
	// Return full DER for private key (needed for signing)
	const rawPrivate = (privateKey as Buffer).toString("hex");
	return { publicKey: rawPublic, privateKey: rawPrivate };
}

/**
 * Computes the canonical hash of manifest fields for signing (excluding signature and publicKey and signedAt).
 */
function computeSigningPayload(
	manifest: Omit<SkillManifest, "signature" | "publicKey" | "signedAt">,
	signedAt: string,
	publicKey: string,
): string {
	const hashable = {
		version: manifest.version,
		id: manifest.id,
		name: manifest.name,
		publisher: manifest.publisher,
		permissions: manifest.permissions,
		entryHash: manifest.entryHash,
		signedAt,
		publicKey,
	};
	return canonicalize(hashable);
}

/**
 * Signs an unsigned manifest with the given private key. Returns a fully signed SkillManifest.
 */
export function signManifest(
	manifest: Omit<SkillManifest, "signature" | "publicKey" | "signedAt">,
	privateKeyHex: string,
): SkillManifest {
	const privateKeyDer = Buffer.from(privateKeyHex, "hex");
	const privateKey = {
		key: privateKeyDer,
		format: "der" as const,
		type: "pkcs8" as const,
	};

	// Derive public key from the private key
	const privKeyObj = createPrivateKey({
		key: privateKeyDer,
		format: "der",
		type: "pkcs8",
	});
	const pubKeyObj = createPublicKey(privKeyObj);
	const pubKeyDerActual = pubKeyObj.export({ type: "spki", format: "der" });
	const publicKeyHex = (pubKeyDerActual as Buffer).subarray(12).toString("hex");

	const signedAt = new Date().toISOString();
	const payload = computeSigningPayload(manifest, signedAt, publicKeyHex);
	const payloadBytes = Buffer.from(payload, "utf-8");

	const signature = sign(null, payloadBytes, privateKey);
	const signatureHex = (signature as Buffer).toString("hex");

	return {
		...manifest,
		signedAt,
		publicKey: publicKeyHex,
		signature: signatureHex,
	};
}

/**
 * Verifies the Ed25519 signature on a signed manifest.
 */
export function verifySignature(manifest: SkillManifest): boolean {
	try {
		const payload = computeSigningPayload(
			{
				version: manifest.version,
				id: manifest.id,
				name: manifest.name,
				publisher: manifest.publisher,
				permissions: manifest.permissions,
				entryHash: manifest.entryHash,
			},
			manifest.signedAt,
			manifest.publicKey,
		);
		const payloadBytes = Buffer.from(payload, "utf-8");

		// Reconstruct DER-encoded SPKI public key from raw 32-byte key
		const rawPubKey = Buffer.from(manifest.publicKey, "hex");
		const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
		const spkiDer = Buffer.concat([spkiPrefix, rawPubKey]);

		const publicKey = {
			key: spkiDer,
			format: "der" as const,
			type: "spki" as const,
		};

		return verify(null, payloadBytes, publicKey, Buffer.from(manifest.signature, "hex"));
	} catch {
		return false;
	}
}
