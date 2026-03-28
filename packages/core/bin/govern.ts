#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

const command = process.argv[2];

switch (command) {
	case "init":
		await import("../src/cli/init.js").then((m) => m.run());
		break;
	case "inspect":
		await import("../src/cli/inspect.js").then((m) => m.run());
		break;
	case "health":
		await import("../src/cli/health.js").then((m) => m.run());
		break;
	case "verify":
		await import("../src/cli/verify.js").then((m) => m.run());
		break;
	case "snapshot":
		await import("../src/cli/snapshot.js").then((m) => m.run());
		break;
	case "tb":
		await import("../src/cli/tb.js").then((m) => m.run());
		break;
	default:
		console.log(`Usage: usertrust <command>

Commands:
  init       Initialize governance vault
  inspect    Show governance bank statement
  health     Show entropy diagnostics
  verify     Verify audit chain integrity
  snapshot   Create/restore vault snapshots
  tb         Manage TigerBeetle process`);
		break;
}
