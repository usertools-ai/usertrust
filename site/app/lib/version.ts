// Single source of truth for the version shown in the marketing UI.
// Inlined at build time from the canonical core package manifest so the
// badge can never drift from the published release again.
import coreManifest from "../../../packages/core/package.json";

export const PKG_VERSION: string = coreManifest.version;
