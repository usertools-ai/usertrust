/**
 * Circuit Breaker — per-provider failure isolation
 *
 * Prevents cascading failures by tracking consecutive errors per key
 * and short-circuiting execution when a failure threshold is exceeded.
 *
 * State machine: closed → open → half-open → closed
 *   - closed:    all requests pass through normally
 *   - open:      requests are rejected immediately (fail-fast)
 *   - half-open: a limited number of requests test recovery
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Circuit breaker state. */
export type CircuitState = "closed" | "open" | "half-open";

/** Configuration for a circuit breaker. */
export interface CircuitBreakerConfig {
	/** Number of consecutive failures before opening the circuit (default: 5). */
	failureThreshold: number;
	/** Milliseconds to wait before transitioning from open to half-open (default: 60 000). */
	resetTimeoutMs: number;
	/** Number of successful requests in half-open to close the circuit (default: 2). */
	halfOpenSuccessThreshold: number;
}

/** Snapshot of breaker state for observability. */
export interface CircuitBreakerSnapshot {
	readonly state: CircuitState;
	readonly consecutiveFailures: number;
	readonly halfOpenSuccesses: number;
	readonly lastFailureTime: number | null;
	readonly lastStateChange: number;
}

/** Error thrown when the circuit is open. */
export class CircuitOpenError extends Error {
	readonly breakerKey: string;

	constructor(key: string) {
		super(`Circuit breaker "${key}" is open — request rejected`);
		this.name = "CircuitOpenError";
		this.breakerKey = key;
	}
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CircuitBreakerConfig = {
	failureThreshold: 5,
	resetTimeoutMs: 60_000,
	halfOpenSuccessThreshold: 2,
};

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

/**
 * A single circuit breaker instance tracking failure state for one key.
 */
export class CircuitBreaker {
	readonly key: string;
	private readonly config: CircuitBreakerConfig;
	private state: CircuitState = "closed";
	private consecutiveFailures = 0;
	private halfOpenSuccesses = 0;
	private lastFailureTime: number | null = null;
	private lastStateChange: number;
	private readonly now: () => number;

	constructor(key: string, config?: Partial<CircuitBreakerConfig>, clock?: () => number) {
		this.key = key;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.now = clock ?? Date.now;
		this.lastStateChange = this.now();
	}

	/** Get a read-only snapshot of the breaker state. */
	snapshot(): CircuitBreakerSnapshot {
		return {
			state: this.getState(),
			consecutiveFailures: this.consecutiveFailures,
			halfOpenSuccesses: this.halfOpenSuccesses,
			lastFailureTime: this.lastFailureTime,
			lastStateChange: this.lastStateChange,
		};
	}

	/**
	 * Get the current state, applying automatic open → half-open transition
	 * when the reset timeout has elapsed.
	 */
	getState(): CircuitState {
		if (
			this.state === "open" &&
			this.lastFailureTime !== null &&
			this.now() - this.lastFailureTime >= this.config.resetTimeoutMs
		) {
			this.transitionTo("half-open");
		}
		return this.state;
	}

	/**
	 * Check whether a request should be allowed through.
	 * Throws CircuitOpenError if the circuit is open.
	 */
	allowRequest(): void {
		const current = this.getState();
		if (current === "open") {
			throw new CircuitOpenError(this.key);
		}
		// closed and half-open both allow requests
	}

	/** Record a successful request. */
	recordSuccess(): void {
		if (this.state === "half-open") {
			this.halfOpenSuccesses++;
			if (this.halfOpenSuccesses >= this.config.halfOpenSuccessThreshold) {
				this.transitionTo("closed");
			}
		} else {
			// Reset failure count on success in closed state
			this.consecutiveFailures = 0;
		}
	}

	/** Record a failed request. */
	recordFailure(): void {
		this.consecutiveFailures++;
		this.lastFailureTime = this.now();

		if (this.state === "half-open") {
			// Any failure in half-open reopens the circuit
			this.transitionTo("open");
		} else if (this.consecutiveFailures >= this.config.failureThreshold) {
			this.transitionTo("open");
		}
	}

	/** Force-reset the breaker to closed state (for admin/testing). */
	reset(): void {
		this.transitionTo("closed");
	}

	private transitionTo(newState: CircuitState): void {
		this.state = newState;
		this.lastStateChange = this.now();
		if (newState === "closed") {
			this.consecutiveFailures = 0;
			this.halfOpenSuccesses = 0;
		} else if (newState === "half-open") {
			this.halfOpenSuccesses = 0;
		}
	}
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry of circuit breakers keyed by string (e.g. provider, action).
 * Lazily creates breakers on first access.
 */
export class CircuitBreakerRegistry {
	private readonly breakers = new Map<string, CircuitBreaker>();
	private readonly config: Partial<CircuitBreakerConfig>;
	private readonly clock: (() => number) | undefined;

	constructor(config?: Partial<CircuitBreakerConfig>, clock?: () => number) {
		this.config = config ?? {};
		this.clock = clock;
	}

	/** Get or create a breaker for the given key. */
	get(key: string): CircuitBreaker {
		let breaker = this.breakers.get(key);
		if (breaker === undefined) {
			breaker = new CircuitBreaker(key, this.config, this.clock);
			this.breakers.set(key, breaker);
		}
		return breaker;
	}

	/** Get a snapshot of all breakers. */
	allSnapshots(): Record<string, CircuitBreakerSnapshot> {
		const result: Record<string, CircuitBreakerSnapshot> = {};
		for (const [key, breaker] of this.breakers) {
			result[key] = breaker.snapshot();
		}
		return result;
	}

	/** Reset all breakers to closed state. */
	resetAll(): void {
		for (const breaker of this.breakers.values()) {
			breaker.reset();
		}
	}

	/** Get the number of tracked breakers. */
	get size(): number {
		return this.breakers.size;
	}
}
