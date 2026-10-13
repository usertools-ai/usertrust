// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A tenant whose audit trail cannot be appended to (its tail refused under `audit.failClosed`, a torn
 * line, another writer holding its vault) is refused by NAME on the wire: HTTP 503, `audit_refused`,
 * with the refusal's state, never an opaque 500. The reason is built from the state, never from the
 * error's message, which names the vault's path on the host. And it is never a policy decision:
 * `evaluate_only` does not turn it into a shadow 200.
 */

import {
	AuditDegradedError,
	AuditTailMismatchError,
	AuditTornTailError,
	AuditWriterLockHeldError,
	type TailState,
} from "usertrust";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { toHttpError } from "../src/wire.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const KEY = "ut_srv_key";
const HOST_PATH = "/srv/tenants/acme/.usertrust/audit/events.jsonl";

const fewer: TailState = {
	state: "FEWER_THAN_ANCHOR",
	torn: null,
	found: { sequence: 7, hash: "a".repeat(64) },
	anchored: { sequence: 10, lastHash: "b".repeat(64) },
	note: "the log ends at sequence 7; its anchor records 10 events: events after 7 are missing",
};
const refusedBy = (cause: unknown) =>
	new AuditDegradedError("the audit trail cannot be appended to", { cause });

describe("toHttpError: an audit refusal is a named 503 with its state", () => {
	it("a refused tail: its state, and no host path", () => {
		const mapped = toHttpError(refusedBy(new AuditTailMismatchError(HOST_PATH, fewer)));
		expect(mapped).toEqual({
			status: 503,
			body: {
				error: "audit_refused",
				reason: "the audit trail's tail is refused (FEWER_THAN_ANCHOR)",
				state: "FEWER_THAN_ANCHOR",
			},
		});
		expect(JSON.stringify(mapped)).not.toContain("/srv/");
	});

	it("a torn line, another writer, and a cause it does not know", () => {
		const torn: TailState = {
			...fewer,
			state: "MATCH",
			torn: { kind: "fragment", offset: 1, length: 2 },
		};
		expect(toHttpError(refusedBy(new AuditTornTailError(HOST_PATH, 2, torn))).body).toMatchObject({
			error: "audit_refused",
			state: "TORN_TAIL",
		});
		expect(
			toHttpError(refusedBy(new AuditWriterLockHeldError(`held: ${HOST_PATH}`))).body,
		).toMatchObject({ error: "audit_refused", state: "WRITER_LOCK_HELD" });
		const unknown = toHttpError(refusedBy(new Error(`EIO at ${HOST_PATH}`)));
		expect(unknown).toMatchObject({
			status: 503,
			body: { error: "audit_refused", state: "UNKNOWN" },
		});
		expect(JSON.stringify(unknown)).not.toContain("/srv/");
	});

	it("torn bytes after lines refused in their own right: the lines' state is the one named, never TORN_TAIL alone", () => {
		const tornAfterTruncation: TailState = {
			...fewer,
			torn: { kind: "non_event", offset: 1, length: 2 },
		};
		const mapped = toHttpError(
			refusedBy(new AuditTornTailError(HOST_PATH, 2, tornAfterTruncation)),
		);
		expect(mapped).toEqual({
			status: 503,
			body: {
				error: "audit_refused",
				reason:
					"the audit trail's tail is refused (FEWER_THAN_ANCHOR), and the audit log ends in a torn line (non_event)",
				state: "FEWER_THAN_ANCHOR",
			},
		});
		expect(JSON.stringify(mapped)).not.toContain("/srv/");
	});

	it("a refusal thrown bare, with nothing wrapping it (a settle whose record could not be written): the same 503, never an opaque 500", () => {
		expect(toHttpError(new AuditTailMismatchError(HOST_PATH, fewer))).toEqual({
			status: 503,
			body: {
				error: "audit_refused",
				reason: "the audit trail's tail is refused (FEWER_THAN_ANCHOR)",
				state: "FEWER_THAN_ANCHOR",
			},
		});
		const torn: TailState = {
			...fewer,
			state: "MATCH",
			torn: { kind: "fragment", offset: 1, length: 2 },
		};
		expect(toHttpError(new AuditTornTailError(HOST_PATH, 2, torn))).toMatchObject({
			status: 503,
			body: { error: "audit_refused", state: "TORN_TAIL" },
		});
		const held = toHttpError(new AuditWriterLockHeldError(`held: ${HOST_PATH}`));
		expect(held).toMatchObject({
			status: 503,
			body: { error: "audit_refused", state: "WRITER_LOCK_HELD" },
		});
		expect(JSON.stringify(held)).not.toContain("/srv/");
	});

	it("CONTROL: an error that is no audit refusal is still the opaque 500", () => {
		expect(toHttpError(new Error(`EIO at ${HOST_PATH}`))).toEqual({
			status: 500,
			body: { error: "internal", reason: "internal error" },
		});
	});
});

describe("POST /v1/authorize: a fail-closed tenant whose audit is refused", () => {
	let server: UsertrustServer | undefined;
	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	async function startWith(enforcement: ServerConfig["enforcement"]): Promise<string> {
		const fake = createFakeGovernor();
		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir: "/tmp/utsrv-audit-refused",
				enforcement,
				pendingTtlMs: 300_000,
				dryRun: true,
				tenants: [{ id: "acme", keyHash: hashKey(KEY) }],
			},
			factory: async () => ({
				...fake.governor,
				authorize: async () => {
					throw refusedBy(new AuditTailMismatchError(HOST_PATH, fewer));
				},
			}),
		});
		const { port } = await server.listen();
		return `http://127.0.0.1:${port}`;
	}

	const authorize = (base: string) =>
		fetch(`${base}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ model: "m" }),
		});

	it("enforce: 503 audit_refused, with the state", async () => {
		const res = await authorize(await startWith("enforce"));
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			error: "audit_refused",
			reason: "the audit trail's tail is refused (FEWER_THAN_ANCHOR)",
			state: "FEWER_THAN_ANCHOR",
		});
	});

	it("evaluate_only: still 503, never a shadow 200 (the server cannot record the call; that is no policy decision)", async () => {
		const res = await authorize(await startWith("evaluate_only"));
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: string }).error).toBe("audit_refused");
	});
});
