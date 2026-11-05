// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** `extractZipEntry`: one named entry out of a stored or deflate zip, failing closed on anything else. */

import { crc32 as nodeCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, extractZipEntry, ZipEntryError } from "../../src/ledger/zip-entry.js";
import { makeZip } from "./fixtures/make-zip.js";

const BODY = Buffer.from("#!/bin/sh\necho hello\n".repeat(50));

describe("extractZipEntry", () => {
	it.each(["stored", "deflate"] as const)("extracts a %s entry byte for byte", (method) => {
		const zip = makeZip([{ name: "tigerbeetle", data: BODY, method }]);
		expect(extractZipEntry(zip, "tigerbeetle", 1 << 20).equals(BODY)).toBe(true);
	});

	it("matches the entry name exactly, so a traversal name is never an entry", () => {
		const zip = makeZip([{ name: "../tigerbeetle", data: BODY }]);
		expect(() => extractZipEntry(zip, "tigerbeetle", 1 << 20)).toThrow(ZipEntryError);
	});

	it("refuses a missing entry, a duplicated entry and an entry over the byte cap", () => {
		expect(() =>
			extractZipEntry(makeZip([{ name: "other", data: BODY }]), "tigerbeetle", 1 << 20),
		).toThrow(/no entry named/);
		const dup = makeZip([
			{ name: "tigerbeetle", data: BODY },
			{ name: "tigerbeetle", data: BODY },
		]);
		expect(() => extractZipEntry(dup, "tigerbeetle", 1 << 20)).toThrow(/twice/);
		expect(() =>
			extractZipEntry(
				makeZip([{ name: "tigerbeetle", data: BODY }]),
				"tigerbeetle",
				BODY.length - 1,
			),
		).toThrow(/byte cap/);
	});

	it("refuses an encrypted entry, a truncated file and bytes that are not a zip", () => {
		const enc = makeZip([{ name: "tigerbeetle", data: BODY, encrypted: true }]);
		expect(() => extractZipEntry(enc, "tigerbeetle", 1 << 20)).toThrow(/encrypted/);
		const zip = makeZip([{ name: "tigerbeetle", data: BODY }]);
		expect(() => extractZipEntry(zip.subarray(0, zip.length - 30), "tigerbeetle", 1 << 20)).toThrow(
			ZipEntryError,
		);
		expect(() =>
			extractZipEntry(Buffer.from("not a zip at all, just some text"), "tigerbeetle", 1 << 20),
		).toThrow(/not a zip/);
	});

	it("refuses an entry whose checksum does not match (a flipped byte in stored data)", () => {
		const zip = Buffer.from(makeZip([{ name: "tigerbeetle", data: BODY }]));
		const at = 30 + "tigerbeetle".length + 10;
		zip[at] = (zip[at] as number) ^ 0xff;
		expect(() => extractZipEntry(zip, "tigerbeetle", 1 << 20)).toThrow(/crc32/);
	});

	it("refuses a deflate entry that inflates past its declared size", () => {
		const zip = Buffer.from(makeZip([{ name: "tigerbeetle", data: BODY, method: "deflate" }]));
		// lower the declared uncompressed size in the central directory (offset of the record + 24)
		const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
		zip.writeUInt32LE(BODY.length - 5, cd + 24);
		expect(() => extractZipEntry(zip, "tigerbeetle", 1 << 20)).toThrow(/inflate/);
	});
});

describe("crc32", () => {
	it("agrees with node's own implementation", () => {
		for (const data of [Buffer.alloc(0), Buffer.from("a"), BODY, Buffer.alloc(100_000, 7)]) {
			expect(crc32(data)).toBe(nodeCrc32(data));
		}
	});
});
