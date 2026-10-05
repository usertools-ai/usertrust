# Receipt amount framing — R40

**Status:** decided 2026-08-15. This is the copy of the decision that lives in
this public repo so the next page change cannot restore the rejected wording
from a still-sound argument.

The rendered amount was reviewed, and **the floor was rejected.** `"at least $X of
spend was CAUSED…"` is a vague claim about an undefined quantity. The
replacement is the **unqualified number, with its scope named beneath it:**

```
$0.4820
Charged to this session · delegated work bills to the delegate
```

Honesty comes from naming the scope, not from hedging the figure. Every
delegation posture states what its number covers. None of them qualifies the
number itself.

**v0.10 — cluster receipts name an agent key and a window, not a session.**
Every receipt issued is a cluster receipt (`receipt-spec.md` §15). A cluster
receipt covers every charge to one agent key's account over a system-defined
window, so its scope line names the key:

```
$0.4820
Charged to this agent key · delegated work bills to the delegate
```

The claim line it accompanies is "charged to this agent key between
`<windowStart>` and `<windowEnd>` — $X", with the window's ledger timestamps
rendered as RFC 3339 UTC. The scoped never-understates sentence reads "never
understates the ledger-POSTed charges to this agent key in this window".

- **The rule does not change.** The number stays unqualified, its scope stays
  named beneath it, and no floor is restored.
- **The session form above belongs to the reserved session kind**, which is
  defined and never issued. A page renders each receipt with its own kind's
  sentence, selected by `scope`, and never one kind's sentence under the
  other's number.

The `indeterminate` bound clause still holds — unknown coverage supports no
bound in either direction — and lives in the R39 copy, not as an exception to
a floor that no longer exists.

Do not restore `"at least $"` on this page. The longer design-doc R40 (DRAFT
v0.9) and `receipt-spec.md` §7 bound clause were written before this review;
they are amended in the operator's private copies of those documents.

## Amendment 2026-10-05: the brief receipt

**Decided:** a receipt is read at a glance and should be brief. The verified
page leads with one card (the verdict, the amount, **one scope chip**, what it
covers, when, and a short ID); everything else is behind one collapsed
"Details". Nothing is removed from the page.

What this changes, and what it does not:

- **R38 / R39 / R40.** The amount's posture label is the chip, **visible next to
  the amount** (its `title` is the one-line meaning). The full scope statement,
  the scope caption and the attested-enums line are on the page, **one
  disclosure away**. They are no longer required to sit above the fold. The
  rule that the amount never renders without its posture label is unchanged.
- **R41.** The level strip on the card labels the anchored level
  "resolver-asserted"; the full sentence sits beside the anchored rung in
  Details, rendered once.
- **R6 / R7 / R8.** The verbatim rung disclaimers are unchanged and are in
  Details.
- **Unchanged:** the floor stays rejected, `indeterminate` still supports no
  bound in either direction, and the retired unconditional promise must not be
  restated anywhere. The page still never computes a verdict.

Tests pin the new shape (`site/app/r/rendering.test.tsx`, `brief.test.tsx`):
the chip is outside any `<details>` and sits right after the amount; the
sentences are inside the one `<details>`.

### The plain-language layer, the share card and the 404

The verified card is not the only brief state. Every other state now leads with
a plain word (two to four words, e.g. "Pending", "Not verified", "Can't verify
now") and one plain line. The state's full headline and its notes, as pinned
in `site/app/r/lib/shell-copy.ts`, are in that state's Details. The plain copy
is in `site/app/r/lib/plain-copy.ts`.

What this changes, and what it does not:

- **The lead.** The plain word and line come first; the full wording is one
  disclosure away. Nothing is removed from the page.
- **The share card.** Its word is the page's plain word, so `ogCardWord` no
  longer equals `shellHeadline`. On a verified receipt the card also carries
  the amount; it carries no receipt ID, no account handle and no other
  receipt's ID. This replaces the earlier default for the card (verdict only,
  amount on the page): the amount is what a receipt is shared for, and an ID
  or a handle is what would tie it back to someone. The amount's posture label
  stays on the page.
- **Unchanged:** each state's register (except the 404's, below), and the rule
  that nothing short of verified is ever green.
- **The 404 (receipt-spec v0.10 §15.13).** Every 404 reads "no receipt under
  this ID yet", and explains that a receipt is minted once its agent key has
  been idle for the key's idle threshold (10 minutes by default, on the
  ledger's clock) and its audit segment has sealed. A cluster receipt's ID is
  derived, so it can be cited before its receipt exists, and a 404 cannot say
  whether one is coming. A 404 is therefore neutral: never rendered as
  forgery, and never green. The loud "never allocated — integrity red flag"
  rendering is retired for every ID.
- **The cluster receipt's glance** is headed "Receipt", as every kind is; its
  kind is shown in Details as `SPEC ut1 · SCOPE cluster`. It shows the ledger
  window, with its duration and idle threshold; the governed calls it covers,
  with their models and provider; and the skipped-windows disclosure. That
  disclosure is NEVER folded into Details: it is an honesty disclosure, and a
  gap the receipt admits is read with the receipt, not after a click.

Tests pin the plain layer, the card's word and the 404
(`site/app/r/brief.test.tsx`, `states.test.tsx`, `lib/shell-copy.test.ts`).

### Nothing on the page ties a receipt back to whoever it charged

The public page renders no account handle, no previous receipt's ID or link to
it, and no repository, in the glance, in Details or on the share card. The
predecessor check still reports its result, without an ID; skipped windows
show their times and reasons, without IDs. The signed bytes are served
unchanged (`receipt.json`, `envelope.json`), so they still carry those fields
until a later spec version changes the document itself.

Tests pin it for every cluster fixture (`site/app/r/cluster-rendering.test.tsx`):
no `a1_` anywhere in the render, no `ut1_` but the receipt's own, no
`repoId`, and no share-card line carrying either prefix.
