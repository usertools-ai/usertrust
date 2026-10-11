// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The package's only entry point (".") exports the whole wire contract, release
 * included: a client that validates or types its requests gets every route's from
 * one import. A dropped export fails here at run time (the schema) or in the test
 * typecheck (the types), never silently.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
	AbortRequestSchema,
	type AbortResponse,
	AuthorizeRequestSchema,
	type ReleaseRequest,
	ReleaseRequestSchema,
	type ReleaseResponse,
	SettleRequestSchema,
} from "../src/index.js";

describe("the package index exports every route's wire contract", () => {
	it("release is exported beside authorize, settle and abort", () => {
		for (const schema of [
			AuthorizeRequestSchema,
			SettleRequestSchema,
			AbortRequestSchema,
			ReleaseRequestSchema,
		]) {
			expect(typeof schema.safeParse).toBe("function");
		}
		const request = ReleaseRequestSchema.parse({ transferId: "tx_1", reason: "given back" });
		expect(request).toEqual({ transferId: "tx_1", reason: "given back" });
		expectTypeOf(request).toEqualTypeOf<ReleaseRequest>();
		expectTypeOf<ReleaseResponse>().toEqualTypeOf<{
			released: true;
			transferId: string;
			voidError?: string;
		}>();
		// Abort's 200 has release's shape: it says THIS request ended the hold.
		expectTypeOf<AbortResponse>().toEqualTypeOf<{
			aborted: true;
			transferId: string;
			voidError?: string;
		}>();
	});
});
