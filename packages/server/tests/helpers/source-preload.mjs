// Preload for running the server's TypeScript sources under plain `node`, the way a
// test spawns the CLI: `NODE_OPTIONS=--import <this file>`. tsx compiles the sources;
// source-hooks.mjs resolves `usertrust` to the core's sources, as vitest's alias does
// (no package needs building first). NODE_OPTIONS reaches every child process too.
import { register } from "node:module";
import { register as registerTsx } from "tsx/esm/api";

registerTsx();
register("./source-hooks.mjs", import.meta.url);
