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
they are amended in the private spec copies
(`usertools-stealth/docs/specs/from-usertrust/` and
`usertools-stealth/docs/specs/receipt-page/README.md`).
