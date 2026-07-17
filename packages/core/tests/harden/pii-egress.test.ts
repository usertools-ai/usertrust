// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { redactMessages } from "../../src/policy/pii.js";

describe("redactMessages outbound contract", () => {
	it("redacts PII in message content and leaves structure intact", () => {
		const messages = [{ role: "user", content: "email me at john@acme.com and ssn 123-45-6789" }];
		const { data, detection } = redactMessages(messages) as {
			data: Array<{ role: string; content: string }>;
			detection: { found: boolean };
		};
		expect(detection.found).toBe(true);
		expect(data[0]?.content).toContain("[REDACTED:");
		expect(data[0]?.content).not.toContain("john@acme.com");
		expect(data[0]?.content).not.toContain("123-45-6789");
		expect(data[0]?.role).toBe("user"); // non-PII field untouched
	});

	it("is pure — does not mutate input", () => {
		const messages = [{ role: "user", content: "ssn 123-45-6789" }];
		redactMessages(messages);
		expect(messages[0]?.content).toBe("ssn 123-45-6789");
	});

	it("returns the input structurally unchanged when no PII is present", () => {
		const messages = [{ role: "user", content: "what is the capital of France?" }];
		const { data, detection } = redactMessages(messages) as {
			data: Array<{ role: string; content: string }>;
			detection: { found: boolean };
		};
		expect(detection.found).toBe(false);
		expect(data[0]?.content).toBe("what is the capital of France?");
	});
});
