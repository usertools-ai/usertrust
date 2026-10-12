// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust secret <add|rm|ls|get|rotate>
 *
 * Manages credentials in the encrypted vault store.
 */

import { join } from "node:path";
import pc from "picocolors";
import { type AuditWriter, createAuditWriter } from "../audit/chain.js";
import { loadConfig } from "../config.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { ActionKind } from "../shared/types.js";
import { createVaultStore, type VaultStore } from "../vault/store.js";
import { parseFlags } from "./flags.js";
import { scrubForTerminal, toSafeJson, warnIfVaultLoose } from "./target.js";

const SUBCOMMANDS = ["add", "rm", "ls", "get", "rotate"] as const;
type Sub = (typeof SUBCOMMANDS)[number];

export async function run(_unused?: unknown, opts?: { json?: boolean }): Promise<void> {
	const { json, positional } = parseFlags();
	const jsonOut = opts?.json ?? json;

	// positional: ["secret", sub, ...rest]
	const sub = positional[1] as Sub | undefined;
	if (!sub || !SUBCOMMANDS.includes(sub)) {
		const msg = `Usage: usertrust secret <add|rm|ls|get|rotate>

Subcommands:
  add <name> <value>   Store a credential
  rm <name>            Remove a credential
  ls                   List stored credentials
  get <name>           Retrieve a credential value
  rotate <name> <val>  Rotate a credential`;
		if (jsonOut) {
			console.log(
				toSafeJson({
					command: "secret",
					success: false,
					data: { error: sub ? `Unknown subcommand: ${sub}` : "Missing subcommand" },
				}),
			);
		} else {
			console.log(msg);
		}
		return;
	}

	const cwd = process.cwd();
	warnIfVaultLoose(join(cwd, VAULT_DIR));
	const config = await loadConfig(undefined, cwd);
	const audit = createAuditWriter(cwd);
	const vault = await createVaultStore({ vaultBase: cwd, config, audit });

	let commandFailed = false;
	try {
		switch (sub) {
			case "add": {
				const name = positional[2];
				const value = positional[3];
				if (!name || !value) {
					if (jsonOut)
						console.log(
							toSafeJson({
								command: "secret add",
								success: false,
								data: { error: "Name required" },
							}),
						);
					else console.log(pc.red("Usage: usertrust secret add <name> <value>"));
					return;
				}
				await vault.add(name, value);
				if (jsonOut)
					console.log(toSafeJson({ command: "secret add", success: true, data: { name } }));
				else console.log(pc.green(`Credential "${scrubForTerminal(name)}" stored.`));
				break;
			}

			case "rm": {
				const name = positional[2];
				if (!name) {
					if (jsonOut)
						console.log(
							toSafeJson({
								command: "secret rm",
								success: false,
								data: { error: "Name required" },
							}),
						);
					else console.log(pc.red("Usage: usertrust secret rm <name>"));
					return;
				}
				await vault.remove(name);
				if (jsonOut)
					console.log(toSafeJson({ command: "secret rm", success: true, data: { name } }));
				else console.log(pc.green(`Credential "${scrubForTerminal(name)}" removed.`));
				break;
			}

			case "ls": {
				const entries = await vault.list();
				if (jsonOut) {
					console.log(toSafeJson({ command: "secret ls", success: true, data: entries }));
				} else if (entries.length === 0) {
					console.log(pc.dim("No credentials stored."));
				} else {
					for (const e of entries) {
						console.log(
							`${pc.bold(scrubForTerminal(e.name))}  scope=${JSON.stringify(e.scope)}  rotated=${e.rotatedAt}`,
						);
					}
				}
				break;
			}

			case "get": {
				const name = positional[2];
				if (!name) {
					if (jsonOut)
						console.log(
							toSafeJson({
								command: "secret get",
								success: false,
								data: { error: "Name required" },
							}),
						);
					else console.log(pc.red("Usage: usertrust secret get <name>"));
					return;
				}
				const result = await vault.get(name, {
					agent: "cli",
					action: "tool_use" as ActionKind,
				});
				if (jsonOut) {
					if (result.granted) {
						process.stdout.write(
							`${toSafeJson({ command: "secret get", success: true, data: { name, value: result.value } })}\n`,
						);
					} else {
						console.log(
							toSafeJson({
								command: "secret get",
								success: false,
								data: { name, error: result.reason },
							}),
						);
					}
				} else if (result.granted) {
					process.stdout.write(`${result.value ?? ""}\n`);
				} else {
					console.log(pc.red(result.reason ?? "Access denied"));
				}
				break;
			}

			case "rotate": {
				const name = positional[2];
				const value = positional[3];
				if (!name || !value) {
					if (jsonOut)
						console.log(
							toSafeJson({
								command: "secret rotate",
								success: false,
								data: { error: "Name required" },
							}),
						);
					else console.log(pc.red("Usage: usertrust secret rotate <name> <value>"));
					return;
				}
				await vault.rotate(name, value);
				if (jsonOut)
					console.log(toSafeJson({ command: "secret rotate", success: true, data: { name } }));
				else console.log(pc.green(`Credential "${scrubForTerminal(name)}" rotated.`));
				break;
			}
		}
	} catch (err) {
		commandFailed = true;
		throw err;
	} finally {
		closeAfterCommand(vault, audit, commandFailed);
	}
}

/**
 * Destroy the vault and release the audit writer — BOTH, whichever throws — and report a failure of
 * either without ever hiding the command's own outcome. Nothing here throws: a throw from a
 * `finally` replaces the error the command is propagating.
 *  - The command failed: its error is what the CLI reports; a cleanup failure is a warning.
 *  - The command succeeded: a cleanup failure — an audit lock left behind keeps other processes
 *    off the vault until this one exits — is an error: a message on stderr (stdout keeps the
 *    command's own output, a single JSON line under --json) and a non-zero exit code.
 * Both messages carry paths (a lock file's, from the vault directory's name), so they are scrubbed
 * for the terminal like every other untrusted string this command prints.
 */
function closeAfterCommand(vault: VaultStore, audit: AuditWriter, commandFailed: boolean): void {
	const failures: string[] = [];
	try {
		vault.destroy();
	} catch (err) {
		failures.push(`vault: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		audit.release();
	} catch (err) {
		failures.push(`audit lock: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (failures.length === 0) return;
	if (commandFailed) {
		console.warn(
			pc.yellow(
				`Warning: cleanup after the failed command also failed: ${scrubForTerminal(failures.join("; "))}`,
			),
		);
		return;
	}
	console.error(pc.red(`Cleanup failed: ${scrubForTerminal(failures.join("; "))}`));
	process.exitCode = 1;
}
