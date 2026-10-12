# Releasing

The six lockstep packages (`usertrust`, `usertrust-verify`, `usertrust-openclaw`,
`usertrust-server`, `usertrust-acs-adapter`, `usertrust-ui`) are released together, at one
version, by the **Release** workflow (`.github/workflows/publish.yml`). It is started by hand
(`workflow_dispatch`). Its shell logic lives in `scripts/release.sh`, and
`packages/core/tests/harden/release-workflow.test.ts` pins both.

`usertrust-monte-cristo` and the Claude Code plugin are not part of this release; see
`AGENTS.md`.

## Before the first release: owner setup

**Every release is refused until the environment `npm-publish` exists with at least one
required reviewer** (see "Owner setup" below). This is intended: without it, anyone who can
dispatch the workflow could publish with no approval. The refusal comes from the `ci-gate`
job and names the step to take.

## What a release does

Three jobs, so that dependency code never runs next to a credential that can push to the
repository or mint an OIDC token for provenance:

1. **ci-gate** (token: `contents: read`, `actions: read`).
   - The run must be on `master`, or, for a republish only, on a release tag.
   - CI (`ci.yml`) must have passed on the exact commit being released: its latest run for a
     push of that commit must have completed with every job `success`, including each job
     named in `REQUIRED_CI_JOBS`. A missing, pending, skipped, cancelled or failed job stops
     the release and is named in the error.
   - The `npm-publish` environment must require at least one reviewer. A missing environment,
     a permission error, or an answer that cannot be read is a refusal, never a pass. (Reading
     an environment's protection rules needs `actions: read`.)
2. **build** (token: `contents: read` only; no OIDC token, no secret).
   1. Installs (`npm ci`, with install scripts, exactly as CI does), typechecks and tests.
   2. Refuses to start if the committed version is not fully on npm (finish it with republish
      first), bumps all six packages by the chosen `version` (patch, minor or major), and
      refuses if the new version already has a tag or is already on npm.
   3. Builds, then **commits the bump and creates the tag `v<version>` locally**, and checks
      that nothing under `packages/` differs from that commit.
   4. Packs each package into a tarball (`npm pack --ignore-scripts`), bundles the release
      commit and tag (`git bundle`), and uploads both as the `release` artifact.
3. **publish**, in the `npm-publish` environment, so it waits for the approval (token:
   `contents: write`, `id-token: write`, `actions: read`; `NPM_TOKEN` in one step). It installs
   nothing and runs no dependency code: only git, gh, node, the npm that ships with node, and
   GitHub's own checkout, setup-node and download-artifact actions.
   1. Checks the CI gate again, since approval can come long after step 1.
   2. Downloads the artifact and checks the release commit, as git objects, without checking
      it out:
      - its version (validated as `major.minor.patch` before it is used) is tagged, and the tag
        points at it;
      - it has one parent, which is the commit this run was dispatched on;
      - it changes exactly the six `packages/<dir>/package.json` paths (literal strings), each a
        regular file (mode 100644) before and after;
      - each manifest is unchanged but for `version`, and none has `publishConfig`.
   3. For each tarball, streams `package/package.json` out as data and requires it to equal the
      release commit's manifest for that package, field by field. Then runs
      `npm publish <tarball> --access public --provenance --registry https://registry.npmjs.org/
      --dry-run` for each, from an empty directory, with a user config the script writes.
   4. **Pushes the release commit and tag** to `master`, atomically.
   5. Publishes each tarball with the same command, without `--dry-run`. Publishing a tarball
      runs no lifecycle script.
   6. Creates the GitHub Release `v<version>` with generated notes, deciding Latest
      explicitly: it is Latest only if no `v*` release tag is a higher semver (prereleases
      never take it), so finishing an older version never takes Latest from a newer one.

   Each step runs only if every step before it succeeded, so a normal release publishes
   nothing unless its push to `master` went through.

### Build output is untrusted data

The publish job treats everything the build job hands it (the git bundle, the commit in it,
the tarballs, the version it reports) as untrusted DATA, never as code or config:

- The working tree stays at the dispatched commit, so every script the job runs comes from
  that commit. The release commit is never checked out.
- A manifest is read from a git blob whose tree entry is checked to be a regular file (mode
  100644), or from a tarball member streamed to a file the script created. It is opened
  without following a symlink and without waiting on a FIFO, and it must be a regular file.
  It is parsed with `JSON.parse`, never `require()`d.
- Changed paths are compared as literal strings (`git diff-tree -z`, no pathname expansion,
  literal pathspecs), never as patterns.
- `npm publish` runs from an empty directory, with `--registry https://registry.npmjs.org/`, a
  user config holding only the `${NODE_AUTH_TOKEN}` reference (no config in a dry run), and an
  empty global config. No `.npmrc` from the artifact or the checkout applies, and the token
  is only in that step's environment. A `publishConfig` in any released manifest is refused.
  In npm 10.9.2, `--registry` on the command line already wins over `publishConfig.registry`,
  but npm's documentation does not say so, so the workflow does not rely on it.

### Credentials

- No checkout persists a credential (`persist-credentials: false`). The write token reaches
  git only in the push step, through the environment of that one `git push`
  (`GIT_CONFIG_*`), so it is never written to `.git/config` or any other file.
- In the publish job the same token is also used by the CI re-check and by `gh release
  create`, both of which run only `gh`.
- **What remains:** GitHub cannot scope `id-token: write` to one step, so every step of the
  publish job could mint an OIDC token; those steps are the tools above and nothing from the
  repository's dependencies. The tarballs themselves are built in the build job, from
  dependency code: a compromised build dependency could still alter what is published, as it
  could before. The split stops it reaching the push, the OIDC token and `NPM_TOKEN`; the
  release commit it hands on is checked to be a version bump and nothing else.

## Modes

| Mode | Runs | Pushes | Publishes | GitHub Release |
|---|---|---|---|---|
| normal | every step | release commit + tag, before publishing | all six | created, marked latest |
| `dry_run` | every step through the publish dry run, including the local commit and tag, the artifact and its checks | nothing | nothing (`npm publish --dry-run` only) | none |
| `republish` | ci-gate; build without bump, commit or tag; publish without the release-commit check or the push | nothing | each package not yet on npm | created only if missing |

`dry_run` and `republish` can be combined: a republish rehearsal that pushes and publishes
nothing.

Every mode, dry runs included, is refused until the environment is protected, and then waits
for its approval. Do a `dry_run` before the first release after any change to the workflow.

## Why the commit and tag are pushed before publishing

A version on npm cannot be published again, and unpublishing is restricted. So the state to
avoid is the registry holding a version the repository never recorded. Pushing first means:

- **The push fails** (master moved after dispatch, or a branch rule refuses it): nothing was
  published. Dispatch the release again.
- **The publish fails, entirely or part way**: the repository records `v<version>` and the
  registry lacks some or all of it. Recover with **republish**, dispatched on the tag (below).
  It builds the exact tagged tree, skips what is already on npm, publishes the rest, and
  creates the GitHub Release if it is missing. A normal release refuses to bump past a
  version that is not fully published, so a failed release cannot be abandoned by accident.
- **The GitHub Release fails** after a good publish: republish on the tag creates it (all
  six packages are skipped).

Publishing first would turn a failed push into a version on npm that no commit or tag
describes, and the next release would compute the same number again.

The provenance attestation records the commit the workflow was dispatched on (the parent of
the release commit, the one CI tested); the release commit differs from it only in the six
`version` fields.

## Republishing

Dispatch the Release workflow **on the tag** (`Use workflow from` → tag `v<version>`) with
`republish` checked. The ci-gate job checks that the tag's commit changes nothing but the
`version` field of the lockstep `package.json` files, and gates on its parent, the commit CI
ran on. (The release commit itself has no CI run: pushes made with the workflow's token do not
trigger workflows.) It also fetches `master` afresh and requires the tag's commit to be on it:
a version-only commit tagged on a side branch was never released and is refused, and so is a
shallow history or a `master` it cannot fetch. Dispatching on `master` also works while
`master` is still the release commit.

## The required CI checks

`REQUIRED_CI_JOBS` in `publish.yml` lists the `ci.yml` jobs, by the name each has on a push
to `master`. When you add, rename or remove a job in `ci.yml`, update that list in the same
pull request; the release-workflow test fails until they agree. A job the list does not name
must still pass.

## Owner setup (repository settings, done by hand)

The workflow names these; it cannot create or configure them.

- **Create the environment `npm-publish`** (Settings → Environments) with **at least one
  required reviewer**. Until then every release is refused by `ci-gate`. Consider turning on
  "Prevent self-review" (the gate warns when it is off).
  - **Move `NPM_TOKEN` into it as an environment secret** and delete the repository secret,
    so that only the approved publish job can read the token.
  - Restrict its deployment refs to `master` and tags matching `v*` (republish runs on a tag).
    Together with the environment secret, this keeps a workflow dispatched from any other
    branch, with an edited copy of this file, away from the token. The gate warns, but does
    not refuse, when no deployment-branch policy is set: it cannot see whether the token is an
    environment secret, and without that the policy protects nothing.
- **Branch protection on `master`**: requiring the CI checks on `master` would also apply to
  the workflow's own push of the release commit, which never gets a CI run, so that push
  would be refused (safely: before anything is published). Before requiring checks, give the
  release a way past them, for example a ruleset bypass for the actor that pushes the release
  commit, or change the release to land its bump through a pull request.
