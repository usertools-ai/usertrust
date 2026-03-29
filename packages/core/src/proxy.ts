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
 *
 * AUD-456: Proxy mode is honest about being a stub. Receipts include
 * `proxyStub: true` and a console.warn fires on first call.
 */
export function connectProxy(url: string, key?: string): ProxyConnection {
	let warnedOnce = false;

	function emitStubWarning(): void {
		if (!warnedOnce) {
			warnedOnce = true;
			// AUD-456: intentional one-time warning for proxy stub mode
			console.warn("usertrust: proxy mode is a stub — no real financial governance is applied");
		}
	}

	return {
		url,
		key,
		async spend(params: ProxySpendParams): Promise<ProxySpendResult> {
			emitStubWarning();
			return {
				transferId: `proxy_${Date.now().toString(36)}`,
				estimatedCost: params.estimatedCost,
			};
		},
		async settle(_transferId: string, _actualCost: number): Promise<void> {
			// Stub: no-op — real implementation will POST settlement
			emitStubWarning();
		},
		async void(_transferId: string): Promise<void> {
			// Stub: no-op — real implementation will POST void
			emitStubWarning();
		},
		destroy(): void {
			// Stub: no-op — real implementation will close HTTP connection pool
		},
	};
}
