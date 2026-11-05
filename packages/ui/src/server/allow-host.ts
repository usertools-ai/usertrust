// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `--allow-host <name>`: let the dashboard answer a request whose `Host` header names this host,
 * for a private network proxy such as `tailscale serve` that forwards to the loopback bind.
 *
 * This only ever ADDS to the loopback allow-list. The bind address does not change, and a name is
 * accepted only as a plain DNS hostname: no wildcard, no IP literal (the loopback names are already
 * allowed, so naming them changes nothing), no port, no scheme.
 */

/** Why a name was refused, or its normalised (lower-case) form. */
export type AllowHostResult = { ok: true; name: string } | { ok: false; reason: string };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The loopback names the server always answers to; naming one is accepted and adds nothing. */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

export function parseAllowHost(raw: string): AllowHostResult {
	const name = raw.trim().toLowerCase();
	if (name === "") return { ok: false, reason: "is empty" };
	if (name.includes("*")) return { ok: false, reason: "must not be a wildcard" };
	if (LOOPBACK_NAMES.has(name)) return { ok: true, name };
	if (/[:/@\s[\]]/.test(name)) {
		return { ok: false, reason: "must be a bare host name (no scheme, port, path or IP literal)" };
	}
	if (name.length > 253) return { ok: false, reason: "is longer than 253 characters" };
	const labels = name.split(".");
	if (!labels.every((label) => LABEL.test(label))) {
		return {
			ok: false,
			reason: "must be made of labels of a-z, 0-9 and '-', not starting or ending with '-'",
		};
	}
	// An all-numeric last label is an IP address (or part of one), never a DNS name.
	if (/^[0-9]+$/.test(labels[labels.length - 1] as string)) {
		return { ok: false, reason: "must not be an IP address" };
	}
	return { ok: true, name };
}

/**
 * Parse every name; the first bad one is returned as an error message. The message NAMES the value by
 * its position and never repeats it: it is untrusted text, and a terminal would act on any control
 * character in it (a C1 CSI byte, DEL, a bidi override) that escaping the C0 range does not remove.
 */
export function parseAllowHosts(
	raw: readonly string[],
): { ok: true; names: string[] } | { ok: false; error: string } {
	const names: string[] = [];
	for (const [i, value] of raw.entries()) {
		const parsed = parseAllowHost(value);
		if (!parsed.ok) return { ok: false, error: `--allow-host value ${i + 1} ${parsed.reason}` };
		if (!LOOPBACK_NAMES.has(parsed.name) && !names.includes(parsed.name)) names.push(parsed.name);
	}
	return { ok: true, names };
}

/** True when `host` (a Host header) is exactly one allowed name, with the server's port or none. */
export function hostAllowed(
	host: string | undefined,
	names: readonly string[],
	port: number,
): boolean {
	if (host === undefined || names.length === 0) return false;
	const h = host.toLowerCase();
	return names.some((name) => h === name || h === `${name}:${port}`);
}

/** True when `origin` is `https://<name>`, `http://<name>` or `http://<name>:<port>` for an allowed name. */
export function originAllowed(origin: string, names: readonly string[], port: number): boolean {
	const o = origin.toLowerCase();
	return names.some(
		(name) => o === `https://${name}` || o === `http://${name}` || o === `http://${name}:${port}`,
	);
}

/** The line printed at startup when any host is allowed. */
export function allowHostNotice(names: readonly string[]): string {
	return `usertrust-ui also answers requests for host ${names.join(", ")}. Use only behind a private network such as Tailscale serve; never a public tunnel.`;
}
