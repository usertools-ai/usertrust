import { randomBytes } from "node:crypto";

/** Generate a u128 bigint ID for TigerBeetle (time-based + random) */
export function tbId(): bigint {
	const buf = randomBytes(16);
	const now = BigInt(Date.now());
	buf[0] = Number((now >> 40n) & 0xffn);
	buf[1] = Number((now >> 32n) & 0xffn);
	buf[2] = Number((now >> 24n) & 0xffn);
	buf[3] = Number((now >> 16n) & 0xffn);
	buf[4] = Number((now >> 8n) & 0xffn);
	buf[5] = Number(now & 0xffn);
	let id = 0n;
	for (let i = 0; i < 16; i++) {
		id = (id << 8n) | BigInt(buf[i] as number);
	}
	return id;
}

/** Generate a string ID for govern records */
export function governId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** FNV-1a 32-bit hash */
export function fnv1a32(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}
