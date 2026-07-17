// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { detectPII } from "../../src/policy/pii.js";

describe("bare SSN detection", () => {
	it("detects a bare 9-digit valid SSN", () => {
		const r = detectPII({ note: "member id 123456789 on file" });
		expect(r.types).toContain("ssn");
	});
	it("detects a space-separated SSN", () => {
		expect(detectPII({ x: "123 45 6789" }).types).toContain("ssn");
	});
	it("still detects the dashed form", () => {
		expect(detectPII({ x: "123-45-6789" }).types).toContain("ssn");
	});
	it("does NOT match structurally invalid areas (000/666/9xx)", () => {
		expect(detectPII({ x: "000112222" }).types).not.toContain("ssn");
		expect(detectPII({ x: "666112222" }).types).not.toContain("ssn");
		expect(detectPII({ x: "900112222" }).types).not.toContain("ssn");
	});
	it("does NOT match a 10-digit embedded run", () => {
		expect(detectPII({ x: "phone 1234567890" }).types).not.toContain("ssn");
	});
});
