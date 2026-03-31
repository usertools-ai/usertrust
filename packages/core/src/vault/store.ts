// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Encrypted Credential Store — AES-256-GCM vault for agent secrets.
 *
 * Stores credentials in `<vaultBase>/.usertrust/credentials.enc` as a JSON
 * envelope `{ salt, iv, tag, ciphertext }` wrapping an encrypted array of
 * CredentialEntry objects. Scoped access (agent/action/time-window) is enforced
 * on every `get()` call, with audit events emitted for all operations.
 *
 * Atomic writes: data is written to a .tmp file then renamed, matching the
 * spend-ledger pattern in govern.ts.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditWriter } from "../audit/chain.js";
import { VAULT_DIR } from "../shared/constants.js";
import { VaultKeyMissingError } from "../shared/errors.js";
import type {
	ActionKind,
	CredentialAccessResult,
	CredentialEntry,
	CredentialScope,
	TrustConfig,
} from "../shared/types.js";
import { deriveKey, generateSalt } from "./derive.js";
import { checkScope } from "./scope.js";

// ── Encrypted file envelope ──

interface VaultEnvelope {
	salt: string;
	iv: string;
	tag: string;
	ciphertext: string;
}

// ── Public interface ──

export interface VaultStore {
	add(name: string, value: string, scope?: Partial<CredentialScope>): Promise<void>;
	remove(name: string): Promise<void>;
	get(
		name: string,
		accessor: { agent: string; action: ActionKind },
	): Promise<CredentialAccessResult>;
	list(): Promise<
		Array<{ name: string; scope: CredentialScope; createdAt: string; rotatedAt: string }>
	>;
	rotate(name: string, newValue: string): Promise<void>;
	destroy(): void;
}

// ── Encryption helpers ──

function encrypt(data: string, passphrase: string): VaultEnvelope {
	const salt = generateSalt();
	const key = deriveKey(passphrase, salt);
	const iv = randomBytes(12); // 12-byte IV for AES-256-GCM
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(data, "utf-8"), cipher.final()]);
	const tag = cipher.getAuthTag(); // 16-byte auth tag
	return {
		salt: salt.toString("hex"),
		iv: iv.toString("hex"),
		tag: tag.toString("hex"),
		ciphertext: encrypted.toString("hex"),
	};
}

function decrypt(envelope: VaultEnvelope, passphrase: string): string {
	const salt = Buffer.from(envelope.salt, "hex");
	const key = deriveKey(passphrase, salt);
	const iv = Buffer.from(envelope.iv, "hex");
	const tag = Buffer.from(envelope.tag, "hex");
	const ciphertext = Buffer.from(envelope.ciphertext, "hex");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return decrypted.toString("utf-8");
}

// ── Factory ──

/**
 * Create an encrypted vault store.
 *
 * Reads the master key from the env var specified in config.vault.masterKeyEnv
 * (default: USERTRUST_VAULT_KEY). Throws VaultNotInitializedError if the key
 * is not set.
 */
export async function createVaultStore(opts: {
	vaultBase: string;
	config: TrustConfig;
	audit?: AuditWriter;
}): Promise<VaultStore> {
	const { vaultBase, config, audit } = opts;

	const masterKeyEnv = config.vault?.masterKeyEnv ?? "USERTRUST_VAULT_KEY";
	const envValue = process.env[masterKeyEnv];
	if (!envValue) {
		throw new VaultKeyMissingError(masterKeyEnv);
	}
	const passphrase: string = envValue;

	const auditAccess = config.vault?.auditAccess ?? true;
	const defaultScope: CredentialScope = {
		agents: config.vault?.defaultScope?.agents ?? [],
		actions: (config.vault?.defaultScope?.actions ?? []) as ActionKind[],
		expiresAt: config.vault?.defaultScope?.expiresAt ?? null,
	};

	const vaultDir = join(vaultBase, VAULT_DIR);
	const credPath = join(vaultDir, "credentials.enc");
	const tmpPath = join(vaultDir, "credentials.enc.tmp");

	// Ensure vault directory exists
	if (!existsSync(vaultDir)) {
		mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
	}

	// ── In-memory credential state ──

	let entries: CredentialEntry[] = [];
	let destroyed = false;

	// Load existing credentials from disk
	if (existsSync(credPath)) {
		const raw = readFileSync(credPath, "utf-8");
		const envelope = JSON.parse(raw) as VaultEnvelope;
		const plaintext = decrypt(envelope, passphrase);
		entries = JSON.parse(plaintext) as CredentialEntry[];
	}

	// ── Persistence ──

	function persist(): void {
		const plaintext = JSON.stringify(entries);
		const envelope = encrypt(plaintext, passphrase);
		// Atomic write: write to .tmp then rename
		writeFileSync(tmpPath, JSON.stringify(envelope), { encoding: "utf-8", mode: 0o600 });
		renameSync(tmpPath, credPath);
	}

	// ── Audit helper ──

	async function emitAudit(kind: string, data: Record<string, unknown>): Promise<void> {
		if (auditAccess && audit) {
			await audit.appendEvent({ kind, actor: "vault", data });
		}
	}

	// ── VaultStore implementation ──

	async function add(
		name: string,
		value: string,
		scope?: Partial<CredentialScope>,
	): Promise<void> {
		if (destroyed) throw new Error("VaultStore has been destroyed");

		const now = new Date().toISOString();
		const mergedScope: CredentialScope = {
			agents: scope?.agents ?? defaultScope.agents,
			actions: scope?.actions ?? defaultScope.actions,
			expiresAt: scope?.expiresAt !== undefined ? scope.expiresAt : defaultScope.expiresAt,
		};

		// Overwrite if already exists
		const existing = entries.findIndex((e) => e.name === name);
		const entry: CredentialEntry = {
			name,
			value,
			scope: mergedScope,
			createdAt: now,
			rotatedAt: now,
		};

		if (existing >= 0) {
			entries[existing] = entry;
		} else {
			entries.push(entry);
		}

		persist();
		await emitAudit("credential_added", { name });
	}

	async function remove(name: string): Promise<void> {
		if (destroyed) throw new Error("VaultStore has been destroyed");

		entries = entries.filter((e) => e.name !== name);
		persist();
		await emitAudit("credential_removed", { name });
	}

	async function get(
		name: string,
		accessor: { agent: string; action: ActionKind },
	): Promise<CredentialAccessResult> {
		if (destroyed) throw new Error("VaultStore has been destroyed");

		const entry = entries.find((e) => e.name === name);
		if (!entry) {
			return { granted: false, reason: `Credential "${name}" not found` };
		}

		const scopeResult = checkScope(entry.scope, accessor);
		if (!scopeResult.allowed) {
			const reason = scopeResult.reason ?? "Access denied";
			await emitAudit("credential_denied", {
				name,
				agent: accessor.agent,
				action: accessor.action,
				granted: false,
				reason,
			});
			return { granted: false, reason };
		}

		await emitAudit("credential_access", {
			name,
			agent: accessor.agent,
			action: accessor.action,
			granted: true,
		});
		return { granted: true, value: entry.value };
	}

	async function list(): Promise<
		Array<{ name: string; scope: CredentialScope; createdAt: string; rotatedAt: string }>
	> {
		if (destroyed) throw new Error("VaultStore has been destroyed");

		return entries.map((e) => ({
			name: e.name,
			scope: e.scope,
			createdAt: e.createdAt,
			rotatedAt: e.rotatedAt,
		}));
	}

	async function rotate(name: string, newValue: string): Promise<void> {
		if (destroyed) throw new Error("VaultStore has been destroyed");

		const entry = entries.find((e) => e.name === name);
		if (!entry) {
			throw new Error(`Credential "${name}" not found`);
		}

		entry.value = newValue;
		entry.rotatedAt = new Date().toISOString();
		persist();
		await emitAudit("credential_rotated", { name });
	}

	function destroyStore(): void {
		// Note: JavaScript strings are immutable in V8 — assigning "" removes the
		// reference but the original string remains in the heap until GC. True
		// memory-safe secret clearing requires Buffer-based storage, which is a
		// future enhancement. This destroy() provides reference cleanup only.
		for (const entry of entries) {
			entry.value = "";
		}
		entries = [];
		destroyed = true;
	}

	return {
		add,
		remove,
		get,
		list,
		rotate,
		destroy: destroyStore,
	};
}
