// SPDX-License-Identifier: Apache-2.0
/**
 * ensureAnchorIdentity: the one idempotent entry point that init (and later the
 * scheduler) calls to make sure a vault can anchor.
 *
 * It never overwrites or deletes an existing key or identity, and mints at most once
 * (the identity file is created exclusively, so two concurrent callers cannot both
 * succeed; the loser removes only the key pair it just made and re-reads the winner's).
 * Vaults signed by an external signer (KMS/HSM) have no key file and are out of scope:
 *
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
	ANCHOR_IDENTITY_EXISTS,
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
	| "key-superseded"
	| "env-key-set"
	| "key-write-failed";

export function ensureAnchorIdentity(
	rootDir: string,
	opts?: { keyFile?: string },
	retried = false,
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
		// Resolve the signer exactly as the emitter does: USERTRUST_ANCHOR_KEY, then the
		// given key file, then the default path. A vault keyed by the environment, or
		// rotated onto a successor key, is judged by the key it would really sign with.
		let signerKeyId: string;
		try {
			signerKeyId = resolveSigner(
				{ type: "pem", ...(opts?.keyFile !== undefined ? { file: opts.keyFile } : {}) },
				identity.vaultId,
			).keyId;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			const absent =
				code === "ENOENT" || /^No anchor private key/.test(String((err as Error).message));
			return {
				status: "needs-attention",
				reason: absent ? "key-missing" : "key-mismatch",
				message: absent
					? `No anchor key found (looked at USERTRUST_ANCHOR_KEY, the key file, then ${defaultKeyPath(identity.vaultId)}). No new key was minted; restore it, or run \`usertrust anchor rotate\` if it is lost.`
					: "The anchor key cannot be read as a signing key. Nothing was changed.",
			};
		}
		if (signerKeyId !== identity.keyId) {
			// readAnchorIdentity checks only the top-level fields, so the history may be any shape.
			const history: unknown = identity.keyHistory;
			if (
				history !== undefined &&
				(!Array.isArray(history) ||
					!history.every(
						(k: unknown) =>
							typeof k === "object" &&
							k !== null &&
							typeof (k as { keyId?: unknown }).keyId === "string" &&
							typeof (k as { publicKeySpki?: unknown }).publicKeySpki === "string",
					))
			) {
				return {
					status: "needs-attention",
					reason: "identity-unreadable",
					message: `${identityPath} has a malformed key history. It was left untouched; inspect or restore it.`,
				};
			}
			const superseded = identity.keyHistory?.some((k) => k.keyId === signerKeyId) === true;
			return {
				status: "needs-attention",
				reason: superseded ? "key-superseded" : "key-mismatch",
				message: superseded
					? "The key found is an earlier one: this vault has rotated. Point USERTRUST_ANCHOR_KEY or --key-file at the current private key. Nothing was changed."
					: `The key found does not match this vault's identity (keyId ${identity.keyId}). Nothing was changed.`,
			};
		}
		return { status: "ready", identity, keyId: identity.keyId };
	}

	// The emitter prefers USERTRUST_ANCHOR_KEY over any key file, so a key minted now would
	// never be the one it signs with (the next anchor would be refused as stale-signer-key).
	// Adopting an environment key is a separate feature; until then mint nothing.
	if ((process.env.USERTRUST_ANCHOR_KEY ?? "") !== "") {
		return {
			status: "needs-attention",
			reason: "env-key-set",
			message:
				"USERTRUST_ANCHOR_KEY is set, and it overrides any key this would create. Unset it to set up anchoring here; nothing was created.",
		};
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
		// A concurrent caller created the identity between our check and our write:
		// its identity stands, so judge that one instead of reporting a failure.
		// Only that race: any other failure is reported, never mistaken for a ready vault.
		if (!retried && (err as NodeJS.ErrnoException).code === ANCHOR_IDENTITY_EXISTS) {
			return ensureAnchorIdentity(rootDir, opts, true);
		}
		return {
			status: "needs-attention",
			reason: "key-write-failed",
			message: `Could not create the anchor key: ${err instanceof Error ? err.message : String(err)}. Fix the cause and run \`usertrust anchor init\`.`,
		};
	}
}
