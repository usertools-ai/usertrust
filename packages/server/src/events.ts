// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

export type ServerEvent =
	| { type: "authorized"; transferId: string; model: string; estimatedCost: number; at: string }
	| { type: "settled"; transferId: string; cost: number; budgetRemaining: number; at: string }
	| { type: "aborted"; transferId: string; reason: string; at: string }
	| { type: "denied"; error: string; reason: string; shadow: boolean; at: string }
	| { type: "pending_expired"; transferId: string; at: string };

type Listener = (event: ServerEvent) => void;

export class EventBus {
	private readonly listeners = new Map<string, Set<Listener>>();

	subscribe(tenantId: string, listener: Listener): () => void {
		let set = this.listeners.get(tenantId);
		if (!set) {
			set = new Set();
			this.listeners.set(tenantId, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) {
				this.listeners.delete(tenantId);
			}
		};
	}

	publish(tenantId: string, event: ServerEvent): void {
		const set = this.listeners.get(tenantId);
		if (!set) return;
		for (const listener of set) {
			try {
				listener(event);
			} catch {
				// A broken subscriber must never break governance event delivery.
			}
		}
	}
}
