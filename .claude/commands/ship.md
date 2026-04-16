Autonomous delivery pipeline. Takes the current brainstorming context and ships it to production.

You are the **team lead**. You orchestrate the pipeline by creating a team, dispatching agents, and monitoring progress. Do NOT do implementation work yourself — delegate to teammates.

## WORKTREE REQUIRED — DO THIS FIRST

**Before doing ANYTHING else, create a worktree.** Do NOT work on master. Do NOT work on the current branch. Every /ship invocation gets its own isolated worktree.

**Branch from master.** The project uses single-branch flow — `master` is the only long-lived branch.

```bash
# Resolve main repo root — works from anywhere in the repo or any worktree
MAIN_REPO="$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -n1)"

cd "$MAIN_REPO"
git fetch origin master
git worktree add .worktrees/ship-<name> -b ship/<name> origin/master
cd .worktrees/ship-<name>
```

**Verify you are in the worktree before proceeding:**
```bash
pwd  # Must show .worktrees/ship-<name>
git branch --show-current  # Must show ship/<name>
```

If you are NOT in a worktree, STOP. Create one. This is non-negotiable. Working on master or another instance's branch causes merge conflicts and lost work.

**All subsequent commands run from inside the worktree.** Not the main repo. Not another branch. The worktree.

---

## Pipeline Stages

```
/ship
  ├─ 0.  WORKTREE           — Create isolated worktree from master
  ├─ 1.  PLAN               — superpowers:writing-plans → structured task list
  ├─ 1b. PLAN REVIEW        — GPT-5.4 external review via proxy (~30s, pre-code)
  ├─ 2.  AUDIT              — Self-review against CLAUDE.md + scope + security
  ├─ 3.  IMPLEMENT          — Dispatch agents (flat, sequential, or domain-lead)
  ├─ 4.  CHECK              — Quick local: tsc + biome + vitest (~30s)
  ├─ 5.  FIX                — superpowers:systematic-debugging if check fails
  ├─ 6.  CODE REVIEW        — Internal code review agent (local, pre-push)
  │      SECURITY REVIEW      Security review agent (local, parallel with 6)
  ├─ 6b. SECURITY REVIEW    — Trail of Bits differential-review (parallel with 6)
  ├─ 7.  REMEDIATE INTERNAL — Fix findings from reviews
  ├─ 8.  VERIFY WORKTREE    — Confirm still in worktree before commit
  ├─ 9.  COMMIT             — Stage specific files + conventional commit
  ├─ 10. PUSH + DRAFT PR    — Push branch, open DRAFT PR (Codex triggers, CI skips)
  ├─ 11. CODEX GATE         — Local Codex review via scripts/codex-review.sh (~30s)
  ├─ 12. REMEDIATE CODEX    — Triage → fix → deliberate dismissed (max 2) → ruling
  ├─ 13. MARK READY         — gh pr ready → CI triggers ONCE on final code
  ├─ 14. VERIFY             — End-to-end verification (while CI runs)
  ├─ 15. HANDOFF            — Report to user, wait for "merge" + CI green
  └─ 16. MERGE              — Merge, pull main repo, clean up worktree
```

Follow this EXACTLY. Do not skip stages. Do not reorder stages.

### Docs-only fast path

If every changed file is a `.md` file, stages 4-7 (CHECK, FIX, CODE REVIEW, REMEDIATE INTERNAL)
add no value — there is no code to typecheck, lint, or review. Detect this early and skip them.

```bash
# Fast-path heuristic: if all changed files are .md, skip stages 4-7
NON_MD="$(git diff --name-only origin/master...HEAD | grep -v '\.md$')"
if [ -z "$NON_MD" ]; then
  echo "Docs-only change detected — skipping stages 4-7"
  # Jump directly to stage 8 (VERIFY WORKTREE)
fi
```

Run the check immediately after Stage 3 (IMPLEMENT). If the variable is empty, proceed to
Stage 8. Otherwise continue through stages 4-7 as normal.

### GH Actions minutes budget

Minutes = billed execution time. Codex review now runs locally via `scripts/codex-review.sh` (~30s, 0 GH Actions minutes). GPT-5.4 plan review (Stage 1b) is a proxy call (~$0.05-0.15 in tokens, 0 GH Actions minutes).

| Workflow | When | Runner | Minutes |
|---|---|---|---|
| GPT-5.4 plan review (Stage 1b) | Stage 1b (pre-code) | proxy.usertools.ai | 0m (~$0.05-0.15 tokens) |
| `codex-review.yml` | Stage 10 (draft → skipped) / Stage 13 (marked ready) | `ubuntu-latest` | ~2-3m |
| `codex-arbitrate.yml` | Stage 12c (per dismissal, max 2) | `ubuntu-latest` | ~1-2m each |
| `ci.yml` | Stage 13 (marked ready) | `ubuntu-latest` | ~2-3m |
| **Total (no dismissals)** | | | **~4-6m** |
| **Total (2 dismissals)** | | | **~6-10m** |

## Stage Instructions

### 1. PLAN

**Invoke `superpowers:writing-plans`** to produce a structured implementation plan. This skill creates bite-sized TDD tasks with exact file paths, code, and test commands.

If brainstorming hasn't happened yet and the task is non-trivial, **invoke `superpowers:brainstorming` first** to explore approaches before planning.

Write the plan as `TaskCreate` items — one task per independent unit of work. The writing-plans skill produces the structure; you translate it into tasks.

### 1b. PLAN REVIEW (GPT-5.4)

**External model review of the plan before any code is written.** GPT-5.4 provides fresh eyes on blind spots, missing edge cases, and feasibility issues that self-review misses. This is cheap insurance (~30s, ~$0.05-0.15 in proxy tokens, 0 GH Actions minutes).

**Skip if:** docs-only fast path (no implementation to review).

**How to run:**

1. Assemble the plan into a single text block — either a spec file or a summary of the tasks from Stage 1.

2. Send to GPT-5.4 via the proxy:

```bash
PLAN=$(cat <spec-or-plan-file>)
# Or if plan is tasks only: summarize tasks into a text block

curl -s --max-time 300 "https://proxy.usertools.ai/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $USERTOOLS_API_KEY" \
  -d "$(jq -n --arg plan "$PLAN" '{
    model: "gpt-5.4",
    messages: [{role: "user", content: ("Review this implementation plan for a TypeScript SDK that provides financial governance for AI agents (two-phase spend via TigerBeetle, hash-chained audit trail, policy gate, zero-dep standalone verifier). Identify:\n1. Missing edge cases or error paths\n2. Security risks (credential leaks, raw prompt storage, injection)\n3. Hash-chain / audit parity issues (usertrust-verify must produce identical results to core)\n4. Feasibility issues (will the described approach actually work?)\n5. Over-engineering (is it doing too much?)\n6. Ambiguities that will cause implementation confusion\n\nBe specific — name what is missing and what should change. Do not rewrite the plan.\n\n" + $plan)}],
    max_tokens: 4096,
    stream: true
  }')" | grep '^data: ' | sed 's/^data: //' | \
    jq -r 'select(.choices[0].delta.content != null) | .choices[0].delta.content' | tr -d '\n'
```

3. **Triage findings** — same classification pattern as Codex:

| Classification | Action |
|---------------|--------|
| **Valid + actionable** | Incorporate into the plan (update tasks) |
| **Valid but v2** | Note as future work, don't expand this PR's scope |
| **Invalid / wrong for our context** | Dismiss with reasoning |

GPT-5.4 reviews from a generic best-practices perspective. It does NOT know your CLAUDE.md invariants, your architecture, or your operational context. Common false positives:
- Flagging `usertrust-verify` intentional code duplication as a DRY violation
- Recommending runtime dependencies in the zero-dependency verifier
- Suggesting LLM-based policy decisions (Board of Directors is heuristic by design)
- Over-specifying error handling that the governance gate already covers
- Suggesting scope expansion disguised as "minimum changes before implementation"

**Use your judgment.** Accept edge cases, security gaps, and hash-chain / audit-parity issues. Reject scope creep and security theater.

4. **Update the plan** if accepted findings change the task list. Revise existing TaskCreate items or add new ones. Don't let the review expand scope beyond the original brainstorm.

5. **Record the triage** — note which findings were accepted/rejected. This feeds into the Stage 15 handoff report.

**Degraded mode:** If the proxy returns an error (rate limit, timeout, balance), note it and proceed to Stage 2. The plan review is valuable but not a hard gate.

**Model choice:** GPT-5.4 is the default. For domain-specific plans (audit/verify parity, security, CLI UX), consider also sending to a second heavyweight in parallel (e.g., `grok-4`, `gemini-2.5-pro`) for diverse perspectives. Cap at 2 models per review.

### 2. AUDIT

Review your plan against:
- CLAUDE.md invariants (two-phase spend, hash-chain integrity, zero-dep verify, duck typing, ESM strict TS)
- Scope creep (anything not discussed in brainstorm = cut it)
- Missing test coverage (test-to-source ratio must stay above 1.65:1)
- Security concerns (credential leaks, raw prompt storage, injection)
- `usertrust-verify` parity (if touching audit/canonicalize/merkle — changes must be mirrored)

Fix any issues found. If audit found nothing, proceed.

### 3. IMPLEMENT

**Choose the right dispatch pattern based on scope:**

**Single task (1-3 files):** Use a single `Agent` call with `subagent_type: "general-purpose"`.

**Multiple independent tasks (same domain):** **Invoke `superpowers:dispatching-parallel-agents`** to run agents concurrently. Each agent gets its own task from the plan.

**Sequential dependent tasks:** **Invoke `superpowers:subagent-driven-development`** to execute tasks in order with review between each.

**Cross-domain feature (3+ domains affected):** Use **Domain Lead dispatch** — see below.

---

#### Domain Lead Dispatch (Multi-Level)

**Trigger:** Scan the task list from Stage 1. If planned tasks touch files in **3 or more domains** from the domain map below, use Domain Lead mode. Otherwise, use flat or sequential dispatch.

**Domain Map:**

| Domain Lead | Scope | Key Files |
|------------|-------|-----------|
| **Governance** | `src/govern.ts`, `src/config.ts`, `src/detect.ts`, `src/proxy.ts`, `src/streaming.ts`, `src/shared/` | govern.ts |
| **Ledger** | `src/ledger/` | engine.ts, client.ts, pricing.ts |
| **Audit** | `src/audit/`, `packages/verify/src/` | chain.ts, merkle.ts, canonical.ts |
| **Policy** | `src/policy/`, `src/board/` | gate.ts, pii.ts, board.ts |
| **Runtime** | `src/resilience/`, `src/memory/`, `src/snapshot/` | circuit.ts, patterns.ts |
| **CLI** | `src/cli/` | main.ts |
| **Site** | `site/` | app/page.tsx |
| **Infra** | `.github/`, `scripts/` | ci.yml |

All `src/` paths are relative to `packages/core/`.

**Domain leads ONLY modify files within their scope.** This prevents merge conflicts between parallel leads. If a file doesn't appear in any domain scope, the Level 0 lead handles it directly.

**Three-phase flow:**

```
Phase 1: SHARED TYPES (sequential — only if cross-domain types needed)
  Dispatch Governance lead to create shared types/schemas first.
  Other domain leads wait.
  Skip this phase if no new shared types are needed.

Phase 2: DOMAIN WORK (parallel)
  Dispatch all remaining domain leads simultaneously via TeamCreate.
  Each domain lead:
    1. Reads CLAUDE.md (mandatory)
    2. Reads all relevant source files in their scope
    3. Discovers sub-tasks the plan didn't anticipate
    4. Spawns Level 2 task agents for each sub-task
    5. Reviews Level 2 output for domain correctness
    6. Reports back: files modified, tests written, issues found

Phase 3: INTEGRATION (sequential)
  Level 0 merges all domain lead reports.
  Runs full typecheck + test suite.
  Resolves cross-domain issues before proceeding to Stage 4.
```

**Domain lead prompt template:**
```
"You are the [DOMAIN] domain lead for usertrust at [WORKTREE PATH].

## Your Domain
Scope: [files/directories from domain map]

## Feature
[Feature description from brainstorm]

## Your Tasks from the Plan
[Filtered task list for this domain]

## Instructions
1. Read CLAUDE.md first — understand invariants and patterns
2. Read all relevant source files in your scope
3. Identify sub-tasks (the plan may not cover everything — discover what's needed)
4. For each sub-task, spawn a task agent:
   - Specific file(s) to modify
   - CLAUDE.md patterns relevant to the change
   - Test expectations
5. Review each task agent's output for domain correctness
6. Report back to Level 0:
   - Files modified (with paths)
   - Tests written and passing/failing
   - Issues found
   - Unexpected cross-domain needs discovered

## Cross-Domain Dependencies
[Types/interfaces from Governance lead, or types you need — provided by Level 0]

## Constraints
- ONLY modify files within your domain scope
- Follow CLAUDE.md patterns exactly
- globals: false in tests — import everything from vitest
- Mock TigerBeetle at module level in tests
- ESM only — .js extensions in imports
- Biome: tabs, 100-char line width

IMPORTANT: Read CLAUDE.md first. Do NOT modify files outside your scope."
```

**Agent prompt pattern (for flat dispatch):**
```
"You are working on the usertrust project at [WORKTREE PATH].
Project uses: TypeScript 5.9 strict, ESM, Vitest 4, Biome (tabs, 100-char).

Architecture: Financial governance SDK for AI agents with:
- TigerBeetle two-phase settlement (PENDING → POST/VOID)
- SHA-256 hash-chained audit trail + Merkle proofs (RFC 6962)
- Duck-typed LLM client detection (Anthropic/OpenAI/Google)
- Dead-letter queue on audit write failure
- Policy gate with 12 field operators + PII detection
- Board of Directors (heuristic review, NOT LLM calls)
- usertrust-verify: zero-dependency standalone verifier (intentional code duplication)

Your task: [specific task with file paths and expected output]

Key patterns to follow:
- [relevant CLAUDE.md patterns for this task]
- [type signatures they'll need]
- [test patterns if writing tests]

IMPORTANT: Read CLAUDE.md first."
```

---

**Domain-specific skill invocation — tell agents to use these when relevant:**

| If the task touches... | Invoke this skill | Why |
|----------------------|------------------|-----|
| `site/` | `frontend-design` | Production-grade UI patterns |
| Frontend polish pass | `apple-polish` | iOS/macOS quality audit |
| Tests before implementation | `superpowers:test-driven-development` | Write failing test first |

### 4. CHECK (Quick Local)

**Fast local checks (~30 seconds).** Full test suite runs on GitHub CI later (stage 13).

```bash
npx tsc -b --noEmit                    # ~3s — catches type errors
npx biome check .                      # ~1s — catches lint/format
npx vitest run                         # ~25s — catches test failures
```

If any check fails, proceed to Stage 5 (FIX).

**Optional pre-flight (if touching CI/workflow files):**
```bash
scripts/preflight.sh
```

### 5. FIX

If CHECK failed, **invoke `superpowers:systematic-debugging`**:
1. Observe the actual error (don't guess)
2. Form a hypothesis about root cause
3. Test the hypothesis with the minimum change
4. Verify the fix, then re-run CHECK

Max 2 fix cycles. If still failing after 2 attempts, ABORT and report what's broken.

### 6. CODE REVIEW + SECURITY REVIEW (Local, Pre-Push)

Run internal reviews BEFORE pushing — they don't need a PR.

Launch two agents **in parallel**:

**Code review agent:**
- Run `/code-review:code-review` against the diff
- Return findings as structured text

**Security review agent (financial SDK — always run):**
- Review for credential leaks, raw prompt storage (only hashes allowed), hash chain integrity violations, injection, OWASP top 10
- Extra focus on two-phase spend lifecycle completeness and `usertrust-verify` parity
- Return findings as structured text

Both run locally via Agent tool. Wait for both to complete.

### 6b. SECURITY REVIEW (Trail of Bits)

Run `/security-review` **in parallel with Stage 6** — Trail of Bits differential-review skill on the PR diff. This is a security-critical financial SDK (hash-chain integrity, audit parity, credential handling), so a second independent security pass is worth the ~1-2min.

- Uses Trail of Bits differential-review skill on the PR diff
- Depth tier: SMALL (<20 files) = DEEP, MEDIUM (20-200) = FOCUSED, LARGE (200+) = SURGICAL
- Focus areas for usertrust:
  - Credential leaks (API keys, provider tokens in logs or audit entries)
  - Raw prompt storage (only SHA-256 hashes allowed — never the prompt body)
  - Hash-chain integrity (canonicalization order, BigInt boundary handling)
  - `usertrust-verify` parity (any divergence between core and verifier is a CVE-class bug)
  - Two-phase spend lifecycle holes (PENDING without POST/VOID)
  - Policy gate bypass (field operator misuse, PII detector escapes)
- P0/P1 findings → add to Stage 7 remediation queue (merge blocker)
- P2/P3 findings → PR comment only (advisory)
- **Skip if:** all changes are `.md` files (docs-only fast path)
- **Degraded mode:** if `/security-review` isn't installed locally, skip with a note in the Stage 15 handoff — Stage 6 in-house security review still runs

### 7. REMEDIATE INTERNAL

Fix findings from code review + security review.

1. Apply fixes
2. Re-run quick local checks (stage 4)
3. Commit fixes into the same branch

Max 2 remediation cycles. If still failing, STOP and report.

### 8. VERIFY WORKTREE

Confirm you are still in the worktree:

```bash
pwd  # Must show .worktrees/ship-<name>
git branch --show-current  # Must show ship/<name>
```

If not, STOP. You drifted. `cd` back to the worktree before committing.

### 9. COMMIT

- `git add` specific files only — NEVER `git add -A` or `git add .`
- Conventional commit: `feat(scope):`, `fix(scope):`, etc.
- End with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Verify with `git status` after commit

### 10. PUSH + DRAFT PR

- Push: `git push -u origin ship/<name>`
- Create **DRAFT** PR: `gh pr create --draft --title "..." --body "..."`
- PR body: Summary (bullet points), Test plan, Files changed
- Target `master` as the base branch

**Draft PR skips CI and `codex-review.yml`** — both are filtered to non-draft PRs only.
The local review in Stage 11 via `scripts/codex-review.sh` is the primary, faster review (~30s).

### 11. CODEX GATE

**Run local Codex review** (~30s vs ~3min via GitHub Actions). No GH Actions minutes consumed.

```bash
# Run local Codex review (~30s)
"$(git rev-parse --show-toplevel)/scripts/codex-review.sh" <PR-number>

# Read the review (posted as PR comment by the script)
gh api repos/{owner}/{repo}/issues/{number}/comments \
  --jq '[.[] | select(.body | test("Codex Review"; "i"))] | last | .body'
```

Codex does NOT know your CLAUDE.md invariants. It may:
- Flag two-phase spend as "unnecessary complexity"
- Suggest `require()` in an ESM project
- Recommend patterns that violate your architecture
- Flag intentional code duplication in `usertrust-verify`

**Classify each finding:**

| Classification | Action |
|---------------|--------|
| **Valid + actionable** | Fix in Stage 12b |
| **Valid but v2 / out of scope** | Defer with reasoning — don't let Codex expand this PR |
| **Invalid / wrong for our context** | Dismiss → deliberation in Stage 12c (max 2) |

**Use your judgment.** Accept real bugs, security gaps, and invariant violations. Reject generic best-practice suggestions that don't know about two-phase spend, zero-dep verify, or the hash-chain design. The architect's decision is final.

### 12. REMEDIATE CODEX

#### 12a. TRIAGE
Classify every Codex finding. Post triage as a PR comment.

#### 12b. FIX
Apply fixes for valid findings. Commit and push.

#### 12c. DELIBERATE (max 2 per PR)
For each **dismissed** finding (up to 2), trigger adversarial deliberation:

1. Post Claude's position as a PR comment with the deliberation marker:
```markdown
## Dismissal: [finding summary]

**Codex finding:** [quote the finding]
**Claude's position:** [technical reasoning for dismissal]

<!-- codex-deliberate
FINDING: [finding text]
CLAUDE_POSITION: [reasoning text]
-->
```

2. This triggers `codex-arbitrate.yml` — Codex argues against its own finding.
3. Wait for the deliberation response (~1-2 min).
4. Post a verdict comment:

```markdown
## Deliberation Verdict

**Finding:** [summary]
**Outcome:** [Codex concedes / Codex holds / Stalemate]
**Verdict:** [Dismissed — reasoning / Fixed in `<sha>` / Escalated to user]
```

**Outcomes:**
- Codex concedes → dismissal stands
- Codex holds → fix the finding
- Stalemate → escalate to user

**Cap: 2 deliberations per PR.** Remaining dismissals stand without deliberation — post reasoning on PR, architect's decision is final.

#### 12d. SUMMARY
Post remediation summary on PR:

```bash
gh pr comment <PR> --body "$(cat <<'EOF'
## Codex Remediation Summary

| # | Finding | Severity | Classification | Action | Commit |
|---|---------|----------|---------------|--------|--------|
| 1 | [summary] | [sev] | Valid / Dismissed / Deferred | Fixed / Dismissed / Deferred | `<sha>` or — |

**Deliberations:** [N of 2 used]
**Result:** All findings addressed
EOF
)"
```

### 13. MARK READY

Mark the PR ready for review. This triggers CI (once, on final code).

**⛔ NEVER SKIP CI.** `ci.yml` has **no path filter** — it runs on every non-draft PR regardless of which files changed. There is no such thing as a "docs-only skip" or "site-only skip" or "backend-only skip." CI (typecheck + lint + tests + coverage) runs on **every** non-draft PR. If you find yourself reasoning that CI can be skipped because of what files changed, you are wrong — re-read this paragraph. The only thing that changes CI behavior is draft/non-draft, nothing else.

```bash
gh pr ready <PR-number>
```

**Wait for CI to complete:**
```bash
gh pr checks <PR-number> --watch --timeout 420
```

Post CI results on the PR:

```bash
gh pr comment <PR> --body "$(cat <<'EOF'
## CI Results (Final)

| Step | Status |
|------|--------|
| Typecheck | ✓ / ✗ |
| Lint | ✓ / ✗ |
| Tests + Coverage | ✓ / ✗ |

**Commit:** `<sha>`
EOF
)"
```

If CI fails, fix → push → CI re-runs automatically (PR is no longer draft).

### 14. VERIFY

**Invoke `superpowers:verification-before-completion`** — run while CI is in progress.

Run the feature end-to-end. Don't assume it works because tests pass.

For an SDK, verify:
- Does `trust()` still work with mock clients? (dry-run mode)
- Does the CLI still function? (`npx usertrust inspect`, `npx usertrust health`)
- Does the audit chain verify? (`npx usertrust verify`)
- Are there TypeScript compile errors in consumer-facing types?
- If touching verify: does `usertrust-verify` produce identical results to core?

Track what you found and fixed for the HANDOFF report.

### 15. HANDOFF

**Invoke `superpowers:finishing-a-development-branch`** to decide integration strategy.

Then **STOP.** Report the PR to the user for testing:

```
## PR Ready for Testing

**PR:** <link>
**Branch:** ship/<name>
**Status:** CI pass / Known issues listed below

### What's in this PR
- <bullet summary of changes>

### How to test
- <specific commands to run the feature>
- <what to look for>

### Review audit trail (all on PR)
- **Plan review (GPT-5.4):** [N findings, N accepted, N rejected]
- **Internal review:** [N findings, N fixed]
- **Security review (in-house):** [pass / N findings]
- **Security review (Trail of Bits):** [pass / N findings, or skipped]
- **Codex findings:** [N found, N fixed, N dismissed]
- **Deliberations:** [N of 2, outcomes]

### Known issues (if any)
- <anything you couldn't fix or chose to defer>
```

**Post the handoff report as a PR comment:**

```bash
gh pr comment <PR> --body "$(cat <<'EOF'
## Ship Pipeline Complete

**Branch:** ship/<name>
**Pipeline stages:** 0-15 ✓

### Audit Trail
- **Plan review (GPT-5.4):** [N findings, N accepted, N rejected] (stage 1b)
- **Internal review:** [N findings, N auto-fixed] (stage 6-7)
- **Security review (in-house):** [pass/N findings] (stage 6-7)
- **Security review (Trail of Bits):** [pass/N findings, or skipped] (stage 6b)
- **Codex findings:** [N found, N fixed, N dismissed] (stage 11-12)
- **Deliberations:** [N of 2, outcomes] (stage 12c)
- **CI:** [pass/fail] (stage 13)
- **Verification:** [pass/N issues found and fixed] (stage 14)

### Summary
[1-3 bullet summary of what shipped]
EOF
)"
```

**Wait for the user to say "merge" before proceeding.**

### 16. MERGE (User-Initiated)

Only when user says "merge", "ship it", "lgtm", or similar.

**Requires:** CI green (stage 13).

- `gh pr merge <PR-number> --squash --subject "<title>"`
- Report: merged SHA
- Delete remote branch: `git push origin --delete ship/<name>`
- Clean up worktree AND local branch (both are required — worktree removal alone leaves the branch):

```bash
git worktree remove .worktrees/ship-<name>
git branch -D ship/<name>
```

- Prune stale remote-tracking refs: `git remote prune origin`
- Sync main repo:

```bash
MAIN_REPO="$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -n1)"
cd "$MAIN_REPO"
git pull origin master
```

**Post-merge:** Consider invoking `claude-md-improver` if the PR introduced new patterns that CLAUDE.md should document.

**Note:** `/ship` does NOT deploy. Deployment happens via `/promote` — a separate command that handles npm publish + site deploy + GitHub release.

## Abort Conditions

The pipeline STOPS and reports if:
- Local CHECK fails after 2 fix attempts (stage 5)
- Internal review remediation exceeds 2 cycles (stage 7)
- Codex deliberations exceed 2 per PR (stage 12c)
- CI fails after 2 fix attempts (stage 13)
- VERIFY reveals unfixable issues (stage 14)
- Any `gh` CLI command fails unexpectedly

Always report: which stage failed, what the error was, PR link if created.

**Degraded mode:** If `scripts/codex-review.sh` fails (API error, missing key), proceed without it — post a skip note on the PR and continue to Stage 12 with no Codex findings to triage.

## Red Flags — You Are About to Violate /ship

- **Working outside a worktree (on master or another branch)**
- **Creating a non-draft PR** (must be draft — CI should not run until stage 13)
- **Implementing code yourself instead of delegating to agents**
- Running `git add -A` or `git add .`
- Pushing directly to master
- Skipping reviews because "it's a small change"
- Adding features not discussed in the brainstorm
- Merging without CI green
- Creating documentation files not asked for
- Proceeding past a failed stage without attempting a fix
- Not providing agents with full project context (CLAUDE.md + relevant source)
- Claiming work is done without running verification
- Blindly implementing Codex suggestions without verifying against CLAUDE.md
- Giving two agents (or domain leads) the same file
- Triggering more than 2 deliberations per PR
- **Leaving local `ship/*` branches after merge** (worktree removal doesn't delete the branch — run `git branch -D`)
- **Leaving remote `ship/*` branches after merge** (squash merge doesn't auto-delete — run `git push origin --delete`)
- **Skipping plan review because "it's a simple change"** (GPT-5.4 routinely catches missing edge cases, hash-chain holes, and audit-parity gaps that self-review misses — $0.05 of tokens saves hours of rework)
- **Skipping CI because "tests already passed locally"** (`ci.yml` always runs — it's the authoritative check)

**All of these mean: STOP. Re-read the stage instructions.**

## Rules

- Do NOT skip stages. The order is load-bearing.
- Do NOT implement code yourself — delegate to agents.
- Do NOT use `git add -A` or `git add .` — stage specific files only.
- Do NOT push to master directly — always go through a PR.
- Do NOT merge without CI green.
- Do NOT create docs unless the brainstorm called for it. YAGNI.
- Do NOT add features beyond what was brainstormed.
- Always branch from master — single-branch flow.
- Draft PRs only — CI runs once when marked ready, not before. NEVER skip CI.
- `ci.yml` has NO path filter — it runs on ALL non-draft PRs.
- Max 2 deliberations per PR — remaining dismissals stand on reasoning alone.
- Give agents FULL context — they cannot see your conversation history.
- Invoke the right skill at the right stage — don't reinvent.
- Domain leads ONLY modify files within their scope — no exceptions.
- Codex is an advisor, not an authority — verify every suggestion against CLAUDE.md.
- /ship does NOT deploy — use /promote after merge for npm publish + site deploy.
