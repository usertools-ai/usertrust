// SessionStart's one request, made from a configured session's isolated child (launch.mjs
// `probeInChild`): does the server list `job-type`? It is not a hook of hooks.json; the launcher
// starts it only as that child, so the request is made under the child's sanitized environment
// and never the parent's. Its stdout is the launcher's to read and never SessionStart's: the
// answer is one fixed token line, written only after a well-formed list holding `job-type` was
// seen, and exit 0. Anything else is "not listed".
//
// It ends ITSELF (`process.exit`) once the probe settles: the request's abort at its bound does
// not close every socket (a server that accepts the connection and stalls the TLS handshake
// keeps connection work alive), and a probe left running would hold the inherited stderr, with
// no parent if its launcher was killed.
import { PROBE_TOKEN, probeJobType } from "./job-log.mjs";
import { requireLaunch } from "./lib.mjs";

requireLaunch();

/** The one thing this module writes to stdout: a fixed token, nothing from the server. */
function acknowledge() {
	return new Promise((resolve) => process.stdout.write(`${PROBE_TOKEN}\n`, () => resolve()));
}

if (await probeJobType()) await acknowledge();
process.exit(0);
