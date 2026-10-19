/**
 * usertrust-server 5.1.0's redaction of an internal error's message, as released: the oracle the
 * no-regression differential checks the server against (tests/redact-no-regression.test.ts).
 * Copied from the v5.1.0 tag (release commit 811c6ae7): `packages/server/src/server.ts` (blob
 * 84b53b5d), from `BEARER_TOKEN` through `internalErrorLine`, and `packages/server/src/cli/scrub.ts`
 * (blob 8e63a6b7), `scrubForStderr` and what it uses. Changed only so it stands alone: `RouteName`
 * is `string`, nothing but the two functions is exported, and the ellipsis the clip appends is
 * built from its code point. Its patterns are quadratic or throw on some long inputs (that is why
 * they were replaced); on short text it is the definition of what 5.1.0 printed.
 */

/** The most a printed message keeps, in code points, after sanitizing. */
const MAX_PRINTED_CHARS = 4_096;
const ELLIPSIS = String.fromCharCode(0x2026);

// Escape sequences, 7-bit (ESC [ / ESC ]) and 8-bit (CSI / OSC) introducers alike, removed
// WHOLE so none of their text ("[2J") is left behind. An OSC body stops at a newline, so an
// unterminated one cannot swallow the lines after it.
const ESCAPE_SEQUENCES =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
	/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?|\x1b[@-_]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character strip is a terminal-injection defense
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;
// LINE SEPARATOR and PARAGRAPH SEPARATOR: no control class holds them, and a viewer that
// honours them starts a new line there, so a caller's message could show a forged log line.
// Built from code points so the source carries no invisible character.
const LINE_SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, "g");

/**
 * Text the CLI prints at an operator's terminal that carries configured values (a ledger
 * address, a config path, a child's stderr). Turns U+2028 and U+2029 into `\n`, so they are
 * line breaks like any other (a caller that joins lines on `\n` folds them too, and an OSC body
 * stops at them); removes escape sequences, then every C0, DEL and C1 character (U+0085
 * included), keeping only the line breaks; then clips to MAX_PRINTED_CHARS. In that
 * order: sanitized before it is clipped, so a cut can never leave half a sequence behind.
 */
function scrubForStderr(text: string): string {
	const clean = text
		.replace(LINE_SEPARATORS, "\n")
		.replace(ESCAPE_SEQUENCES, "")
		.split("\n")
		.map((line) => line.replace(CONTROL_CHARACTERS, ""))
		.join("\n");
	const chars = Array.from(clean);
	return chars.length <= MAX_PRINTED_CHARS
		? clean
		: `${chars.slice(0, MAX_PRINTED_CHARS).join("")}${ELLIPSIS}`;
}

/** A bearer token wherever a message quotes one: `Bearer <token>`. */
const BEARER_TOKEN = /\b(Bearer)\s+[^\s"',;]+/gi;
/**
 * An api-key style value: `x-api-key: <v>`, `api_key=<v>`, `"api-key": "<v>"`. A QUOTED value is
 * consumed through its closing quote (or to the end, unclosed), whatever it holds: `"abc;def"` is
 * one value, never `abc` followed by text. An escape inside it is a backslash and ANY character,
 * a line terminator included (`\\[\s\S]`): with `\\.` an escaped CR or LF ended the match there,
 * and the rest of the value was logged. An unquoted value ends at whitespace, a quote, `,`, `;` or
 * `&`. Two leaks have now been found in this pattern; a third replaces it with a structured
 * redactor rather than another case.
 */
const API_KEY_VALUE =
	/\b(x-api-key|api[-_]key)(["']?\s*[:=]\s*)(?:"((?:[^"\\]|\\[\s\S])*)"?|'((?:[^'\\]|\\[\s\S])*)'?|[^\s"',;&]+)/gi;

/**
 * `text` with every `secret` (the caller's own bearer key, when known), every `Bearer <token>` and
 * every api-key style value replaced by `[redacted]`. Scrubbing is not redaction: `scrubForStderr`
 * removes terminal control, never a credential.
 */
function redactSecrets(text: string, secrets: readonly string[] = []): string {
	let out = text;
	for (const secret of secrets) if (secret !== "") out = out.split(secret).join("[redacted]");
	return out
		.replace(BEARER_TOKEN, "$1 [redacted]")
		.replace(API_KEY_VALUE, (_match, name: string, sep: string, dq?: string, sq?: string) => {
			const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
			return `${name}${sep}${quote}[redacted]${quote}`;
		});
}

/**
 * One line for the operator's log about an error a client only ever sees as the opaque
 * `500 internal`: which tenant, which route, and the error's own name and message, so a
 * tenant refused at its first request (its vault, say) says why somewhere. It carries no key,
 * header or request body of its own. The message is the server's or governor's text, which can
 * quote what a caller sent, so credentials in it are REDACTED (`redactSecrets`, with the caller's
 * own key in `secrets`) before escape sequences and control characters are removed
 * (`scrubForStderr`) and its lines joined into one; and once more after, so a key a control
 * character had split cannot come back together.
 */
export function internalErrorLine(
	err: unknown,
	tenantId: string | undefined,
	route: string,
	secrets: readonly string[] = [],
): string {
	const name = err instanceof Error ? err.name : typeof err;
	const message = err instanceof Error ? err.message : String(err);
	const raw = redactSecrets(`${name}: ${message}`, secrets);
	const text = redactSecrets(scrubForStderr(raw).replace(/\s*\n\s*/g, " "), secrets);
	const tenant = tenantId === undefined ? "-" : scrubForStderr(tenantId);
	return `usertrust-server: internal error: tenant=${tenant} route=${route}: ${text}`;
}

export { internalErrorLine as internalErrorLine510, redactSecrets as redactSecrets510 };
