# CLI Subcommands: Vault Secrets + Supply Chain Verification

**Date:** 2026-04-02
**Status:** Approved
**Scope:** Two new CLI subcommand groups for usertrust

## Context

P2 (Supply Chain) and P3 (Credential Vault) shipped the core APIs but no CLI wrappers. Users need command-line access to manage secrets and verify skill manifests.

## Architecture

Extend `main.ts` with two subcommand groups using the existing lazy-import + switch pattern:

```
usertrust secret <add|rm|ls|get|rotate>   -> src/cli/secret.ts
usertrust skill verify <path>             -> src/cli/skill.ts
```

`main.ts` parses `argv[0]` as before. When it matches `secret` or `skill`, it passes `argv[1]` (the subcommand) and remaining args to the handler module. Each handler module exports a `run(subcommand, args, opts)` function.

## `usertrust secret` (5 subcommands)

All require `USERTRUST_VAULT_KEY` env var. All emit audit events via the existing `VaultStore`.

### `secret add <name>`

Adds a credential to the vault.

**Flags:**
- `--value <value>` — secret value (if omitted, reads from stdin with no echo)
- `--agent <name>` — restrict to specific agent (repeatable for multiple agents)
- `--action <kind>` — restrict to specific action kind (repeatable)
- `--expires <iso8601>` — expiration timestamp
- `--json` — structured output

**Behavior:**
1. Open vault store via `createVaultStore()`
2. Build `CredentialScope` from flags (empty arrays = unrestricted)
3. Call `store.add(name, value, scope)`
4. Print confirmation or JSON receipt
5. Call `store.destroy()`

### `secret rm <name>`

Removes a credential.

**Flags:** `--json`

**Behavior:** Open store, call `store.remove(name)`, print confirmation, destroy.

### `secret ls`

Lists all credentials — names, scopes, timestamps. No values exposed.

**Flags:** `--json`

**Behavior:** Open store, call `store.list()`, format as table (human) or JSON array.

**Human output format:**
```
NAME              AGENTS      ACTIONS     EXPIRES     CREATED
OPENAI_API_KEY    my-agent    llm_call    never       2026-04-01
STRIPE_KEY        *           api_request 2026-12-31  2026-04-01
```

### `secret get <name>`

Retrieves a single credential value if scope allows. Designed for piping.

**Flags (both required):**
- `--agent <name>` — accessor agent identity
- `--action <kind>` — accessor action kind
- `--json` — structured output

**Behavior:**
1. Open vault store
2. Call `store.get(name, { agent, action })`
3. If granted: print raw value to stdout (human mode) or JSON with value
4. If denied: print error to stderr, exit code 1
5. Destroy store

**Piping usage:** `usertrust secret get OPENAI_API_KEY --agent bot --action llm_call`

### `secret rotate <name>`

Rotates a credential's value.

**Flags:**
- `--value <value>` — new value (if omitted, reads from stdin)
- `--json`

**Behavior:** Open store, call `store.rotate(name, newValue)`, print confirmation, destroy.

## `usertrust skill` (1 subcommand)

### `skill verify <path>`

Reads a skill manifest JSON from `<path>` and runs the full verification pipeline.

**Flags:**
- `--json` — structured output
- `--trusted-publisher <name>` — override trusted publishers list (repeatable)

**Behavior:**
1. Read manifest JSON from `<path>`
2. Parse with `validateManifest()`
3. Load trust config (or build minimal config from flags)
4. Call `enforceSkillLoad(manifest, config)`
5. Print verification result

**Human output:**
```
Skill: acme/summarizer
Publisher: acme
Signature: VALID
Permissions: llm_call, tool_use (ALLOWED)
Result: PASSED
```

**Failure output:**
```
Skill: evil/keylogger
Publisher: evil
Signature: INVALID
Result: FAILED — Invalid manifest signature
```

## `main.ts` changes

Add `secret` and `skill` to the `COMMANDS` array. Add cases to the switch:

```typescript
case "secret":
    await import("./secret.js").then((m) =>
        m.run(positional[1], positional.slice(2), { json: jsonFlag })
    );
    break;
case "skill":
    await import("./skill.js").then((m) =>
        m.run(positional[1], positional.slice(2), { json: jsonFlag })
    );
    break;
```

Update the help text to include the new commands.

## Flag parsing

Use the same manual `argv` parsing as existing commands (no external arg parser). Parse `--flag value` pairs from the positional args after the subcommand. For repeatable flags like `--agent`, collect into arrays.

## Error handling

- Missing `USERTRUST_VAULT_KEY`: print hint about setting env var, exit 1
- Missing required flags (e.g., `--agent` for `get`): print usage, exit 1
- Vault store errors: catch and print with existing error hint/docsUrl pattern
- Invalid manifest path: print "File not found", exit 1

## stdin value reading

When `--value` is omitted for `add` and `rotate`, read from stdin. If stdin is a TTY, prompt with "Enter value: " (no echo). If stdin is piped, read the full input.

```typescript
import { createInterface } from "node:readline";

async function readStdinValue(): Promise<string> {
    if (process.stdin.isTTY) {
        // Interactive: prompt with no echo
        process.stdout.write("Enter value: ");
        const rl = createInterface({ input: process.stdin });
        // Disable echo via raw mode
        process.stdin.setRawMode?.(true);
        // ... read line, restore echo
    } else {
        // Piped: read all input
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        return Buffer.concat(chunks).toString("utf-8").trim();
    }
}
```

## Tests

### `tests/cli/secret.test.ts` (~15 tests)

Tests invoke the handler's `run()` function directly (same pattern as other CLI tests). Vault is created in a temp directory with `USERTRUST_VAULT_KEY` set in `process.env`.

- `add` + `ls` shows new credential
- `add` + `get` with correct scope returns value
- `get` with wrong agent denied (exit code 1)
- `get` with wrong action denied
- `rm` + `ls` shows credential removed
- `rotate` + `get` returns new value
- `ls --json` returns valid JSON array
- `get --json` returns valid JSON with value
- `add` with `--agent` and `--action` flags creates scoped credential
- `add` with `--expires` sets expiration
- Missing `USERTRUST_VAULT_KEY` prints error
- Missing `--agent` on `get` prints usage
- Unknown subcommand prints help

### `tests/cli/skill.test.ts` (~8 tests)

- Valid signed manifest passes verification
- Tampered manifest fails
- Invalid signature fails
- Denied permissions reported
- `--json` returns structured result
- `--trusted-publisher` overrides config
- Non-existent file path prints error
- Invalid JSON prints error

## Files

| Action | Path |
|--------|------|
| Modify | `packages/core/src/cli/main.ts` |
| Create | `packages/core/src/cli/secret.ts` |
| Create | `packages/core/src/cli/skill.ts` |
| Create | `packages/core/tests/cli/secret.test.ts` |
| Create | `packages/core/tests/cli/skill.test.ts` |
