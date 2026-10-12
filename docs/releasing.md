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
   3. Builds, then **commits the bump (`git commit -s`, so it carries a DCO sign-off) and
      creates the tag `v<version>` locally**, and checks that nothing under `packages/`
      differs from that commit.
   4. Packs each package into a tarball (`npm pack --ignore-scripts`), bundles the release
      commit and tag (`git bundle`), and uploads both as the `release` artifact. These
      tarballs are never published: the publish job reads them as data (below).
3. **publish**, in the `npm-publish` environment, so it waits for the approval (token:
   `contents: write`, `id-token: write`, `actions: read`; `NPM_TOKEN` in one step). It installs
   nothing and runs no dependency code: only git, gh, jq, python3, node, the npm that ships
   with node, and GitHub's own checkout, setup-node and download-artifact actions.
   1. Checks the CI gate again, since approval can come long after step 1.
   2. Downloads the artifact and checks the release commit, as git objects, without checking
      it out:
      - its version (validated as `major.minor.patch` before it is used) is tagged, and the tag
        points at it;
      - it has one parent, which is the commit this run was dispatched on;
      - its message is exactly `release: v<version>` and its committer's `Signed-off-by:`
        trailer, nothing more;
      - it changes exactly the six `packages/<dir>/package.json` paths (literal strings), each a
        regular file (mode 100644) before and after;
      - each manifest is unchanged but for `version`, and none has `publishConfig`.
   3. **Assembles the tarball npm will publish**, for each package, and verifies it (see "The
      publish tarball is assembled, not taken from the build" below). Then runs
      `npm publish <assembled tarball> --access public --provenance --ignore-scripts
      --registry https://registry.npmjs.org/ --dry-run` for each, from an empty directory,
      with a user config the script writes and a fresh npm cache.
   4. **Pushes the release commit and tag** to `master`, atomically.
   5. Assembles the six tarballs again (the same commit gives the same bytes) and publishes
      each with the same command, without `--dry-run`. Publishing a tarball runs no lifecycle
      script.
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
- A manifest, or any other root file, is read from a git blob whose tree entry is checked to
  be a regular file (mode 100644). A manifest is opened without following a symlink and
  without waiting on a FIFO, must be a regular file, and is parsed with `JSON.parse`, never
  `require()`d.
- Changed paths are compared as literal strings (`git diff-tree -z`, no pathname expansion,
  literal pathspecs), never as patterns.
- `npm publish` runs from an empty directory, with `--registry https://registry.npmjs.org/`,
  `--ignore-scripts`, a user config holding only the `${NODE_AUTH_TOKEN}` reference (no config
  in a dry run), an empty global config, and `npm_config_cache` set to a new private
  directory of its own. No `.npmrc` from the artifact or the checkout applies, and the token
  is only in that step's environment. A `publishConfig` in any released manifest is refused.
  In npm 10.9.2, `--registry` on the command line already wins over `publishConfig.registry`,
  but npm's documentation does not say so, so the workflow does not rely on it.
- **No job restores a cache.** Every `actions/setup-node` says `package-manager-cache: false`
  and none says `cache:`, so no npm cache written by another workflow's dependency code
  reaches the release.

### The publish tarball is assembled, not taken from the build

The build job runs dependency code, so the tarballs it packs are untrusted. Checking such a
tarball and then publishing it leaves gaps, because npm reads an archive differently from the
code that checked it (a later duplicate `package/package.json` wins; a PAX `comment` record
carrying newline-separated records is one comment to Python and several records to npm's tar
reader). Repacking with npm leaves others, because npm's packer, walking a directory the build
shaped, honors nested `.npmignore` files and reads `\` as `/`. So the publish job **never
publishes an archive the build made and never lets npm walk a directory the build shaped.**
`scripts/release-tarball.py` writes the tarball npm publishes:

1. **The build tarball is read as data, in a limited child process.** The child cannot write a
   byte to any file (its file-size limit is zero) and has a CPU limit and a wall-clock limit;
   on Linux (the runner) it also has an address-space limit. It reads at most the compressed
   cap, decompresses incrementally up to the decompressed cap, and requires exactly one
   complete gzip member with nothing after it. It parses the tar headers itself: every physical
   header counts, including PAX `x` headers; an extended header's body is checked against its
   cap before it is parsed, its records are parsed by their length prefixes, and only `path`
   and a `size` equal to the header's are used (`comment`, `mtime`, `atime`, `ctime`, `uid`,
   `gid`, `uname` and `gname` are ignored; every other key, including `linkpath` and any
   `GNU.sparse.*`, refuses). A global header (`g`), a GNU long name (`L`/`K`), a GNU sparse
   file (`S`), a link, a device, a FIFO and every other type refuse; only regular files and
   directories pass. Any failure, of a rule or of the process, refuses the whole release before
   anything is published.
2. **Each member is classified.**
   - Root members (`package/package.json`, `README.md`, `LICENSE`, `NOTICE`, and any root
     file the release commit's manifest lists in `files`) must be regular files, within the
     caps, and not repeated; **their contents are discarded**. Any other root member refuses.
   - Every other member must be under `package/dist/`, and its whole name must match
     `package/dist/[A-Za-z0-9._@-]+(/[A-Za-z0-9._@-]+)*`. No component may begin or end with a
     dot (so no `.npmignore`, `.gitignore` or `.npmrc` at any depth, and no `..`), and none
     may be `package.json`, `node_modules`, `npm-shrinkwrap.json` or `binding.gyp`, in any
     case. No name may repeat (compared without case), and no file may also be a directory
     or sit inside a file.
3. **The output is written from scratch.** Its root files come from the release commit's git
   blobs (`package.json` among them, version-checked); its other files are the accepted
   `dist/` members' bytes. Every header is new: the name, the size, mode 0644, owner 0 with
   empty user and group names, the release commit's time, type "regular file". Members are
   sorted. The format is USTAR when every name fits its fields (true of every name the six
   packages ship today): a USTAR header has no extended records for a reader to interpret. A
   name that does not fit gets PAX, whose only record is that `path`. Nothing of an input
   header, extended record or link field is copied. The gzip wrapper is fixed (no file name,
   mtime 0), so one commit and one build tarball always give the same bytes.
4. **The output is verified.** It is read back from disk and parsed by the same strict
   parser: its complete path set, order, every byte, and every header field must be what was
   meant, and the only extended record allowed is `path`. Then the system's `tar` extracts it
   into a temporary directory, which must succeed without any output, and must produce
   exactly the expected files with the expected bytes.

**The caps:** 16 MiB compressed; 64 MiB decompressed; 4,096 physical tar headers; 8 MiB per
file; 48 MiB in all; 200 bytes per member name, 100 per component, 16 levels below
`package/`; 1,024 bytes per extended-header body. The parser process: 120 s wall clock,
60 s CPU, a file-size limit of zero, and 512 MiB of address space on Linux. The largest
package today packs to about 330 files and 2.7 MB, with a longest name of 69 bytes, 4 levels
deep.

**What npm sees.** npm is given the assembled file's path and nothing else. To publish it,
npm extracts and inspects **only that sanitized archive**, in the fresh private cache: it reads
`package/package.json` and normalizes the metadata it sends to the registry (so the registry's
metadata is npm's normalization of the commit's manifest, while the tarball the registry
stores is byte for byte the assembled file). It never sees the build tarball, the artifact
directory or the checkout's package directories, and a tarball spec runs no lifecycle script.

**What remains.** The `dist/` bytes are built by dependency code, which is inherent to building
from source; provenance attests the workflow that built them. Within the name rule and the
caps, the build also still chooses **which** `dist/` paths exist: nothing independent of the
build fixes that file set. It cannot change the manifest, the root files, any configuration,
the registry, install scripts, or anything outside `dist/`, and it cannot reach the push, the
OIDC token or `NPM_TOKEN`.

### Credentials

- No checkout persists a credential (`persist-credentials: false`). The write token reaches
  git only in the push step, through the environment of that one `git push`
  (`GIT_CONFIG_*`), so it is never written to `.git/config` or any other file.
- In the publish job the same token is also used by the CI re-check and by `gh release
  create`, both of which run only `gh`.
- **What remains:** GitHub cannot scope `id-token: write` to one step, so every step of the
  publish job could mint an OIDC token; those steps are the tools above and nothing from the
  repository's dependencies. A compromised build dependency can still change the `dist/`
  bytes, and which permitted `dist/` paths exist (see above). The split stops it reaching the
  push, the OIDC token and `NPM_TOKEN`; the release commit it hands on is checked to be a
  version bump and nothing else, and the tarball it packs is used only as a source of
  `dist/` bytes.

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
