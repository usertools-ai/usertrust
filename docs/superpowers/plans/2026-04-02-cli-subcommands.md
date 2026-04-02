# CLI Subcommands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `usertrust secret` (5 subcommands) and `usertrust skill verify` CLI commands wrapping the existing vault and supply-chain APIs.

**Architecture:** Two new handler modules (`secret.ts`, `skill.ts`) following the existing lazy-import pattern in `main.ts`. Each exports a `run()` function. A shared `parseFlags()` helper handles repeatable `--flag value` parsing. Tests call `run()` directly with console.log spied.

**Tech Stack:** TypeScript 5.9, ESM, Node.js `node:readline` for stdin, Vitest 4, picocolors for terminal output.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/core/src/cli/flags.ts` | Shared flag parser for subcommands |
| Create | `packages/core/src/cli/secret.ts` | `usertrust secret` handler (5 subcommands) |
| Create | `packages/core/src/cli/skill.ts` | `usertrust skill verify` handler |
| Modify | `packages/core/src/cli/main.ts` | Add `secret` + `skill` to switch + help |
| Create | `packages/core/tests/cli/secret.test.ts` | Vault CLI tests |
| Create | `packages/core/tests/cli/skill.test.ts` | Skill verify CLI tests |

---

### Task 1: Flag Parser Utility

**Files:**
- Create: `packages/core/src/cli/flags.ts`

- [ ] **Step 1: Create the flag parser**

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Minimal flag parser for CLI subcommands.
 * Supports --flag value pairs and repeatable flags (collected into arrays).
 */

export interface ParsedFlags {
	positional: string[];
	flags: Record<string, string>;
	arrays: Record<string, string[]>;
}

/**
 * Parse argv-style args into positional args, single-value flags, and repeatable array flags.
 *
 * @param args - The args after the subcommand (e.g., ["KEY", "--agent", "bot", "--action", "llm_call"])
 * @param repeatableKeys - Flag names that should be collected into arrays (e.g., ["agent", "action"])
 */
export function parseFlags(args: string[], repeatableKeys: string[] = []): ParsedFlags {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	const arrays: Record<string, string[]> = {};

	for (const key of repeatableKeys) {
		arrays[key] = [];
	}

	let i = 0;
	while (i < args.length) {
		const arg = args[i] as string;
		if (arg.startsWith("--") && i + 1 < args.length) {
			const key = arg.slice(2);
			const value = args[i + 1] as string;
			if (repeatableKeys.includes(key)) {
				(arrays[key] as string[]).push(value);
			} else {
				flags[key] = value;
			}
			i += 2;
		} else if (!arg.startsWith("--")) {
			positional.push(arg);
			i++;
		} else {
			// Flag without value — skip
			i++;
		}
	}

	return { positional, flags, arrays };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/cli/flags.ts
git commit -m "feat(cli): add shared flag parser for subcommands"
```

---

### Task 2: Secret CLI Handler

**Files:**
- Create: `packages/core/src/cli/secret.ts`

- [ ] **Step 1: Create the secret handler**

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust secret <add|rm|ls|get|rotate>
 *
 * Manages encrypted credentials in the usertrust vault.
 * All operations require USERTRUST_VAULT_KEY env var.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import pc from "picocolors";
import { createAuditWriter } from "../audit/chain.js";
import { loadConfig } from "../config.js";
import type { ActionKind, CredentialScope } from "../shared/types.js";
import { createVaultStore } from "../vault/store.js";
import { parseFlags } from "./flags.js";

const SUBCOMMANDS = ["add", "rm", "ls", "get", "rotate"] as const;
type SecretSubcommand = (typeof SUBCOMMANDS)[number];

async function readStdinValue(): Promise<string> {
	if (process.stdin.isTTY) {
		return new Promise((resolve) => {
			process.stdout.write("Enter value: ");
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			rl.question("", (answer) => {
				rl.close();
				resolve(answer.trim());
			});
		});
	}
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf-8").trim();
}

function printUsage(): void {
	console.log(`Usage: usertrust secret <command> [options]

Commands:
  add <name>       Add a credential
  rm <name>        Remove a credential
  ls               List all credentials
  get <name>       Retrieve a credential value
  rotate <name>    Rotate a credential value

Options:
  --value <val>    Secret value (or read from stdin)
  --agent <name>   Restrict to agent (repeatable)
  --action <kind>  Restrict to action kind (repeatable)
  --expires <iso>  Expiration timestamp (ISO 8601)
  --json           Output as JSON`);
}

export async function run(
	subcommand: string | undefined,
	args: string[],
	opts: { json?: boolean },
): Promise<void> {
	const json = opts.json === true;

	if (!subcommand || !SUBCOMMANDS.includes(subcommand as SecretSubcommand)) {
		if (json) {
			console.log(
				JSON.stringify({
					command: "secret",
					success: false,
					error: subcommand ? `Unknown subcommand: ${subcommand}` : "No subcommand provided",
				}),
			);
		} else {
			if (subcommand) console.log(`Unknown subcommand: "${subcommand}"`);
			printUsage();
		}
		return;
	}

	const parsed = parseFlags(args, ["agent", "action"]);
	const rootDir = process.cwd();

	let config;
	try {
		config = await loadConfig(undefined, rootDir);
	} catch {
		config = await loadConfig({ budget: 50_000 }, rootDir);
	}

	let store;
	try {
		const audit = createAuditWriter(rootDir);
		store = await createVaultStore({ vaultBase: rootDir, config, audit });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			console.log(JSON.stringify({ command: "secret", success: false, error: msg }));
		} else {
			console.error(pc.red(msg));
		}
		process.exitCode = 1;
		return;
	}

	try {
		switch (subcommand as SecretSubcommand) {
			case "add": {
				const name = parsed.positional[0];
				if (!name) {
					if (json) {
						console.log(
							JSON.stringify({ command: "secret add", success: false, error: "Name required" }),
						);
					} else {
						console.error(pc.red("Name required: usertrust secret add <name>"));
					}
					process.exitCode = 1;
					return;
				}
				const value = parsed.flags.value ?? (await readStdinValue());
				const scope: Partial<CredentialScope> = {};
				if (parsed.arrays.agent && parsed.arrays.agent.length > 0) {
					scope.agents = parsed.arrays.agent;
				}
				if (parsed.arrays.action && parsed.arrays.action.length > 0) {
					scope.actions = parsed.arrays.action as ActionKind[];
				}
				if (parsed.flags.expires) {
					scope.expiresAt = parsed.flags.expires;
				}
				await store.add(name, value, scope);
				if (json) {
					console.log(JSON.stringify({ command: "secret add", success: true, name }));
				} else {
					console.log(`${pc.green("Added")} credential: ${name}`);
				}
				break;
			}

			case "rm": {
				const name = parsed.positional[0];
				if (!name) {
					if (json) {
						console.log(
							JSON.stringify({ command: "secret rm", success: false, error: "Name required" }),
						);
					} else {
						console.error(pc.red("Name required: usertrust secret rm <name>"));
					}
					process.exitCode = 1;
					return;
				}
				await store.remove(name);
				if (json) {
					console.log(JSON.stringify({ command: "secret rm", success: true, name }));
				} else {
					console.log(`${pc.green("Removed")} credential: ${name}`);
				}
				break;
			}

			case "ls": {
				const entries = await store.list();
				if (json) {
					console.log(JSON.stringify({ command: "secret ls", success: true, data: entries }));
				} else {
					if (entries.length === 0) {
						console.log("No credentials stored.");
					} else {
						const header = `${"NAME".padEnd(24)} ${"AGENTS".padEnd(16)} ${"ACTIONS".padEnd(16)} ${"EXPIRES".padEnd(12)} CREATED`;
						console.log(header);
						for (const e of entries) {
							const agents = e.scope.agents.length > 0 ? e.scope.agents.join(",") : "*";
							const actions = e.scope.actions.length > 0 ? e.scope.actions.join(",") : "*";
							const expires = e.scope.expiresAt
								? new Date(e.scope.expiresAt).toISOString().slice(0, 10)
								: "never";
							const created = new Date(e.createdAt).toISOString().slice(0, 10);
							console.log(
								`${e.name.padEnd(24)} ${agents.padEnd(16)} ${actions.padEnd(16)} ${expires.padEnd(12)} ${created}`,
							);
						}
					}
				}
				break;
			}

			case "get": {
				const name = parsed.positional[0];
				const agent = parsed.flags.agent ?? parsed.arrays.agent?.[0];
				const action = parsed.flags.action ?? parsed.arrays.action?.[0];
				if (!name || !agent || !action) {
					const missing = [!name && "name", !agent && "--agent", !action && "--action"]
						.filter(Boolean)
						.join(", ");
					if (json) {
						console.log(
							JSON.stringify({
								command: "secret get",
								success: false,
								error: `Missing required: ${missing}`,
							}),
						);
					} else {
						console.error(
							pc.red(`Missing required: ${missing}`),
							"\nUsage: usertrust secret get <name> --agent <agent> --action <action>",
						);
					}
					process.exitCode = 1;
					return;
				}
				const result = await store.get(name, { agent, action: action as ActionKind });
				if (result.granted) {
					if (json) {
						console.log(
							JSON.stringify({
								command: "secret get",
								success: true,
								name,
								value: result.value,
							}),
						);
					} else {
						process.stdout.write(result.value ?? "");
					}
				} else {
					if (json) {
						console.log(
							JSON.stringify({
								command: "secret get",
								success: false,
								name,
								error: result.reason,
							}),
						);
					} else {
						console.error(pc.red(`Access denied: ${result.reason}`));
					}
					process.exitCode = 1;
				}
				break;
			}

			case "rotate": {
				const name = parsed.positional[0];
				if (!name) {
					if (json) {
						console.log(
							JSON.stringify({
								command: "secret rotate",
								success: false,
								error: "Name required",
							}),
						);
					} else {
						console.error(pc.red("Name required: usertrust secret rotate <name>"));
					}
					process.exitCode = 1;
					return;
				}
				const value = parsed.flags.value ?? (await readStdinValue());
				await store.rotate(name, value);
				if (json) {
					console.log(JSON.stringify({ command: "secret rotate", success: true, name }));
				} else {
					console.log(`${pc.green("Rotated")} credential: ${name}`);
				}
				break;
			}
		}
	} finally {
		store.destroy();
	}
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/cli/secret.ts
git commit -m "feat(cli): add usertrust secret subcommands (add/rm/ls/get/rotate)"
```

---

### Task 3: Skill CLI Handler

**Files:**
- Create: `packages/core/src/cli/skill.ts`

- [ ] **Step 1: Create the skill handler**

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust skill verify <path>
 *
 * Verifies a skill manifest's signature and permissions.
 */

import { existsSync, readFileSync } from "node:fs";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import { enforceSkillLoad } from "../supply-chain/permissions.js";
import { validateManifest } from "../supply-chain/manifest.js";
import { verifySignature } from "../supply-chain/sign.js";
import { parseFlags } from "./flags.js";

const SUBCOMMANDS = ["verify"] as const;

export async function run(
	subcommand: string | undefined,
	args: string[],
	opts: { json?: boolean },
): Promise<void> {
	const json = opts.json === true;

	if (subcommand !== "verify") {
		if (json) {
			console.log(
				JSON.stringify({
					command: "skill",
					success: false,
					error: subcommand ? `Unknown subcommand: ${subcommand}` : "No subcommand provided",
				}),
			);
		} else {
			if (subcommand) console.log(`Unknown subcommand: "${subcommand}"`);
			console.log(`Usage: usertrust skill verify <path> [options]

Options:
  --trusted-publisher <name>   Add trusted publisher (repeatable)
  --json                       Output as JSON`);
		}
		return;
	}

	const parsed = parseFlags(args, ["trusted-publisher"]);
	const manifestPath = parsed.positional[0];

	if (!manifestPath) {
		if (json) {
			console.log(
				JSON.stringify({ command: "skill verify", success: false, error: "Path required" }),
			);
		} else {
			console.error(pc.red("Path required: usertrust skill verify <path>"));
		}
		process.exitCode = 1;
		return;
	}

	if (!existsSync(manifestPath)) {
		if (json) {
			console.log(
				JSON.stringify({
					command: "skill verify",
					success: false,
					error: `File not found: ${manifestPath}`,
				}),
			);
		} else {
			console.error(pc.red(`File not found: ${manifestPath}`));
		}
		process.exitCode = 1;
		return;
	}

	let rawManifest: unknown;
	try {
		rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch {
		if (json) {
			console.log(
				JSON.stringify({
					command: "skill verify",
					success: false,
					error: `Invalid JSON in ${manifestPath}`,
				}),
			);
		} else {
			console.error(pc.red(`Invalid JSON in ${manifestPath}`));
		}
		process.exitCode = 1;
		return;
	}

	let manifest;
	try {
		manifest = validateManifest(rawManifest);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			console.log(
				JSON.stringify({ command: "skill verify", success: false, error: `Schema error: ${msg}` }),
			);
		} else {
			console.error(pc.red(`Schema validation failed: ${msg}`));
		}
		process.exitCode = 1;
		return;
	}

	const rootDir = process.cwd();
	let config;
	try {
		config = await loadConfig(undefined, rootDir);
	} catch {
		config = await loadConfig({ budget: 50_000 }, rootDir);
	}

	// Apply --trusted-publisher overrides
	const trustedOverrides = parsed.arrays["trusted-publisher"] ?? [];
	if (trustedOverrides.length > 0) {
		config = {
			...config,
			supplyChain: {
				...config.supplyChain,
				enabled: true,
				trustedPublishers: [
					...(config.supplyChain?.trustedPublishers ?? []),
					...trustedOverrides,
				],
			},
		};
	}

	// Ensure supply chain is enabled for verification
	if (!config.supplyChain?.enabled) {
		config = {
			...config,
			supplyChain: { ...config.supplyChain, enabled: true },
		};
	}

	const sigValid = verifySignature(manifest);
	const result = enforceSkillLoad(manifest, config);

	if (json) {
		console.log(
			JSON.stringify({
				command: "skill verify",
				success: result.valid,
				data: {
					id: manifest.id,
					publisher: manifest.publisher,
					signatureValid: sigValid,
					permissionsAllowed: result.permissionsAllowed,
					deniedPermissions: result.deniedPermissions,
					manifestHash: result.manifestHash,
					error: result.error,
				},
			}),
		);
	} else {
		console.log(`Skill: ${manifest.id}`);
		console.log(`Publisher: ${manifest.publisher}`);
		console.log(`Signature: ${sigValid ? pc.green("VALID") : pc.red("INVALID")}`);
		const permStr = manifest.permissions.join(", ");
		console.log(
			`Permissions: ${permStr} (${result.permissionsAllowed ? pc.green("ALLOWED") : pc.red("DENIED")})`,
		);
		if (result.valid) {
			console.log(`Result: ${pc.green("PASSED")}`);
		} else {
			console.log(`Result: ${pc.red(`FAILED — ${result.error ?? "Verification failed"}`)}`);
		}
	}

	if (!result.valid) {
		process.exitCode = 1;
	}
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/cli/skill.ts
git commit -m "feat(cli): add usertrust skill verify command"
```

---

### Task 4: Wire Into main.ts

**Files:**
- Modify: `packages/core/src/cli/main.ts`

- [ ] **Step 1: Add `secret` and `skill` to COMMANDS and switch**

In `main.ts`, change the `COMMANDS` array (line 5):

```typescript
const COMMANDS = [
	"init",
	"inspect",
	"health",
	"verify",
	"snapshot",
	"tb",
	"pricing",
	"completions",
	"secret",
	"skill",
] as const;
```

Add two cases before the `default:` in the switch (after the `completions` case around line 91):

```typescript
	case "secret":
		await import("./secret.js").then((m) =>
			m.run(positional[1], positional.slice(2), { json: jsonFlag }),
		);
		break;
	case "skill":
		await import("./skill.js").then((m) =>
			m.run(positional[1], positional.slice(2), { json: jsonFlag }),
		);
		break;
```

Update the help text in the default case to add:

```
  secret        Manage vault credentials
  skill         Verify skill manifests
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/cli/main.ts
git commit -m "feat(cli): wire secret and skill subcommands into main"
```

---

### Task 5: Secret CLI Tests

**Files:**
- Create: `packages/core/tests/cli/secret.test.ts`

- [ ] **Step 1: Write the secret CLI tests**

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/secret.js";

describe("usertrust secret", () => {
	let tmpVault: string;
	let logOutput: string[];
	let errOutput: string[];
	let originalEnv: string | undefined;
	let originalCwd: string;

	beforeEach(() => {
		tmpVault = join(tmpdir(), `secret-cli-${randomUUID()}`);
		mkdirSync(tmpVault, { recursive: true });
		// Create minimal config
		mkdirSync(join(tmpVault, ".usertrust"), { recursive: true });
		writeFileSync(
			join(tmpVault, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 50000, vault: { enabled: true, auditAccess: false } }),
		);
		logOutput = [];
		errOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errOutput.push(args.map(String).join(" "));
		});
		originalEnv = process.env.USERTRUST_VAULT_KEY;
		process.env.USERTRUST_VAULT_KEY = "test-master-key";
		originalCwd = process.cwd();
		process.chdir(tmpVault);
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		if (originalEnv === undefined) {
			// biome-ignore lint/performance/noDelete: must remove env var
			delete process.env.USERTRUST_VAULT_KEY;
		} else {
			process.env.USERTRUST_VAULT_KEY = originalEnv;
		}
		rmSync(tmpVault, { recursive: true, force: true });
		process.exitCode = undefined;
	});

	it("prints usage for unknown subcommand", async () => {
		await run("bogus", [], { json: false });
		expect(logOutput.some((l) => l.includes("Unknown subcommand"))).toBe(true);
	});

	it("prints usage when no subcommand given", async () => {
		await run(undefined, [], { json: false });
		expect(logOutput.some((l) => l.includes("Usage:"))).toBe(true);
	});

	it("add + ls shows credential", async () => {
		await run("add", ["MY_KEY", "--value", "secret123"], { json: false });
		logOutput = [];
		await run("ls", [], { json: false });
		expect(logOutput.some((l) => l.includes("MY_KEY"))).toBe(true);
	});

	it("add + get with correct scope returns value", async () => {
		await run("add", ["SCOPED_KEY", "--value", "val1", "--agent", "bot", "--action", "llm_call"], {
			json: false,
		});
		logOutput = [];
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run("get", ["SCOPED_KEY", "--agent", "bot", "--action", "llm_call"], { json: false });
		expect(writeSpy).toHaveBeenCalledWith("val1");
		writeSpy.mockRestore();
	});

	it("get with wrong agent denied", async () => {
		await run("add", ["AG_KEY", "--value", "v", "--agent", "good-bot"], { json: false });
		await run("get", ["AG_KEY", "--agent", "evil-bot", "--action", "llm_call"], { json: false });
		expect(process.exitCode).toBe(1);
		expect(errOutput.some((l) => l.includes("denied") || l.includes("Access"))).toBe(true);
	});

	it("get with wrong action denied", async () => {
		await run("add", ["AC_KEY", "--value", "v", "--action", "llm_call"], { json: false });
		await run("get", ["AC_KEY", "--agent", "bot", "--action", "shell_command"], { json: false });
		expect(process.exitCode).toBe(1);
	});

	it("rm + ls shows credential removed", async () => {
		await run("add", ["RM_KEY", "--value", "v"], { json: false });
		await run("rm", ["RM_KEY"], { json: false });
		logOutput = [];
		await run("ls", [], { json: false });
		expect(logOutput.some((l) => l.includes("No credentials"))).toBe(true);
	});

	it("rotate + get returns new value", async () => {
		await run("add", ["ROT_KEY", "--value", "old"], { json: false });
		await run("rotate", ["ROT_KEY", "--value", "new"], { json: false });
		logOutput = [];
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run("get", ["ROT_KEY", "--agent", "a", "--action", "llm_call"], { json: false });
		expect(writeSpy).toHaveBeenCalledWith("new");
		writeSpy.mockRestore();
	});

	it("ls --json returns valid JSON", async () => {
		await run("add", ["J_KEY", "--value", "v"], { json: false });
		logOutput = [];
		await run("ls", [], { json: true });
		const parsed = JSON.parse(logOutput[0] as string);
		expect(parsed.success).toBe(true);
		expect(parsed.data).toBeInstanceOf(Array);
		expect(parsed.data[0].name).toBe("J_KEY");
	});

	it("get --json returns value", async () => {
		await run("add", ["JG_KEY", "--value", "secret"], { json: false });
		logOutput = [];
		await run("get", ["JG_KEY", "--agent", "a", "--action", "llm_call"], { json: true });
		const parsed = JSON.parse(logOutput[0] as string);
		expect(parsed.success).toBe(true);
		expect(parsed.value).toBe("secret");
	});

	it("add with --expires sets expiration", async () => {
		const future = new Date(Date.now() + 86400_000).toISOString();
		await run("add", ["EXP_KEY", "--value", "v", "--expires", future], { json: false });
		logOutput = [];
		await run("ls", [], { json: true });
		const parsed = JSON.parse(logOutput[0] as string);
		expect(parsed.data[0].scope.expiresAt).toBe(future);
	});

	it("missing vault key prints error", async () => {
		// biome-ignore lint/performance/noDelete: must remove env var
		delete process.env.USERTRUST_VAULT_KEY;
		await run("ls", [], { json: false });
		expect(process.exitCode).toBe(1);
		expect(errOutput.some((l) => l.includes("Vault") || l.includes("key"))).toBe(true);
	});

	it("missing --agent on get prints usage", async () => {
		await run("add", ["X", "--value", "v"], { json: false });
		errOutput = [];
		await run("get", ["X"], { json: false });
		expect(process.exitCode).toBe(1);
		expect(errOutput.some((l) => l.includes("--agent"))).toBe(true);
	});

	it("unknown subcommand --json returns error JSON", async () => {
		await run("bogus", [], { json: true });
		const parsed = JSON.parse(logOutput[0] as string);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain("bogus");
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run packages/core/tests/cli/secret.test.ts`
Expected: All 13 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/core/tests/cli/secret.test.ts
git commit -m "test(cli): add secret subcommand tests"
```

---

### Task 6: Skill CLI Tests

**Files:**
- Create: `packages/core/tests/cli/skill.test.ts`

- [ ] **Step 1: Write the skill CLI tests**

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnsignedManifest } from "../../src/supply-chain/manifest.js";
import { generateKeyPair, signManifest } from "../../src/supply-chain/sign.js";
import { run } from "../../src/cli/skill.js";

describe("usertrust skill verify", () => {
	let tmpDir: string;
	let logOutput: string[];
	let errOutput: string[];
	let originalCwd: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `skill-cli-${randomUUID()}`);
		mkdirSync(tmpDir, { recursive: true });
		// Create minimal config with supply chain enabled
		mkdirSync(join(tmpDir, ".usertrust"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".usertrust", "usertrust.config.json"),
			JSON.stringify({
				budget: 50000,
				supplyChain: {
					enabled: true,
					trustedPublishers: [],
					allowedPermissions: ["llm_call", "tool_use", "file_read"],
					requireSignature: true,
				},
			}),
		);
		logOutput = [];
		errOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errOutput.push(args.map(String).join(" "));
		});
		originalCwd = process.cwd();
		process.chdir(tmpDir);
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		rmSync(tmpDir, { recursive: true, force: true });
		process.exitCode = undefined;
	});

	function writeManifest(manifest: object): string {
		const path = join(tmpDir, "manifest.json");
		writeFileSync(path, JSON.stringify(manifest));
		return path;
	}

	function makeSignedManifest() {
		const { publicKey, privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/summarizer",
			name: "Summarizer",
			publisher: "acme",
			permissions: ["llm_call", "tool_use"],
			entrySource: "export function run() {}",
		});
		return signManifest(unsigned, privateKey);
	}

	it("valid signed manifest passes", async () => {
		const manifest = makeSignedManifest();
		const path = writeManifest(manifest);
		await run("verify", [path], { json: false });
		expect(logOutput.some((l) => l.includes("PASSED"))).toBe(true);
		expect(process.exitCode).toBeUndefined();
	});

	it("tampered manifest fails", async () => {
		const manifest = makeSignedManifest();
		const tampered = { ...manifest, name: "Evil" };
		const path = writeManifest(tampered);
		await run("verify", [path], { json: false });
		expect(logOutput.some((l) => l.includes("FAILED"))).toBe(true);
		expect(process.exitCode).toBe(1);
	});

	it("invalid signature fails", async () => {
		const manifest = makeSignedManifest();
		const bad = { ...manifest, signature: "a".repeat(128) };
		const path = writeManifest(bad);
		await run("verify", [path], { json: false });
		expect(logOutput.some((l) => l.includes("INVALID"))).toBe(true);
		expect(process.exitCode).toBe(1);
	});

	it("denied permissions reported", async () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "evil/keylogger",
			name: "Keylogger",
			publisher: "evil",
			permissions: ["shell_command", "network_access"],
			entrySource: "export function run() {}",
		});
		const manifest = signManifest(unsigned, privateKey);
		const path = writeManifest(manifest);
		await run("verify", [path], { json: false });
		expect(logOutput.some((l) => l.includes("DENIED"))).toBe(true);
		expect(process.exitCode).toBe(1);
	});

	it("--json returns structured result", async () => {
		const manifest = makeSignedManifest();
		const path = writeManifest(manifest);
		await run("verify", [path], { json: true });
		const parsed = JSON.parse(logOutput[0] as string);
		expect(parsed.success).toBe(true);
		expect(parsed.data.id).toBe("acme/summarizer");
		expect(parsed.data.signatureValid).toBe(true);
	});

	it("--trusted-publisher overrides config", async () => {
		const { privateKey } = generateKeyPair();
		const unsigned = createUnsignedManifest({
			id: "acme/admin-tool",
			name: "Admin Tool",
			publisher: "acme",
			permissions: ["shell_command", "network_access"],
			entrySource: "export function run() {}",
		});
		const manifest = signManifest(unsigned, privateKey);
		const path = writeManifest(manifest);
		await run("verify", [path, "--trusted-publisher", "acme"], { json: true });
		const parsed = JSON.parse(logOutput[0] as string);
		expect(parsed.success).toBe(true);
	});

	it("non-existent file prints error", async () => {
		await run("verify", ["/nonexistent/path.json"], { json: false });
		expect(process.exitCode).toBe(1);
		expect(errOutput.some((l) => l.includes("File not found"))).toBe(true);
	});

	it("invalid JSON prints error", async () => {
		const path = join(tmpDir, "bad.json");
		writeFileSync(path, "not json {{{");
		await run("verify", [path], { json: false });
		expect(process.exitCode).toBe(1);
		expect(errOutput.some((l) => l.includes("Invalid JSON"))).toBe(true);
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run packages/core/tests/cli/skill.test.ts`
Expected: All 8 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/core/tests/cli/skill.test.ts
git commit -m "test(cli): add skill verify command tests"
```

---

### Task 7: Full Suite Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (1359 existing + ~21 new = ~1380 total).

- [ ] **Step 2: Run biome check**

Run: `npx biome check packages/core/src/cli/ packages/core/tests/cli/secret.test.ts packages/core/tests/cli/skill.test.ts`
Expected: No errors in new files. Fix any formatting issues with `npx biome check --write`.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc -b --noEmit`
Expected: No new errors.

- [ ] **Step 4: Final commit if any biome fixes**

```bash
git add -u
git commit -m "fix(cli): biome formatting"
```
