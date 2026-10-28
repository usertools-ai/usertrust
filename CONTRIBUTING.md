# Contributing to usertrust

We welcome contributions to usertrust! By participating, you agree to abide by these guidelines.

## Developer Certificate of Origin (DCO)

All contributions must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO v1.1). By signing off, you certify that you wrote the contribution or otherwise have the right to submit it under the Apache 2.0 license.

Add `Signed-off-by` to every commit:

```
git commit -s -m "feat: add new feature"
```

Or manually append to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use `git commit --amend -s` to add a sign-off to an existing commit.

## License

All contributions are made under the [Apache License 2.0](./LICENSE). By submitting a pull request, you represent that you have the right to license your contribution under Apache 2.0 and that the contribution does not violate any third-party intellectual property rights.

## How to contribute

1. Fork the repository
2. Create a feature branch from `master`
3. Make your changes with signed-off commits
4. Ensure tests pass: `npm test`
5. Ensure lint passes: `npm run lint`
6. Open a pull request against `master`

Don't add a wall-clock threshold to a test without its headroom. A real sleep, an elapsed-time
check or deadline, or a test's own timeout passes where it was written and fails on a slower or
busier runner. `npm run timing-thresholds` finds them in every test file. A new one fails CI
unless the whole file fakes what it uses, or a `// timing:` comment on its line or directly above
it states the bound and the headroom measured on CI, for example
`// timing: 30 s budget; slowest of 20 CI runs took 9 s`. The ones already there are counted in
`timing-thresholds.baseline.json`, which only shrinks: when you remove one, run
`npm run timing-thresholds -- --update`.

Fake timers accept a sleep or a `Date.now()` check only when `vi.useFakeTimers` is called at the
top level of the file, or in a top-level `beforeEach` or `beforeAll`, and its `toFake` (if any) lists
the API: `setTimeout` or `setInterval` for a sleep, `Date` for `Date.now()`. A fake inside one
test or `describe` accepts nothing, because the check does not follow which tests it covers. For the
same reason, a file that calls `vi.useRealTimers` anywhere but a top-level `afterEach` or `afterAll`
gets nothing from its fakes, and neither does one that calls it in a top-level `afterEach` while a fake
is set up once (at the top level or in a `beforeAll`): after the first test, the rest run on real
timers.

Don't commit agent config. A pull request that adds, edits or removes Claude Code's `.claude/`,
an `.mcp.json`, or `.grok/` or `.codex/`, at any depth, fails the `agent-config` check: it would
run on the machine of anyone who opens the checkout in a coding agent. The same check holds the
name of every file you add to letters, digits, `.`, `_`, `-`, `[` and `]`, and refuses one that
differs from another file or directory only in case: a case-insensitive filesystem opens both as
one.

## Releasing

Maintainers release the npm packages with the Release workflow; see
[docs/releasing.md](./docs/releasing.md).

## Code of conduct

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md). By participating, you agree to uphold these standards.
