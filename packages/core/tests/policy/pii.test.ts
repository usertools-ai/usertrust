/**
 * PII Detector Tests
 *
 * Part A: Individual PII patterns (email, phone, SSN, credit card, IPv4)
 * Part B: Recursive scanning (nested objects, arrays)
 * Part C: Edge cases
 */

import { describe, expect, it, vi } from "vitest";
import {
	detectPII,
	isOpaqueTextFree,
	normalizedView,
	type PIIDetection,
	type RedactedData,
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

	it("detects a phone written with repeated separators, or after punctuation", () => {
		for (const text of [
			"call 555  867 5309 today",
			"+1 (234)  567 - 8901",
			"tel:5558675309",
			"(5558675309)",
			"5 5 5 8 6 7 5 3 0 9",
		]) {
			expect(detectPII({ text }).types, text).toContain("phone");
		}
	});

	it("detects international numbers written with spaces", () => {
		for (const text of [
			"call +44 20 7946 0958 today",
			"+33 1 42 68 53 00",
			"+49 30 901820",
			"+61 2 9374 4000",
			"+91 98765 43210",
		]) {
			expect(detectPII({ text }).types, text).toContain("phone");
		}
	});

	it("detects a phone spaced with any whitespace, non-breaking spaces included", () => {
		const nbsp = String.fromCodePoint(0xa0);
		const narrow = String.fromCodePoint(0x202f);
		for (const text of [
			["555", "867", "5309"].join(nbsp),
			["+44", "20", "7946", "0958"].join(narrow),
			["+33", "1", "42", "68", "53", "00"].join(nbsp),
		]) {
			expect(detectPII({ text }).types, JSON.stringify(text)).toContain("phone");
		}
	});

	it("does not read part of a group of 16 or more digits as a phone", () => {
		for (const text of [
			'order_id: "12345678901234567890"',
			"12345678901234567",
			"4111111111111111",
			// "00" and then 16 or 17 digits: it starts like a dial string, but is too long for one.
			"001234567890123456",
			"0012345678901234567",
		]) {
			expect(detectPII({ text }).types, text).not.toContain("phone");
		}
		// The card is still a card.
		expect(detectPII({ text: "4111111111111111" }).types).toContain("credit_card");
	});

	it("detects a number dialled with an international access prefix, 16 digits or more", () => {
		for (const text of [
			"Call 0114915123456789",
			"0114915123456789",
			"00491512345678901",
			"0011 61 2 9374 4000",
			"001161293744000",
			"0104915123456789",
		]) {
			expect(detectPII({ text }).types, text).toContain("phone");
		}
	});

	it("detects a phone with an extension written right after it", () => {
		for (const text of [
			"555-867-5309x123",
			"555-867-5309ext12",
			"555-867-5309 ext. 12",
			"call 555.867.5309X42 today",
			"(555) 867-5309 x123",
			"555-867-5309#123",
		]) {
			expect(detectPII({ text }).types, text).toContain("phone");
		}
	});

	it("not a phone: letters that are not an extension marker (x, ext, ext.) make the digits before them part of a word", () => {
		for (const text of [
			"555-867-5309abc123",
			"5558675309q42",
			"ref 5558675309abc12",
			"555-867-5309xy12", // x, then a letter: not x followed by digits
			"555-867-5309extra12", // ext, then more letters: not ext followed by digits
		]) {
			expect(detectPII({ text }).types, text).not.toContain("phone");
		}
	});

	it("does not read digits before a word that only starts like an extension as a phone", () => {
		for (const text of ["id-5558675309x9f2a", "ref-5558675309xyz", "5558675309extra"]) {
			expect(detectPII({ text }).types, text).not.toContain("phone");
		}
	});

	it("detects a phone after digits that belong to a word", () => {
		// "12" belongs to "SKU12" and is left out; the number after it is still a phone.
		expect(detectPII({ text: "SKU12 555 867 5309" }).types).toContain("phone");
	});

	it("does not read digits inside an identifier as a phone", () => {
		for (const text of [
			"toolu_1234567890123abc",
			"call_12345678901",
			"id-x5558675309y",
			"ref-5558675309z",
		]) {
			expect(detectPII({ text }).types, text).not.toContain("phone");
		}
	});

	it("leaves tool call ids unredacted, so two different ids stay different", () => {
		const ids = { use: "toolu_1234567890123abc", result: "toolu_9876543210987xyz" };
		const redacted = redactPII(ids);
		expect(redacted.detection.found).toBe(false);
		expect(redacted.data).toEqual(ids);
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

	it("detects a bare, structurally-valid SSN without dashes", () => {
		// Hardening (Finding 7): bare 9-digit SSNs that pass SSA structural
		// validation are now detected (over-redaction is the safe direction).
		const result = detectPII({ number: "123456789" });
		expect(result.types).toContain("ssn");
	});

	it("does not detect a structurally-invalid bare 9-digit number", () => {
		// Invalid area (000) keeps random 9-digit identifiers from matching.
		const result = detectPII({ number: "000000000" });
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

	it("detects an address after an out-of-range candidate", () => {
		for (const text of ["1.2.3.256 192.168.1.1", "version 999.999.999.999, host 10.0.0.1"]) {
			expect(detectPII({ text }).types, text).toContain("ipv4");
		}
	});

	it("detects an address that overlaps an out-of-range candidate", () => {
		// The first candidate is 999.1.2.3; the address 1.2.3.4 starts inside it.
		expect(detectPII({ text: "999.1.2.3.4" }).types).toContain("ipv4");
	});

	it("does not detect a string of out-of-range candidates only", () => {
		expect(detectPII({ text: "1.2.3.256 300.1.1.1 999.1.2.3" }).types).not.toContain("ipv4");
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

	it("does not detect a bare run that is too long: a run with no separator is checked whole", () => {
		const result = detectPII({ id: "41111111111111111111" });
		expect(result.types).not.toContain("credit_card");
	});

	it("detects a card beside its expiry", () => {
		for (const text of ["4111-1111-1111-1111 12/29", "card 4111 1111 1111 1111 exp 12 29"]) {
			expect(detectPII({ text }).types, text).toContain("credit_card");
		}
	});

	it("does not read a card from part of a longer list of groups, as 5.0.4 did not", () => {
		// A chain of groups joined by one space is checked whole. Any four of a list of four-digit
		// numbers pass Luhn one time in ten, so a window inside the list would read as a card.
		for (const text of [
			"12 4111 1111 1111 1111",
			"4111 1111 1111 1111 1234 5678",
			"1234 5678 9012 3456 7890 1234",
		]) {
			expect(detectPII({ text }).types, text).not.toContain("credit_card");
		}
	});

	it("does not detect a Luhn-invalid number beside its expiry", () => {
		// No span of whole groups here, with 13-19 digits, passes Luhn.
		for (const text of ["4111 1111 1111 1112 12 29", "4111 1111 1111 1112 1234 5678"]) {
			expect(detectPII({ text }).types, text).not.toContain("credit_card");
		}
	});

	it("detects a card in a card's layout among other numbers", () => {
		for (const text of [
			"3782-822463-10005 12/29", // 4-6-5, American Express, beside its expiry
			"3056-9309-0259-04 12/29", // 4-4-4-2, Diners Club, beside its expiry
			"30569309025904 7", // one group of 14
			"41111111 11111111", // 5.0.4's check: one candidate, 16 digits
			"4222222222222 7", // one group of 13, beside another number
		]) {
			expect(detectPII({ text }).types, text).toContain("credit_card");
		}
	});

	it("does not read a card from groups that are not printed as one", () => {
		for (const text of [
			"9 4111 1111-1111 1111 5", // two kinds of separator
			"9 4111\n1111\n1111\n1111 5", // one group per line
			"[0 1 1 0 1 0 0 1 1 1 0 1 0 1 1 0]", // a printed bit vector
			"ref4111 1111 1111 1111", // the first group belongs to a word
			"4111 1111 1111 1111z", // the last group belongs to a word
			"4111.1111.1111.1111 12", // joined by dots, not one space or one dash
			"4111 and 1111 and 1111 and 1111", // a gap that only starts with a space joins nothing
			// Known limits, kept as in 5.0.4: a chain is checked whole, never a window inside it.
			"4111-1111-1111-1111-123", // the card joined by the same dash to one more group
			"order 2024-4111-1111-1111-1111", // a number joined to the card by the same dash
			"4111 1111 1111 1111 12/29", // a spaced card, then its expiry after one space
		]) {
			expect(detectPII({ text }).types, JSON.stringify(text)).not.toContain("credit_card");
		}
	});

	it("detects each card layout as a whole dashed chain, alone and at either end of the text", () => {
		// Luhn-valid numbers in each layout. Beside an expiry, or after one, 5.0.4's candidate takes
		// the neighbour in and fails, so these rows are found by the layout check.
		const layouts: Array<[string, string]> = [
			["4-4-4-4-1", "4111-1111-1111-1111-3"],
			["4-4-4-4-2", "4111-1111-1111-1111-18"],
			["4-4-4-4-3", "4111-1111-1111-1111-110"],
			["4-4-4-1", "4111-1111-1111-9"],
			["4-4-4-2", "4111-1111-1111-14"],
			["4-4-4-3", "4111-1111-1111-116"],
		];
		for (const [layout, card] of layouts) {
			for (const text of [card, `${card} 12/29`, `exp 12/29 ${card}`]) {
				expect(detectPII({ text }).types, `${layout}: ${text}`).toContain("credit_card");
			}
		}
	});

	it("a chain of five groups in a layout is a card, and the same chain with one group more is not", () => {
		expect(detectPII({ text: "4111-1111-1111-1111-3 12/29" }).types).toContain("credit_card");
		expect(detectPII({ text: "7-4111-1111-1111-1111-3 12/29" }).types).not.toContain("credit_card");
		expect(detectPII({ text: "4111-1111-1111-1111-3-7 12/29" }).types).not.toContain("credit_card");
	});

	it("detects cards of 13 and of 19 digits", () => {
		for (const card of ["4222222222222", "4111111111111111110"]) {
			expect(detectPII({ card }).types, card).toContain("credit_card");
		}
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

	it("does not detect a bare 9-digit run with an invalid SSN area (666)", () => {
		// Hardening (Finding 7): bare valid SSNs are detected, but structural
		// validation still excludes reserved areas (666/000/9xx).
		const result = detectPII({ number: "666456789" });
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

	it("detects a long hex secret after a run of hex letters or of digits alone", () => {
		const secret = "a1b2c3d4e5f6".repeat(6);
		for (const text of [`${"a".repeat(64)} ${secret}`, `${"1".repeat(64)} ${secret}`]) {
			expect(detectPII({ text }).types).toContain("generic_secret");
		}
		expect(detectPII({ text: `${"a".repeat(64)} ${"1".repeat(64)}` }).types).not.toContain(
			"generic_secret",
		);
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

describe("redactPII — the closed allowlist kept by reference (AbortSignal only)", () => {
	const EMAIL = "write to alice@example.com";

	it("a real AbortSignal is kept by reference and not walked", () => {
		const signal = new AbortController().signal;
		expect(isOpaqueTextFree(signal)).toBe(true);
		const out = redactPII({ prompt: EMAIL, config: { abortSignal: signal } }).data as {
			prompt: string;
			config: { abortSignal: unknown };
		};
		expect(out.prompt).not.toContain("alice@example.com");
		expect(out.config.abortSignal).toBe(signal);
	});

	it("a duck-typed fake signal is NOT kept: cloned like any plain object, its strings redacted", () => {
		const fake = { aborted: false, addEventListener() {}, note: EMAIL };
		expect(isOpaqueTextFree(fake)).toBe(false);
		const out = redactPII({ prompt: EMAIL, config: { abortSignal: fake } }).data as {
			config: { abortSignal: Record<string, unknown> };
		};
		expect(out.config.abortSignal).not.toBe(fake);
		expect(String(out.config.abortSignal.note)).not.toContain("alice@example.com");
	});

	it("an object made from AbortSignal.prototype is not a real signal (brand check), so not kept", () => {
		expect(isOpaqueTextFree(Object.create(AbortSignal.prototype) as object)).toBe(false);
	});

	it("a real AbortSignal carrying an extra own property (where text could hide) is not kept", () => {
		const signal = Object.assign(new AbortController().signal, { note: EMAIL });
		expect(isOpaqueTextFree(signal)).toBe(false);
	});

	it("a real AbortSignal with a non-enumerable toJSON is not opaque, and is never kept outside config.abortSignal", () => {
		const signal = new AbortController().signal;
		Object.defineProperty(signal, "toJSON", { value: () => EMAIL, enumerable: false });
		expect(isOpaqueTextFree(signal)).toBe(false);
		const clean = new AbortController().signal;
		const out = redactPII({
			prompt: EMAIL,
			contents: [{ parts: [{ functionResponse: { response: { carrier: signal, clean } } }] }],
			config: { abortSignal: clean },
		}).data as { config: { abortSignal: unknown }; contents: unknown };
		expect(JSON.stringify(out)).not.toContain("alice@example.com");
		// Kept only at the transport slot; nested, even a clean signal is flattened.
		expect(out.config.abortSignal).toBe(clean);
		expect(JSON.stringify(out.contents)).not.toContain("alice@example.com");
	});

	it("binary values are NOT on the allowlist: a Uint8Array keeps today's behaviour (flattened)", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(isOpaqueTextFree(bytes)).toBe(false);
		const out = redactPII({ prompt: EMAIL, data: bytes }).data as { data: unknown };
		expect(out.data).not.toBe(bytes);
	});
});

describe("redactPII — non-enumerable fields and an own __proto__ key", () => {
	const EMAIL = "write to alice@example.com";

	/** Every own key of every object, in order, with its descriptor flags and prototype. */
	function shape(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(shape);
		if (value === null || typeof value !== "object") return value;
		return {
			proto: Object.getPrototypeOf(value) === Object.prototype ? "Object.prototype" : "other",
			keys: Reflect.ownKeys(value).map((k) => {
				const d = Object.getOwnPropertyDescriptor(value, k) as PropertyDescriptor;
				return [
					String(k),
					"value" in d ? "data" : "accessor",
					d.enumerable,
					d.writable,
					d.configurable,
					shape(d.value),
				];
			}),
		};
	}

	/** The clone as it was built before this change: own enumerable keys, ASSIGNED. */
	function assignedClone(value: unknown): unknown {
		if (typeof value === "string") return redactPII(value).data;
		if (Array.isArray(value)) return value.map(assignedClone);
		if (value === null || typeof value !== "object") return value;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			out[key] = assignedClone((value as Record<string, unknown>)[key]);
		}
		return out;
	}

	it("a non-enumerable own field is kept, still non-enumerable, and redacted", () => {
		const config: Record<string, unknown> = { temperature: 0 };
		Object.defineProperty(config, "systemInstruction", { value: EMAIL, enumerable: false });
		Object.defineProperty(config, "nested", { value: { note: EMAIL }, enumerable: false });
		const out = (redactPII({ prompt: EMAIL, config }).data as { config: object }).config;
		const d = Object.getOwnPropertyDescriptor(out, "systemInstruction");
		expect(d?.enumerable).toBe(false);
		expect(d?.value).toBe("[REDACTED:email]");
		const n = Object.getOwnPropertyDescriptor(out, "nested");
		expect(n?.enumerable).toBe(false);
		expect(n?.value).toEqual({ note: "[REDACTED:email]" });
		expect(Object.keys(out)).toEqual(["temperature"]);
		expect(JSON.stringify(out)).toBe('{"temperature":0}');
	});

	it("a non-enumerable function (a hidden toJSON) is not carried into the clone", () => {
		const carrier: Record<string, unknown> = { text: "plain" };
		Object.defineProperty(carrier, "toJSON", { value: () => EMAIL, enumerable: false });
		const out = redactPII({ prompt: EMAIL, carrier }).data as { carrier: object };
		expect(Object.hasOwn(out.carrier, "toJSON")).toBe(false);
		expect(JSON.stringify(out)).not.toContain("alice@example.com");
	});

	it('an own "__proto__" key from JSON.parse stays an own key, redacted; the prototype is unchanged', () => {
		const input = JSON.parse(
			`{"prompt":"hi","__proto__":{"note":"${EMAIL}"},"contents":[{"__proto__":"${EMAIL}"}]}`,
		) as object;
		expect(Object.hasOwn(input, "__proto__")).toBe(true);
		const out = redactPII(input).data as { contents: object[] };
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({
			note: "[REDACTED:email]",
		});
		expect(Object.getPrototypeOf(out.contents[0])).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(out.contents[0], "__proto__")?.value).toBe(
			"[REDACTED:email]",
		);
		expect(Object.keys(out)).toEqual(["prompt", "__proto__", "contents"]);
		expect(JSON.stringify(out)).toBe(
			'{"prompt":"hi","__proto__":{"note":"[REDACTED:email]"},"contents":[{"__proto__":"[REDACTED:email]"}]}',
		);
	});

	// Unchanged by keeping hidden fields: an accessor is not a data property. detectPII and the clone
	// each read an enumerable getter once, and the clone keeps its value as plain data.
	it("accessors: an enumerable getter is read by detection and by the clone, its value kept as redacted data; a non-enumerable one is never invoked", () => {
		let enumReads = 0;
		let hiddenReads = 0;
		const input: Record<string, unknown> = {};
		Object.defineProperty(input, "shown", {
			get: () => {
				enumReads++;
				return EMAIL;
			},
			enumerable: true,
		});
		Object.defineProperty(input, "hidden", {
			get: () => {
				hiddenReads++;
				return EMAIL;
			},
			enumerable: false,
		});
		const out = redactPII(input).data as object;
		expect(enumReads).toBe(2);
		expect(hiddenReads).toBe(0);
		expect(Object.getOwnPropertyDescriptor(out, "shown")).toEqual({
			value: "[REDACTED:email]",
			writable: true,
			enumerable: true,
			configurable: true,
		});
		expect(Object.hasOwn(out, "hidden")).toBe(false);
	});

	// Ordinary inputs (own enumerable data keys only): the clone is identical to the one assignment
	// built, key for key, descriptor for descriptor, prototype for prototype.
	const ORDINARY: ReadonlyArray<readonly [string, unknown]> = [
		["no PII", { name: "John", age: 30, active: true }],
		["an email", { email: "user@example.com" }],
		["nested objects", { user: { profile: { email: "user@example.com" } } }],
		["arrays", { emails: ["user@example.com", "admin@test.org"] }],
		["several types in one string", { note: "Call 234-567-8901 or email user@example.com" }],
		["an API key", { key: "sk-proj-abc123def456ghi789jkl" }],
		["non-string values", { count: 42, flag: true, empty: null, email: "user@example.com" }],
		["empty structures", { a: {}, b: [], c: "" }],
		["a top-level array", [{ ip: "192.168.1.1" }, "plain", 3]],
		[
			"an Anthropic request",
			{
				model: "claude-sonnet-4-6",
				max_tokens: 64,
				system: EMAIL,
				messages: [{ role: "user", content: [{ type: "text", text: EMAIL }] }],
			},
		],
		[
			"an OpenAI request",
			{
				model: "gpt-4o",
				messages: [
					{ role: "system", content: "be brief" },
					{ role: "user", content: EMAIL },
				],
				tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
			},
		],
		[
			"a Google request",
			{
				model: "gemini-2.5-flash",
				contents: [{ role: "user", parts: [{ text: EMAIL }] }],
				config: { temperature: 0, systemInstruction: EMAIL },
			},
		],
		["a JSON.parse request", JSON.parse(`{"messages":[{"role":"user","content":"${EMAIL}"}]}`)],
	];
	for (const [label, input] of ORDINARY) {
		it(`ordinary input, ${label}: identical to the assigned clone`, () => {
			expect(shape(redactPII(input).data)).toEqual(shape(assignedClone(input)));
		});
	}
});

describe("redactPII — cycles and shared references keep their shape in the copy", () => {
	const EMAIL = "alice@example.com";

	it("a non-enumerable back-reference to the object itself: no throw, the clone's hidden parent is the clone, the email redacted", () => {
		const input: Record<string, unknown> = { email: EMAIL };
		Object.defineProperty(input, "parent", { value: input, enumerable: false });
		const out = redactPII(input).data as Record<string, unknown>;
		expect(out.email).toBe("[REDACTED:email]");
		const d = Object.getOwnPropertyDescriptor(out, "parent");
		expect(d?.enumerable).toBe(false);
		expect(d?.value).toBe(out);
	});

	it("a non-enumerable reference to a grandparent: no throw, it points at the grandparent's clone", () => {
		const input: Record<string, unknown> = { note: EMAIL, child: { grandchild: { email: EMAIL } } };
		const grandchild = (input.child as Record<string, Record<string, unknown>>).grandchild;
		Object.defineProperty(grandchild, "root", { value: input, enumerable: false });
		const out = redactPII(input).data as {
			note: string;
			child: { grandchild: Record<string, unknown> };
		};
		expect(out.child.grandchild.email).toBe("[REDACTED:email]");
		expect(Object.getOwnPropertyDescriptor(out.child.grandchild, "root")?.value).toBe(out);
		expect(out.note).toBe("[REDACTED:email]");
	});

	it("one object referenced twice (no cycle): one clone, referenced twice, redacted", () => {
		const shared = { email: EMAIL };
		const out = redactPII({ a: shared, b: [shared] }).data as {
			a: Record<string, unknown>;
			b: Array<Record<string, unknown>>;
		};
		expect(out.a).not.toBe(shared);
		expect(out.b[0]).toBe(out.a);
		expect(out.a.email).toBe("[REDACTED:email]");
	});

	it("an ENUMERABLE cycle: detection scans it once and redaction copies its shape, where both threw RangeError", () => {
		const input: Record<string, unknown> = { email: EMAIL };
		input.self = input;
		// The walk does not enter an object already open on its path, so the cycle is scanned once.
		const detection = detectPII(input);
		expect(detection.types).toEqual(["email"]);
		expect(detection.paths).toEqual(["email(email)"]);
		const out = redactPII(input).data as Record<string, unknown>;
		expect(out.email).toBe("[REDACTED:email]");
		expect(out.self).toBe(out);
		expect(input.email).toBe(EMAIL);
	});
});

describe("redactPII — an object reached before config is walked again at config, so its signal stays by reference", () => {
	const EMAIL = "write to alice@example.com";

	type Out = Record<string, unknown> & { config: { abortSignal: unknown } };
	/** Each shape, and where its other copy of config lands in the redacted request. */
	const shapes: Array<[string, (cfg: object) => Record<string, unknown>, (out: Out) => unknown]> = [
		[
			"as an earlier key",
			(cfg) => ({ model: "m", alias: cfg, contents: EMAIL, config: cfg }),
			(out) => out.alias,
		],
		[
			"inside an earlier content part",
			(cfg) => ({
				model: "m",
				contents: [{ role: "user", parts: [{ text: EMAIL, meta: cfg }] }],
				config: cfg,
			}),
			(out) => (out.contents as Array<{ parts: Array<{ meta: unknown }> }>)[0]?.parts[0]?.meta,
		],
		[
			"as a LATER key",
			(cfg) => ({ model: "m", contents: EMAIL, config: cfg, backup: cfg }),
			(out) => out.backup,
		],
		[
			"inside a LATER content part",
			(cfg) => ({
				model: "m",
				config: cfg,
				contents: [{ role: "user", parts: [{ text: EMAIL, meta: cfg }] }],
			}),
			(out) => (out.contents as Array<{ parts: Array<{ meta: unknown }> }>)[0]?.parts[0]?.meta,
		],
	];
	for (const [label, make, other] of shapes) {
		it(`config also reached ${label}: config.abortSignal is the caller's signal; the other copy's is flattened, as before`, () => {
			const signal = new AbortController().signal;
			const cfg = { abortSignal: signal };
			const out = redactPII(make(cfg)).data as Out;
			expect(out.config.abortSignal).toBe(signal);
			// the other copy is its own clone, whose signal is a plain object, never the caller's
			const copy = other(out) as { abortSignal: unknown };
			expect(copy).not.toBe(out.config);
			expect(copy.abortSignal).not.toBe(signal);
			expect(Object.getPrototypeOf(copy.abortSignal)).toBe(Object.prototype);
			expect(JSON.stringify(out)).not.toContain("alice@example.com");
		});
	}

	it("control: config reached only at config keeps its signal by reference", () => {
		const signal = new AbortController().signal;
		const out = redactPII({ model: "m", contents: EMAIL, config: { abortSignal: signal } })
			.data as {
			config: { abortSignal: unknown };
		};
		expect(out.config.abortSignal).toBe(signal);
	});

	it("a cycle through config ends: a hidden config.self back to the request, and a hidden config that is the request itself", () => {
		const signal = new AbortController().signal;
		const params: Record<string, unknown> = { model: "m", contents: EMAIL };
		const cfg: Record<string, unknown> = { abortSignal: signal };
		Object.defineProperty(cfg, "self", { value: params, enumerable: false });
		params.config = cfg;
		const out = redactPII(params).data as Record<string, Record<string, unknown>>;
		expect(out.config?.abortSignal).toBe(signal);
		expect(Object.getOwnPropertyDescriptor(out.config, "self")?.value).toBe(out);

		const loop: Record<string, unknown> = { model: "m", contents: EMAIL, abortSignal: signal };
		Object.defineProperty(loop, "config", { value: loop, enumerable: false });
		const looped = redactPII(loop).data as Record<string, unknown>;
		const config = Object.getOwnPropertyDescriptor(looped, "config")?.value as Record<
			string,
			unknown
		>;
		expect(config.abortSignal).toBe(signal);
		expect(Object.getOwnPropertyDescriptor(config, "config")?.value).toBe(looped);
	});
});

describe("redactPII — an array's items are defined on the copy, never assigned", () => {
	it("an index setter on Array.prototype never runs from redaction, and the copy holds its own redacted [0]", () => {
		// redactPII is detectPII, then the copy. detectPII, unchanged, assigns its own scan list, which
		// runs the setter as before; what redaction adds is the difference between the two counts.
		const calls = { set: 0 };
		Object.defineProperty(Array.prototype, "0", {
			get: () => undefined,
			set: () => {
				calls.set++;
			},
			configurable: true,
		});
		try {
			const input = () => ({ messages: ["mail alice@example.com"] });
			detectPII(input());
			const byDetection = calls.set;
			calls.set = 0;
			const out = redactPII(input()).data as { messages: unknown[] };
			expect(calls.set - byDetection).toBe(0);
			// field by field: a deep comparison would itself read the polluted index
			const own = Object.getOwnPropertyDescriptor(out.messages, "0");
			expect(own?.value).toBe("[REDACTED:email]");
			expect(own?.enumerable).toBe(true);
			expect(own?.writable).toBe(true);
			expect(out.messages.length).toBe(1);
		} finally {
			Reflect.deleteProperty(Array.prototype, "0");
		}
	});
});

describe("detectPII — a card is found with an index setter on Array.prototype", () => {
	it("detects and redacts a card by either check while Array.prototype[0] swallows writes", () => {
		Object.defineProperty(Array.prototype, "0", {
			get: () => undefined,
			set: () => {},
			configurable: true,
		});
		try {
			for (const card of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111 12/29"]) {
				expect(detectPII({ v: card }).types, card).toContain("credit_card");
				const out = redactPII({ v: card }).data as { v: string };
				expect(out.v, card).toMatch(/^\[REDACTED:.*credit_card/);
			}
		} finally {
			Reflect.deleteProperty(Array.prototype, "0");
		}
	});
});

describe("redactPII — signalSent: a request whose transport slot is never serialized (the governor's Google request)", () => {
	const EMAIL = "write to alice@example.com";
	type Out = { prompt: string; config: { abortSignal: unknown }; contents?: unknown };

	it("a real signal at config.abortSignal is kept by reference whatever own fields it carries, a cycle among them included", () => {
		const signal = new AbortController().signal as AbortSignal & Record<string, unknown>;
		signal.note = EMAIL;
		signal.self = signal;
		const { data, detection } = redactPII(
			{ prompt: EMAIL, config: { abortSignal: signal } },
			{ signalSent: true },
		);
		const out = data as Out;
		expect(out.config.abortSignal).toBe(signal);
		expect(out.prompt).not.toContain("alice@example.com");
		// The signal is not walked, so its field is no finding: it is never sent.
		expect(detection.paths).toEqual(["prompt(email)"]);
	});

	it("without it (an action's audit copy, the public detectPII), a real signal with an own field is still walked and its text redacted", () => {
		const signal = Object.assign(new AbortController().signal, { note: EMAIL });
		const out = redactPII({ prompt: EMAIL, config: { abortSignal: signal } }).data as Out;
		expect(out.config.abortSignal).not.toBe(signal);
		expect(JSON.stringify(out)).not.toContain("alice@example.com");
		expect(detectPII({ config: { abortSignal: signal } }).paths).toEqual([
			"config.abortSignal.note(email)",
		]);
	});

	it("with it, a look-alike at the slot is still walked and redacted: a spread copy, and a duck-typed object", () => {
		for (const fake of [
			{ ...new AbortController().signal, note: EMAIL },
			{ aborted: false, addEventListener() {}, note: EMAIL },
		]) {
			const out = redactPII({ prompt: EMAIL, config: { abortSignal: fake } }, { signalSent: true })
				.data as Out;
			expect(out.config.abortSignal).not.toBe(fake);
			expect(JSON.stringify(out)).not.toContain("alice@example.com");
		}
	});

	it("with it, a real signal anywhere but the slot is still walked and redacted", () => {
		const nested = Object.assign(new AbortController().signal, { note: EMAIL });
		const clean = new AbortController().signal;
		const out = redactPII(
			{
				prompt: EMAIL,
				contents: [{ parts: [{ functionResponse: { response: { nested } } }] }],
				config: { abortSignal: clean },
			},
			{ signalSent: true },
		).data as Out;
		expect(out.config.abortSignal).toBe(clean);
		expect(JSON.stringify(out.contents)).not.toContain("alice@example.com");
	});

	it("a real signal whose prototype derives from AbortSignal.prototype is still kept by the default rule (as instanceof kept it); an object two levels down with no signal state is not", () => {
		const signal = new AbortController().signal;
		Object.setPrototypeOf(signal, Object.create(AbortSignal.prototype));
		expect(isOpaqueTextFree(signal)).toBe(true);
		const out = redactPII({ prompt: EMAIL, config: { abortSignal: signal } }).data as Out;
		expect(out.config.abortSignal).toBe(signal);
		expect(isOpaqueTextFree(Object.create(Object.create(AbortSignal.prototype)) as object)).toBe(
			false,
		);
	});

	it("the brand check runs no caller code: a Proxy of a real signal is not opaque, and its getPrototypeOf trap never runs", () => {
		let traps = 0;
		const proxy = new Proxy(new AbortController().signal, {
			getPrototypeOf(target) {
				traps++;
				return Reflect.getPrototypeOf(target);
			},
		});
		expect(isOpaqueTextFree(proxy)).toBe(false);
		expect(traps).toBe(0);
	});
});

// ===========================================================================
// The email scan, found from each "@" (linear in the message)
// ===========================================================================

describe("detectPII — email, found from each @", () => {
	const hasEmail = (text: string): boolean => detectPII(text).types.includes("email");

	it("finds real emails: plain, + % and dots in the local part, a subdomain, short and long TLDs", () => {
		for (const email of [
			"user@example.com",
			"first.last+tag@example.com",
			"user%relay@example.org",
			"a.b.c@mail.eu.example.com",
			"someone@example.io",
			"someone@example.technology",
		]) {
			expect(hasEmail(`write to ${email} today`), email).toBe(true);
		}
	});

	it("a local part of 64 characters is found, and so is one of 65: the pattern matches from the last local character before the @, so no length limit applies on that side (as before)", () => {
		expect(hasEmail(`${"a".repeat(64)}@example.com`)).toBe(true);
		expect(hasEmail(`${"a".repeat(65)}@example.com`)).toBe(true);
		expect(hasEmail(`${"a".repeat(10_000)}@example.com`)).toBe(true);
	});

	it("a domain of 255 characters is found, and so is a longer one: the TLD is looked for along the whole domain run (as before)", () => {
		const label = "a".repeat(63);
		const domain255 = `${label}.${label}.${label}.${"a".repeat(59)}.com`;
		expect(domain255.length).toBe(255);
		expect(hasEmail(`u@${domain255}`)).toBe(true);
		expect(hasEmail(`u@${"a".repeat(10_000)}.com`)).toBe(true);
	});

	it("an email at the very start and at the very end of the text", () => {
		expect(hasEmail("a@b.co and then some text")).toBe(true);
		expect(hasEmail("some text and then a@b.co")).toBe(true);
		expect(hasEmail("a@b.co")).toBe(true);
	});

	it("two emails close together, and an @ that is not one before one that is", () => {
		expect(hasEmail("a@b.co,c@d.co")).toBe(true);
		expect(hasEmail("x@y z@example.com")).toBe(true);
		expect(hasEmail("@@a@b.co")).toBe(true);
		expect(hasEmail("a@@b.co")).toBe(false);
	});

	it("an @ with no valid domain is not an email", () => {
		for (const text of [
			"user@",
			"user@localhost",
			"user@.com",
			"user@example.c",
			"user@example.c0m",
			"user@example.",
			"user@-.x",
			" @example.com",
			"@example.com",
			"user@ example.com",
		]) {
			expect(hasEmail(text), text).toBe(false);
		}
	});

	it("the TLD needs two letters right after a dot, and nothing after them: a longer run still matches", () => {
		expect(hasEmail("user@a.bc")).toBe(true);
		expect(hasEmail("user@a.bc9")).toBe(true);
		expect(hasEmail("user@a-b.cd-e")).toBe(true);
		expect(hasEmail("user@a..bc")).toBe(true);
		expect(hasEmail("user@a.b.c")).toBe(false);
	});

	it("an @ inside a long run of letters is not an email without a dotted domain, and is one with it", () => {
		const run = "a".repeat(100_000);
		expect(hasEmail(`${run}@${run}`)).toBe(false);
		expect(hasEmail(`${run}@${run}.com${run}`)).toBe(true);
	});
});

describe("detectPII — jwt", () => {
	const hasJwt = (text: string): boolean => detectPII(text).types.includes("jwt");
	const JWT =
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

	it("finds a JWT alone, in text, and after a run that holds other starts", () => {
		expect(hasJwt(JWT)).toBe(true);
		expect(hasJwt(`Authorization: ${JWT}.`)).toBe(true);
		expect(hasJwt(`-eyJ-eyJ-eyJ ${JWT}`)).toBe(true);
		expect(hasJwt(`-eyJ-eyJ-${JWT}`)).toBe(true);
	});

	it("does not find one with a short segment, a missing segment, or no boundary before eyJ", () => {
		expect(hasJwt("eyJshort.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")).toBe(false);
		expect(hasJwt("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0")).toBe(false);
		expect(hasJwt(`x${JWT}`)).toBe(false);
	});
});

describe("the normalized view: fullwidth forms and format characters", () => {
	const cp = (n: number) => String.fromCodePoint(n);
	const ZWSP = cp(0x200b);
	const fullwidth = (s: string) =>
		[...s]
			.map((c) => {
				const code = c.codePointAt(0) as number;
				return code > 0x20 && code < 0x7f ? cp(code + 0xfee0) : c;
			})
			.join("");
	const key = ["sk", "-proj-", "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY"].join("");
	const split = (s: string, cf: string) => `${s.slice(0, 9)}${cf}${s.slice(9)}`;

	it("a key split by any one format character is a key", () => {
		// Zero-width space, non-joiner, joiner, word joiner, byte order mark, soft hyphen, and a
		// left-to-right mark: each is Unicode category Cf.
		for (const cf of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad, 0x200e].map(cp)) {
			expect(detectPII(split(key, cf)).types, cf.codePointAt(0)?.toString(16)).toContain("api_key");
		}
	});

	it("a key, card, phone, SSN, email and address in fullwidth forms are found", () => {
		const rows: Array<[string, string]> = [
			["api_key", fullwidth(key)],
			["credit_card", fullwidth("4111 1111 1111 1111")],
			["phone", fullwidth("(234) 567-8901")],
			["ssn", fullwidth("123-45-6789")],
			["email", fullwidth("alice@example.com")],
			["ipv4", fullwidth("192.168.1.1")],
		];
		for (const [type, text] of rows) expect(detectPII(text).types, type).toContain(type);
	});

	it("paths and types are the same whichever view matched", () => {
		const plain = detectPII({ a: { b: key }, c: ["4111 1111 1111 1111"] });
		const hidden = detectPII({ a: { b: split(key, ZWSP) }, c: [fullwidth("4111 1111 1111 1111")] });
		expect(hidden.types).toEqual(plain.types);
		expect(hidden.paths).toEqual(plain.paths);
		expect(hidden.found).toBe(true);
	});

	it("redaction replaces the WHOLE original value, format characters and all, as it does the plain one", () => {
		const card = "4111 1111 1111 1111";
		const plain = redactPII({ note: `use ${key} today`, card }).data as Record<string, string>;
		const out = redactPII({ note: `use ${split(key, ZWSP)} today`, card: fullwidth(card) })
			.data as Record<string, string>;
		expect(out.note).toBe("[REDACTED:api_key]");
		expect(out).toEqual(plain);
	});

	it("text with fullwidth forms or format characters and no PII is left byte for byte", () => {
		const text = `${fullwidth("Hello")} ${ZWSP}world${cp(0xfeff)} ${cp(0xfdfa)} ok`;
		const out = redactPII({ text }).data as Record<string, string>;
		expect(out.text).toBe(text);
		expect(detectPII(text).found).toBe(false);
	});

	it("a character NFKC expands (U+FDFA, to 18) beside a key leaves the key found", () => {
		const fdfa = cp(0xfdfa);
		for (const text of [`${fdfa}${key}`, `${key}${fdfa}`, `${fdfa} ${split(key, ZWSP)} ${fdfa}`]) {
			expect(detectPII(text).types).toContain("api_key");
		}
	});

	it("the view, for EVERY code point: removed if a format character; its NFKC form if that is ASCII and the character is a fullwidth form or the form holds no letter or digit; else kept", () => {
		const wrong: string[] = [];
		let replaced = 0;
		let fullwidthReplaced = 0;
		for (let code = 0x80; code <= 0x10ffff; code++) {
			if (code >= 0xd800 && code <= 0xdfff) continue;
			const c = cp(code);
			const form = c.normalize("NFKC");
			const isFullwidth = code >= 0xff01 && code <= 0xff5e;
			const expected = /^\p{Cf}$/u.test(c)
				? ""
				: form !== c &&
						/^[ -~\t\n\r\f\v]+$/.test(form) &&
						(isFullwidth || !/[A-Za-z0-9]/.test(form))
					? form
					: c;
			if (expected !== c && expected !== "") {
				replaced++;
				if (isFullwidth) fullwidthReplaced++;
			}
			const got = normalizedView(`a${c}b`);
			if (got !== `a${expected}b`) wrong.push(code.toString(16));
			if (got.length - 2 > 3 * c.length) wrong.push(`${code.toString(16)} longer than 3`);
		}
		expect(wrong.slice(0, 10)).toEqual([]);
		// Every fullwidth form of printable ASCII, and 76 spaces and punctuation forms: 170 under
		// Unicode 16. NFKC mappings are stable, so a later Unicode version only adds to them.
		expect(fullwidthReplaced).toBe(94);
		expect(replaced).toBeGreaterThanOrEqual(170);
	}, 60_000);

	it("the view of ASCII text is the same string; a lone surrogate is kept", () => {
		const ascii = `plain ASCII ${key}`;
		expect(normalizedView(ascii)).toBe(ascii);
		const lone = `x${cp(0xd800)}y`;
		expect(normalizedView(lone)).toBe(lone);
	});

	it("a value 5.0.4's patterns already read stays found (the view only adds)", () => {
		for (const text of [
			key,
			"4111 1111 1111 1111",
			"alice@example.com",
			`${fullwidth("x")} ${key}`,
		]) {
			expect(detectPII(text).found, text.slice(0, 12)).toBe(true);
		}
	});

	// A superscript, subscript, circled, full-stop or mathematical digit or letter, glued to a value
	// one character short of a pattern, used to complete it in the view: a footnote marker after a
	// number read as its last digit. Each is now kept, so the answer is the plain text's.
	const MARKS = [0xb9, 0x2081, 0x2460, 0x2488, 0x1d7cf].map(cp);
	const LETTER_MARKS = [0x1d43, 0x1d41a, 0x24d0].map(cp);
	const HEX63 = "0123456789abcdef".repeat(4).slice(0, 63);

	it("a digit mark glued after a number does not extend it into a phone, SSN, card or hex secret", () => {
		for (const mark of MARKS) {
			for (const text of ["234-567-890", "123-45-678", "4111 1111 1111 111", HEX63]) {
				const label = `${text.slice(0, 12)} + U+${mark.codePointAt(0)?.toString(16)}`;
				expect(detectPII(text + mark).types, label).toEqual(detectPII(text).types);
				expect(normalizedView(text + mark), label).toBe(text + mark);
			}
		}
		// Positive control: the same rows with the digit typed plainly, or in its fullwidth form.
		for (const digit of ["1", cp(0xff11)]) {
			expect(detectPII(`234-567-890${digit}`).types).toContain("phone");
			expect(detectPII(`123-45-678${digit}`).types).toContain("ssn");
			expect(detectPII(`4111 1111 1111 111${digit}`).types).toContain("credit_card");
			expect(detectPII(`${HEX63}${digit}`).types).toContain("generic_secret");
		}
	});

	it("a letter mark glued after a hex run does not extend it into a secret", () => {
		for (const mark of LETTER_MARKS) {
			expect(detectPII(HEX63 + mark).found, `U+${mark.codePointAt(0)?.toString(16)}`).toBe(false);
		}
		for (const letter of ["a", cp(0xff41)]) {
			expect(detectPII(HEX63 + letter).types).toContain("generic_secret");
		}
	});

	it("a value written entirely in superscript digits is not read (the declared cost)", () => {
		const ssn = [0xb9, 0xb2, 0xb3, 0x2d, 0x2074, 0x2075, 0x2d, 0x2076, 0x2077, 0x2078, 0x2079]
			.map(cp)
			.join("");
		expect(detectPII(ssn).found).toBe(false);
	});

	it("spaces and punctuation forms are still read: a no-break space, a small hyphen", () => {
		const nbsp = cp(0xa0);
		const header = `-----BEGIN${nbsp}RSA${nbsp}PRIVATE${nbsp}KEY-----`;
		expect(normalizedView(header)).toBe("-----BEGIN RSA PRIVATE KEY-----");
		expect(normalizedView(`234${cp(0xfe63)}567`)).toBe("234-567");
	});

	it("the code point table is allocated with the first string that is not ASCII, not at import", async () => {
		vi.resetModules();
		const before = process.memoryUsage().arrayBuffers;
		const fresh = await import("../../src/policy/pii.js");
		fresh.detectPII({ note: `plain ASCII ${key}` });
		const afterAscii = process.memoryUsage().arrayBuffers;
		fresh.normalizedView(fullwidth("x"));
		const afterView = process.memoryUsage().arrayBuffers;
		expect(afterAscii - before).toBeLessThan(0x110000 / 2);
		expect(afterView - afterAscii).toBeGreaterThanOrEqual(0x110000);
	});
});
