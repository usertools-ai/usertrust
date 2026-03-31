// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Key Derivation — scrypt-based AES-256 key from passphrase + salt.
 *
 * Uses node:crypto scryptSync with N=2^17, r=8, p=1 to derive a 32-byte
 * key suitable for AES-256-GCM encryption of the credential vault.
 */

import { randomBytes, scryptSync } from "node:crypto";

/**
 * Derive a 32-byte AES-256 key from a passphrase using scrypt.
 *
 * @param passphrase - The master passphrase (from env var).
 * @param salt - A 16-byte salt (from generateSalt or stored alongside ciphertext).
 * @returns A 32-byte Buffer suitable for AES-256-GCM.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
	// maxmem must cover 128 * N * r = 128 MiB for N=2^17, r=8.
	return scryptSync(passphrase, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }) as Buffer;
}

/**
 * Generate a cryptographically random 16-byte salt.
 */
export function generateSalt(): Buffer {
	return randomBytes(16);
}
