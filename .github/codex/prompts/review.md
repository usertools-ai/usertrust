# Code Review — usertrust

You are reviewing a pull request for usertrust, an open-source financial governance SDK for AI agents. It wraps LLM clients (Anthropic, OpenAI, Google) with a JS Proxy so every AI call becomes an immutable, auditable, double-entry financial transaction.

## CRITICAL: Scope Constraint

**ONLY review code that was CHANGED in this PR's diff.** Do not flag pre-existing issues in unchanged files. If a file appears in the diff, only review the changed lines and their immediate context.

Run `git diff origin/master...HEAD` mentally — anything outside that diff is out of scope.

## Architecture Context

- **TigerBeetle** — immutable double-entry ledger, two-phase settlement (PENDING → POST/VOID)
- **SHA-256 hash-chained audit trail** — append-only JSONL, each event chains from previous event's hash
- **Merkle proofs (RFC 6962)** — domain-separated hashing, inclusion and consistency proofs
- **Duck-typed client detection** — identifies LLM SDKs by structural shape, never imports providers directly
- **Dead-letter queue** — on audit write failure after TigerBeetle success, never throw on degradation
- **`usertrust-verify` is zero-dependency** — intentionally duplicates canonicalize/verifyChain/Merkle from core
- **TypeScript 5.9 strict** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM only
- **Biome** — tabs, 100-char line width

## Review Focus

Examine the PR diff for:

1. **Correctness** — logic errors, edge cases, off-by-one, null/undefined safety
2. **Two-phase lifecycle** — PENDING hold before every LLM call, POST on success, VOID on every failure path
3. **Hash chain integrity** — changes to canonicalization, hashing, or event format must be mirrored in both `usertrust` and `usertrust-verify`
4. **TypeScript** — `noUncheckedIndexedAccess` violations (array access without narrowing), `exactOptionalPropertyTypes` violations (assigning `undefined` to optional fields)
5. **Security** — injection, credential leaks, hardcoded secrets, raw prompt storage (only SHA-256 hashes allowed)
6. **Zero-dep verify** — `usertrust-verify` must not import from `usertrust` or add any dependencies

## What NOT to flag

- Pre-existing issues in code not modified by this PR
- Style/formatting (Biome handles this)
- Missing tests (unless a critical path is untested)
- Documentation gaps (unless docs are the PR's purpose)
- Theoretical issues without concrete exploit paths
- Intentional code duplication between `usertrust` and `usertrust-verify` (by design)

## Output Format

For each finding:
- **Severity**: Blocking / High / Medium
- **File:Line**: exact location in the PR diff
- **Description**: what's wrong and why it matters
- **Suggestion**: concrete fix (code snippet if possible)

If the PR is clean, say: "No issues found. PR is clean." Better to approve a good PR than generate noise.
