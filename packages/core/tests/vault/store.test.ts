// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Tests for the encrypted credential vault store — add, get, remove, rotate,
 * scope enforcement, audit events, and destroy.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditWriter } from "../../src/audit/chain.js";
import { VaultKeyMissingError } from "../../src/shared/errors.js";
import { TrustConfigSchema } from "../../src/shared/types.js";
import type { TrustConfig } from "../../src/shared/types.js";
import { createVaultStore } from "../../src/vault/store.js";

// ── Helpers ──

const TEST_PASSPHRASE = "test-vault-passphrase-2026";

function makeTmpVault(): string {
	const dir = join(tmpdir(), `vault-store-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeConfig(overrides?: Partial<TrustConfig["vault"]>): TrustConfig {
	return TrustConfigSchema.parse({
		budget: 10_000,
		vault: {
			enabled: true,
			auditAccess: true,
			...overrides,
		},
	});
}

/** Simple audit writer mock that records all appended events. */
function mockAuditWriter(): AuditWriter & {
	events: Array<{ kind: string; data: Record<string, unknown> }>;
} {
	const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
	return {
		events,
		appendEvent: vi.fn(async (input) => {
			events.push({ kind: input.kind, data: input.data });
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		}),
		getWriteFailures: () => 0,
		isDegraded: () => false,
		flush: async () => {},
		release: () => {},
	};
}

// ── Test Suite ──

describe("VaultStore", () => {
	let tmpVault: string;
	const originalEnv = process.env.USERTRUST_VAULT_KEY;

	beforeEach(() => {
		tmpVault = makeTmpVault();
		process.env.USERTRUST_VAULT_KEY = TEST_PASSPHRASE;
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// Cleanup best-effort
		}
		if (originalEnv === undefined) {
			// biome-ignore lint/performance/noDelete: must remove env var, not set to "undefined" string
			delete process.env.USERTRUST_VAULT_KEY;
		} else {
			process.env.USERTRUST_VAULT_KEY = originalEnv;
		}
	});

	// ─────────────────────────────────────────────────────────────────────
	// 1. add + get round-trip
	// ─────────────────────────────────────────────────────────────────────

	it("add + get round-trip succeeds", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("OPENAI_API_KEY", "sk-test-12345");
		const result = await store.get("OPENAI_API_KEY", { agent: "agent-1", action: "llm_call" });

		expect(result.granted).toBe(true);
		expect(result.value).toBe("sk-test-12345");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 2. add + list shows entry without value
	// ─────────────────────────────────────────────────────────────────────

	it("add + list shows entry without value", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("SECRET_TOKEN", "tok-secret-value");
		const entries = await store.list();

		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("SECRET_TOKEN");
		expect(entries[0].scope).toBeDefined();
		expect(entries[0].createdAt).toBeTruthy();
		expect(entries[0].rotatedAt).toBeTruthy();
		// Value must NOT be present in list output
		expect((entries[0] as Record<string, unknown>).value).toBeUndefined();
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 3. add + remove + get returns not found
	// ─────────────────────────────────────────────────────────────────────

	it("add + remove + get returns not found", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("TEMP_KEY", "temporary");
		await store.remove("TEMP_KEY");
		const result = await store.get("TEMP_KEY", { agent: "agent-1", action: "llm_call" });

		expect(result.granted).toBe(false);
		expect(result.reason).toContain("not found");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 4. get with correct agent scope succeeds
	// ─────────────────────────────────────────────────────────────────────

	it("get with correct agent scope succeeds", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("SCOPED_KEY", "value", { agents: ["allowed-agent"] });
		const result = await store.get("SCOPED_KEY", {
			agent: "allowed-agent",
			action: "llm_call",
		});

		expect(result.granted).toBe(true);
		expect(result.value).toBe("value");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 5. get with wrong agent scope denied
	// ─────────────────────────────────────────────────────────────────────

	it("get with wrong agent scope denied", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("SCOPED_KEY", "value", { agents: ["allowed-agent"] });
		const result = await store.get("SCOPED_KEY", {
			agent: "forbidden-agent",
			action: "llm_call",
		});

		expect(result.granted).toBe(false);
		expect(result.reason).toContain("forbidden-agent");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 6. get with correct action scope succeeds
	// ─────────────────────────────────────────────────────────────────────

	it("get with correct action scope succeeds", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("ACTION_KEY", "value", { actions: ["llm_call", "api_request"] });
		const result = await store.get("ACTION_KEY", {
			agent: "agent-1",
			action: "api_request",
		});

		expect(result.granted).toBe(true);
		expect(result.value).toBe("value");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 7. get with wrong action scope denied
	// ─────────────────────────────────────────────────────────────────────

	it("get with wrong action scope denied", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("ACTION_KEY", "value", { actions: ["llm_call"] });
		const result = await store.get("ACTION_KEY", {
			agent: "agent-1",
			action: "shell_command",
		});

		expect(result.granted).toBe(false);
		expect(result.reason).toContain("shell_command");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 8. get with expired credential denied
	// ─────────────────────────────────────────────────────────────────────

	it("get with expired credential denied", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		const pastDate = new Date(Date.now() - 60_000).toISOString();
		await store.add("EXPIRED_KEY", "value", { expiresAt: pastDate });
		const result = await store.get("EXPIRED_KEY", { agent: "agent-1", action: "llm_call" });

		expect(result.granted).toBe(false);
		expect(result.reason).toBe("Credential expired");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 9. get with non-expired credential succeeds
	// ─────────────────────────────────────────────────────────────────────

	it("get with non-expired credential succeeds", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		const futureDate = new Date(Date.now() + 60_000).toISOString();
		await store.add("VALID_KEY", "value", { expiresAt: futureDate });
		const result = await store.get("VALID_KEY", { agent: "agent-1", action: "llm_call" });

		expect(result.granted).toBe(true);
		expect(result.value).toBe("value");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 10. rotate updates value
	// ─────────────────────────────────────────────────────────────────────

	it("rotate updates value", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("ROTATE_KEY", "old-value");
		await store.rotate("ROTATE_KEY", "new-value");
		const result = await store.get("ROTATE_KEY", { agent: "agent-1", action: "llm_call" });

		expect(result.granted).toBe(true);
		expect(result.value).toBe("new-value");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 11. rotate updates rotatedAt timestamp
	// ─────────────────────────────────────────────────────────────────────

	it("rotate updates rotatedAt timestamp", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("ROTATE_TS_KEY", "value");
		const before = await store.list();
		const createdAt = before[0].rotatedAt;

		// Small delay to ensure timestamp difference
		await new Promise((r) => setTimeout(r, 10));
		await store.rotate("ROTATE_TS_KEY", "new-value");
		const after = await store.list();

		expect(new Date(after[0].rotatedAt).getTime()).toBeGreaterThan(new Date(createdAt).getTime());
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 12. list returns multiple entries
	// ─────────────────────────────────────────────────────────────────────

	it("list returns multiple entries", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("KEY_A", "value-a");
		await store.add("KEY_B", "value-b");
		await store.add("KEY_C", "value-c");
		const entries = await store.list();

		expect(entries).toHaveLength(3);
		const names = entries.map((e) => e.name).sort();
		expect(names).toEqual(["KEY_A", "KEY_B", "KEY_C"]);
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 13. add duplicate name overwrites
	// ─────────────────────────────────────────────────────────────────────

	it("add duplicate name overwrites", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("DUP_KEY", "first-value");
		await store.add("DUP_KEY", "second-value");

		const entries = await store.list();
		expect(entries).toHaveLength(1);

		const result = await store.get("DUP_KEY", { agent: "agent-1", action: "llm_call" });
		expect(result.value).toBe("second-value");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 14. destroy wipes state
	// ─────────────────────────────────────────────────────────────────────

	it("destroy wipes state", async () => {
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
		});

		await store.add("WIPE_KEY", "secret");
		store.destroy();

		await expect(store.get("WIPE_KEY", { agent: "agent-1", action: "llm_call" })).rejects.toThrow(
			"VaultStore has been destroyed",
		);
	});

	// ─────────────────────────────────────────────────────────────────────
	// 15. get emits audit event (credential_access)
	// ─────────────────────────────────────────────────────────────────────

	it("get emits audit event (credential_access)", async () => {
		const audit = mockAuditWriter();
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
			audit,
		});

		await store.add("AUDIT_KEY", "value");
		await store.get("AUDIT_KEY", { agent: "agent-1", action: "llm_call" });

		const accessEvents = audit.events.filter((e) => e.kind === "credential_access");
		expect(accessEvents).toHaveLength(1);
		expect(accessEvents[0].data.name).toBe("AUDIT_KEY");
		expect(accessEvents[0].data.agent).toBe("agent-1");
		expect(accessEvents[0].data.action).toBe("llm_call");
		expect(accessEvents[0].data.granted).toBe(true);
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 16. denied get emits audit event (credential_denied)
	// ─────────────────────────────────────────────────────────────────────

	it("denied get emits audit event (credential_denied)", async () => {
		const audit = mockAuditWriter();
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
			audit,
		});

		await store.add("DENIED_KEY", "value", { agents: ["only-this-agent"] });
		await store.get("DENIED_KEY", { agent: "wrong-agent", action: "llm_call" });

		const deniedEvents = audit.events.filter((e) => e.kind === "credential_denied");
		expect(deniedEvents).toHaveLength(1);
		expect(deniedEvents[0].data.name).toBe("DENIED_KEY");
		expect(deniedEvents[0].data.granted).toBe(false);
		expect(deniedEvents[0].data.reason).toContain("wrong-agent");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 17. add emits audit event (credential_added)
	// ─────────────────────────────────────────────────────────────────────

	it("add emits audit event (credential_added)", async () => {
		const audit = mockAuditWriter();
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
			audit,
		});

		await store.add("NEW_KEY", "value");

		const addedEvents = audit.events.filter((e) => e.kind === "credential_added");
		expect(addedEvents).toHaveLength(1);
		expect(addedEvents[0].data.name).toBe("NEW_KEY");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 18. remove emits audit event (credential_removed)
	// ─────────────────────────────────────────────────────────────────────

	it("remove emits audit event (credential_removed)", async () => {
		const audit = mockAuditWriter();
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
			audit,
		});

		await store.add("RM_KEY", "value");
		await store.remove("RM_KEY");

		const removedEvents = audit.events.filter((e) => e.kind === "credential_removed");
		expect(removedEvents).toHaveLength(1);
		expect(removedEvents[0].data.name).toBe("RM_KEY");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 19. rotate emits audit event (credential_rotated)
	// ─────────────────────────────────────────────────────────────────────

	it("rotate emits audit event (credential_rotated)", async () => {
		const audit = mockAuditWriter();
		const store = await createVaultStore({
			vaultBase: tmpVault,
			config: makeConfig(),
			audit,
		});

		await store.add("ROT_KEY", "old-value");
		await store.rotate("ROT_KEY", "new-value");

		const rotatedEvents = audit.events.filter((e) => e.kind === "credential_rotated");
		expect(rotatedEvents).toHaveLength(1);
		expect(rotatedEvents[0].data.name).toBe("ROT_KEY");
		store.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────
	// 20. missing vault key throws VaultKeyMissingError
	// ─────────────────────────────────────────────────────────────────────

	it("missing vault key throws VaultKeyMissingError", async () => {
		// biome-ignore lint/performance/noDelete: must remove env var, not set to "undefined" string
		delete process.env.USERTRUST_VAULT_KEY;

		await expect(
			createVaultStore({
				vaultBase: tmpVault,
				config: makeConfig(),
			}),
		).rejects.toThrow(VaultKeyMissingError);
	});

	// ─────────────────────────────────────────────────────────────────────
	// 21. Persistence — data survives across store instances
	// ─────────────────────────────────────────────────────────────────────

	it("persists encrypted data across store instances", async () => {
		const config = makeConfig();

		// First store — add credential
		const store1 = await createVaultStore({ vaultBase: tmpVault, config });
		await store1.add("PERSIST_KEY", "persistent-value");
		store1.destroy();

		// Second store — read credential
		const store2 = await createVaultStore({ vaultBase: tmpVault, config });
		const result = await store2.get("PERSIST_KEY", { agent: "agent-1", action: "llm_call" });

		expect(result.granted).toBe(true);
		expect(result.value).toBe("persistent-value");
		store2.destroy();
	});
});
