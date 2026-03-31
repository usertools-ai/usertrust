/**
 * PII Detector Tests
 *
 * Part A: Individual PII patterns (email, phone, SSN, credit card, IPv4)
 * Part B: Recursive scanning (nested objects, arrays)
 * Part C: Edge cases
 */

import { describe, expect, it } from "vitest";
import {
	type PIIDetection,
	type RedactedData,
	detectPII,
	redactPII,
} from "../../src/policy/pii.js";

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

// ===========================================================================
// Part E: Secret pattern detection
// ===========================================================================

describe("detectPII — api_key", () => {
	it("detects OpenAI-style sk- key", () => {
		const result = detectPII({ key: "sk-proj-abc123def456ghi789jkl" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("api_key");
	});

	it("detects Anthropic-style sk-ant- key", () => {
		const result = detectPII({ key: "sk-ant-api03-abc123def456ghi789jklmno" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("api_key");
	});

	it("does not detect short sk- strings", () => {
		const result = detectPII({ key: "sk-short" });
		expect(result.types).not.toContain("api_key");
	});
});

describe("detectPII — aws_key", () => {
	it("detects a standard AWS access key", () => {
		const result = detectPII({ key: "AKIAIOSFODNN7EXAMPLE" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("aws_key");
	});

	it("does not detect AKIA alone", () => {
		const result = detectPII({ key: "AKIA" });
		expect(result.types).not.toContain("aws_key");
	});
});

describe("detectPII — github_token", () => {
	it("detects ghp_ personal access token", () => {
		const result = detectPII({ token: "ghp_ABCDEFghijklmnopqrstuv1234" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("github_token");
	});

	it("detects github_pat_ fine-grained token", () => {
		const result = detectPII({ token: "github_pat_ABCDEFghijklmnopqrstuv1234" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("github_token");
	});

	it("does not detect short ghp_ strings", () => {
		const result = detectPII({ token: "ghp_short" });
		expect(result.types).not.toContain("github_token");
	});
});

describe("detectPII — api_key (Stripe-style underscore prefix)", () => {
	// Construct test keys programmatically to avoid GitHub push protection
	const livePrefix = ["sk", "live", ""].join("_");
	const testPrefix = ["sk", "test", ""].join("_");

	it("detects Stripe-style live secret key", () => {
		const result = detectPII({ key: `${livePrefix}xxxxxxxxxxxxxxxxxxxxxxxxxxx` });
		expect(result.found).toBe(true);
		expect(result.types).toContain("api_key");
	});

	it("detects Stripe-style test secret key", () => {
		const result = detectPII({ key: `${testPrefix}xxxxxxxxxxxxxxxxxxxxxxxxxxx` });
		expect(result.found).toBe(true);
		expect(result.types).toContain("api_key");
	});
});

describe("detectPII — jwt", () => {
	it("detects a raw JWT token", () => {
		const result = detectPII({
			token:
				"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("jwt");
	});

	it("does not detect a short JWT-like string", () => {
		const result = detectPII({ token: "eyJhbGci.short.x" });
		expect(result.types).not.toContain("jwt");
	});
});

describe("detectPII — private_key", () => {
	it("detects a PEM RSA private key header", () => {
		const result = detectPII({
			key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...",
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("private_key");
	});

	it("detects a generic PEM private key header", () => {
		const result = detectPII({
			key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADA...",
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("private_key");
	});

	it("does not detect PEM public key", () => {
		const result = detectPII({
			key: "-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...",
		});
		expect(result.types).not.toContain("private_key");
	});
});

describe("detectPII — generic_secret (npm token)", () => {
	it("detects npm token", () => {
		const result = detectPII({
			token: "npm_abcdefghijklmnopqrstuvwxyz0123456789",
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("generic_secret");
	});
});

describe("detectPII — api_key does not double-fire with generic_secret", () => {
	it("sk- key tagged as api_key only, not generic_secret", () => {
		const result = detectPII({ key: "sk-proj-abc123def456ghi789jkl" });
		expect(result.types).toContain("api_key");
		expect(result.types).not.toContain("generic_secret");
	});
});

describe("detectPII — bearer_token", () => {
	it("detects Bearer JWT token", () => {
		const result = detectPII({
			header: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123",
		});
		expect(result.found).toBe(true);
		expect(result.types).toContain("bearer_token");
	});

	it("does not detect Bearer with short token", () => {
		const result = detectPII({ header: "Bearer short" });
		expect(result.types).not.toContain("bearer_token");
	});
});

describe("detectPII — generic_secret", () => {
	it("detects GitLab personal access token", () => {
		const result = detectPII({ token: "glpat-xxxxxxxxxxxxxxxxxxxx" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("generic_secret");
	});

	it("detects Slack bot token", () => {
		const result = detectPII({ token: "xoxb-12345-67890-abcdef" });
		expect(result.found).toBe(true);
		expect(result.types).toContain("generic_secret");
	});

	it("detects long hex string (64+ chars)", () => {
		const hex = "a1b2c3d4e5f6".repeat(6);
		const result = detectPII({ secret: hex });
		expect(result.found).toBe(true);
		expect(result.types).toContain("generic_secret");
	});

	it("does not detect short random strings", () => {
		const result = detectPII({ value: "hello-world-123" });
		expect(result.types).not.toContain("generic_secret");
	});
});

// ===========================================================================
// Part F: redactPII
// ===========================================================================

describe("redactPII", () => {
	it("returns unchanged data when no PII is found", () => {
		const input = { name: "John", age: 30, active: true };
		const result = redactPII(input);
		expect(result.data).toEqual(input);
		expect(result.detection.found).toBe(false);
	});

	it("redacts an email address", () => {
		const result = redactPII({ email: "user@example.com" });
		expect((result.data as Record<string, unknown>).email).toBe("[REDACTED:email]");
		expect(result.detection.found).toBe(true);
		expect(result.detection.types).toContain("email");
	});

	it("redacts nested objects", () => {
		const result = redactPII({
			user: {
				profile: {
					email: "user@example.com",
				},
			},
		});
		const data = result.data as Record<string, Record<string, Record<string, unknown>>>;
		expect(data.user.profile.email).toBe("[REDACTED:email]");
	});

	it("redacts values inside arrays", () => {
		const result = redactPII({
			emails: ["user@example.com", "admin@test.org"],
		});
		const data = result.data as Record<string, string[]>;
		expect(data.emails[0]).toBe("[REDACTED:email]");
		expect(data.emails[1]).toBe("[REDACTED:email]");
	});

	it("lists multiple PII types in one redaction placeholder", () => {
		const result = redactPII({
			note: "Call 234-567-8901 or email user@example.com",
		});
		const data = result.data as Record<string, string>;
		expect(data.note).toContain("REDACTED:");
		expect(data.note).toContain("email");
		expect(data.note).toContain("phone");
	});

	it("redacts API keys", () => {
		const result = redactPII({ key: "sk-proj-abc123def456ghi789jkl" });
		const data = result.data as Record<string, string>;
		expect(data.key).toContain("REDACTED:");
		expect(data.key).toContain("api_key");
	});

	it("passes through non-string values unchanged", () => {
		const result = redactPII({
			count: 42,
			flag: true,
			empty: null,
			email: "user@example.com",
		});
		const data = result.data as Record<string, unknown>;
		expect(data.count).toBe(42);
		expect(data.flag).toBe(true);
		expect(data.empty).toBe(null);
		expect(data.email).toBe("[REDACTED:email]");
	});
});
