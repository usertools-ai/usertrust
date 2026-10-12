// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { frameVersion, SnapshotReplay } from "../src/shared/replay.js";

type D = { status: Record<string, string> };
const set =
	(id: string, status: string) =>
	(d: D): D => ({ status: { ...d.status, [id]: status } });
const snapshot = (status: Record<string, string>) => (): D => ({ status });

describe("SnapshotReplay: a snapshot never loses a frame that overtook it", () => {
	it("a status correction applied before an OLDER snapshot landed is re-applied on top of it", () => {
		const replay = new SnapshotReplay<D>();
		let d: D = { status: { r1: "settled" } };
		const gen = replay.begin(); // the snapshot is taken at version 4 ...
		const correction = set("r1", "ambiguous");
		replay.record(5, correction); // ... and the version-5 correction arrives first
		d = correction(d);
		const install = snapshot({ r1: "settled" });
		// The control: installing the snapshot alone (the store before this) loses the correction.
		expect(install().status.r1).toBe("settled");
		d = (replay.land(gen, 4, install) as (d: D) => D)(d);
		replay.end();
		expect(d.status.r1).toBe("ambiguous");
	});

	it("a frame the snapshot already holds is not re-applied over it", () => {
		const replay = new SnapshotReplay<D>();
		const gen = replay.begin();
		replay.record(4, set("r1", "ambiguous"));
		const d = (replay.land(gen, 5, snapshot({ r1: "released" })) as (d: D) => D)({ status: {} });
		replay.end();
		expect(d.status.r1).toBe("released");
	});

	it("frames are kept only while a snapshot is in flight", () => {
		const replay = new SnapshotReplay<D>();
		replay.record(2, set("r1", "early"));
		replay.begin();
		replay.record(3, set("r2", "kept"));
		replay.end();
		const gen = replay.begin();
		const d = (replay.land(gen, 0, snapshot({})) as (d: D) => D)({ status: {} });
		replay.end();
		expect(d.status).toEqual({});
	});

	it("two snapshots in flight: kept frames are re-applied to the first to land", () => {
		const replay = new SnapshotReplay<D>();
		const g1 = replay.begin();
		const g2 = replay.begin();
		replay.record(3, set("r1", "ambiguous"));
		const older = replay.land(g1, 1, snapshot({ r1: "settled" })) as (d: D) => D;
		expect(older({ status: {} }).status.r1).toBe("ambiguous");
		replay.end();
		const newer = replay.land(g2, 2, snapshot({ r1: "settled" })) as (d: D) => D;
		expect(newer({ status: {} }).status.r1).toBe("ambiguous");
		replay.end();
	});

	it("red-first (installed settled): a snapshot OLDER than one already installed is dropped", () => {
		const replay = new SnapshotReplay<D>();
		const older = replay.begin();
		const newer = replay.begin();
		expect(replay.land(newer, 5, snapshot({ r1: "ambiguous" }))).toBeDefined();
		replay.end();
		expect(replay.land(older, 4, snapshot({ r1: "settled" }))).toBeUndefined();
		replay.end();
	});

	it("red-first (installed settled): a snapshot begun before a reconnect is dropped after the new one lands", () => {
		const replay = new SnapshotReplay<D>();
		let d: D = { status: { r1: "settled" } };
		const a = replay.begin(); // snapshot A, version 4, in flight
		const correction = set("r1", "ambiguous");
		replay.record(5, correction); // the version-5 correction arrives ...
		d = correction(d);
		replay.reset(); // ... then the stream reconnects, dropping it
		const b = replay.begin();
		const installB = replay.land(b, 5, snapshot({ r1: "ambiguous" })) as (d: D) => D;
		d = installB(d);
		replay.end();
		// A lands last: its connection is gone, so it installs nothing.
		expect(replay.land(a, 4, snapshot({ r1: "settled" }))).toBeUndefined();
		replay.end();
		expect(d.status.r1).toBe("ambiguous");
	});

	it("red-first (installed the dead server's): a snapshot from before a server RESTART is dropped though its version is higher", () => {
		const replay = new SnapshotReplay<D>();
		const a = replay.begin(); // the old server, at version 40
		replay.reset(); // it restarted: versions start again
		const b = replay.begin();
		expect(replay.land(b, 2, snapshot({ r1: "ambiguous" }))).toBeDefined();
		replay.end();
		expect(replay.land(a, 40, snapshot({ r1: "settled" }))).toBeUndefined();
		replay.end();
	});

	it("a reconnect drops kept frames: their versions belong to a server that may be gone", () => {
		const replay = new SnapshotReplay<D>();
		replay.begin();
		replay.record(9, set("r1", "stale"));
		replay.reset();
		const gen = replay.begin();
		const d = (replay.land(gen, 0, snapshot({ r1: "settled" })) as (d: D) => D)({ status: {} });
		replay.end();
		replay.end();
		expect(d.status.r1).toBe("settled");
	});

	it("a frame's version is its SSE id; a frame without a usable one is re-applied over any snapshot", () => {
		expect(frameVersion("7")).toBe(7);
		expect(frameVersion("0")).toBe(0);
		for (const id of ["", "x", "1.5", "-", "1e400"])
			expect(frameVersion(id), id).toBe(Number.POSITIVE_INFINITY);
	});
});
