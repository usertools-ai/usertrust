# Releasing

The six lockstep packages (`usertrust`, `usertrust-verify`, `usertrust-openclaw`,
`usertrust-server`, `usertrust-acs-adapter`, `usertrust-ui`) are released together, at one
version, by the **Release** workflow (`.github/workflows/publish.yml`). It is started by hand
(`workflow_dispatch`). Its shell logic lives in `scripts/release.sh`, and
`packages/core/tests/harden/release-workflow.test.ts` pins both.

`usertrust-monte-cristo` and the Claude Code plugin are not part of this release; see
`AGENTS.md`.

## What a release does

1. **ci-gate** (a job of its own, before any approval). The run must be on `master`, or, for a
   republish only, on a release tag. CI (`ci.yml`) must have passed on the exact commit being
   released: its latest run for a push of that commit must have completed with every job
   `success`, including each job named in `REQUIRED_CI_JOBS`. A missing, pending, skipped,
   cancelled or failed job stops the release and is named in the error.
2. **release**, in the `npm-publish` environment (so it waits for any approval the owner has
   configured):
   1. Checks the CI gate again, since approval can come long after step 1.
   2. Installs, typechecks and tests.
   3. Refuses to start if the committed version is not fully on npm (finish it with republish
      first), bumps all six packages by the chosen `version` (patch, minor or major), and
      refuses if the new version already has a tag or is already on npm.
   4. Builds, then **commits the bump and creates the tag `v<version>` locally**, and checks
      that nothing under `packages/` differs from that commit.
   5. Runs `npm publish --access public --provenance --dry-run` for each package: the publish
      command itself, uploading nothing.
   6. **Pushes the release commit and tag** to `master`, atomically.
   7. Publishes each package with `npm publish --access public --provenance`.
   8. Creates the GitHub Release `v<version>` with generated notes.

## Modes

| Mode | Runs | Pushes | Publishes | GitHub Release |
|---|---|---|---|---|
| normal | every step | release commit + tag, before publishing | all six | created, marked latest |
| `dry_run` | every step through the publish dry run, including the local commit and tag | nothing | nothing (`npm publish --dry-run` only) | none |
| `republish` | gate, install, typecheck, test, build, publish dry run, publish | nothing | each package not yet on npm | created only if missing |

`dry_run` and `republish` can be combined: a republish rehearsal that pushes and publishes
nothing.

Every mode, dry runs included, waits for the `npm-publish` environment's approval once the
owner has configured one. Do a `dry_run` before the first release after any change to the
workflow.

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
trigger workflows.) Dispatching on `master` also works while `master` is still the release
commit.

## The required CI checks

`REQUIRED_CI_JOBS` in `publish.yml` lists the `ci.yml` jobs, by the name each has on a push
to `master`. When you add, rename or remove a job in `ci.yml`, update that list in the same
pull request; the release-workflow test fails until they agree. A job the list does not name
must still pass.

## Owner setup (repository settings, done by hand)

The workflow names these; it cannot create or configure them.

- **Create the environment `npm-publish`** (Settings → Environments) with **required
  reviewer(s)**. Until it exists, the first run creates it with no protection, and a release
  needs no approval.
  - Optionally restrict its deployment refs to `master` and tags matching `v*` (republish runs
    on a tag).
  - Optionally **move `NPM_TOKEN` into it as an environment secret** and delete the
    repository secret, so that only the approved release job can read the token.
- **Branch protection on `master`**: requiring the CI checks on `master` would also apply to
  the workflow's own push of the release commit, which never gets a CI run, so that push
  would be refused (safely: before anything is published). Before requiring checks, give the
  release a way past them, for example a ruleset bypass for the actor that pushes the release
  commit, or change the release to land its bump through a pull request.
