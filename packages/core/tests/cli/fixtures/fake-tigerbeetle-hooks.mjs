// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// Module resolve hook registered by fake-tigerbeetle-register.mjs: `tigerbeetle-node` is the fake.
const FAKE = new URL("./fake-tigerbeetle.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "tigerbeetle-node") return nextResolve(FAKE, context);
	return nextResolve(specifier, context);
}
