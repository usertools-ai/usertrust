// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transferIdHash } from "usertrust-verify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../core/src/audit/chain.js";
import { createUiServer, type UiServer } from "../src/server/server.js";

async function readSse(
	port: number,
	predicate: (eventName: string) => boolean,
	act: () => Promise<void>,
	timeoutMs = 5000,
): Promise<{ eventName: string; data: string; id: string | undefined }> {
	const res = await fetch(`http://127.0.0.1:${port}/api/tail`);
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	await act();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const blocks = buffer.split("\n\n");
		buffer = blocks.pop() ?? "";
		for (const block of blocks) {
			const eventName = /event: (.+)/.exec(block)?.[1] ?? "message";
			const data = /data: (.+)/.exec(block)?.[1] ?? "";
			const id = /^id: (.+)$/m.exec(block)?.[1];
			if (predicate(eventName)) {
				await reader.cancel();
				return { eventName, data, id };
			}
		}
	}
	await reader.cancel();
	throw new Error("SSE event not received in time");
}

describe("live tail", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-tail-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { cost: 1, transferId: "tx_seed" },
		});
		writer.release();
	});

	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("pushes appended events as rows", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const { eventName, data } = await readSse(
			ui.port,
			(name) => name === "rows",
			async () => {
				const writer = createAuditWriter(tempDir);
				await writer.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { cost: 2, transferId: "tx_live" },
				});
				writer.release();
			},
		);
		expect(eventName).toBe("rows");
		const rows = JSON.parse(data) as Array<{ transferId?: string }>;
		expect(rows.some((r) => r.transferId === "tx_live")).toBe(true);
	});

	it("red-first (stays settled): an ambiguity appended after an OPTIMISTIC settlement re-classifies the EARLIER row", async () => {
		// The audit-first path writes `settled: true` before the POST and appends `settlement_ambiguous` only when the
		// POST throws: the earlier row's verdict changes after it was sent, so the server sends the change.
		const seed = createAuditWriter(tempDir);
		await seed.appendEvent({
			kind: "llm_call",
			actor: "local",
			data: { cost: 3, transferId: "tx_opt", settled: true },
		});
		seed.release();
		ui = await createUiServer(tempDir, { port: 0 });
		const before = (await (await fetch(`http://127.0.0.1:${ui.port}/api/events`)).json()) as {
			rows: Array<{ id: string; transferId?: string; status?: string }>;
		};
		const optimistic = before.rows.find((r) => r.transferId === "tx_opt");
		expect(optimistic?.status).toBe("settled");
		const { data } = await readSse(
			ui.port,
			(name) => name === "status",
			async () => {
				const writer = createAuditWriter(tempDir);
				await writer.appendEvent({
					kind: "settlement_ambiguous",
					actor: "local",
					data: { transferId: "tx_opt", error: "post failed" },
				});
				writer.release();
			},
		);
		expect(JSON.parse(data)).toEqual([{ id: optimistic?.id, status: "ambiguous" }]);
		const after = (await (await fetch(`http://127.0.0.1:${ui.port}/api/events`)).json()) as {
			rows: Array<{ transferId?: string; kind: string; status?: string }>;
		};
		expect(
			after.rows.filter((r) => r.transferId === "tx_opt").map((r) => [r.kind, r.status]),
		).toEqual([
			["llm_call", "ambiguous"],
			["settlement_ambiguous", "ambiguous"],
		]);
	});

	it("every frame carries the state's version as its SSE id, and a snapshot the version it was taken at", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const events = async () =>
			(await (await fetch(`http://127.0.0.1:${ui?.port}/api/events`)).json()) as {
				version: number;
			};
		const { version: before } = await events();
		expect(typeof before).toBe("number");
		const { id } = await readSse(
			ui.port,
			(name) => name === "rows",
			async () => {
				const writer = createAuditWriter(tempDir);
				await writer.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: { cost: 2, transferId: "tx_v" },
				});
				writer.release();
			},
		);
		expect(id).toBe(String(before + 1));
		expect((await events()).version).toBe(before + 1);
	});

	it("red-first (unrecoverable): a late settle's hash-only record joins its swept transfer live: RELEASED", async () => {
		const seed = createAuditWriter(tempDir);
		await seed.appendEvent({
			kind: "hold_released",
			actor: "local",
			data: { transferId: "tx_swept", reason: "pending TTL expired" },
		});
		seed.release();
		ui = await createUiServer(tempDir, { port: 0 });
		const { data } = await readSse(
			ui.port,
			(name) => name === "rows",
			async () => {
				const writer = createAuditWriter(tempDir);
				await writer.appendEvent({
					kind: "settlement_unrecoverable",
					actor: "local",
					data: { transferIdHash: transferIdHash("tx_swept"), reason: "no hold" },
				});
				writer.release();
			},
		);
		expect(
			(JSON.parse(data) as Array<{ kind: string; status?: string }>).map((r) => [r.kind, r.status]),
		).toEqual([["settlement_unrecoverable", "released"]]);
	});

	it("signals resync when the log shrinks", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		const { eventName } = await readSse(
			ui.port,
			(name) => name === "resync",
			async () => {
				truncateSync(logPath, 0);
			},
		);
		expect(eventName).toBe("resync");
	});

	it("signals resync when an appended event's hash does not verify", async () => {
		// Amendment A4: linkage alone is not enough — a forged line with the
		// correct previousHash but a bogus hash must trigger a full resync.
		ui = await createUiServer(tempDir, { port: 0 });
		const logPath = join(tempDir, ".usertrust", "audit", "events.jsonl");
		const lastLine = readFileSync(logPath, "utf-8").trim().split("\n").at(-1) as string;
		const last = JSON.parse(lastLine) as { hash: string };
		const forged = {
			id: "forged",
			timestamp: new Date().toISOString(),
			previousHash: last.hash,
			kind: "llm_call",
			actor: "local",
			data: { cost: 999, transferId: "tx_forged" },
			sequence: 2,
			hash: "0".repeat(64),
		};
		const { eventName } = await readSse(
			ui.port,
			(name) => name === "resync",
			async () => {
				appendFileSync(logPath, `${JSON.stringify(forged)}\n`);
			},
		);
		expect(eventName).toBe("resync");
	});
});
