import type { ReactNode } from "react";

/**
 * §6.1's other half: "Non-green terminal states set the masthead in the
 * danger language instead (full `--color-danger` ≥ 16px / graphics;
 * `--color-danger-ink` for 12–14px red text — the H2 rule). The verdict is
 * never color-only: the word IS the verdict."
 *
 * Three registers, none of them the green ladder's `--color-ut`:
 *   - `neutral` — pending/terminal-without-a-receipt states that are not
 *     alarms (§7: "Neutral register, no red, no green" / "not danger");
 *   - `warning` — the operational 503 (§10.4's "operational condition, not
 *     a cryptographic mismatch");
 *   - `danger` — the loud failures (404/409) and `billedUnfinalized`, which
 *     is danger-registered but explicitly WITHOUT 409's full diagnostic
 *     treatment (§7: "Danger register without the integrity-failure
 *     treatment").
 *
 * The word is always rendered at ≥16px display size, so full `--color-danger`
 * (5.21:1 on the page ground) is the H2-correct choice here — the same rung
 * `VerdictMasthead` gives the green word in full `--color-ut`, never a
 * lightened "ink" variant reserved for 12-14px body text.
 */
const REGISTER_INK: Record<"neutral" | "warning" | "danger", string> = {
	neutral: "text-white/85",
	warning: "text-warning",
	danger: "text-danger",
};

export default function NonGreenMasthead({
	word,
	register,
	children,
}: {
	word: string;
	register: "neutral" | "warning" | "danger";
	/** Optional fine print / explanatory lines, rendered beneath the word. */
	children?: ReactNode;
}) {
	return (
		<header className="flex flex-col gap-4" data-register={register}>
			<h1
				className={`font-display text-3xl leading-tight uppercase tracking-[0.06em] sm:text-5xl ${REGISTER_INK[register]}`}
			>
				{word}
			</h1>
			{children ? (
				<div className="flex flex-col gap-2 border-l-2 border-white/15 pl-4">{children}</div>
			) : null}
		</header>
	);
}
