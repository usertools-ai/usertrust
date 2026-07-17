// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — verify pkg CLI must map a FAILED vault verdict to a nonzero exit
 * code. The vault-mode verdict→exit mapping is exposed as a pure function so it
 * can be unit-tested without spawning a built CLI (keeps the zero-dep package
 * test-buildless).
 */

import { describe, expect, it } from "vitest";
import { exitCodeFor } from "../../src/index.js";

describe("HARDEN: verify CLI exit-code mapping", () => {
	it("maps a failed verdict to exit code 1", () => {
		expect(exitCodeFor({ valid: false })).toBe(1);
	});

	it("maps a valid verdict to exit code 0", () => {
		expect(exitCodeFor({ valid: true })).toBe(0);
	});
});
