// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Pull ONE named entry out of a zip held in memory. The TigerBeetle release archives are plain
 * single-file zips (stored or deflate), so this is the whole parser: no zip64, no encryption, no
 * directory entries, no path handling at all. It is called only on bytes whose sha256 already matched
 * the pinned manifest, so it never sees an attacker's archive; the checks below are for a damaged or
 * unexpected-but-genuine file, and they fail closed.
 */

import { inflateRawSync } from "node:zlib";

export class ZipEntryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipEntryError";
	}
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** The end-of-central-directory record is 22 bytes plus a comment of at most 65535 bytes. */
const EOCD_SEARCH = 22 + 0xffff;

let crcTable: Uint32Array | undefined;

/** CRC-32 (IEEE), the checksum a zip stores for each entry. */
export function crc32(data: Uint8Array): number {
	if (crcTable === undefined) {
		const table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[n] = c >>> 0;
		}
		crcTable = table;
	}
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = (crcTable[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function need(zip: Buffer, offset: number, length: number, what: string): void {
	if (offset < 0 || length < 0 || offset + length > zip.length) {
		throw new ZipEntryError(`zip is truncated or damaged (${what})`);
	}
}

/**
 * Return the bytes of the entry named exactly `entryName` (compared byte for byte, so a path such as
 * `../x` can never match). `maxBytes` caps the uncompressed size: an entry that declares more, or
 * inflates to more, is refused.
 */
export function extractZipEntry(zip: Buffer, entryName: string, maxBytes: number): Buffer {
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - EOCD_SEARCH); i--) {
		if (zip.readUInt32LE(i) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipEntryError("not a zip: no end-of-central-directory record");
	const total = zip.readUInt16LE(eocd + 10);
	const cdSize = zip.readUInt32LE(eocd + 12);
	const cdOffset = zip.readUInt32LE(eocd + 16);
	if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		throw new ZipEntryError("zip64 archives are not supported");
	}
	need(zip, cdOffset, cdSize, "central directory");

	let found:
		| { flags: number; method: number; crc: number; csize: number; usize: number; local: number }
		| undefined;
	let at = cdOffset;
	for (let n = 0; n < total; n++) {
		need(zip, at, 46, "central directory entry");
		if (zip.readUInt32LE(at) !== CENTRAL_SIG)
			throw new ZipEntryError("bad central directory entry");
		const nameLen = zip.readUInt16LE(at + 28);
		const extraLen = zip.readUInt16LE(at + 30);
		const commentLen = zip.readUInt16LE(at + 32);
		need(zip, at + 46, nameLen + extraLen + commentLen, "central directory entry name");
		const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
		if (name === entryName) {
			if (found !== undefined) throw new ZipEntryError(`the zip lists "${entryName}" twice`);
			found = {
				flags: zip.readUInt16LE(at + 8),
				method: zip.readUInt16LE(at + 10),
				crc: zip.readUInt32LE(at + 16),
				csize: zip.readUInt32LE(at + 20),
				usize: zip.readUInt32LE(at + 24),
				local: zip.readUInt32LE(at + 42),
			};
		}
		at += 46 + nameLen + extraLen + commentLen;
	}
	if (found === undefined) throw new ZipEntryError(`the zip has no entry named "${entryName}"`);
	if ((found.flags & 1) !== 0) throw new ZipEntryError("encrypted zip entries are not supported");
	if (found.method !== 0 && found.method !== 8) {
		throw new ZipEntryError(
			`zip compression method ${found.method} is not supported (stored and deflate only)`,
		);
	}
	if (found.usize > maxBytes) {
		throw new ZipEntryError(
			`entry "${entryName}" declares ${found.usize} bytes, over the ${maxBytes} byte cap`,
		);
	}
	need(zip, found.local, 30, "local header");
	if (zip.readUInt32LE(found.local) !== LOCAL_SIG) throw new ZipEntryError("bad local file header");
	const dataStart =
		found.local + 30 + zip.readUInt16LE(found.local + 26) + zip.readUInt16LE(found.local + 28);
	need(zip, dataStart, found.csize, "entry data");
	const raw = zip.subarray(dataStart, dataStart + found.csize);

	let out: Buffer;
	if (found.method === 0) {
		if (found.csize !== found.usize) throw new ZipEntryError("stored entry sizes disagree");
		out = Buffer.from(raw);
	} else {
		try {
			out = inflateRawSync(raw, { maxOutputLength: found.usize });
		} catch (err) {
			throw new ZipEntryError(
				`entry "${entryName}" does not inflate to its declared size: ${(err as Error).message}`,
			);
		}
	}
	if (out.length !== found.usize) throw new ZipEntryError("entry size does not match its header");
	if (crc32(out) !== found.crc) throw new ZipEntryError("entry checksum (crc32) does not match");
	return out;
}
