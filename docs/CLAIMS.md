# Integrity claims register

Every sentence the documentation states about the audit chain's integrity (what verification catches, what it does not, what is recorded and what can go missing) is listed in [`claims.json`](claims.json), with the test that proves it. `packages/core/tests/harden/claims-register.test.ts` fails when the documentation and the register disagree.

The register exists because sentences about the chain kept saying more than verification does, and each was found by a reader after it shipped. Some examples: a reordered event "breaks verification", although the verifiers read events in `sequence` order. A shorter but internally consistent chain "no longer passes", although it does once `.meta` is rewritten. The trail is "immutable", although it is tamper-evident. Nothing failed when those sentences stopped being true, or when they never were.

## What the test checks

- **(a) Every integrity sentence is registered.** The test scans the documentation in `scope.scan` for the words in `vocabulary` (case-insensitive regular expressions: tamper, immutable, append-only, truncate, detected, VERIFIED, proves, every call and the rest). The words come in families, because an overclaim rarely repeats the last one's wording: never or cannot followed by rewritten, modified, altered, changed, edited, deleted, erased, overwritten, forged, falsified or removed; and unalterable, unchangeable, indelible, unforgeable, incorruptible, write-once, permanent and forever. A test row holds one sentence per family, so narrowing a family fails. Each hit must sit inside a registered statement, inside a registered non-claim, or inside a `pendingCopy` span of a denied phrase. For `CHANGELOG.md`, only the `[Unreleased]` section is scanned, because released entries are a dated record.
- **(b) Every entry still points at something real.** Each statement and non-claim must appear in its file word for word (whitespace is collapsed, so a line wrap does not matter). Each cited test must exist in its file as a literal `it(...)` or `test(...)` title that is not skipped or todo, and the file must not hold a `.skip`, `.todo` or `.only` that could stop it from running.
- **(c) No documentation states a denied phrase.** Each entry in `denied` is a regular expression for wording that is false, tied by `contradictedBy` to the sentence or test title that contradicts it. That contradicting text must still exist. If it is removed, the denial fails and gets reviewed rather than lapsing. `scope.denied` also covers the site's page components.
- **(d) Unproven claims are counted.** A claim with no proof carries a `pending` reason. The test prints every pending claim, and fails if their number rises above `pendingCeiling`.

The test does not judge whether a sentence is true. That is the cited test's job, and the reviewer's when an entry is added: a statement registered against the wrong test passes here. What the register does is put each claim and its evidence side by side, where a reviewer can see both.

## Adding or changing an integrity sentence

1. Write the sentence in the documentation.
2. If it states something about the chain, find or write the test that fails when the sentence stops being true. Add the sentence to an existing claim's `statements`, or add a claim with `id`, `kind` (`guarantee` for what holds, `caveat` for a stated limit, which must stay true too), `claim` (one plain sentence), `statements` and `proofs`.
3. A caveat that cannot be proven in this repository yet goes in with `"proofs": []` and a `pending` reason. Raising `pendingCeiling` is a decision the reviewer sees in the diff.
4. If the vocabulary hit is not an integrity claim (a key detected by its prefix, the order in which properties are inserted), add it to `nonclaims` with the reason.
5. When you reword a registered sentence, update its `text` in the same change. Check (b) names any entry left behind.

## Entries awaiting a ruling

A denied phrase can list `pendingCopy` spans: places that still use the wording while the product copy is being decided. Those spans pass, and the test prints them. When the copy changes, delete the span. Once no span is left, the phrase is denied everywhere.
