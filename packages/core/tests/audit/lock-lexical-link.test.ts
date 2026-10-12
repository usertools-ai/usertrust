// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The audit lock is taken beside the log it guards, for EVERY writer, not only a governor's. The lock
 * once resolved its directory with the portable resolver, which folds a `..` in a link's target
 * lexically: through `.usertrust -> <a>/link/../vault` it named `<a>/vault`, while the OS (and the
 * log) is at `<link's target>/../vault`. A writer there met no lock and appended beside a live
 * writer's. The governors' shared writer was fixed first; these rows hold the two writers that are
 * built from a caller's spelling: `usertrust audit quarantine-tail` and `usertrust secret`.
 *
 * Layout: <t>/proj/.usertrust -> <t>/a/link/../vault, <t>/a/link -> <t>/b/subdir. The OS opens
 * <t>/b/vault; a lexical fold names <t>/a/vault. Both exist. A live writer holds <t>/b/vault's lock
 * through another project whose `.usertrust` is a plain link to it (no `..`).
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditWriterLockHeldError, createAuditWriter } from "../../src/audit/chain.js";
import { quarantineTornTail } from "../../src/audit/quarantine.js";
import { run as secretRun } from "../../src/cli/secret.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

let t: string;
const argv = process.argv;
const vaultKey = process.env.USERTRUST_VAULT_KEY;
beforeEach(() => {
	// `usertrust secret` needs its key, or it fails before its first append and a row proves nothing.
	process.env.USERTRUST_VAULT_KEY = "a".repeat(64);
	t = mkdtempSync(join(tmpdir(), "lock-lexical-"));
	for (const d of ["a/vault/audit", "b/vault/audit", "b/subdir", "proj", "holder"]) {
		mkdirSync(join(t, d), { recursive: true, mode: 0o700 });
	}
	symlinkSync(join(t, "b", "subdir"), join(t, "a", "link"));
	symlinkSync(`${join(t, "a", "link")}/../vault`, join(t, "proj", VAULT_DIR));
	symlinkSync(join(t, "b", "vault"), join(t, "holder", VAULT_DIR));
	// The vault's own config, which `usertrust secret` loads before it does anything.
	writeFileSync(join(t, "b", "vault", "usertrust.config.json"), JSON.stringify({ budget: 1000 }));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	if (vaultKey === undefined) {
		delete process.env.USERTRUST_VAULT_KEY;
	} else {
		process.env.USERTRUST_VAULT_KEY = vaultKey;
	}
	process.argv = argv;
	process.exitCode = 0;
	rmSync(t, { recursive: true, force: true });
});

const physicalAudit = () => join(t, "b", "vault", "audit");
const lexicalAudit = () => join(t, "a", "vault", "audit");

/** A live writer on the vault, through the plain link: its lock is in the directory the OS opens. */
async function liveHolder() {
	const holder = createAuditWriter(join(t, "holder"), { lockAtCreate: true });
	await holder.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_held" } });
	expect(readdirSync(physicalAudit())).toContain(".audit-writer.lock");
	return holder;
}

describe("a writer built from a caller's spelling meets the lock beside the log", () => {
	it("quarantine-tail through the `..` link is refused by the live writer's lock, and takes none in the lexical directory", async () => {
		const holder = await liveHolder();
		try {
			const log = join(physicalAudit(), "events.jsonl");
			writeFileSync(log, `${readFileSync(log, "utf-8")}{"torn`);
			const before = readFileSync(log);
			const refused = await quarantineTornTail(join(t, "proj")).then(
				() => "repaired",
				(e: unknown) => e,
			);
			expect(refused).toBeInstanceOf(AuditWriterLockHeldError);
			expect(readFileSync(log), "the live writer's log is untouched").toEqual(before);
			expect(readdirSync(lexicalAudit()), "no lock where nothing is written").toEqual([]);
		} finally {
			holder.release();
		}
	});

	it("`usertrust secret add` through the `..` link appends nothing beside the live writer, and takes no lock in the lexical directory", async () => {
		const holder = await liveHolder();
		const cwd = process.cwd();
		const log = join(physicalAudit(), "events.jsonl");
		const before = readFileSync(log);
		try {
			process.chdir(join(t, "proj"));
			process.argv = ["node", "usertrust", "secret", "add", "api_key", "s3cret"];
			await secretRun().catch(() => {});
		} finally {
			process.chdir(cwd);
			holder.release();
		}
		expect(readFileSync(log), "nothing appended under another writer's lock").toEqual(before);
		expect(readdirSync(lexicalAudit())).toEqual([]);
	});

	it("CONTROL: with no other writer, `usertrust secret add` through the same link appends its event to the log the OS opens", async () => {
		const holder = await liveHolder();
		holder.release();
		const log = join(physicalAudit(), "events.jsonl");
		const before = readFileSync(log, "utf-8").trim().split("\n").length;
		const cwd = process.cwd();
		try {
			process.chdir(join(t, "proj"));
			process.argv = ["node", "usertrust", "secret", "add", "api_key", "s3cret"];
			await secretRun();
		} finally {
			process.chdir(cwd);
		}
		expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(before + 1);
		expect(readdirSync(lexicalAudit())).toEqual([]);
	});

	it("CONTROL: with no other writer, quarantine-tail through the same link repairs the vault the OS opens", async () => {
		const holder = await liveHolder();
		holder.release();
		const log = join(physicalAudit(), "events.jsonl");
		writeFileSync(log, `${readFileSync(log, "utf-8")}{"torn`);
		const r = await quarantineTornTail(join(t, "proj"));
		expect(r.torn).not.toBeNull();
		expect(readFileSync(log, "utf-8").endsWith("\n")).toBe(true);
		expect(readdirSync(lexicalAudit())).toEqual([]);
	});
});
