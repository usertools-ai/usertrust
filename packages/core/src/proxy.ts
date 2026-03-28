// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Proxy Mode — Remote Governance Connection
 *
 * When `opts.proxy` is set, governance flows through the remote proxy
 * instead of a local TigerBeetle instance. This is a stub for v1 —
 * the real implementation will HTTP POST to proxy.usertools.ai.
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
 * Stub implementation for v1 — all operations succeed immediately
 * with synthetic data. Real implementation will HTTP POST to the
 * proxy URL with the provided API key.
 */
export function connectProxy(url: string, key?: string): ProxyConnection {
	return {
		url,
		key,
		async spend(params: ProxySpendParams): Promise<ProxySpendResult> {
			return {
				transferId: `proxy_${Date.now().toString(36)}`,
				estimatedCost: params.estimatedCost,
			};
		},
		async settle(_transferId: string, _actualCost: number): Promise<void> {
			// Stub: no-op — real implementation will POST settlement
		},
		async void(_transferId: string): Promise<void> {
			// Stub: no-op — real implementation will POST void
		},
		destroy(): void {
			// Stub: no-op — real implementation will close HTTP connection pool
		},
	};
}
