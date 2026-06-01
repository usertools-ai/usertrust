Promote usertrust: trigger the GH Release workflow, deploy site, and report.

**Usage:** `/promote [patch|minor|major]` (default: patch)

This command is a thin wrapper. The authoritative release logic lives in
`.github/workflows/publish.yml` (lockstep bump + provenance publish + tag + GH release).

---

## 1. PRE-FLIGHT

Must run from the main repo, not a worktree:

```bash
cd /Users/camhome/usertrust
[ "$(git rev-parse --show-toplevel)" = "/Users/camhome/usertrust" ] || { echo "Not in main repo — abort"; exit 1; }
git pull origin master
git status --porcelain   # Must be empty — abort if dirty
```

## 2. DETERMINE VERSION

```bash
CURRENT=$(node -p 'require("./packages/core/package.json").version')
BUMP="${ARGUMENTS:-patch}"
echo "Current: v${CURRENT}, Bump: ${BUMP}"
```

## 3. LOCAL VALIDATION

Run full local checks before triggering the workflow. All three must pass — STOP on failure:

```bash
npx tsc -b --noEmit      # typecheck
npx biome check .        # lint
npx vitest run           # tests
```

The workflow repeats typecheck + tests server-side, but local-first fails faster and saves Actions minutes.

## 4. TRIGGER GH RELEASE WORKFLOW

Trigger the workflow, wait ~5s for the run to register, then capture its id:

```bash
gh workflow run Release -f version="$BUMP" -f dry_run=false
sleep 5
RUN_ID=$(gh run list --workflow=Release --limit 1 --json databaseId --jq '.[0].databaseId')
echo "Release run: ${RUN_ID}"
```

## 5. WATCH THE WORKFLOW

Stream progress to completion (~1-2 min). Abort on failure — do not partial-fix locally:

```bash
gh run watch "$RUN_ID" --exit-status || { echo "Release workflow failed — investigate before retrying"; exit 1; }
```

## 6. PULL MASTER

The workflow's `github-actions[bot]` commit includes the version bump + tag. Sync locally:

```bash
git pull origin master --tags
```

## 7. CAPTURE NEW VERSION

```bash
NEW_VERSION=$(node -p 'require("./packages/core/package.json").version')
echo "Released v${NEW_VERSION}"
```

## 8. DEPLOY SITE FROM REPO ROOT

The Vercel project's Root Directory setting is `site/`, so deploy runs from the repo root
(not from `site/` — that double-nests the path and deploy fails):

```bash
cd /Users/camhome/usertrust
pnpm exec vercel --prod --yes
```

Sanity check:

```bash
curl -sf https://usertrust.ai > /dev/null && echo "site live" || echo "site check failed"
```

## 9. REPORT

Collect PRs merged since the previous release, then print the summary:

```bash
PREV_TAG=$(gh release list --limit 2 --json tagName --jq '.[1].tagName // empty')
if [ -n "$PREV_TAG" ]; then
  SINCE=$(gh release view "$PREV_TAG" --json publishedAt --jq '.publishedAt')
  PRS=$(gh pr list --state merged --search "merged:>=$SINCE" --json number,title,author --jq '.[] | "- #\(.number) \(.title) (@\(.author.login))"')
else
  PRS=$(gh pr list --state merged --limit 10 --json number,title,author --jq '.[] | "- #\(.number) \(.title) (@\(.author.login))"')
fi
RELEASE_URL=$(gh release view "v${NEW_VERSION}" --json url --jq '.url')
```

Output:

```
## Release v${NEW_VERSION}

**npm (lockstep):**
- usertrust@${NEW_VERSION}
- usertrust-verify@${NEW_VERSION}
- usertrust-openclaw@${NEW_VERSION}

**Site:** https://usertrust.ai (deployed)
**GitHub Release:** ${RELEASE_URL}

### PRs in this release
${PRS}
```

## Notes

- **monte-cristo** is intentionally NOT in the `publish.yml` lockstep. It stays private at v0.1.0 until the foundation is more complete — separate decision, do not add it here.
- **2FA:** the GH workflow publishes via `secrets.NPM_TOKEN` (automation token, no OTP). A local `npm publish` would hit an OTP prompt on every publish — that is why local publish is off the table.
- **Source of truth:** `.github/workflows/publish.yml` owns version bump, build, publish, tag, and GH release creation. If that workflow changes, update this command to match.

## Rules

- Always `git pull origin master` before starting — work from latest.
- Never run from a worktree — must be on the main repo.
- All local checks must pass before triggering the workflow.
- Never bypass the workflow with local `npm publish` (bypasses provenance + lockstep bump).
- If the workflow fails, abort and investigate before retrying — do not partial-fix locally.
- Always deploy site from repo root (NOT from `site/`) — the Vercel Root Directory setting is already `site/`.
