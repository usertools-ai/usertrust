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

## Choosing the version

The version is decided by what the release changes, never by the person dispatching it. Every
entry in the CHANGELOG sits under a heading that names its class, and the release's bump is the
highest class among its entries:

| Bump | When | CHANGELOG headings |
|---|---|---|
| **major** | an export removed or renamed, a default changed, or an output's shape changed. At most one a quarter (below) | `### Removed`, `### Breaking` |
| **minor** | a new detection, option or export, or another change a caller can see that breaks nothing | `### Added`, `### Changed`, `### Deprecated` |
| **patch** | a fix to a bug, a crash or a false positive, with no change to the public API or a default | `### Fixed`, `### Security`, `### Dependencies` |

Two more headings are notes, which carry no class: `### Read before upgrading` (what an
existing caller may notice, and what to do about it) and `### Known issues`. Any other `###`
heading is refused, so an entry cannot sit outside the policy.

**The check.** For a new release, ci-gate runs `scripts/release.sh assert-bump <version input>`
on the dispatched commit. It reads `CHANGELOG.md` from that commit (the git blob, not a working
tree) and refuses the release, before anything is built, when:

- `[Unreleased]` still holds an entry (cut them first: "Cutting the CHANGELOG", below);
- the section under `[Unreleased]` is not `## [X.Y.Z] - YYYY-MM-DD`, or `X.Y.Z` is not the
  version this dispatch makes (the committed version bumped by the `version` input);
- that section has no entry under a class heading, an entry under no heading, or a heading
  that is neither a class nor a note;
- the `version` input is not exactly the highest class among its entries. Both directions are
  refused: a patch release of a section with an `Added` entry, and a major release of a section
  with nothing under `Removed` or `Breaking`.

**At most one major a quarter.** A major is refused while the last one is less than 90 days
old: the highest `v<N>.0.0` tag on `master`, aged by its tag date (a tag whose commit is not on
`master` was never released and does not count). To release one anyway, give the reason in the
`allow_early_major` input. It is written into the release tag and leads the GitHub Release's
notes, so a republish, which refuses the input, still has it. The input is refused on any
release that does not need it (a patch, a minor, or a major more than 90 days after the last
one) and on a republish, so a reason is never given and then silently unused.

A republish skips the check: it publishes a version already tagged, whose bump was checked when
it was released.

## Cutting the CHANGELOG

Entries collect under `## [Unreleased]`, each under its class heading, as pull requests merge.
Before dispatching a release, a pull request cuts them:

1. Work out the bump from the highest class under `[Unreleased]` (see "Choosing the version"),
   and from it the new version: the committed version bumped by that much.
2. Rename the `[Unreleased]` heading to `## [X.Y.Z] - YYYY-MM-DD` with that version and the
   day's date, and add a new, empty `## [Unreleased]` above it.
3. Merge that pull request, and dispatch the release on `master`, at that commit, once CI has
   passed on it, with the bump from step 1.

The release commit then changes only the six `package.json` files, as it always has: the
CHANGELOG already says what the release holds, at the commit CI tested. A pull request that
merges between the cut and the dispatch adds its entries under the new `[Unreleased]`, for the
next release.

## What a release does

Three jobs, so that dependency code never runs next to a credential that can push to the
repository or mint an OIDC token for provenance:

1. **ci-gate** (token: `contents: read`, `actions: read`).
   - The run must be on `master`, or, for a republish only, on a release tag.
   - For a new release, the `version` input must be exactly the bump the CHANGELOG's release
     section requires, and a major released less than 90 days after the previous one needs a
     reason in `allow_early_major` (see "Choosing the version"). A republish skips this check
     and refuses `allow_early_major`.
   - CI (`ci.yml`) must have passed on the exact commit being released: its latest run for a
     push of that commit must have completed with every job `success`, including each job
     named in `REQUIRED_CI_JOBS`. A missing, pending, skipped, cancelled or failed job stops
     the release and is named in the error.
   - The `npm-publish` environment must require at least one reviewer. A missing environment,
     a permission error, or an answer that cannot be read is a refusal, never a pass. (Reading
     an environment's protection rules needs `actions: read`.) If the environment lets the
     person who dispatched the release approve it, the gate warns (see "Self-approval").
2. **build** (token: `contents: read` only; no OIDC token, no secret). It runs as **two legs
   of one matrix**, `release` and `rebuild`, each on its own fresh runner. Both run the steps
   below, from one job definition so the two cannot drift apart, and each uploads its output
   under its own name. The publish job publishes from `release` and uses `rebuild` only to
   check it (see "The rebuild check").
   1. Installs (`npm ci`, with install scripts, exactly as CI does), typechecks and tests.
   2. Refuses to start if the committed version is not fully on npm (finish it with republish
      first), bumps all six packages by the chosen `version` (patch, minor or major), pins
      every lockstep sibling they depend on to the new version (see "Sibling dependencies are
      pinned" below), and refuses if the new version already has a tag or is already on npm.
   3. Builds, then **commits the bump (`git commit -s`, so it carries a DCO sign-off) and
      creates the tag `v<version>` locally**, and checks that nothing under `packages/`
      differs from that commit.
   4. Packs each package into a tarball (`npm pack --ignore-scripts`), bundles the release
      commit and tag (`git bundle`), and uploads both as an artifact named after the leg. These
      tarballs are never published: the publish job reads them as data (below).
3. **publish**, in the `npm-publish` environment, so it waits for the approval (token:
   `contents: write`, `id-token: write`, `actions: read`; `NPM_TOKEN` in one step). It installs
   nothing and runs no dependency code: only git, gh, jq, python3, node, the npm that ships
   with node, and GitHub's own checkout, setup-node and download-artifact actions. **It builds
   nothing**: every byte it publishes was built by the build job, on Node 22 (the runtime CI
   tests on); this job only assembles tarballs from those bytes (python3) and runs npm. It
   runs Node 24, for the npm Node 24 bundles, and its first step after setup-node prints
   node's and npm's versions and refuses an npm older than 11.5.1 or a Node older than
   22.14.0, before anything reads or writes the registry. Those are the versions npm trusted
   publishing needs (see "npm authentication and provenance"); below them npm would publish
   with `NPM_TOKEN` alone, without saying so. npm 11 is also needed for the reason in step 3.
   The publish job pins **Node 24.21.0** exactly, which bundles npm 11.19.0 (per
   nodejs.org/dist/index.json): the version at which the npm sources this page cites
   (`lib/commands/publish.js`, `lib/utils/oidc.js`) were read, so a release never changes
   behaviour silently. Bumping that pin is a deliberate act: re-read npm's `publish.js` and
   `oidc.js` at the npm version the new Node bundles, and update these citations in the same
   pull request (the release-workflow test requires the pin and this line to name the same
   version).
   1. Checks the CI gate again, since approval can come long after step 1.
   2. Downloads both legs' artifacts, and works out the expected version itself: the
      dispatched commit's committed version, bumped by the `version` input
      (`release.sh expected-version`). Nothing the build job reports is used as the version.
      Then it checks the `release` leg's release commit, as git objects, without checking it
      out:
      - its version is exactly the expected version, and is tagged, and the tag points at it;
      - it has one parent, which is the commit this run was dispatched on;
      - its message is exactly `release: v<version>` and its committer's `Signed-off-by:`
        trailer, nothing more;
      - it changes exactly the six `packages/<dir>/package.json` paths (literal strings), each a
        regular file (mode 100644) before and after;
      - each manifest names every lockstep sibling at exactly the new version, is otherwise
        unchanged but for `version` (no dependency added, dropped or changed, no field added,
        dropped or changed), and none has `publishConfig`.

      Then **the rebuild check**, in every mode: for each package it assembles the publish
      tarball (step 3) twice, once with the `release` leg's `dist/` bytes and once with the
      `rebuild` leg's, and refuses unless the two are byte-identical (sha256;
      `release.sh compare-builds`). Both legs' tarballs are read as data.
   3. **Assembles the tarball npm will publish**, for each package, and verifies it (see "The
      publish tarball is assembled, not taken from the build" below). Then runs
      `npm publish <assembled tarball> --access public [--tag backfill] --provenance
      --ignore-scripts --registry https://registry.npmjs.org/ --dry-run` for each, from an
      empty directory, with a user config the script writes and a fresh npm cache.
      **The dist-tag is decided once for all six**, before any is published, by the same
      check that decides the GitHub Release's Latest (step 6): `latest` only for the newest
      release, `backfill` for an older version finished by republish, so npm's `latest` never
      moves back to it. The check: no `v*` tag on master is a higher semver (tags and master
      fetched first; a tag whose commit is not on master, such as one pushed for an abandoned
      branch, is not a release and does not count; if master cannot be fetched, or the history
      is shallow, the release is refused, never compared against every tag), and
      no package has a higher version on npm (`npm view <name> versions --json --tag latest`,
      the highest non-prerelease version, which is npm's own rule; a version published
      without a `v*` tag, or under another dist-tag, still counts; a package already at this
      version is not counted as higher). Only the registry's own 404 for the package
      (`Not Found - GET https://registry.npmjs.org/<name>`) reads as "never published, holds
      nothing". Any other E404 refuses: npm resolves a bare name against its `tag` config
      (`lib/commands/view.js`), so a tag the package lacks answers E404 `No match found for
      version <tag>` though the package exists, and an unpublished package (`Unpublished on
      <time>`) no longer shows which versions it held. For the same reason
      `scripts/release.sh` drops any `npm_config_tag` from its environment (npm reads the
      name in any case) before running npm at all, and `npm view` is given `--tag latest`. A
      registry it cannot read, or an answer it cannot parse, refuses the release: it never
      defaults to `latest`.
      **Then it checks all six against npm, before publishing any.** A new release refuses
      if any `<name>@<version>` is already there: the build job checked none was, but the
      approval can come hours later, and a version published in between is not this
      release's. This is the dry-run step, before the push: nothing is pushed, published or
      released, and the error names each package. A republish skips a package already there
      only if npm holds exactly the tarball this run assembled (its `dist.integrity` is the
      sha512, and its `dist.shasum` the sha1, of our tarball; read with `npm view
      <name>@<version> dist --json`); a different, missing or unreadable digest refuses
      before anything is published. npm uploads a tarball's bytes unchanged (npm/cli v11.19.0:
      `workspaces/libnpmpack/lib/index.js` reads the file through pacote, and
      `workspaces/libnpmpublish/lib/publish.js` computes both digests from those bytes and
      uploads them), and the same commit assembles the same bytes, so a package an earlier run
      of this workflow published matches.
      `latest` is applied as npm's default, with **no `--tag`**, so that npm's own refusal to
      apply `latest` implicitly to a version not higher than one it holds stays active as a
      backstop (an explicit `--tag latest` would bypass it); `backfill` is passed as
      `--tag backfill`. npm added that refusal in 11.0.0 (`lib/commands/publish.js`; absent at
      v10.9.2), which is why the publish job runs Node 24 and refuses an older npm. npm's
      check runs per package, and treats a registry it cannot read as holding nothing, so
      alone it could stop a release part-way; the check above runs for all six first.
      Versions are major.minor.patch only: this workflow does not support prereleases (one
      would publish under `backfill`).
   4. **Pushes the release commit and tag** to `master`, atomically, and only while `master`
      is still the dispatched commit (see "Why the commit and tag are pushed before
      publishing"). The tag is annotated in this job, on the verified commit, with the version
      and an early major's reason.
   5. Assembles the six tarballs again (the same commit gives the same bytes) and publishes
      each with the same command, without `--dry-run`. Publishing a tarball runs no lifecycle
      script.
   6. Creates the GitHub Release `v<version>` with generated notes, deciding Latest
      explicitly: it is Latest only if no `v*` release tag on master is a higher semver and no package
      has a higher version on npm (prereleases never take it), so finishing an older version
      never takes Latest from a newer one. It runs only after every package's publish
      succeeded. For a major released early, the `allow_early_major` reason leads the notes,
      above the generated ones; it is read from the release tag, which step 4 annotated with it.
      This is the same answer that chose the npm dist-tag in steps 3 and 5.

   Each step runs only if every step before it succeeded, so a normal release publishes
   nothing unless its push to `master` went through.

### Sibling dependencies are pinned

Four of the six packages depend on others in the set: `usertrust-openclaw`, `usertrust-server`
and `usertrust-acs-adapter` on `usertrust`, and `usertrust-ui` on `usertrust` and
`usertrust-verify`. Each names those siblings at **exactly its own version**, so that installing
`usertrust-server@X` installs `usertrust@X` and no other. A range such as `"*"` lets an install
keep a sibling from an earlier release: npm keeps an installed package that satisfies the
range, so a package upgraded in place (an `npx usertrust-server` folder made while an older
version was latest, for one) can run against an older `usertrust` that lacks an export it
imports, and fail to start.

- **The bump sets them.** The build job runs `npm version <bump> --no-git-tag-version
  --no-workspaces-update` in each package, which sets that package's own `version` and nothing
  else, then `scripts/release.sh pin-siblings`, which sets every lockstep package a manifest
  names in `dependencies`, `optionalDependencies`, `peerDependencies` or `devDependencies` to
  the new version. No sibling is a peer today; one added as a peer is pinned exactly too, by
  design, since the six only work together at one version. `--no-workspaces-update` stops npm
  reinstalling after each bump: run inside
  a workspace, `npm version` reinstalls the tree, and once `usertrust` is bumped, a sibling's
  pin to the previous version no longer matches the workspace's own package, so npm would
  install that previous version from the registry into the tree the build job builds.
- **The checks require them.** The release-commit check accepts exactly those changes, each
  to exactly the new version, and refuses a sibling at any other spec (`"*"`, a range, another
  version). The publish step refuses a manifest whose siblings are not at the version it
  publishes.
- **`master` carries them.** The release commit lands on `master`, so between releases every
  sibling is pinned at the version `master` records, which is the workspace's own package, and
  `npm ci` links it. A release commit changes only the six manifests, so after a release
  `package-lock.json` records the previous release's pins until it is next regenerated, as it
  already lags the workspace versions; `npm ci` accepts both, since the workspace packages
  satisfy the pins. A pin to any version but the workspace's own does not match the workspace
  package, so npm would install that version from the registry instead; the release-workflow
  test checks the repository's manifests for this.
- **Why not a native rewrite.** `pnpm publish` rewrites pnpm's `workspace:` protocol to an exact
  version, but this repository uses npm workspaces: npm has no workspace protocol (npm 10.9.2
  refuses `workspace:*` with `EUNSUPPORTEDPROTOCOL`, and `npm pack` keeps every spec as
  written), and `npm version` never rewrites a spec that names the package it bumps. The
  published `package.json` is also the release commit's git blob, not one a packer writes, so
  the pin has to be in the commit.

### Build output is untrusted data

The publish job treats everything the build job hands it (the git bundle, the commit in it,
both legs' tarballs) as untrusted DATA, never as code or config. It takes no version from the
build job: it computes the version it expects and checks the release commit against it.

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
  In npm 10.9.2 and 11.19.0, `--registry` on the command line already wins over
  `publishConfig.registry` (`lib/commands/publish.js`, which drops from `publishConfig` every
  key given as a command-line flag), but npm's documentation does not say so, so the workflow
  does not rely on it.
- **No job restores a cache.** Every `actions/setup-node` says `package-manager-cache: false`
  and none says `cache:`, so no npm cache written by another workflow's dependency code
  reaches the release.

### npm authentication and provenance

The publish step authenticates with `NPM_TOKEN`, as `NODE_AUTH_TOKEN`, through the user config
`scripts/release.sh` writes, and passes `--provenance`, which signs with the job's GitHub OIDC
token (`id-token: write`, granted to the publish job only).

The npm the publish job runs (11.19.0, bundled with the pinned Node 24.21.0) also tries **npm trusted publishing**
on every publish, by itself. As read in npm/cli at v11.19.0 (the npm bundled with Node
v24.21.0):

- `lib/commands/publish.js:147` calls `oidc()` from `lib/utils/oidc.js` on every publish, the
  dry run included. `lib/utils/oidc.js` is absent at v11.4.2 and present from v11.5.0.
- No setting disables it. It runs whenever the CI environment offers an OIDC token: in GitHub
  Actions, when `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are set
  (`id-token: write`), or when `NPM_ID_TOKEN` is set. `--provenance` needs the same
  `ACTIONS_ID_TOKEN_REQUEST_URL` (`ensureProvenanceGeneration` in
  `workspaces/libnpmpublish/lib/publish.js`), so the exchange cannot be turned off without
  turning off provenance.
- It asks npm to exchange the OIDC token for a publish token for that package. If trusted
  publishing is configured for the package, npm publishes with the exchanged token instead of
  `NPM_TOKEN`. If it is not, the exchange fails, npm logs it at verbose level only, and
  publishes with `NPM_TOKEN` as before. It never fails the publish itself.

So the OIDC token is a credential that can publish once trusted publishing is configured,
which is one more reason `id-token: write` is granted to the publish job and no other (the
release-workflow test pins this). Configuring it is an owner step (below).

What trusted publishing needs, per npm's documentation
(<https://docs.npmjs.com/trusted-publishers>), and how this workflow meets it:

- **npm 11.5.1 or later and Node 22.14.0 or later.** The publish job refuses anything older
  (see step 3 of "What a release does"), so a release never falls back to `NPM_TOKEN` because
  of an old npm.
- **A GitHub-hosted runner.** Every job runs on `ubuntu-latest`.
- **The workflow file name, exactly.** npm checks the name of the workflow that requested the
  OIDC token, `publish.yml`, against the one configured (case-sensitive, with the extension).
  The release is dispatched on this workflow itself, never through another workflow.
- **`repository.url` matching the repository.** All six manifests say
  `git+https://github.com/usertools-ai/usertrust.git`.
- **`id-token: write`**, which only the publish job has. The token is GitHub's OIDC token
  (<https://docs.github.com/en/actions/reference/security/oidc>).

When a package publishes through trusted publishing from a public repository, npm generates its
provenance itself; `--provenance` stays on the command for a publish that falls back to the
token.

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
   blobs (`package.json` among them, checked for its version and for every sibling at that
   version); its other files are the accepted
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
caps, the build also still chooses **which** `dist/` paths exist. The rebuild check (step 2 of
the publish job) requires a second, independent runner to build the same bytes and the same
file set, so a build that goes wrong on one runner is refused; it cannot catch a change that
both builds make alike (see "Approving the `npm-publish` deployment"). It cannot change the manifest, the root files, any configuration,
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
  bytes, and which permitted `dist/` paths exist, as long as it changes them the same way on
  both build runners (see above). The split stops it reaching the
  push, the OIDC token and `NPM_TOKEN`; the release commit it hands on is checked to be a
  version bump (the versions and the sibling pins) and nothing else, and the tarball it packs
  is used only as a source of
  `dist/` bytes.

## Approving the `npm-publish` deployment

Two things the publish job uses come from the build job, which runs dependency code: the
`dist/` bytes and the release commit. The workflow checks both itself, so the approval no longer
needs a manual rebuild:

- **The version.** The publish job computes the version it expects, from the dispatched commit
  and the `version` input, and refuses a release commit at any other version. ci-gate has
  already required that input to be the bump the CHANGELOG requires ("Choosing the version").
- **The `dist/` bytes.** The rebuild check requires a second build, on a second fresh runner,
  to give byte-identical publish tarballs.

The publish job waits for the approval before any of its steps, so nothing has been pushed or
published yet. Before approving, read the run's page: ci-gate passed, and its "Require the bump
the CHANGELOG requires" step names the version and the class that requires it; both build legs
passed, and each one's summary says `Release v<version>`, the same version. Approve only a run
you dispatched or expected.

**What the checks do not catch.** Both legs install the same lockfile and build the same
commit, so a compromised dependency at a locked version builds the same bytes on both and passes
the rebuild check. The rebuild check catches a build that differs between runners (a runner
that was tampered with, a build that is not reproducible); it does not vet the dependencies.
Those are vetted where they change: in the pull requests that change `package-lock.json`.

### Self-approval

The environment's "Prevent self-review" setting stops the person who dispatched a run from
approving it. While the project has a single maintainer who can approve, it is off, and that is
accepted: the approval is then a second, deliberate step by the same person, not a second
person's review. ci-gate warns on every release while it is off. Turn it on once a second
reviewer is added.

## Modes

| Mode | Runs | Pushes | Publishes | GitHub Release |
|---|---|---|---|---|
| normal | every step | release commit + tag, before publishing | all six, under the dist-tag `latest`; refused, before the push, if any is already on npm | created, marked latest |
| `dry_run` | every step through the publish dry run, including the local commit and tag, the artifact and its checks | nothing | nothing (`npm publish --dry-run` only) | none |
| `republish` | ci-gate; build without bump, commit or tag; publish without the release-commit check or the push | nothing | each package not yet on npm (one already there is skipped only if npm holds this run's exact tarball, else refused), under `latest` if it is the newest release, else `backfill` | created only if missing (Latest only if it is the newest release) |

`dry_run` and `republish` can be combined: a republish rehearsal that pushes and publishes
nothing.

`allow_early_major` is not a mode: it is the reason for a major released less than 90 days
after the previous one, and is refused on any other release and on a republish (see "Choosing
the version").

Every mode, dry runs included, is refused until the environment is protected, and then waits
for its approval. Do a `dry_run` before the first release after any change to the workflow.

## Why the commit and tag are pushed before publishing

A version on npm cannot be published again, and unpublishing is restricted. So the state to
avoid is the registry holding a version the repository never recorded. Pushing first means:

- **The push fails** (master moved after dispatch, in either direction, or a branch rule
  refuses it): nothing was published. Dispatch the release again. The push carries
  `--force-with-lease=refs/heads/master:<dispatched commit>`, so it goes through only while
  master is still the commit the run was dispatched on: a master reset backwards during the
  approval wait (to retract a commit) refuses it too, where a plain push would have been a
  fast-forward again and restored what was retracted. The release commit's parent is the
  dispatched commit, so the push never overwrites anything.
- **The publish fails, entirely or part way**: the repository records `v<version>` and the
  registry lacks some or all of it. Recover with **republish**, dispatched on the tag (below).
  It builds the exact tagged tree, skips what npm already holds byte-for-byte, publishes the rest, and
  creates the GitHub Release if it is missing. A normal release refuses to bump past a
  version that is not fully published, so a failed release cannot be abandoned by accident.
- **The GitHub Release fails** after a good publish: republish on the tag creates it (all
  six packages are skipped).

Publishing first would turn a failed push into a version on npm that no commit or tag
describes, and the next release would compute the same number again.

The provenance attestation records the commit the workflow was dispatched on (the parent of
the release commit, the one CI tested); the release commit differs from it only in the six
`version` fields and the sibling pins.

## Republishing

Dispatch the Release workflow **on the tag** (`Use workflow from` → tag `v<version>`) with
`republish` checked. The ci-gate job checks that the tag's commit is a release commit (it
changes nothing but the `version` fields and the sibling pins of the lockstep `package.json`
files), and gates on its parent, the commit CI ran on. (The release commit itself has no CI
run: pushes made with the workflow's token do not trigger workflows.) It also fetches `master`
afresh and requires the tag's commit to be on it: a release commit tagged on a side branch was
never released and is refused, and so is a shallow history or a `master` it cannot fetch. A tag
made before siblings were pinned (v5.0.1 and earlier) names them as `"*"`, so republish
refuses it. None needs one, as npm holds those versions in full; republishing one would take a
deliberate change to the release-commit check. Dispatching on `master` also works while
`master` is still the release commit. A republish of a version older than the newest `v*`
release publishes under the dist-tag `backfill`, not `latest`, so npm users who install
without a version keep getting the newest release.

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
- **npm trusted publishing (on npmjs.com).** This is the package owner's act on npmjs.com, in
  each package's settings (Settings, Trusted Publisher), not a change to this repository.
  For each of the six packages, add a GitHub Actions trusted publisher:
  - organization `usertools-ai`, repository `usertrust`, workflow filename `publish.yml` (the
    file name only, with its extension), environment name `npm-publish`;
  - under allowed actions, **allow `npm publish`**. A configuration created after
    2026-09-03 allows only `npm stage publish` until this is chosen, and this workflow runs
    `npm publish`.

  npm does not check a configuration when it is saved, and **a new configuration expires
  unless its first successful publish happens within 2 days**; an expired one cannot be used
  or edited, only deleted and made again. So add it shortly before a release is dispatched.
  After the first release that publishes through OIDC, set each package's publishing access to "Require two-factor
  authentication and disallow tokens", which npm recommends once trusted publishing works, and
  delete the `NPM_TOKEN` secret. Source: <https://docs.npmjs.com/trusted-publishers>.
- **Branch protection on `master`**: requiring the CI checks on `master` would also apply to
  the workflow's own push of the release commit, which never gets a CI run, so that push
  would be refused (safely: before anything is published). Before requiring checks, give the
  release a way past them, for example a ruleset bypass for the actor that pushes the release
  commit, or change the release to land its bump through a pull request.
