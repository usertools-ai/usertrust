// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Hand-made tar archives for the release tests: each header is written byte by byte, so a
 * fixture can carry exactly the defect a test needs (a link, a FIFO, a PAX record, a bad
 * name) and nothing else. And a reader for the tarballs the release writes, which reports
 * every header field and every PAX record it finds.
 */

import { gunzipSync, gzipSync } from "node:zlib";

export interface Fields {
	/** The type flag: "0" (file), "5" (directory), "1", "2", "6", "x", "g", "L", "S", ... */
	type?: string;
	size?: number;
	linkname?: string;
	prefix?: string;
	mode?: number;
	/** Raw bytes written over the header at an offset, before the checksum: [offset, latin1]. */
	patch?: [number, string][];
}

const octal = (h: Buffer, offset: number, length: number, value: number): void => {
	h.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, "latin1");
};

/** One 512-byte POSIX ustar header, checksum included. */
export function header(name: string, f: Fields = {}): Buffer {
	const h = Buffer.alloc(512);
	const raw = Buffer.from(name, "utf8");
	if (raw.length > 100) throw new Error(`header name longer than 100 bytes: ${name}`);
	raw.copy(h, 0);
	octal(h, 100, 8, f.mode ?? 0o644);
	octal(h, 108, 8, 0);
	octal(h, 116, 8, 0);
	octal(h, 124, 12, f.size ?? 0);
	octal(h, 136, 12, 1_700_000_000);
	h.write(f.type ?? "0", 156, "latin1");
	if (f.linkname !== undefined) h.write(f.linkname, 157, "utf8");
	h.write("ustar\0", 257, "latin1");
	h.write("00", 263, "latin1");
	if (f.prefix !== undefined) h.write(f.prefix, 345, "utf8");
	for (const [offset, bytes] of f.patch ?? []) h.write(bytes, offset, "latin1");
	h.fill(0x20, 148, 156);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
	return h;
}

const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

/** A member: its header and its data, padded to a whole block. */
export function member(name: string, data: Buffer | string = "", f: Fields = {}): Buffer {
	const d = Buffer.from(data);
	return Buffer.concat([header(name, { ...f, size: d.length }), pad(d)]);
}

/** One PAX record, "<length> <key>=<value>\n", with its length computed. */
export function record(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let n = Buffer.byteLength(body) + 1;
	while (String(n).length + Buffer.byteLength(body) !== n) n += 1;
	return `${n}${body}`;
}

/** A PAX extended header ("x") carrying <records>, to apply to the member after it. */
export function pax(records: [string, string][], f: Fields = {}): Buffer {
	const body = Buffer.from(records.map(([k, v]) => record(k, v)).join(""), "utf8");
	return member("PaxHeader/x", body, { ...f, type: f.type ?? "x" });
}

/** A PAX extended header whose body is exactly <body>, well formed or not. */
export const paxRaw = (body: Buffer | string): Buffer => member("PaxHeader/x", body, { type: "x" });

/** The members, then the end-of-archive marker. */
export const archive = (...members: Buffer[]): Buffer =>
	Buffer.concat([...members, Buffer.alloc(1024)]);

export const gz = (b: Buffer): Buffer => gzipSync(b);

export interface ReadEntry {
	name: string;
	type: string;
	size: number;
	mode: number;
	uid: number;
	gid: number;
	uname: string;
	gname: string;
	mtime: number;
	linkname: string;
	magic: string;
	/** The keys of the PAX records that applied to this member, in order. */
	paxKeys: string[];
	data: Buffer;
}

const cstr = (b: Buffer): string => {
	const nul = b.indexOf(0);
	return b.subarray(0, nul < 0 ? b.length : nul).toString("utf8");
};
const num = (b: Buffer): number => Number.parseInt(cstr(b).trim() || "0", 8);

/** Every member of a gzipped tar, with its header fields; extended headers are folded in. */
export function readTar(gzipped: Buffer): ReadEntry[] {
	const tar = gunzipSync(gzipped);
	const out: ReadEntry[] = [];
	let off = 0;
	let pending: Record<string, string> | null = null;
	while (off + 512 <= tar.length) {
		const h = tar.subarray(off, off + 512);
		if (h.every((b) => b === 0)) break;
		const size = num(h.subarray(124, 136));
		const type = String.fromCharCode(h[156] ?? 0);
		const data = Buffer.from(tar.subarray(off + 512, off + 512 + size));
		off += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			pending = {};
			let i = 0;
			while (i < data.length) {
				const space = data.indexOf(0x20, i);
				const n = Number.parseInt(data.subarray(i, space).toString("latin1"), 10);
				const rec = data.subarray(space + 1, i + n - 1).toString("utf8");
				const eq = rec.indexOf("=");
				pending[rec.slice(0, eq)] = rec.slice(eq + 1);
				i += n;
			}
			continue;
		}
		const prefix = cstr(h.subarray(345, 500));
		const name = cstr(h.subarray(0, 100));
		out.push({
			name: pending?.path ?? (prefix ? `${prefix}/${name}` : name),
			type,
			size,
			mode: num(h.subarray(100, 108)),
			uid: num(h.subarray(108, 116)),
			gid: num(h.subarray(116, 124)),
			uname: cstr(h.subarray(265, 297)),
			gname: cstr(h.subarray(297, 329)),
			mtime: num(h.subarray(136, 148)),
			linkname: cstr(h.subarray(157, 257)),
			magic: h.subarray(257, 265).toString("latin1"),
			paxKeys: pending ? Object.keys(pending) : [],
			data,
		});
		pending = null;
	}
	return out;
}
