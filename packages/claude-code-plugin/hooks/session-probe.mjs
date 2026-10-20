// SessionStart's one request, made from a configured session's isolated child (launch.mjs
// `probeInChild`): does the server list `job-type`? It is not a hook of hooks.json; the launcher
// starts it only as that child, so the request is made under the child's sanitized environment
// and never the parent's. It writes nothing to stdout (SessionStart's one JSON object is the
// parent's): the answer is its exit code, `PROBE_LISTED` or 0.
import { PROBE_LISTED, probeJobType } from "./job-log.mjs";
import { requireLaunch } from "./lib.mjs";

requireLaunch();

process.exitCode = (await probeJobType()) ? PROBE_LISTED : 0;
