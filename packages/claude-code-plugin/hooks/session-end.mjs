// SessionEnd: the session is over. The final response that Stop could not find in
// the transcript yet may be there now, so the scan Stop makes is made once more:
// leftover holds with usage settled, every agent's remainder posted (through the
// same claims as every post, so nothing Stop already posted is posted again), and
// the rest given back (`settleSession` in transcript.mjs).
//
// Claude Code gives this hook far less time than any other: 1.5 s by default,
// which no timeout a plugin's hooks.json sets can raise, and
// CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS can (lib.mjs `sessionEndBudgetMs`).
// hooks.json's `timeout` for this hook does not raise that budget: it only
// bounds this hook once the variable has raised it (and before Claude Code
// v2.1.268 a hook without its own timeout kept 1.5 s even then). Every step is
// sized to the budget, a Stop still finishing included: its lock is waited for
// only a fifth of it. SessionEnd cannot block, and never fails a session.
//
// While the server's breaker is open (lib.mjs `breakerOpen`, watch mode only), nothing is
// sent and nothing is touched but the state's first-run time (transcript.mjs
// `stampFirstRun`), and this is the session's last hook: no later one settles what it leaves,
// unless the session is resumed. So its record is a GAP, not a deferral, naming the holds it
// leaves (`skipSettlePoint`).
import {
	breakerOpen,
	readStdin,
	requireLaunch,
	say,
	sessionEndBudgetMs,
	skipSettlePoint,
	usageMode,
	useHookBudget,
} from "./lib.mjs";
import { sessionEndLockWait, settleSession, stampFirstRun } from "./transcript.mjs";

requireLaunch();
useHookBudget(sessionEndBudgetMs());

try {
	const input = JSON.parse((await readStdin()) || "{}");
	if (await breakerOpen()) {
		if (usageMode() === "transcript") await stampFirstRun();
		await skipSettlePoint({
			kind: "gap",
			phase: "session-end",
			session: input.session_id ?? "unknown",
			agent: null,
		});
	} else {
		await settleSession({ input, hook: "SessionEnd", lockWaitMs: sessionEndLockWait() });
	}
} catch (err) {
	say(`usertrust: session-end settle failed: ${err instanceof Error ? err.message : String(err)}`);
}
