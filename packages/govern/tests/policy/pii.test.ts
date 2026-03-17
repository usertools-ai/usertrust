/**
 * PII Detector Tests
 *
 * Part A: Individual PII patterns (email, phone, SSN, credit card, IPv4)
 * Part B: Recursive scanning (nested objects, arrays)
 * Part C: Edge cases
 */

import { describe, expect, it } from "vitest";
import { type PIIDetection, detectPII } from "../../src/policy/pii.js";

// ===========================================================================
// Part A: Individual PII patterns
// ===========================================================================

describe("detectPII — email", () => {
	it("detects a standard email address", () => {
		const result = detectPII({ email: "user@example.com" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
	});

	it("detects email with dots and plus in local part", () => {
		const result = detectPII({ contact: "first.last+tag@domain.co.uk" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
	});

	it("does not false-positive on non-email strings", () => {
		const result = detectPII({ name: "John Doe", count: "42" });
		expect(result.types).not.toContain("email");
	});
});

describe("detectPII — phone", () => {
	it("detects US phone with dashes", () => {
		const result = detectPII({ phone: "234-567-8901" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("phone");
	});

	it("detects US phone with parentheses", () => {
		const result = detectPII({ phone: "(234) 567-8901" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("phone");
	});

	it("detects international phone with +1 prefix", () => {
		const result = detectPII({ phone: "+1-234-567-8901" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("phone");
	});

	it("detects phone with dots", () => {
		const result = detectPII({ phone: "234.567.8901" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("phone");
	});

	it("does not false-positive on short numbers", () => {
		const result = detectPII({ code: "12345" });
		expect(result.types).not.toContain("phone");
	});
});

describe("detectPII — SSN", () => {
	it("detects a standard SSN with dashes", () => {
		const result = detectPII({ ssn: "123-45-6789" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("ssn");
	});

	it("does not detect SSN without dashes (avoids false positives)", () => {
		const result = detectPII({ number: "123456789" });
		expect(result.types).not.toContain("ssn");
	});

	it("detects SSN embedded in text", () => {
		const result = detectPII({ note: "SSN is 123-45-6789 on file" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("ssn");
	});
});

describe("detectPII — credit card", () => {
	it("detects a valid Visa card (Luhn-valid)", () => {
		const result = detectPII({ card: "4111111111111111" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("credit_card");
	});

	it("detects a card with dashes", () => {
		const result = detectPII({ card: "4111-1111-1111-1111" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("credit_card");
	});

	it("detects a card with spaces", () => {
		const result = detectPII({ card: "4111 1111 1111 1111" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("credit_card");
	});

	it("does not detect a Luhn-invalid number", () => {
		const result = detectPII({ card: "4111111111111112" });
		expect(result.types).not.toContain("credit_card");
	});

	it("does not detect numbers that are too short", () => {
		const result = detectPII({ short: "411111111111" });
		expect(result.types).not.toContain("credit_card");
	});
});

describe("detectPII — IPv4", () => {
	it("detects a standard IPv4 address", () => {
		const result = detectPII({ ip: "192.168.1.1" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("ipv4");
	});

	it("detects 10.0.0.1", () => {
		const result = detectPII({ ip: "10.0.0.1" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("ipv4");
	});

	it("does not detect out-of-range octets", () => {
		const result = detectPII({ ip: "999.999.999.999" });
		expect(result.types).not.toContain("ipv4");
	});

	it("does not detect partial IPs", () => {
		const result = detectPII({ partial: "192.168.1" });
		expect(result.types).not.toContain("ipv4");
	});
});

// ===========================================================================
// Part B: Recursive scanning
// ===========================================================================

describe("detectPII — recursive scanning", () => {
	it("scans nested objects", () => {
		const result = detectPII({
			user: {
				profile: {
					email: "user@example.com",
				},
			},
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
		expect(result.paths.some((p) => p.includes("user.profile.email"))).toBe(true);
	});

	it("scans arrays", () => {
		const result = detectPII({
			contacts: ["user@example.com", "admin@test.org"],
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
		expect(result.paths.length).toBeGreaterThanOrEqual(2);
	});

	it("scans arrays of objects", () => {
		const result = detectPII({
			people: [
				{ name: "Alice", phone: "234-567-8901" },
				{ name: "Bob", ssn: "123-45-6789" },
			],
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("phone");
		expect(result.types).toContain("ssn");
	});

	it("detects multiple PII types in one object", () => {
		const result = detectPII({
			email: "user@example.com",
			phone: "234-567-8901",
			ssn: "123-45-6789",
			ip: "10.0.0.1",
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
		expect(result.types).toContain("phone");
		expect(result.types).toContain("ssn");
		expect(result.types).toContain("ipv4");
	});

	it("returns empty for clean data", () => {
		const result = detectPII({
			name: "John Doe",
			age: 30,
			active: true,
			tags: ["admin", "user"],
		});
		expect(result.found).toBe(false);
		expect(result.types).toEqual([]);
		expect(result.paths).toEqual([]);
	});

	it("handles null and undefined values", () => {
		const result = detectPII({
			name: null,
			value: undefined,
		});
		expect(result.found).toBe(false);
	});

	it("handles non-object input", () => {
		expect(detectPII("user@example.com").found).toBe(true);
		expect(detectPII(42).found).toBe(false);
		expect(detectPII(null).found).toBe(false);
		expect(detectPII(undefined).found).toBe(false);
	});
});

// ===========================================================================
// Part C: Paths
// ===========================================================================

describe("detectPII — paths", () => {
	it("includes PII type in path annotation", () => {
		const result = detectPII({ contact: "user@example.com" });
		expect(result.paths).toContain("contact(email)");
	});

	it("includes nested path with type", () => {
		const result = detectPII({
			billing: { ssn: "123-45-6789" },
		});
		expect(result.paths.some((p) => p.startsWith("billing.ssn("))).toBe(true);
	});

	it("includes array index in path", () => {
		const result = detectPII({
			emails: ["user@example.com"],
		});
		expect(result.paths.some((p) => p.includes("[0]"))).toBe(true);
	});

	it("returns path annotation for root-level string", () => {
		const result = detectPII("user@example.com");
		expect(result.paths.some((p) => p === "(email)")).toBe(true);
	});
});

// ===========================================================================
// Part D: Additional edge cases for coverage
// ===========================================================================

describe("detectPII — credit card edge cases", () => {
	it("does not detect a number that fails Luhn check (line 74)", () => {
		// 4111111111111112 fails Luhn — differs from valid 4111111111111111 by last digit
		const result = detectPII({ card: "4111111111111112" });
		expect(result.types).not.toContain("credit_card");
	});

	it("does not detect a number that is too short after stripping", () => {
		const result = detectPII({ card: "4111 1111 1111" });
		expect(result.types).not.toContain("credit_card");
	});

	it("does not detect a number that is too long after stripping", () => {
		// 20+ digits — exceeds 19 digit limit
		const result = detectPII({ card: "4111 1111 1111 1111 1111" });
		expect(result.types).not.toContain("credit_card");
	});

	it("does not detect when candidate has non-digit characters after stripping", () => {
		// Letters mixed in won't match the initial regex
		const result = detectPII({ card: "4111-abcd-1111-1111" });
		expect(result.types).not.toContain("credit_card");
	});

	it("detects Mastercard (Luhn-valid)", () => {
		// 5500000000000004 is a Luhn-valid Mastercard test number
		const result = detectPII({ card: "5500000000000004" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("credit_card");
	});

	it("detects Amex (Luhn-valid, 15 digits)", () => {
		// 378282246310005 is a Luhn-valid Amex test number
		const result = detectPII({ card: "378282246310005" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("credit_card");
	});

	it("does not detect random 16-digit number that fails Luhn", () => {
		// Random number that fails Luhn: 1234567890123456
		const result = detectPII({ card: "1234567890123456" });
		expect(result.types).not.toContain("credit_card");
	});
});

describe("detectPII — nested array inside object (line 87)", () => {
	it("scans nested arrays inside objects", () => {
		const result = detectPII({
			users: [
				{
					contacts: ["user@example.com", "admin@test.org"],
				},
			],
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
		expect(result.paths.some((p) => p.includes("users[0].contacts[0]"))).toBe(true);
	});

	it("scans deeply nested arrays of objects", () => {
		const result = detectPII({
			level1: {
				level2: [
					{
						level3: {
							phones: ["234-567-8901"],
						},
					},
				],
			},
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("phone");
	});
});

describe("detectPII — null values in arrays", () => {
	it("handles null values in arrays without crashing", () => {
		const result = detectPII({
			items: [null, "user@example.com", null],
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
	});

	it("handles undefined values in arrays", () => {
		const result = detectPII({
			items: [undefined, "123-45-6789", undefined],
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("ssn");
	});

	it("handles all-null array", () => {
		const result = detectPII({
			items: [null, null, null],
		});
		expect(result.found).toBe(false);
	});
});

describe("detectPII — very long strings", () => {
	it("detects PII embedded in a very long string", () => {
		const padding = "x".repeat(10000);
		const result = detectPII({ text: `${padding} user@example.com ${padding}` });
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
	});

	it("handles long strings without PII", () => {
		const result = detectPII({ text: "a".repeat(5000) });
		expect(result.found).toBe(false);
	});
});

describe("detectPII — SSN-like but invalid", () => {
	it("does not detect too-few-digit SSN-like pattern", () => {
		const result = detectPII({ number: "12-34-5678" });
		expect(result.types).not.toContain("ssn");
	});

	it("does not detect SSN without dashes", () => {
		const result = detectPII({ number: "123456789" });
		expect(result.types).not.toContain("ssn");
	});

	it("does not detect too-many-digit pattern", () => {
		const result = detectPII({ number: "1234-56-78901" });
		expect(result.types).not.toContain("ssn");
	});
});

describe("detectPII — IPv4 edge cases", () => {
	it("does not detect 256.0.0.1 (out of range)", () => {
		const result = detectPII({ ip: "256.0.0.1" });
		expect(result.types).not.toContain("ipv4");
	});

	it("detects 0.0.0.0", () => {
		const result = detectPII({ ip: "0.0.0.0" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("ipv4");
	});

	it("detects 255.255.255.255", () => {
		const result = detectPII({ ip: "255.255.255.255" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("ipv4");
	});

	it("does not detect IPv6 addresses", () => {
		const result = detectPII({ ip: "2001:0db8:85a3:0000:0000:8a2e:0370:7334" });
		expect(result.types).not.toContain("ipv4");
	});
});

describe("detectPII — mixed types in single string", () => {
	it("detects multiple PII types in a single string value", () => {
		const result = detectPII({
			note: "Contact user@example.com or call 234-567-8901 from IP 10.0.0.1",
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
		expect(result.types).toContain("phone");
		expect(result.types).toContain("ipv4");
	});
});

describe("detectPII — top-level array input", () => {
	it("scans a top-level array", () => {
		const result = detectPII(["user@example.com", "safe text"]);
		expect(result.found).toBe(true);
		expect(result.types).toContain("email");
		expect(result.paths.some((p) => p.includes("[0]"))).toBe(true);
	});
});

describe("detectPII — boolean and number values", () => {
	it("ignores boolean values", () => {
		const result = detectPII({ flag: true, other: false });
		expect(result.found).toBe(false);
	});

	it("ignores plain number values", () => {
		const result = detectPII({ count: 42, price: 19.99 });
		expect(result.found).toBe(false);
	});
});

describe("detectPII — empty structures", () => {
	it("handles empty object", () => {
		const result = detectPII({});
		expect(result.found).toBe(false);
		expect(result.types).toEqual([]);
		expect(result.paths).toEqual([]);
	});

	it("handles empty array", () => {
		const result = detectPII([]);
		expect(result.found).toBe(false);
	});

	it("handles empty string", () => {
		const result = detectPII("");
		expect(result.found).toBe(false);
	});
});
