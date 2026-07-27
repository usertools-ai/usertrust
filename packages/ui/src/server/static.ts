// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json",
};

/** Serve a file from appDir, falling back to index.html (SPA). Traversal-safe. */
export function serveStatic(appDir: string, pathname: string, res: ServerResponse): void {
	// Amendment A8: malformed percent-encoding must not crash the server.
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		res.writeHead(400, { "content-type": "text/plain" });
		res.end("bad request");
		return;
	}
	const candidate = normalize(join(appDir, decoded));
	const safe = candidate.startsWith(appDir + sep) || candidate === appDir;
	const target =
		safe && existsSync(candidate) && extname(candidate) !== ""
			? candidate
			: join(appDir, "index.html");
	if (!existsSync(target)) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("usertrust-ui: SPA assets not built");
		return;
	}
	const body = readFileSync(target);
	res.writeHead(200, {
		"content-type": MIME[extname(target)] ?? "application/octet-stream",
		"content-length": body.length,
	});
	res.end(body);
}
