// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The CSV export puts a byte-order mark in front of the file so Excel reads it as UTF-8. The mark is written in
// the source as a six-character escape, not as the invisible character itself. This reads the real export code
// and checks what that escape becomes: the three UTF-8 bytes EF BB BF at the head of the file.
const here = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(here, "..", "src", "app", "app.tsx"), "utf8");

// What sits between the opening backtick and the CSV body in `new Blob([`...${toCsv(...)}`], ...)`.
const PREFIX = /new Blob\(\[`([^`$]*)\$\{toCsv\(/;

describe("CSV export byte-order mark", () => {
	it("the export's prefix decodes to U+FEFF, the bytes EF BB BF", () => {
		const prefix = PREFIX.exec(APP)?.[1];
		expect(prefix).toBeDefined();
		const decoded = JSON.parse(`"${prefix}"`) as string;
		expect(decoded).toBe(String.fromCodePoint(0xfeff));
		expect([...Buffer.from(`${decoded}x`, "utf8").subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	});

	it("the source spells the mark as an escape and carries no invisible character", () => {
		const prefix = PREFIX.exec(APP)?.[1] ?? "";
		expect(prefix).toHaveLength(6);
		expect(prefix.startsWith("\\u")).toBe(true);
		for (const ch of APP) {
			const code = ch.codePointAt(0) as number;
			const invisible =
				code === 0xfeff || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e);
			expect(invisible, `U+${code.toString(16).toUpperCase()} in app.tsx`).toBe(false);
		}
	});

	it("control: a prefix without the mark is detected as not starting with EF BB BF", () => {
		const bytes = [...Buffer.from("x", "utf8").subarray(0, 3)];
		expect(bytes).not.toEqual([0xef, 0xbb, 0xbf]);
	});
});
