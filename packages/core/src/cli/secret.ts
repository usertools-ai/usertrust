// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust secret <add|rm|ls|get|rotate>
 *
 * Manages credentials in the encrypted vault store.
 */

import pc from "picocolors";
import { createAuditWriter } from "../audit/chain.js";
import { loadConfig } from "../config.js";
import type { ActionKind } from "../shared/types.js";
import { createVaultStore } from "../vault/store.js";
import { parseFlags } from "./flags.js";

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
				JSON.stringify({
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
	const config = await loadConfig(undefined, cwd);
	const audit = createAuditWriter(cwd);
	const vault = await createVaultStore({ vaultBase: cwd, config, audit });

	try {
		switch (sub) {
			case "add": {
				const name = positional[2];
				const value = positional[3];
				if (!name || !value) {
					if (jsonOut)
						console.log(
							JSON.stringify({
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
					console.log(JSON.stringify({ command: "secret add", success: true, data: { name } }));
				else console.log(pc.green(`Credential "${name}" stored.`));
				break;
			}

			case "rm": {
				const name = positional[2];
				if (!name) {
					if (jsonOut)
						console.log(
							JSON.stringify({
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
					console.log(JSON.stringify({ command: "secret rm", success: true, data: { name } }));
				else console.log(pc.green(`Credential "${name}" removed.`));
				break;
			}

			case "ls": {
				const entries = await vault.list();
				if (jsonOut) {
					console.log(JSON.stringify({ command: "secret ls", success: true, data: entries }));
				} else if (entries.length === 0) {
					console.log(pc.dim("No credentials stored."));
				} else {
					for (const e of entries) {
						console.log(
							`${pc.bold(e.name)}  scope=${JSON.stringify(e.scope)}  rotated=${e.rotatedAt}`,
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
							JSON.stringify({
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
							`${JSON.stringify({ command: "secret get", success: true, data: { name, value: result.value } })}\n`,
						);
					} else {
						console.log(
							JSON.stringify({
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
							JSON.stringify({
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
					console.log(JSON.stringify({ command: "secret rotate", success: true, data: { name } }));
				else console.log(pc.green(`Credential "${name}" rotated.`));
				break;
			}
		}
	} finally {
		vault.destroy();
		audit.release();
	}
}
