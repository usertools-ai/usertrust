// SPDX-License-Identifier: Apache-2.0
/**
 * ensureAnchorIdentity: the one idempotent entry point that init (and later the
 * scheduler) calls to make sure a vault can anchor.
 *
 * It never overwrites, never deletes, and mints at most once:
 *   - no identity.json            -> create identity, key, public copy, mirror, outbox
 *   - identity + matching key     -> "ready" (nothing written)
 *   - identity, key missing/other -> "needs-attention" (nothing minted: a new key would
 *                                    fork the vault's signer history)
 *   - identity.json unreadable    -> "needs-attention" (the file is left exactly as found)
 *   - no vault config             -> "needs-attention" (anchoring would create a stray
 *                                    .usertrust that makes the next `init` return early)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VAULT_DIR } from "../shared/constants.js";
import {
	type AnchorIdentity,
	anchorsDir,
	defaultKeyPath,
	initAnchorIdentity,
	readAnchorIdentity,
	resolveSigner,
} from "./anchor.js";

export type EnsureAnchorResult =
	| {
			status: "created";
			identity: AnchorIdentity;
			publicKeyPem: string;
			keyFile: string;
			keyId: string;
	  }
	| { status: "ready"; identity: AnchorIdentity; keyId: string }
	| { status: "needs-attention"; reason: EnsureAnchorReason; message: string };

export type EnsureAnchorReason =
	| "no-vault"
	| "identity-unreadable"
	| "key-missing"
	| "key-mismatch"
	| "key-write-failed";

export function ensureAnchorIdentity(
	rootDir: string,
	opts?: { keyFile?: string },
): EnsureAnchorResult {
	if (!existsSync(join(rootDir, VAULT_DIR, "usertrust.config.json"))) {
		return {
			status: "needs-attention",
			reason: "no-vault",
			message: "No vault here: run `usertrust init` first.",
		};
	}

	const identityPath = join(anchorsDir(rootDir), "identity.json");
	if (existsSync(identityPath)) {
		const identity = readAnchorIdentity(rootDir);
		if (identity === null) {
			return {
				status: "needs-attention",
				reason: "identity-unreadable",
				message: `${identityPath} exists but cannot be read as an anchor identity. It was left untouched; inspect or restore it.`,
			};
		}
		const keyFile = opts?.keyFile ?? defaultKeyPath(identity.vaultId);
		if (!existsSync(keyFile)) {
			return {
				status: "needs-attention",
				reason: "key-missing",
				message: `The anchor key ${keyFile} is missing. No new key was minted; restore it, or run \`usertrust anchor rotate\` if it is lost.`,
			};
		}
		try {
			const signer = resolveSigner({ type: "pem", file: keyFile }, identity.vaultId);
			if (signer.keyId !== identity.keyId) {
				return {
					status: "needs-attention",
					reason: "key-mismatch",
					message: `The key at ${keyFile} does not match this vault's identity (keyId ${identity.keyId}). Nothing was changed.`,
				};
			}
		} catch {
			return {
				status: "needs-attention",
				reason: "key-mismatch",
				message: `The key at ${keyFile} cannot be read as a signing key. Nothing was changed.`,
			};
		}
		return { status: "ready", identity, keyId: identity.keyId };
	}

	try {
		const made = initAnchorIdentity(
			rootDir,
			opts?.keyFile !== undefined ? { keyFile: opts.keyFile } : undefined,
		);
		return {
			status: "created",
			identity: made.identity,
			publicKeyPem: made.publicKeyPem,
			keyFile: made.keyFile,
			keyId: made.identity.keyId,
		};
	} catch (err) {
		return {
			status: "needs-attention",
			reason: "key-write-failed",
			message: `Could not create the anchor key: ${err instanceof Error ? err.message : String(err)}. Fix the cause and run \`usertrust anchor init\`.`,
		};
	}
}
