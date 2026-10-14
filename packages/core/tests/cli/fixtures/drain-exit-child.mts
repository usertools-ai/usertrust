// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// Writes `bytes` to stdout in 4 KiB lines, sets exit code 3, then ends through exitWhenDrained(),
// for a parent reading through a pipe: `tsx drain-exit-child.mts <bytes>`.
import { exitWhenDrained } from "../../../src/cli/drain-exit.js";

const bytes = Number(process.argv[2] ?? "0");
const line = `${"x".repeat(4095)}\n`;
for (let written = 0; written < bytes; written += line.length) process.stdout.write(line);
process.exitCode = 3;
await exitWhenDrained();
