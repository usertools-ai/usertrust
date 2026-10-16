// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// Preload for a CLI run in its own process against fake-tigerbeetle.mjs:
// `node --import tsx --import <this file> main.ts budget …`. It also says, at exit, whether the
// process ended on its own (the event loop drained: `beforeExit` ran) or through process.exit().
import { writeSync } from "node:fs";
import { register } from "node:module";

register("./fake-tigerbeetle-hooks.mjs", import.meta.url);

let endedOnItsOwn = false;
process.on("beforeExit", () => {
	endedOnItsOwn = true;
});
process.on("exit", (code) => {
	writeSync(2, `${JSON.stringify({ fakeTbExit: { endedOnItsOwn, code } })}\n`);
});
