/**
 * fleet-collector.mts — the fleet-ledger collector's CLI ENTRY POINT.
 *
 *   npm run fleet:collect [-- --dry-parse | --publish]
 *
 * This file exists to hold ONE invariant: the build check runs before anything
 * from the workspace is resolved. It therefore imports node builtins and
 * nothing else, and reaches the real collector (`./fleet/collect.mts`) through
 * a DYNAMIC import.
 *
 * Why that is load-bearing: `collect.mts` statically imports
 * `usertrust/pricing`, and `replay.mts` statically imports `usertrust`, whose
 * `types`/`exports` point into a GITIGNORED `dist/`. ESM resolves every static
 * import of a module before that module's first statement executes, so a
 * friendly check living inside `collect.mts` could never run first: on a clean
 * checkout (`npm ci` does not build workspaces) the operator would get an
 * ERR_MODULE_NOT_FOUND stack for `usertrust` instead of the one line that
 * actually fixes it. Keep this file free of workspace imports — a static
 * `import … from "usertrust…"` here silently restores the bad failure mode.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Is the workspace built? Probes the one artifact every fleet module needs
 * transitively — core's compiled entry, which `usertrust` resolves to.
 */
export function coreDistBuilt(repoRoot: string): boolean {
	return existsSync(join(repoRoot, "packages", "core", "dist", "index.js"));
}

export const CORE_DIST_MISSING =
	"packages/core/dist missing — run `npm ci && npx tsc -b` at the repo root first.";

// Import-safe: tests import the exported helpers without running the CLI.
const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	if (!coreDistBuilt(REPO_ROOT)) {
		console.error(CORE_DIST_MISSING);
		process.exit(1);
	}
	const { main } = await import("./fleet/collect.mts");
	await main();
}
