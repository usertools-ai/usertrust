// A server older than this plugin: which capabilities the plugin uses that it does not list, and
// the one line SessionStart says about it. Pure: no I/O, so the probe child and the parent
// share it, and a test can read it.
//
// Only a capability whose absence COSTS the user something is here. The plugin also falls back
// for `settle-unrecoverable`, but it reads both the old 404 and the new 410 answer, so an older
// server loses nothing there, and a warning with no consequence would only be noise.

/** The capabilities the plugin uses, in the order the line names them. */
export const WATCHED_CAPABILITIES = ["hold-ttl", "release"];

/**
 * The first server release that lists each one. tests/server-drift.test.ts reads the CHANGELOG
 * and fails when either of these is not the release whose entry introduced the capability.
 */
export const MINIMUM_SERVER_VERSION = { "hold-ttl": "5.2.0", release: "4.0.0" };

/** What the user loses, in the words the line uses. */
const LOSS = {
	"hold-ttl": "holds expire after 300 s",
	release: "unused holds count as failures on its circuit breaker",
};

/**
 * `/v1/health` states the server's version as free text. It reaches the user's terminal, so only
 * a plain version is kept (`5.1.0`, or with a short pre-release or build tail); anything else is
 * left out and the line says "the connected server".
 */
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
export function plainVersion(value) {
	return typeof value === "string" && VERSION.test(value) ? value : null;
}

/** The watched capabilities a LISTED capability set does not hold, in the line's order. */
export function missingCapabilities(capabilities) {
	return WATCHED_CAPABILITIES.filter((name) => !capabilities.has(name));
}

/** The latest of the fix versions for the missing capabilities (each is x.y.z). */
function fixVersion(missing) {
	const key = (v) => v.split(".").map(Number);
	const later = (a, b) => {
		const [x, y] = [key(a), key(b)];
		for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b;
		return a;
	};
	return missing.map((name) => MINIMUM_SERVER_VERSION[name]).reduce(later);
}

/**
 * The one line: what the server lacks, what that costs, the fix. `drift` is
 * `{ missing: string[], version: string | null }`, with `missing` non-empty.
 */
export function driftLine({ missing, version }) {
	const server = version === null ? "the connected server" : `server ${version}`;
	return (
		`usertrust: ${server} lacks ${missing.join(" and ")}: ` +
		`${missing.map((name) => LOSS[name]).join(" and ")}. ` +
		`Upgrade the server to ${fixVersion(missing)} or later.`
	);
}
