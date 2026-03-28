#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

const command = process.argv[2];

switch (command) {
	case "init":
		await import("./init.js").then((m) => m.run());
		break;
	case "inspect":
		await import("./inspect.js").then((m) => m.run());
		break;
	case "health":
		await import("./health.js").then((m) => m.run());
		break;
	case "verify":
		await import("./verify.js").then((m) => m.run());
		break;
	case "snapshot":
		await import("./snapshot.js").then((m) => m.run());
		break;
	case "tb":
		await import("./tb.js").then((m) => m.run());
		break;
	default:
		console.log(`Usage: usertrust <command>

Commands:
  init       Initialize trust vault
  inspect    Show trust bank statement
  health     Show entropy diagnostics
  verify     Verify audit chain integrity
  snapshot   Create/restore vault snapshots
  tb         Manage TigerBeetle process`);
		break;
}
