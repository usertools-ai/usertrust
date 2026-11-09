// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it, vi } from "vitest";
import type { AtPayload, SummaryPayload, TotalsPayload } from "../src/shared/api.js";
import { breakdown, WHOLE_VAULT } from "../src/shared/breakdown.js";
import { colorsFromRanking, rankColors, SERIES } from "../src/shared/colors.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { rankingFrom } from "../src/shared/totals.js";
import { type Spec, useVaultServer } from "./helpers/vault-server.js";

/** 30 records of `old-heavy` (cost 100), then 10 that alternate `recent-a` (cost 5) and `recent-b` (cost 3). */
function bigVault(): Spec[] {
	return Array.from({ length: 40 }, (_, i) => {
		if (i < 30) return { kind: "llm_call", actor: "old-heavy", data: { cost: 100 } };
		return i % 2 === 0
			? { kind: "llm_call", actor: "recent-a", data: { cost: 5 } }
			: { kind: "llm_call", actor: "recent-b", data: { cost: 3 } };
	});
}

describe("GET /api/totals", () => {
	const vault = useVaultServer();
	const { start, seed, writeEvents, chain } = vault;

	const base = (): string => `http://127.0.0.1:${vault.ui?.port}`;

	async function totals(): Promise<TotalsPayload> {
		const res = await fetch(`${base()}/api/totals`);
		expect(res.status).toBe(200);
		return (await res.json()) as TotalsPayload;
	}

	/** Polls `/api/totals` (vi.waitFor: every 50 ms, for at most 5 s) until `done` holds; fails with the last payload. */
	async function until(done: (p: TotalsPayload) => boolean): Promise<TotalsPayload> {
		let last = await totals();
		if (done(last)) return last;
		try {
			await vi.waitFor(
				async () => {
					last = await totals();
					if (!done(last)) throw new Error("not settled yet");
				},
				// timing: 5 s bound on the server folding an append or a reload in; on a laptop the slowest whole test that
				// waits here took 686 ms in 5 runs (about 7x headroom). Not yet timed on CI.
				{ timeout: 5000, interval: 50 },
			);
		} catch {
			throw new Error(`totals never settled; last payload: ${JSON.stringify(last)}`);
		}
		return last;
	}

	it("ranks a lane by the whole vault, not by the rows the page holds", async () => {
		writeEvents(chain(bigVault()));
		await start({ rowCap: 10 });
		const p = await totals();
		const ranking = rankingFrom(p, "lane");
		expect(ranking).toEqual(["old-heavy", "recent-a", "recent-b"]);
		expect(colorsFromRanking("lane", ranking).of("old-heavy")).toBe(SERIES[0]);
		// Positive control: the rows the page holds do not include the lane at all, and rank another one first.
		const { rows } = (await (await fetch(`${base()}/api/events`)).json()) as { rows: LedgerRow[] };
		expect(rows).toHaveLength(10);
		expect(rows.some((r) => r.actor === "old-heavy")).toBe(false);
		expect(rankColors(rows, "lane").of("recent-a")).toBe(SERIES[0]);
	});

	it("counts every record, not only the rows held", async () => {
		writeEvents(chain(bigVault()));
		await start({ rowCap: 10 });
		const p = await totals();
		expect(p.records).toBe(40);
		const { summary } = (await (await fetch(`${base()}/api/events`)).json()) as {
			summary: SummaryPayload;
		};
		const laneSum = p.dims.lane.reduce((n, k) => n + k.spendUt, 0);
		expect(laneSum).toBe(3040);
		expect(summary.spentUt).toBe(3040);
		expect(p.dims.lane.find((k) => k.key === "old-heavy")).toEqual({
			key: "old-heavy",
			spendUt: 3000,
			calls: 30,
		});
	});

	it("follows an append", async () => {
		// Written through the writer, as a running vault is: an append then extends the state rather than replacing it.
		const specs = bigVault();
		await seed(specs.length, (n) => specs[n] as Spec);
		await start({ rowCap: 10 });
		const before = await totals();
		expect(before.records).toBe(40);
		// A reader of the live tail is attached, so the append is folded in by the tail's grow step, not by a reload.
		const tail = (
			(await fetch(`${base()}/api/tail`)).body as ReadableStream<Uint8Array>
		).getReader();
		let p: TotalsPayload;
		try {
			await seed(1, () => ({ kind: "llm_call", actor: "recent-b", data: { cost: 5000 } }));
			p = await until((t) => t.records === 41);
		} finally {
			await tail.cancel();
		}
		expect(rankingFrom(p, "lane")).toEqual(["recent-b", "old-heavy", "recent-a"]);
		expect(p.dims.lane[0]).toEqual({ key: "recent-b", spendUt: 5015, calls: 6 });
		expect(p.records).toBe(41);
		// An append never moves the epoch; a fallback reload of other records does. So 41 records under the same
		// epoch show the tail's fold ran, not a rebuild.
		expect(p.epoch).toBe(before.epoch);
	});

	it("rebuilds on a reload with other records, and moves the epoch with /api/at's", async () => {
		writeEvents(chain(bigVault()));
		const s = await start({ rowCap: 10 });
		const before = await totals();
		expect(before.records).toBe(40);
		writeEvents(
			chain(
				Array.from({ length: 20 }, () => ({ kind: "llm_call", actor: "fresh", data: { cost: 7 } })),
			),
		);
		s.reload();
		const after = await until((t) => t.records === 20);
		expect(rankingFrom(after, "lane")).toEqual(["fresh"]);
		expect(after.epoch).toBeGreaterThan(before.epoch);
		const at = (await (await fetch(`${base()}/api/at?pos=0`)).json()) as AtPayload;
		expect(after.epoch).toBe(at.epoch);
	});

	it("matches the breakdown over every record, for every dimension", async () => {
		// A server that holds every row is the oracle for one that holds ten.
		writeEvents(chain(bigVault()));
		await start({ rowCap: 100 });
		const { rows } = (await (await fetch(`${base()}/api/events`)).json()) as { rows: LedgerRow[] };
		expect(rows).toHaveLength(40);
		const whole = await totals();
		for (const dim of ["lane", "role", "model", "kind", "provider"] as const) {
			expect(rankingFrom(whole, dim)).toEqual(breakdown(rows, WHOLE_VAULT, dim).keys);
		}
	});

	it("is GET only and never cached", async () => {
		writeEvents(chain(bigVault()));
		await start();
		const post = await fetch(`${base()}/api/totals`, { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET");
		const get = await fetch(`${base()}/api/totals`);
		expect(get.status).toBe(200);
		expect(get.headers.get("cache-control")).toBe("no-store");
		expect(get.headers.get("content-type")).toMatch(/^application\/json/);
	});
});
