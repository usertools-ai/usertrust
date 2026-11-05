// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A minimal zip writer for tests: stored or deflate entries, a central directory and an
 * end-of-central-directory record. The checksum comes from node's own `zlib.crc32`, NOT from the
 * module under test, so the parser's crc32 is checked against an independent implementation.
 */

import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntrySpec {
	name: string;
	data: Buffer;
	method?: "stored" | "deflate";
	/** Set bit 0 of the general-purpose flags (encrypted). */
	encrypted?: boolean;
}

export function makeZip(entries: ZipEntrySpec[], comment: Buffer = Buffer.alloc(0)): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, "utf8");
		const method = e.method === "deflate" ? 8 : 0;
		const body = method === 8 ? deflateRawSync(e.data) : e.data;
		const flags = e.encrypted === true ? 1 : 0;
		const crc = crc32(e.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(e.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		parts.push(local, name, body);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(20, 4);
		cd.writeUInt16LE(20, 6);
		cd.writeUInt16LE(flags, 8);
		cd.writeUInt16LE(method, 10);
		cd.writeUInt32LE(crc, 16);
		cd.writeUInt32LE(body.length, 20);
		cd.writeUInt32LE(e.data.length, 24);
		cd.writeUInt16LE(name.length, 28);
		cd.writeUInt32LE(offset, 42);
		central.push(cd, name);
		offset += 30 + name.length + body.length;
	}
	const cdBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cdBuf.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(comment.length, 20);
	return Buffer.concat([...parts, cdBuf, eocd, comment]);
}
