# A runaway `budgetSpent`, and how to recover

`.usertrust/spend-ledger.json` holds the cumulative session spend (`budgetSpent`, in usertokens). On every start the
controller reads it and seeds the session wallet with `max(0, budget - budgetSpent)`. If that number is wrong by orders of
magnitude, every later call in the vault is refused by the budget rule, and raising `budget` does not help.

## How it used to happen, and what prevents it now
One usage figure that was finite but absurd (a buggy provider or proxy reporting, say, 10^12 tokens) used to be priced as
reported, added to the session counter and written to the file. The ledger caps the POSTED amount at the hold, so no money
was lost, but the counter was not capped.

Three things now prevent it:

- **A plausibility ceiling.** A reported count above 100,000,000 tokens in any single tier (`MAX_PLAUSIBLE_TOKENS_PER_TIER`)
  is not charged. The call settles at the estimate, exactly as for a call that reports no counts, and a `usage_implausible` event is
  appended to the audit chain (and a line is written to stderr) naming the call, the model, the refused figures and the
  ceiling.
- **The counter keeps the metered cost.** The budget enforces what the provider charges, so a plausible call that costs more than its hold is counted in full; `receipt.postedCost` and `settlement_shortfall` show the gap to what the ledger posted. The ceiling above and the persist guard below are what keep one bad figure from refusing every later call.
- **No unrepresentable value is persisted.** A cumulative spend above `Number.MAX_SAFE_INTEGER` is never written; the file
  keeps its last safe value and a line is written to stderr.

## How to see it
`usertrust health` reports `Budget utilization: ... [critical: runaway spend ...]` (and `budgetRunaway: true` in `--json`)
when the persisted spend is unrepresentable or more than 1,000 times the configured budget. It also lists the number of
calls that were charged at the estimate because of an implausible figure.

## Recovery (a vault that already has a runaway value)
1. Stop every process that uses the vault (a stale process rewrites the file on its next settle).
2. Find the real figure. The audit chain is the record: `usertrust inspect` and `usertrust export --markdown <dir>` show
   each `llm_call` cost; the `usage_implausible` and `settlement_shortfall` events show which calls were refused or capped.
3. Edit `.usertrust/spend-ledger.json` and set `budgetSpent` to the correct cumulative spend, a finite number >= 0. Setting it
   to 0 re-grants the whole budget, which is a decision to make deliberately; deleting the file does the same.
4. Start the process again. With a ledger, the wallet is re-seeded from `max(0, budget - budgetSpent)`.
