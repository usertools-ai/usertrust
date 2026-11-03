// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A governor with no ledger behind it must fail within seconds and say how to fix it. The native
 * TigerBeetle client cannot do that: it retries a refused connection forever and imposes no request
 * timeout, so a `trust()` call against a ledger that is not running waits indefinitely, and the
 * process never gets to print a hint.
 *
 * `preflightLedger` is the cheap first step. It opens a plain TCP connection to each configured
 * replica address, before any native client exists. A refused connection is a ledger that is not
 * running, and says so at once. It proves nothing about what answered: a listener that is not a
 * usertrust ledger is `TrustTBClient.connectDeadline`'s to find.
 */

import { connect } from "node:net";
import { LedgerUnavailableError } from "../shared/errors.js";

/** How long one loopback TCP attempt may take before the address counts as not answering. */
const CONNECT_ATTEMPT_MS = 1_000;
/** A remote link may lose a SYN: three seconds outlasts the first retransmit, so a lossy link is not "no ledger". */
const REMOTE_CONNECT_ATTEMPT_MS = 3_000;

export interface PreflightOptions {
	/** The configured cluster id, named in the fix for an explicit non-loopback address. */
	clusterId?: number | bigint;
	/** Per-address TCP attempt budget. Default 1 s for loopback, 3 s for any other host. */
	attemptMs?: number;
}

export interface ParsedAddress {
	host: string;
	port: number;
}

/**
 * Parse one replica address as TigerBeetle writes it: `3000` (loopback), `host:port` or
 * `[v6]:port`. Returns `undefined` for anything else, which `preflightLedger` leaves to the native
 * client rather than refusing on a form it does not know.
 */
export function parseLedgerAddress(address: string): ParsedAddress | undefined {
	const text = address.trim();
	if (/^\d{1,5}$/.test(text)) return validPort(text, "127.0.0.1");
	const v6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(text);
	if (v6) return validPort(v6[2] as string, v6[1] as string);
	const v4 = /^([^:[\]\s]+):(\d{1,5})$/.exec(text);
	if (v4) return validPort(v4[2] as string, v4[1] as string);
	return undefined;
}

function validPort(text: string, host: string): ParsedAddress | undefined {
	const port = Number(text);
	return port >= 1 && port <= 65_535 ? { host, port } : undefined;
}

/** Loopback hosts: the ledger this machine would start itself. */
export function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

/** Resolves true when a TCP connection to the address is accepted, false when it is refused or silent. */
function reachable(target: ParsedAddress, attemptMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: target.host, port: target.port });
		let settled = false;
		const finish = (answered: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(answered);
		};
		const timer = setTimeout(() => finish(false), attemptMs);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/**
 * Throws `LedgerUnavailableError` when no configured address accepts a TCP connection. Passes when
 * at least one does, and when an address is in a form this cannot read (the native client is then
 * the judge). Opens no native client, and leaves no socket or timer behind.
 */
export async function preflightLedger(
	addresses: readonly string[],
	options: PreflightOptions = {},
): Promise<void> {
	const targets: ParsedAddress[] = [];
	for (const address of addresses) {
		const parsed = parseLedgerAddress(address);
		// An address this cannot read is not provably down: leave the verdict to the client.
		if (parsed === undefined) return;
		targets.push(parsed);
	}
	if (targets.length === 0) return;

	const attemptFor = (t: ParsedAddress): number =>
		options.attemptMs ?? (isLoopbackHost(t.host) ? CONNECT_ATTEMPT_MS : REMOTE_CONNECT_ATTEMPT_MS);
	const answers = await Promise.all(targets.map((t) => reachable(t, attemptFor(t))));
	if (answers.some(Boolean)) return;

	const { where, fix, hint } = describeMissingLedger(targets, options.clusterId);
	throw new LedgerUnavailableError(`No ledger is running at ${where}. Fix: ${fix}`, where, {
		hint,
	});
}

/** The address `usertrust tb start` prints commands for: 127.0.0.1:3001, cluster 0, one replica. */
function isDefaultLedger(targets: readonly ParsedAddress[], clusterId?: number | bigint): boolean {
	const only = targets.length === 1 ? targets[0] : undefined;
	return (
		only !== undefined &&
		only.host === "127.0.0.1" &&
		only.port === 3001 &&
		(clusterId === undefined || BigInt(clusterId) === 0n)
	);
}

/**
 * What to tell the caller. `npx usertrust tb start` prints commands for the default ledger only, so
 * the shortcut is named only when that is the ledger that is missing; any other address or cluster
 * is named as configured, so the caller never starts a ledger the governor will not use.
 */
export function describeMissingLedger(
	targets: readonly ParsedAddress[],
	clusterId?: number | bigint,
): { where: string; fix: string; hint: string } {
	const where = targets
		.map((t) => (t.host.includes(":") ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`))
		.join(", ");
	if (isDefaultLedger(targets, clusterId)) {
		return {
			where,
			fix: "npx usertrust tb start",
			hint: "Run `npx usertrust tb start`, or pass { dryRun: true } to skip the ledger.",
		};
	}
	const named = `${where}${clusterId !== undefined ? ` (cluster ${String(clusterId)})` : ""}`;
	return {
		where,
		fix: `start the ledger at ${named}, or change tigerbeetle.addresses`,
		hint: `Start TigerBeetle at ${named}, or pass { dryRun: true } to skip the ledger.`,
	};
}
