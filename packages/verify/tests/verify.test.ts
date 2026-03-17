import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENESIS_HASH, canonicalize, verifyChain, verifyVault } from "../src/index.js";

// ── Helpers ──

function makeTempVault(): string {
	const dir = join(tmpdir(), `verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(dir, "audit"), { recursive: true });
	return dir;
}

interface EventData {
	kind: string;
	actor: string;
	data: Record<string, unknown>;
}

function buildChain(events: EventData[]): string[] {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];

	for (let i = 0; i < events.length; i++) {
		const ev = events[i];
		if (!ev) continue;
		const event: Record<string, unknown> = {
			id: `evt-${i + 1}`,
			timestamp: new Date(Date.now() + i * 1000).toISOString(),
			previousHash,
			kind: ev.kind,
			actor: ev.actor,
			data: ev.data,
			sequence: i + 1,
		};

		const canonical = canonicalize(event);
		const hash = createHash("sha256").update(canonical).digest("hex");
		const fullEvent = { ...event, hash };

		previousHash = hash;
		lines.push(JSON.stringify(fullEvent));
	}

	return lines;
}

function writeChainToVault(vaultPath: string, lines: string[]): void {
	const logPath = join(vaultPath, "audit", "events.jsonl");
	writeFileSync(logPath, `${lines.join("\n")}\n`);
}

// ── Tests ──

describe("verifyChain", () => {
	let vaultPath: string;

	beforeEach(() => {
		vaultPath = makeTempVault();
	});

	afterEach(() => {
		if (existsSync(vaultPath)) {
			rmSync(vaultPath, { recursive: true, force: true });
		}
	});

	it("returns valid for an empty chain (no file)", () => {
		const logPath = join(vaultPath, "audit", "events.jsonl");
		const result = verifyChain(logPath);
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(0);
		expect(result.latestHash).toBe(GENESIS_HASH);
	});

	it("returns valid for a correctly chained log", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { model: "claude-sonnet-4-6" } },
			{ kind: "llm_call", actor: "local", data: { model: "gpt-4o" } },
			{ kind: "llm_call", actor: "local", data: { model: "gemini-2.0-flash" } },
		]);
		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(true);
		expect(result.eventsVerified).toBe(3);
		expect(result.errors).toEqual([]);
	});

	it("detects tampered event hash", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { model: "claude-sonnet-4-6" } },
			{ kind: "llm_call", actor: "local", data: { cost: 100 } },
		]);
		// Tamper with the second event's data
		const secondLine = lines[1];
		if (!secondLine) throw new Error("Expected second line");
		const tampered = JSON.parse(secondLine) as Record<string, unknown>;
		tampered.data = { cost: 999 }; // change data without updating hash
		lines[1] = JSON.stringify(tampered);

		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("hash mismatch");
	});

	it("detects broken previousHash linkage", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { model: "claude-sonnet-4-6" } },
			{ kind: "llm_call", actor: "local", data: { model: "gpt-4o" } },
		]);
		// Break the chain by changing the second event's previousHash
		const secondLine = lines[1];
		if (!secondLine) throw new Error("Expected second line");
		const parsed = JSON.parse(secondLine) as Record<string, unknown>;
		parsed.previousHash = "deadbeef".repeat(8);
		// Recompute hash for the tampered event so hash itself is valid
		const { hash: _, ...withoutHash } = parsed;
		const canonical = canonicalize(withoutHash);
		parsed.hash = createHash("sha256").update(canonical).digest("hex");
		lines[1] = JSON.stringify(parsed);

		const logPath = join(vaultPath, "audit", "events.jsonl");
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const result = verifyChain(logPath);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("previousHash mismatch"))).toBe(true);
	});
});

describe("verifyVault", () => {
	let vaultPath: string;

	beforeEach(() => {
		vaultPath = makeTempVault();
	});

	afterEach(() => {
		if (existsSync(vaultPath)) {
			rmSync(vaultPath, { recursive: true, force: true });
		}
	});

	it("returns VERIFIED for a valid vault", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { model: "claude-sonnet-4-6" } },
			{ kind: "llm_call", actor: "local", data: { model: "gpt-4o" } },
		]);
		writeChainToVault(vaultPath, lines);

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(2);
		expect(result.validHashes).toBe(2);
		expect(result.errors).toEqual([]);
	});

	it("reports chain length and Merkle root", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { a: 1 } },
			{ kind: "llm_call", actor: "local", data: { a: 2 } },
			{ kind: "llm_call", actor: "local", data: { a: 3 } },
		]);
		writeChainToVault(vaultPath, lines);

		const result = verifyVault(vaultPath);
		expect(result.chainLength).toBe(3);
		expect(result.merkleRoot).not.toBeNull();
		expect(typeof result.merkleRoot).toBe("string");
		expect(result.merkleRoot?.length).toBe(64); // SHA-256 hex
	});

	it("reports first and last event timestamps", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: {} },
			{ kind: "llm_call", actor: "local", data: {} },
		]);
		writeChainToVault(vaultPath, lines);

		const result = verifyVault(vaultPath);
		expect(result.firstEvent).not.toBeNull();
		expect(result.lastEvent).not.toBeNull();
	});

	it("detects tampered chain in vault", () => {
		const lines = buildChain([
			{ kind: "llm_call", actor: "local", data: { cost: 50 } },
			{ kind: "llm_call", actor: "local", data: { cost: 100 } },
		]);
		// Tamper
		const secondLine = lines[1];
		if (!secondLine) throw new Error("Expected second line");
		const tampered = JSON.parse(secondLine) as Record<string, unknown>;
		tampered.data = { cost: 0 };
		lines[1] = JSON.stringify(tampered);
		writeChainToVault(vaultPath, lines);

		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("handles missing audit directory", () => {
		const emptyVault = join(
			tmpdir(),
			`verify-test-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(emptyVault, { recursive: true });

		try {
			const result = verifyVault(emptyVault);
			expect(result.valid).toBe(false);
			expect(result.chainLength).toBe(0);
			expect(result.merkleRoot).toBeNull();
			expect(result.errors.length).toBeGreaterThan(0);
		} finally {
			rmSync(emptyVault, { recursive: true, force: true });
		}
	});

	it("handles empty vault with audit directory but no logs", () => {
		// vaultPath already has audit dir from makeTempVault
		const result = verifyVault(vaultPath);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(0);
		expect(result.merkleRoot).toBeNull();
	});

	it("returns deterministic Merkle root for same data", () => {
		const events: EventData[] = [
			{ kind: "llm_call", actor: "local", data: { x: 1 } },
			{ kind: "llm_call", actor: "local", data: { x: 2 } },
		];
		const lines = buildChain(events);
		writeChainToVault(vaultPath, lines);

		const result1 = verifyVault(vaultPath);

		// Write same chain to a second vault
		const vaultPath2 = makeTempVault();
		try {
			writeChainToVault(vaultPath2, lines);
			const result2 = verifyVault(vaultPath2);

			expect(result1.merkleRoot).toBe(result2.merkleRoot);
		} finally {
			rmSync(vaultPath2, { recursive: true, force: true });
		}
	});
});
