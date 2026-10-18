/**
 * The single pattern the server's api-key redaction used before `redactApiKeys`: the reference
 * its matches are checked against. Its quoted value is a quantified group with an alternation
 * inside, and V8 throws `RangeError` running it over an unclosed value of about 10 million
 * characters, which is why the server no longer uses it. On short text it is the definition.
 */
export const OLD_API_KEY_VALUE =
	/\b(x-api-key|api[-_]key)(["']?\s*[:=]\s*)(?:"((?:[^"\\]|\\[\s\S])*)"?|'((?:[^'\\]|\\[\s\S])*)'?|[^\s"',;&]+)/gi;

/** `text` with every value `pattern` matches redacted, as the server redacted it with that pattern. */
export function redactWith(pattern: RegExp, text: string): string {
	return text.replace(pattern, (_m, name: string, sep: string, dq?: string, sq?: string) => {
		const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
		return `${name}${sep}${quote}[redacted]${quote}`;
	});
}
