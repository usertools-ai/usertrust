// Module resolve hook registered by source-preload.mjs: the workspace packages resolve
// to their TypeScript sources, as vitest.config.ts aliases them.
const SOURCES = {
	usertrust: new URL("../../../core/src/index.ts", import.meta.url).href,
	"usertrust/headless": new URL("../../../core/src/headless.ts", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
	const source = SOURCES[specifier];
	if (source !== undefined) return nextResolve(source, context);
	return nextResolve(specifier, context);
}
