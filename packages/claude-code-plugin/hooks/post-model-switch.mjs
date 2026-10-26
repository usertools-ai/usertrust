// PostModelSwitch: record the session's new model (`to_model`), with when it was seen
// (transcript.mjs `recordModelSwitch`). Claude Code runs it after every change of the
// session's model: one you request, an automatic fallback, a plan-mode setting, a resume
// (https://code.claude.com/docs/en/hooks#postmodelswitch). A hold reads it because the
// transcript may lag the conversation (transcript.mjs `holdModelFor`): a newest response
// on disk from before the switch is never taken for the session's current model.
//
// It is registered in hooks/model-switch.json, NOT hooks/hooks.json: a Claude Code before
// v2.1.251 does not know the event, and rejects the whole hooks file that names it, so in
// hooks.json it would turn every other hook off there. In its own file only this hook is lost.
//
// Nothing is printed to stdout: Claude Code adds a PostModelSwitch hook's plain stdout to
// Claude's context. No network call, and it never fails the switch.
import { readStdin, requireLaunch } from "./lib.mjs";
import { recordModelSwitch } from "./transcript.mjs";

requireLaunch();

let payload = {};
try {
	payload = JSON.parse((await readStdin()) || "{}");
} catch {
	// Nothing to read: nothing is recorded.
}
await recordModelSwitch(payload?.session_id, payload?.to_model);
