// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * End the process with the exit code the command set (`process.exitCode`, 0 when unset), once all
 * it wrote to stdout and stderr has been handed to the OS. Where a pipe is written asynchronously
 * (macOS), `process.exit()` drops what is still queued, so a piped `--json` line could be cut. A
 * write's callback runs only once it, and every write queued before it, has been flushed.
 *
 * For a command that cannot end on its own: an evicted ledger client it left open (destroying one
 * aborts the process) keeps the event loop alive.
 */
export async function exitWhenDrained(): Promise<never> {
	await Promise.all(
		[process.stdout, process.stderr].map(
			(stream) => new Promise<void>((resolve) => stream.write("", () => resolve())),
		),
	);
	process.exit(process.exitCode ?? 0);
}
