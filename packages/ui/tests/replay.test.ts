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
		replay.begin(); // the snapshot is taken at version 4 ...
		const correction = set("r1", "ambiguous");
		replay.record(5, correction); // ... and the version-5 correction arrives first
		d = correction(d);
		const install = snapshot({ r1: "settled" });
		// The control: installing the snapshot alone (the store before this) loses the correction.
		expect(install().status.r1).toBe("settled");
		d = replay.land(4, install)(d);
		replay.end();
		expect(d.status.r1).toBe("ambiguous");
	});

	it("a frame the snapshot already holds is not re-applied over it", () => {
		const replay = new SnapshotReplay<D>();
		replay.begin();
		replay.record(4, set("r1", "ambiguous"));
		const d = replay.land(5, snapshot({ r1: "released" }))({ status: {} });
		replay.end();
		expect(d.status.r1).toBe("released");
	});

	it("frames are kept only while a snapshot is in flight", () => {
		const replay = new SnapshotReplay<D>();
		replay.record(2, set("r1", "early"));
		replay.begin();
		replay.record(3, set("r2", "kept"));
		replay.end();
		replay.begin();
		const d = replay.land(0, snapshot({}))({ status: {} });
		replay.end();
		expect(d.status).toEqual({});
	});

	it("two snapshots in flight: every kept frame newer than each is re-applied to each", () => {
		const replay = new SnapshotReplay<D>();
		replay.begin();
		replay.begin();
		replay.record(3, set("r1", "ambiguous"));
		expect(replay.land(2, snapshot({ r1: "settled" }))({ status: {} }).status.r1).toBe("ambiguous");
		replay.end();
		// The older snapshot lands last: the frame is still kept, so it is not lost under it either.
		expect(replay.land(1, snapshot({ r1: "settled" }))({ status: {} }).status.r1).toBe("ambiguous");
		replay.end();
	});

	it("a reconnect drops kept frames: their versions belong to a server that may be gone", () => {
		const replay = new SnapshotReplay<D>();
		replay.begin();
		replay.record(9, set("r1", "stale"));
		replay.reset();
		const d = replay.land(0, snapshot({ r1: "settled" }))({ status: {} });
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
