// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Proxy Mode — Remote Governance Connection
 *
 * AUD-456: Proxy mode is removed from the public API.
 *
 * The previous stub implementation returned hardcoded success for all
 * financial operations (spend/settle/void), making the entire two-phase
 * lifecycle theater. This is a critical governance bypass.
 *
 * When proxy mode is needed in the future, it must be implemented as a
 * real HTTP connection to proxy.usertools.ai with actual financial
 * enforcement. Until then, calling connectProxy() throws.
 *
 * To intentionally bypass governance (e.g., in integration tests),
 * use dryRun mode instead, which is explicit about skipping enforcement.
 */

export interface ProxySpendParams {
	model: string;
	estimatedCost: number;
	actor: string;
}

export interface ProxySpendResult {
	transferId: string;
	estimatedCost: number;
}

export interface ProxyConnection {
	spend(params: ProxySpendParams): Promise<ProxySpendResult>;
	settle(transferId: string, actualCost: number): Promise<void>;
	void(transferId: string): Promise<void>;
	destroy(): void;
	readonly url: string;
	readonly key: string | undefined;
}

/**
 * Connect to a remote governance proxy.
 *
 * AUD-456: Proxy mode is not yet implemented. The previous stub returned
 * hardcoded success, bypassing all financial governance. This function
 * now throws to prevent silent governance bypass.
 *
 * @throws {Error} Always throws — proxy mode is not yet implemented.
 */
export function connectProxy(_url: string, _key?: string): never {
	throw new Error(
		"usertrust: proxy mode is not yet implemented. " +
			"The proxy stub bypassed all financial governance (AUD-456). " +
			"Use dryRun mode for testing, or connect a real TigerBeetle instance for production.",
	);
}
