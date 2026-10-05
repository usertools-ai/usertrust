# Receipt amount framing — R40

**Status:** decided 2026-08-15. This is the copy of the decision that lives in
this public repo so the next page change cannot restore the rejected wording
from a still-sound argument.

Cam reviewed the amount rendered and **rejected the floor.** `"at least $X of
spend was CAUSED…"` is a vague claim about an undefined quantity. The
replacement is the **unqualified number, with its scope named beneath it:**

```
$0.4820
Charged to this session · delegated work bills to the delegate
```

Honesty comes from naming the scope, not from hedging the figure. Every
delegation posture states what its number covers. None of them qualifies the
number itself.

The `indeterminate` bound clause still holds — unknown coverage supports no
bound in either direction — and lives in the R39 copy, not as an exception to
a floor that no longer exists.

Do not restore `"at least $"` on this page. The longer design-doc R40 (DRAFT
v0.9) and `receipt-spec.md` §7 bound clause were written before this review;
they are amended in the private spec copies
(`usertools-stealth/docs/specs/from-usertrust/` and
`usertools-stealth/docs/specs/receipt-page/README.md`).

## Amendment 2026-10-05: the brief receipt

**Decided by Cam:** a receipt is read at a glance and should be brief. The
verified page leads with one card (the verdict, the amount, **one scope chip**,
what it covers, when, and a short ID); everything else is behind one collapsed
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
