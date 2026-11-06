// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { UiServer } from "./server.js";

/** The ports tried, in order, when no --port is given. */
const FIRST_PORT = 4180;
const LAST_PORT = 4199;

/**
 * Starts the server on `requestedPort`, or on the first free port from 4180 to 4199. Only a port in use
 * (EADDRINUSE) moves the search on: any other start error (a project root that cannot be opened, say) is the
 * start's error, reported as it is and never as "no free port".
 */
export async function listenUi(
	create: (port: number) => Promise<UiServer>,
	requestedPort: number | undefined,
): Promise<UiServer> {
	// An explicit --port fails fast on conflict.
	if (requestedPort !== undefined) return create(requestedPort);
	for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
		try {
			return await create(port);
		} catch (err) {
			if ((err as NodeJS.ErrnoException | null)?.code !== "EADDRINUSE") throw err;
		}
	}
	throw new Error(`no free port in ${FIRST_PORT}-${LAST_PORT}; pass --port`);
}
