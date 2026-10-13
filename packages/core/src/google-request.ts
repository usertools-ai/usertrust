// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The governed Google request, read by the SDK's OWN pipeline.
 *
 * A governed `generateContent` / `generateContentStream` must check, meter and send ONE set of
 * values, and those values must be the ones the SDK would send for the caller's request. Describing
 * the SDK's reads by hand (field lists, read order, its copy and serialization semantics, its AFC
 * decision) kept missing them. So nothing here describes them: the SDK's `Models` pipeline itself runs
 * over the caller's request, behind a recording membrane, against a recording ApiClient that sends
 * nothing.
 *
 *   1. CAPTURE. The pipeline runs once over a membrane around the caller's `params`. Every read
 *      passes through to the caller's objects (each getter runs as often, in the same order, with the
 *      same receiver, as natively), and the SDK's writes land on them, as natively. The membrane
 *      records, per object, each key's FIRST read: the caller's state as the SDK first saw it.
 *      Callable tools are answered by stand-ins, so no `tool()` / `callTool()` of the caller runs
 *      before authorization.
 *   2. MATERIALIZE, twice. The recording becomes plain data (the mirror): tree A for the self-check,
 *      tree B for the send. Tree B has never been passed to the SDK when it is sent, so the send is
 *      a first pass, like the native one.
 *   3. SELF-CHECK. The pipeline runs again over tree A, with the same stand-ins and script. It must
 *      make the same `request()` / `requestStream()` calls, argument for argument (path, method,
 *      query, body bytes, `httpOptions`), and the same AFC outcome. If not, the call is refused.
 *
 * The AFC decision is the SDK's own: each callable is answered by a stand-in declaring a probe
 * function, the recorder's first answer calls it, and the SDK ran its loop iff it called a stand-in's
 * `callTool`. A local SDK error (incompatible tools, missing contents, a caller getter that throws)
 * is the SDK's own error, raised before anything is held or sent.
 */

import { types as utilTypes } from "node:util";
import { googleConfigRefusals, googleHttpOptionsRefusals } from "./default-deny.js";
import { governedCallable } from "./google-afc.js";

type Loose = Record<string, unknown>;

export type GoogleMethod = "generateContent" | "generateContentStream";

type ModelsLike = Record<GoogleMethod, (params: unknown) => Promise<unknown>>;

/** A `Models` class: `new Models(apiClient)` runs the SDK's request pipeline against `apiClient`. */
export type GoogleModelsCtor = new (apiClient: unknown) => ModelsLike;

/** The pipeline a governed client runs requests through, and the backend it serializes for. */
export interface GooglePipeline {
	readonly Models: GoogleModelsCtor;
	readonly vertexAI: boolean;
}

/** What one governed request becomes. */
export type GoogleSnapshot =
	| { kind: "ok"; params: unknown; afcRan: boolean; policy: Record<string | symbol, unknown> }
	| { kind: "afcStream" }
	| { kind: "refuse"; reason: string }
	| { kind: "optionRefused"; names: string[] }
	| { kind: "sdkError"; error: unknown };

/** Thrown inside the capture or materialization when the request cannot be represented: "can't tell". */
class CannotTell {
	constructor(readonly reason: string) {
		cannotTells.add(this);
	}
}

/** Ours, recognized without `instanceof`, which would run a caller's Proxy trap on a thrown value. */
const cannotTells = new WeakSet<object>();

function isCannotTell(error: unknown): error is CannotTell {
	return typeof error === "object" && error !== null && cannotTells.has(error);
}

// ── The recording ApiClient ──

/** One `request()` / `requestStream()` call, as the arguments the SDK passed (compared by the self-check). */
interface RecordedRequest {
	stream: boolean;
	path: unknown;
	httpMethod: unknown;
	queryParams: string | undefined;
	body: unknown;
	httpOptions: string | undefined;
	abortSignal: boolean;
}

/** The probe function each callable's stand-in declares; the recorder's first answer calls the first one. */
const PROBE = "__usertrust_probe_";

/** The scripted model answer to the n-th request: a call to the first probe, then text. */
function scriptedAnswer(n: number): Loose {
	const part = n === 0 ? { functionCall: { name: `${PROBE}0`, args: {} } } : { text: "" };
	return { candidates: [{ content: { role: "model", parts: [part] } }] };
}

/**
 * The request's `httpOptions` as the real ApiClient takes them (`patchHttpOptions`): ONE pass over
 * the caller's object, every own enumerable entry, an object value copied shallowly. Everything
 * after reads this copy, as natively, so each caller getter and trap there runs as often.
 */
function patchedHttpOptions(httpOptions: unknown): Loose | undefined {
	if (!httpOptions) return undefined;
	const patched: Loose = {};
	for (const [key, value] of Object.entries(httpOptions as Loose)) {
		if (typeof value === "object") patched[key] = Object.assign({}, value);
		else if (value !== undefined) patched[key] = value;
	}
	return patched;
}

/**
 * The patched options as JSON, without `extraBody`, which goes into the body (`transportBody`). A
 * header goes to the transport's `Headers` as `String(value)`, which is not what JSON makes of an
 * object (a `toJSON` and a `toString` can answer differently), and the SDK types headers as
 * strings: any other header value cannot be told.
 */
function httpOptionsForm(patched: Loose | undefined): string | undefined {
	if (patched === undefined) return undefined;
	const headers = patched["headers"];
	if (headers) {
		for (const value of Object.values(headers as Loose)) {
			if (typeof value !== "string") throw new CannotTell("a header value that is not a string");
		}
	}
	const { extraBody: _extraBody, ...rest } = patched;
	return JSON.stringify(rest);
}

/**
 * The body the transport sends: the SDK's ApiClient deep-merges the patched `extraBody` into the
 * request body and serializes the result (`includeExtraBodyToRequestInit`), so that is what the
 * self-check compares. The merge is the SDK's, step for step.
 */
function transportBody(body: unknown, patched: Loose | undefined): unknown {
	if (patched === undefined || patched["extraBody"] === null) return body;
	const extraBody = patched["extraBody"];
	if (!extraBody || Object.keys(extraBody).length === 0) return body;
	let current: unknown = {};
	if (typeof body === "string" && body.length > 0) {
		try {
			const parsed: unknown = JSON.parse(body);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
			current = parsed;
		} catch {
			return body;
		}
	}
	const deepMerge = (target: unknown, source: unknown): Loose => {
		const output: Loose = Object.assign({}, target);
		for (const key in source as Loose) {
			if (Object.hasOwn(source as object, key)) {
				const sourceValue = (source as Loose)[key];
				const targetValue = output[key];
				if (
					sourceValue &&
					typeof sourceValue === "object" &&
					!Array.isArray(sourceValue) &&
					targetValue &&
					typeof targetValue === "object" &&
					!Array.isArray(targetValue)
				) {
					output[key] = deepMerge(targetValue, sourceValue);
				} else {
					output[key] = sourceValue;
				}
			}
		}
		return output;
	};
	return JSON.stringify(deepMerge(current, extraBody));
}

/** An ApiClient that records each request and answers from the script; nothing is sent. */
function recordingClient(
	vertexAI: boolean,
	sink: RecordedRequest[],
	onTransport: (value: unknown) => void = () => {},
): Loose {
	const record = (stream: boolean, request: unknown): Loose => {
		const r = request as Loose;
		// The abort signal goes to the transport as it is: the request keeps it by reference.
		if (r["abortSignal"] !== undefined) onTransport(r["abortSignal"]);
		const patched = patchedHttpOptions(r["httpOptions"]);
		sink.push({
			stream,
			path: r["path"],
			httpMethod: r["httpMethod"],
			queryParams: r["queryParams"] === undefined ? undefined : JSON.stringify(r["queryParams"]),
			body: transportBody(r["body"], patched),
			httpOptions: httpOptionsForm(patched),
			abortSignal: r["abortSignal"] !== undefined,
		});
		return scriptedAnswer(sink.length - 1);
	};
	return {
		isVertexAI: () => vertexAI,
		getProject: () => undefined,
		getLocation: () => undefined,
		getDefaultHeaders: () => ({}),
		request: async (request: unknown) => {
			const answer = record(false, request);
			return { headers: {}, json: async () => answer };
		},
		requestStream: async (request: unknown) => {
			const answer = record(true, request);
			return (async function* () {
				yield { headers: {}, json: async () => answer };
			})();
		},
	};
}

/** The callables' stand-ins: what the SDK sees instead of the caller's `tool()` / `callTool()`. */
interface StandIns {
	/** Set when the SDK called a stand-in `callTool`: it ran its AFC loop. Reset per pipeline run. */
	afcRan: boolean;
	count: number;
}

function standInFunctions(
	standIns: StandIns,
	index: number,
): { tool: () => Promise<Loose>; callTool: () => Promise<unknown[]> } {
	return {
		tool: async () => ({ functionDeclarations: [{ name: `${PROBE}${index}` }] }),
		// It answers as a tool that ran: one function response. The SDK's stream loop ends a round that
		// yields none, so an empty answer would stop the dry run short of the native loop's reads.
		callTool: async () => {
			standIns.afcRan = true;
			return [{ functionResponse: { name: `${PROBE}${index}`, response: {} } }];
		},
	};
}

/** Run the SDK's pipeline for `method` over `params` against a recorder (into `sink`); a stream is drained. */
async function runPipeline(
	pipeline: GooglePipeline,
	method: GoogleMethod,
	params: unknown,
	sink: RecordedRequest[] = [],
	onTransport?: (value: unknown) => void,
): Promise<RecordedRequest[]> {
	const models = new pipeline.Models(recordingClient(pipeline.vertexAI, sink, onTransport));
	const out = await models[method](params);
	if (method === "generateContentStream") {
		for await (const _ of out as AsyncIterable<unknown>) {
			// drained: an AFC stream makes its requests while it is read
		}
	}
	return sink;
}

// ── The recording membrane ──

/** Where an object was reached from, as far as the stand-ins need to know. */
type Role = "params" | "config" | "httpOptions" | "tools" | "toolEntry" | undefined;

/**
 * What the SDK read at one place in the request: the root, or one key of a recorded object. Each
 * object the SDK reaches gets its own proxy, and passes reads through to ITSELF; but an object read
 * again from the same place (a getter that builds a fresh object on each read) records into the
 * recording of the first one read there. So each place keeps each key's FIRST read, whichever object
 * it came through.
 */
interface Recording {
	/** The first object read here: what a callable is forwarded as. */
	real: object;
	isArray: boolean;
	isFunction: boolean;
	role: Role;
	/** Each string key's FIRST read (a membrane proxy, or a primitive), in first-read order. */
	reads: Map<string, unknown>;
	/** Keys `in` found that were never read: present, value unknown to the SDK. */
	present: Set<string>;
	/** Keys the SDK wrote before ever reading them: it writes them again over the mirror. */
	sdkWrote: Set<string>;
	/** The caller's own key order, as `ownKeys` first answered. */
	keysSeen?: (string | symbol)[];
	/** Every string key any `ownKeys` answer here listed. */
	ownSeen: Set<string>;
	/** Each key's enumerability, as the last descriptor the SDK asked for reported it. */
	enumerable: Map<string, boolean>;
	/** The real prototype, when the SDK asked for it. */
	proto?: object | null;
	touched: boolean;
	/** Handed to the transport as it is (an abort signal): kept by reference if the SDK read nothing of it. */
	transport?: boolean;
	/** A string key other than `toJSON` was read: the SDK read the object by name. */
	readByName: boolean;
	/** The first result of a `toJSON` hook here, when `JSON.stringify` called it. */
	jsonOut?: { value: unknown };
	/** A callable tool: its stand-ins and their probe index. */
	callable?: { index: number; tool: () => Promise<Loose>; callTool: () => Promise<unknown[]> };
}

/** One membrane proxy: the caller's object it passes through to, and the recording it records into. */
interface Wrapped {
	real: object;
	rec: Recording;
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Does `key` exist on `obj` or its prototype chain? Descriptors only, so no getter runs; a Proxy on
 * the chain answers "no" without being asked (its trap would be caller code the SDK did not run).
 * A read that found nothing records nothing: the mirror must not gain a key the caller's object
 * lacks, which an SDK `in` test would then find.
 */
function presentWithoutTraps(obj: object, key: string): boolean {
	for (let o: object | null = obj; o !== null; o = Object.getPrototypeOf(o)) {
		if (utilTypes.isProxy(o)) return false;
		if (Object.getOwnPropertyDescriptor(o, key) !== undefined) return true;
	}
	return false;
}

/** The built-in prototypes of this realm and of the host: a method found on one of them is not caller code. */
const INTRINSIC_PROTOTYPES: ReadonlySet<object> = new Set<object>([
	...[
		Object,
		Array,
		Function,
		String,
		Number,
		Boolean,
		Symbol,
		BigInt,
		Date,
		RegExp,
		Error,
		Map,
		Set,
		WeakMap,
		WeakSet,
		Promise,
		ArrayBuffer,
		DataView,
		Int8Array,
		Uint8Array,
		Uint8ClampedArray,
		Int16Array,
		Uint16Array,
		Int32Array,
		Uint32Array,
		Float32Array,
		Float64Array,
		BigInt64Array,
		BigUint64Array,
		...["Buffer", "URL", "URLSearchParams", "AbortSignal", "EventTarget", "Blob"].map(
			(name) => (globalThis as Loose)[name],
		),
	]
		.filter((ctor): ctor is { prototype: object } => typeof ctor === "function")
		.map((ctor) => ctor.prototype),
	Object.getPrototypeOf(Uint8Array.prototype) as object,
]);

/**
 * Every built-in method of this realm and host: each function held as an own data property of a
 * built-in prototype. A function the SDK reads is built-in only if it IS one of these, wherever it
 * was found (a Proxy's trap may hand back `Array.prototype.map` itself): its output is then a
 * function of what it read through the membrane, which is recorded.
 */
const INTRINSIC_METHODS: ReadonlySet<unknown> = new Set(
	[...INTRINSIC_PROTOTYPES].flatMap((proto) =>
		Reflect.ownKeys(proto).flatMap((key) => {
			const d = Object.getOwnPropertyDescriptor(proto, key);
			return d !== undefined && "value" in d && typeof d.value === "function" ? [d.value] : [];
		}),
	),
);

const functionSource = Function.prototype.toString;

/**
 * Is `fn`, read at `key`, a built-in method? This realm's are known by identity. Another realm's
 * (an array made in a `vm` context, or parsed by a host whose realm is not this module's) are known
 * by their own source text, `function <key>() { [native code] }`, which only a built-in function
 * prints: a bound function and a Proxy print no name, and a caller's function prints its code.
 * That source text is V8's `Function.prototype.toString` (captured when this module loads), which
 * this check relies on: usertrust runs on Node only.
 */
function isBuiltInMethod(fn: unknown, key: string): boolean {
	if (INTRINSIC_METHODS.has(fn)) return true;
	if (typeof fn !== "function" || utilTypes.isProxy(fn)) return false;
	try {
		return Reflect.apply(functionSource, fn, []) === `function ${key}() { [native code] }`;
	} catch {
		return false;
	}
}

const ARRAY_SPECIES_GETTER = Object.getOwnPropertyDescriptor(Array, Symbol.species)?.get;
const ARRAY_SPECIES_SOURCE =
	ARRAY_SPECIES_GETTER === undefined
		? undefined
		: Reflect.apply(functionSource, ARRAY_SPECIES_GETTER, []);

/**
 * Does an array's constructor `ctor` (an Array subclass, or another realm's Array) take the default
 * `Symbol.species`, the built-in getter it inherits from Array (this realm's by identity, another's
 * by its native source text, as `isBuiltInMethod`)? Then the SDK's own `map` natively builds an
 * instance of that class with the same items, which serializes as the plain array answered for it.
 * Descriptors only, no caller code; a Proxy on the way, or a chain past 64, is not the default.
 */
function hasDefaultSpecies(ctor: unknown): boolean {
	let o: unknown = ctor;
	for (let depth = 0; depth < 64; depth++) {
		if (o === null || (typeof o !== "object" && typeof o !== "function")) return true;
		if (utilTypes.isProxy(o)) return false;
		const d = Object.getOwnPropertyDescriptor(o, Symbol.species);
		if (d !== undefined) {
			const get = "get" in d ? d.get : undefined;
			if (get === undefined || utilTypes.isProxy(get)) return false;
			if (get === ARRAY_SPECIES_GETTER) return true;
			try {
				return Reflect.apply(functionSource, get, []) === ARRAY_SPECIES_SOURCE;
			} catch {
				return false;
			}
		}
		o = Object.getPrototypeOf(o);
	}
	return false;
}

/** For each well-known symbol, the source text of this realm's built-in methods held under it. */
const INTRINSIC_SYMBOL_SOURCES: ReadonlyMap<symbol, ReadonlySet<string>> = (() => {
	const sources = new Map<symbol, Set<string>>();
	for (const proto of INTRINSIC_PROTOTYPES) {
		for (const key of Object.getOwnPropertySymbols(proto)) {
			const d = Object.getOwnPropertyDescriptor(proto, key);
			if (d === undefined || !("value" in d) || typeof d.value !== "function") continue;
			let set = sources.get(key);
			if (set === undefined) {
				set = new Set();
				sources.set(key, set);
			}
			set.add(Reflect.apply(functionSource, d.value, []) as string);
		}
	}
	return sources;
})();

/**
 * Is `fn`, read at the symbol `key`, a built-in method (an array's own `[Symbol.iterator]`, say)?
 * This realm's by identity; another realm's when its source text is that of this realm's built-in
 * under the same symbol, which only a built-in prints (V8's `Function.prototype.toString`, as
 * `isBuiltInMethod`). A built-in iterator over a membrane proxy reads its items through the
 * membrane; a caller's iterator could hand the SDK raw objects, past the membrane and its stand-ins.
 */
function isBuiltInSymbolMethod(fn: unknown, key: symbol): boolean {
	if (INTRINSIC_METHODS.has(fn)) return true;
	if (typeof fn !== "function" || utilTypes.isProxy(fn)) return false;
	try {
		return INTRINSIC_SYMBOL_SOURCES.get(key)?.has(Reflect.apply(functionSource, fn, [])) === true;
	} catch {
		return false;
	}
}

/** What a boxed primitive serializes as (`JSON.stringify` unboxes Number, String and Boolean objects). */
function unboxed(value: object): unknown {
	if (utilTypes.isNumberObject(value)) return Number.prototype.valueOf.call(value);
	if (utilTypes.isStringObject(value)) return String.prototype.valueOf.call(value);
	if (utilTypes.isBooleanObject(value)) return Boolean.prototype.valueOf.call(value);
	// A BigInt object throws in JSON.stringify, natively and in the capture, before any mirror is built.
	if (utilTypes.isBigIntObject(value)) throw new CannotTell("a BigInt in the request");
	return {}; // a Symbol object serializes as an empty object
}

const BUILT_IN_CONVERSIONS = new Map<object, readonly unknown[]>([
	[Number.prototype, [Number.prototype.toString, Number.prototype.valueOf]],
	[String.prototype, [String.prototype.toString, String.prototype.valueOf]],
]);

/**
 * What JSON.stringify makes of a boxed primitive that carries fields of its own: a Boolean object's
 * boolean; a BigInt object's bigint (which JSON then refuses, as natively); a Number or String object
 * converted through its `Symbol.toPrimitive`, `toString` and `valueOf`. Those are read as descriptors
 * (no caller code), and must be this realm's built-ins, reached on its built-in prototype past
 * prototypes that hold none of them: a conversion of the caller's is a function JSON would call, so
 * can't tell.
 */
function jsonUnboxed(real: object): unknown {
	if (utilTypes.isBooleanObject(real)) return Boolean.prototype.valueOf.call(real);
	if (utilTypes.isBigIntObject(real)) return BigInt.prototype.valueOf.call(real);
	const builtIn = utilTypes.isNumberObject(real) ? Number.prototype : String.prototype;
	const keys = [Symbol.toPrimitive, "toString", "valueOf"] as const;
	let o: object | null = real;
	for (let depth = 0; o !== builtIn; depth++) {
		if (o === null || depth >= 64 || utilTypes.isProxy(o)) break;
		const holder: object = o;
		if (keys.some((key) => Object.getOwnPropertyDescriptor(holder, key) !== undefined)) break;
		o = Object.getPrototypeOf(holder);
	}
	const own = (key: string) => Object.getOwnPropertyDescriptor(builtIn, key)?.value;
	if (
		o !== builtIn ||
		Object.getOwnPropertyDescriptor(builtIn, Symbol.toPrimitive) !== undefined ||
		own("toString") !== BUILT_IN_CONVERSIONS.get(builtIn)?.[0] ||
		own("valueOf") !== BUILT_IN_CONVERSIONS.get(builtIn)?.[1]
	) {
		throw new CannotTell("a boxed value converted by a function of the caller's");
	}
	return utilTypes.isNumberObject(real)
		? Number.prototype.valueOf.call(real)
		: String.prototype.valueOf.call(real);
}

/**
 * A boxed primitive with nothing of its own beyond its primitive (a String object's index keys and
 * `length`), on its type's built-in prototype: JSON.stringify unboxes it and nothing else of it can
 * be read, so it goes as it is. Any other (a Number object carrying a `tool` and a `callTool`, say)
 * is an ordinary object to the membrane: wrapped, its fields recorded, a callable answered by the
 * stand-ins. Descriptors only, no caller code.
 */
function isPureBoxedPrimitive(value: object): boolean {
	if (!utilTypes.isBoxedPrimitive(value)) return false;
	const proto = Object.getPrototypeOf(value);
	const builtIn = utilTypes.isNumberObject(value)
		? Number.prototype
		: utilTypes.isStringObject(value)
			? String.prototype
			: utilTypes.isBooleanObject(value)
				? Boolean.prototype
				: utilTypes.isBigIntObject(value)
					? BigInt.prototype
					: Symbol.prototype;
	if (proto !== builtIn) return false;
	const length = utilTypes.isStringObject(value) ? String.prototype.valueOf.call(value).length : 0;
	return Reflect.ownKeys(value).every(
		(key) =>
			typeof key === "string" &&
			((utilTypes.isStringObject(value) && key === "length") ||
				(ARRAY_INDEX.test(key) && Number(key) < length)),
	);
}

function childRole(parent: Role, key: string): Role {
	if (parent === "params" && key === "config") return "config";
	if (parent === "config" && key === "httpOptions") return "httpOptions";
	if (parent === "config" && key === "tools") return "tools";
	if (parent === "tools" && ARRAY_INDEX.test(key)) return "toolEntry";
	return undefined;
}

interface Membrane {
	wrap(value: unknown, role: Role): unknown;
	materialize(value: unknown, tree: "check" | "send"): unknown;
	markTransport(value: unknown): void;
	standIns: StandIns;
	/** Why the capture cannot be told, when the SDK called a caller function. */
	tripped(): string | undefined;
	/** What the per-call option check refuses in an `httpOptions` the SDK reached (its names). */
	optionRefusals(): string[];
}

/**
 * `absorbing()` answers true once the dry run has made its first request: from then on the SDK's
 * writes react to the recorder's scripted answers, not to the caller's request, so they are absorbed
 * (neither written through to the caller's objects nor recorded).
 */
/**
 * `params.config.httpOptions` as call start pinned it (see `snapshotGoogleRequest`): served for
 * that PATH, whichever config object a later read returns, in place of any read of the caller's.
 */
export interface PinnedHttpOptions {
	/** The governed copy, or `undefined`: absent at call start, so absent at every later read. */
	readonly httpOptions: Record<string, unknown> | undefined;
	/** Whether it was an enumerable property at call start. */
	readonly enumerable: boolean;
}

function makeMembrane(
	absorbing: () => boolean = () => false,
	pinned?: PinnedHttpOptions,
): Membrane {
	const proxies = new Map<object, Wrapped>(); // proxy -> what it wraps
	const byReal = new WeakMap<object, object>(); // caller's object -> its proxy
	const standIns: StandIns = { afcRan: false, count: 0 };
	/**
	 * Set when the SDK called a function of the caller's. The function never runs: its proxy throws
	 * instead (what it would have returned is unknown, and could hand the SDK raw caller objects past
	 * the membrane), and the request is refused even if the SDK swallowed that throw.
	 */
	let tripped: string | undefined;
	/**
	 * The per-call option check, on what the SDK reaches past an accessor `config` or `httpOptions`
	 * (call start deferred those): the config before its `httpOptions` is read, and the `httpOptions`
	 * object before any of its keys is, from descriptors, as call start checks a data path. A refusal
	 * stops the dry run there, before anything of it runs (an accessor key's getter included); the
	 * mirror's plain copy would no longer show what was refused.
	 */
	const optionRefusals = new Set<string>();
	function refuseOptions(names: string[]): void {
		if (names.length === 0) return;
		for (const name of names) optionRefusals.add(name);
		throw new CannotTell("request options the per-call check refuses");
	}

	function trip(): never {
		tripped ??= "the SDK called a function the request holds";
		throw new CannotTell(tripped);
	}

	/** Replace every membrane proxy inside an SDK-built value with the caller's real object. */
	function unwrapDeep(value: unknown, seen = new Set<object>()): unknown {
		if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
		const w = proxies.get(value);
		if (w !== undefined) return w.real;
		if (typeof value === "function" || seen.has(value)) return value;
		seen.add(value);
		for (const key of Object.keys(value)) {
			const d = Object.getOwnPropertyDescriptor(value, key);
			if (d === undefined || !("value" in d)) continue;
			const unwrapped = unwrapDeep(d.value, seen);
			if (unwrapped !== d.value) (value as Loose)[key] = unwrapped;
		}
		return value;
	}

	function record(rec: Recording, key: string, value: unknown): void {
		if (typeof value === "function" && !proxies.has(value)) return; // methods are not data
		if (rec.reads.has(key) || rec.sdkWrote.has(key)) return;
		rec.reads.set(key, value);
	}

	function newRecording(real: object, role: Role): Recording {
		return {
			real,
			isArray: Array.isArray(real),
			isFunction: typeof real === "function",
			role,
			reads: new Map(),
			present: new Set(),
			sdkWrote: new Set(),
			ownSeen: new Set(),
			enumerable: new Map(),
			touched: false,
			readByName: false,
		};
	}

	/**
	 * The membrane proxy for `value`. `place` is the recording already holding the first object read
	 * at the same place, if any: a different object read there records into it.
	 */
	function wrap(value: unknown, role: Role, place?: Recording): unknown {
		if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
		// A boxed primitive goes as it is: it has no fields the SDK reads, and JSON.stringify unboxes
		// it (the mirror unboxes it the same way).
		if (isPureBoxedPrimitive(value)) return value;
		if (proxies.has(value)) return value;
		const known = byReal.get(value);
		if (known !== undefined) {
			const rec = (proxies.get(known) as Wrapped).rec;
			rec.role ??= role;
			return known;
		}
		const real = value;
		const isArray = Array.isArray(real);
		const rec =
			place !== undefined &&
			place.isArray === isArray &&
			place.isFunction === (typeof real === "function")
				? place
				: newRecording(real, role);
		// A function's shadow is constructible, so `new` reaches the construct trap (which trips).
		const shadow: object = typeof real === "function" ? function shadow() {} : isArray ? [] : {};
		if (isArray) (shadow as unknown[]).length = (real as unknown[]).length;
		const self: Wrapped = { real, rec };
		/** Is `key` here the pinned path, `params.config.httpOptions`? */
		const pinnedHere = (key: string | symbol): boolean =>
			pinned !== undefined && key === "httpOptions" && rec.role === "config";
		const proxy = new Proxy(shadow, {
			get(_t, key) {
				if (typeof key === "symbol") {
					const sv = Reflect.get(real, key, real);
					if (typeof sv === "function")
						return isBuiltInSymbolMethod(sv, key) ? sv : wrap(sv, undefined);
					return sv !== null && typeof sv === "object" ? wrap(sv, undefined) : sv;
				}
				rec.touched = true;
				// PASS-THROUGH: every access reads the caller's object, with it as the receiver. One path
				// is pinned: `params.config.httpOptions` answers the call-start copy (or absent), whichever
				// config object this is; the caller's own property is never read for it.
				const pin = pinnedHere(key);
				const options = rec.role === "config" && key === "httpOptions" && !pin;
				if (options) refuseOptions(googleConfigRefusals(real));
				if (rec.role === "httpOptions") refuseOptions(googleHttpOptionsRefusals(real));
				const v = pin ? pinned?.httpOptions : Reflect.get(real, key, real);
				if (options) refuseOptions(googleHttpOptionsRefusals(v));
				// A Proxy config past an accessor (call start deferred it); with the path pinned, the SDK
				// is served the pinned httpOptions whatever config it reads, as before.
				if (
					pinned === undefined &&
					rec.role === "params" &&
					key === "config" &&
					utilTypes.isProxy(v)
				) {
					refuseOptions(["config.httpOptions (unreadable)"]);
				}
				if (
					rec.role === "toolEntry" &&
					(key === "tool" || key === "callTool") &&
					typeof v === "function"
				) {
					// The send forwards the place's FIRST object as the callable. A callable read here through
					// another object while the first was not seen as one (a getter that answered with a
					// different tool) cannot be told apart; a callable answered again by an equivalent fresh
					// object (a getter that builds one per read) is the first one's.
					if (real !== rec.real && rec.callable === undefined) {
						throw new CannotTell("a tool entry the SDK read as two different objects");
					}
					if (rec.callable === undefined) {
						const index = standIns.count++;
						rec.callable = { index, ...standInFunctions(standIns, index) };
					}
					return rec.callable[key];
				}
				if (key === "toJSON") {
					if (typeof v !== "function") {
						// A boxed primitive the membrane wraps (one carrying fields of its own): JSON.stringify,
						// finding no hook, unboxes it. The proxy has no primitive inside it, so it answers that
						// unboxing as the hook, and the mirror holds what JSON makes of it, as for any hook.
						if (!utilTypes.isBoxedPrimitive(real) || utilTypes.isSymbolObject(real)) return v;
						return () => {
							const out = jsonUnboxed(real);
							rec.jsonOut ??= { value: out };
							return out;
						};
					}
					// JSON.stringify calls the hook with its key: the hook read NOW runs on the real object,
					// each time, as natively (a getter may answer a different hook on each read); the FIRST
					// result is what this place serialized to, and the self-check sees any later difference.
					const hook = v as (k: unknown) => unknown;
					return (k: unknown) => {
						const out = wrap(Reflect.apply(hook, real, [k]), undefined);
						rec.jsonOut ??= { value: out };
						return out;
					};
				}
				rec.readByName = true;
				// An array's `constructor` is read by the SDK's own array methods (`map`, `filter`) to make
				// their result (ArraySpeciesCreate). Natively another realm's Array is replaced by this
				// realm's there; a caller's Array subclass would be constructed, running its code. Both
				// answer this realm's Array: the result is a plain array, which serializes the same.
				if (key === "constructor" && isArray && typeof v === "function" && v !== Array) {
					// A species of the caller's own would be constructed natively (what it builds is not
					// the plain array answered here): can't tell, and it never runs.
					if (!hasDefaultSpecies(v))
						throw new CannotTell("an array whose class names its own Symbol.species");
					return Array;
				}
				// A built-in method goes to the SDK as it is. Any other function (an own or a
				// user-prototype method, a function-valued field) is the caller's: it is data to the
				// membrane (its fields and its toJSON read through, recorded), and calling it trips.
				if (typeof v === "function" && isBuiltInMethod(v, key)) return v;
				const prior = rec.reads.get(key);
				const priorRec =
					prior !== null && typeof prior === "object" ? proxies.get(prior)?.rec : undefined;
				const w = wrap(v, childRole(rec.role, key), priorRec);
				if (v !== undefined || (!pin && presentWithoutTraps(real, key))) record(rec, key, w);
				return w;
			},
			has(_t, key) {
				rec.touched = true;
				const found = pinnedHere(key) ? pinned?.httpOptions !== undefined : Reflect.has(real, key);
				if (found && typeof key === "string" && !rec.reads.has(key)) rec.present.add(key);
				return found;
			},
			ownKeys() {
				rec.touched = true;
				let keys = Reflect.ownKeys(real);
				if (pinnedHere("httpOptions")) {
					keys = keys.filter((k) => k !== "httpOptions");
					if (pinned?.httpOptions !== undefined) keys.push("httpOptions");
				}
				rec.keysSeen ??= keys;
				for (const k of keys) if (typeof k === "string") rec.ownSeen.add(k);
				return keys;
			},
			getOwnPropertyDescriptor(t, key) {
				rec.touched = true;
				if (isArray && key === "length") {
					const length = (real as unknown[]).length;
					(t as unknown[]).length = length;
					return { value: length, writable: true, enumerable: false, configurable: false };
				}
				const d = pinnedHere(key)
					? pinned?.httpOptions === undefined
						? undefined
						: { value: pinned.httpOptions, enumerable: pinned.enumerable }
					: Reflect.getOwnPropertyDescriptor(real, key);
				if (typeof key === "string") rec.enumerable.set(key, d?.enumerable === true);
				if (d === undefined) return undefined;
				return {
					value: undefined,
					writable: true,
					enumerable: d.enumerable === true,
					configurable: true,
				};
			},
			// WRITE-THROUGH: the SDK's writes land on the caller's object, as natively, with no
			// membrane proxy stored in it. They are not recorded: the SDK writes them again over the
			// mirror, which keeps the state the SDK first read.
			// After the dry run's first request, writes are absorbed (see makeMembrane).
			set(_t, key, v) {
				if (absorbing()) return true;
				rec.touched = true;
				if (typeof key === "string" && !rec.reads.has(key)) rec.sdkWrote.add(key);
				return Reflect.set(real, key, unwrapDeep(v), real);
			},
			deleteProperty(_t, key) {
				if (absorbing()) return true;
				rec.touched = true;
				return Reflect.deleteProperty(real, key);
			},
			getPrototypeOf() {
				rec.touched = true;
				const proto = Reflect.getPrototypeOf(real);
				if (!("proto" in rec)) rec.proto = proto;
				return proto;
			},
			apply() {
				return trip();
			},
			construct() {
				return trip();
			},
			defineProperty() {
				throw new CannotTell("the SDK defined a property on the request");
			},
			setPrototypeOf() {
				throw new CannotTell("the SDK set a prototype on the request");
			},
			preventExtensions() {
				throw new CannotTell("the SDK made the request non-extensible");
			},
		});
		proxies.set(proxy, self);
		byReal.set(real, proxy);
		return proxy;
	}

	function setData(obj: object, key: string, value: unknown, enumerable = true): void {
		Object.defineProperty(obj, key, { value, writable: true, enumerable, configurable: true });
	}

	/**
	 * Is `key` enumerable here, as the SDK saw it? Where the SDK enumerated this object (an
	 * `Object.assign`, a `JSON.stringify`), a key it also read by name that those passes did not list
	 * as own and enumerable (an inherited or non-enumerable field) is HIDDEN in the mirror too, a
	 * non-enumerable own property: by-name reads find it, `Object.assign` and `JSON.stringify` skip it,
	 * as natively. Where the SDK never enumerated the object, no reader will: every key is visible.
	 */
	function visible(rec: Recording, key: string): boolean {
		if (rec.keysSeen === undefined) return true;
		return rec.ownSeen.has(key) && rec.enumerable.get(key) !== false;
	}

	/** One materialization: the tree it builds, and each callable placed in it so far. */
	interface Build {
		tree: "check" | "send";
		callables: Set<Recording>;
	}

	function materialize(value: unknown, tree: "check" | "send"): unknown {
		return materializeNode(value, { tree, callables: new Set() }, new Set(), false);
	}

	function materializeNode(
		value: unknown,
		build: Build,
		stack: Set<Recording>,
		toolSlot: boolean,
	): unknown {
		if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
		if (utilTypes.isBoxedPrimitive(value)) return unboxed(value);
		const w = proxies.get(value);
		if (w === undefined) return value; // not one of ours: a value the SDK built
		const rec = w.rec;
		if (rec.callable !== undefined) {
			// A callable stands only at a config.tools[i] slot, once. The same object at another slot
			// (an alias of another config field) would hand the real tool() a part of the request the
			// stand-ins never answered for.
			if (!toolSlot || build.callables.has(rec)) {
				throw new CannotTell("a callable tool the request also holds outside config.tools");
			}
			build.callables.add(rec);
			// The send holds a governed wrapper (its real tool() runs after authorization, inside the
			// first round); the self-check gets the capture's stand-in, so no caller tool()/callTool()
			// runs in it.
			return build.tree === "send"
				? governedCallable(rec.real, callableProto(rec))
				: standInCallable(rec, build, stack);
		}
		if (rec.jsonOut !== undefined) {
			if (rec.readByName) {
				throw new CannotTell("an object the SDK both read by name and serialized through toJSON");
			}
			return materializeNode(rec.jsonOut.value, build, stack, false);
		}
		// A function of the caller's (never called: calling it trips) is a fresh inert function holding
		// what the SDK read of it: JSON.stringify omits a function, as natively.
		const shell = (): object => (rec.isFunction ? () => undefined : {});
		// Never read: a transport value (an AbortSignal) goes as it is; anything else sends nothing of
		// itself, so it is an empty object (or an inert function), never the caller's.
		if (!rec.touched) return rec.transport === true ? w.real : rec.isArray ? [] : shell();
		if (stack.has(rec)) throw new CannotTell("a cycle in the request");
		stack.add(rec);
		try {
			return rec.isArray
				? materializeArray(rec, build, stack)
				: materializeObject(rec, build, stack, shell());
		} finally {
			stack.delete(rec);
		}
	}

	function materializeArray(rec: Recording, build: Build, stack: Set<Recording>): unknown[] {
		// The FIRST `length` read is the array's length, as for any key: an entry read later, past it
		// (one a caller hook appended after the SDK took its length), is not part of it.
		const read = rec.reads.get("length");
		let length = typeof read === "number" ? read : 0;
		if (!rec.reads.has("length")) {
			for (const key of rec.reads.keys()) {
				if (ARRAY_INDEX.test(key)) length = Math.max(length, Number(key) + 1);
			}
		}
		let out: unknown[];
		try {
			out = new Array(length);
		} catch {
			throw new CannotTell("an array length the mirror cannot hold");
		}
		for (const [key, v] of rec.reads) {
			if (ARRAY_INDEX.test(key) && Number(key) < length)
				out[Number(key)] = materializeNode(v, build, stack, rec.role === "tools");
		}
		return out;
	}

	function materializeObject(
		rec: Recording,
		build: Build,
		stack: Set<Recording>,
		out: object,
		skip: readonly string[] = [],
	): object {
		const readKeys = [...rec.reads.keys()];
		const own = rec.keysSeen?.filter((k): k is string => typeof k === "string") ?? [];
		// Membership by Set (the arrays keep the order): a large object is materialized in linear time.
		const ownSet = new Set(own);
		const skipSet = new Set(skip);
		const order = [
			...own.filter((k) => rec.reads.has(k) || rec.present.has(k)),
			...readKeys.filter((k) => !ownSet.has(k)),
			...[...rec.present].filter((k) => !ownSet.has(k) && !rec.reads.has(k)),
		];
		for (const key of order) {
			if (skipSet.has(key)) continue;
			const read = rec.reads.get(key);
			// The transport slot keeps its value BY REFERENCE at its path: an abort signal the SDK handed
			// to the transport goes as it is, even when the same object was reached, and serialized,
			// somewhere else first (there it materializes as JSON makes it).
			const transport =
				rec.role === "config" && key === "abortSignal" && read !== null && typeof read === "object"
					? proxies.get(read)
					: undefined;
			const value =
				transport?.rec.transport === true
					? transport.real
					: rec.reads.has(key)
						? materializeNode(read, build, stack, false)
						: undefined;
			setData(out, key, value, visible(rec, key));
		}
		return out;
	}

	/** A callable's prototype: the one the SDK was answered with, else read without running a trap. */
	function callableProto(rec: Recording): object | null {
		if (rec.proto !== undefined) return rec.proto;
		return utilTypes.isProxy(rec.real) ? Object.prototype : Object.getPrototypeOf(rec.real);
	}

	/** A callable's stand-in for the self-check: its prototype, what the SDK read of it, and the stand-ins. */
	function standInCallable(rec: Recording, build: Build, stack: Set<Recording>): object {
		const callable = rec.callable as NonNullable<Recording["callable"]>;
		const proto = rec.proto === undefined ? Object.prototype : rec.proto;
		const out = materializeObject(rec, build, stack, Object.create(proto) as object, [
			"tool",
			"callTool",
		]);
		setData(out, "tool", callable.tool);
		setData(out, "callTool", callable.callTool);
		return out;
	}

	function markTransport(value: unknown): void {
		const w = value !== null && typeof value === "object" ? proxies.get(value) : undefined;
		if (w !== undefined) w.rec.transport = true;
	}

	return {
		wrap: (value, role) => wrap(value, role),
		materialize,
		markTransport,
		standIns,
		tripped: () => tripped,
		optionRefusals: () => [...optionRefusals],
	};
}

// ── The pipeline: resolved once per governed client ──

/**
 * A `Models` class is accepted only if it BEHAVES as the SDK's pipeline: `generateContent` on a
 * one-word prompt makes exactly one request, whose body carries that prompt as one user turn. Behaviour,
 * not names, so an SDK that renames its internals still passes.
 */
async function probeModels(Models: unknown): Promise<GoogleModelsCtor | undefined> {
	if (typeof Models !== "function") return undefined;
	try {
		const sink: RecordedRequest[] = [];
		const models = new (Models as GoogleModelsCtor)(recordingClient(false, sink));
		if (typeof models?.generateContent !== "function") return undefined;
		if (typeof models.generateContentStream !== "function") return undefined;
		await models.generateContent({ model: "m", contents: "x" });
		if (sink.length !== 1 || typeof sink[0]?.body !== "string") return undefined;
		const body = JSON.parse(sink[0].body) as Loose;
		const turn = JSON.stringify(body["contents"]);
		return turn === JSON.stringify([{ parts: [{ text: "x" }], role: "user" }])
			? (Models as GoogleModelsCtor)
			: undefined;
	} catch {
		return undefined;
	}
}

/** The installed `@google/genai`'s `Models`, if the optional peer is there. */
async function installedModels(): Promise<unknown> {
	const specifier = "@google/genai";
	try {
		const mod = (await import(specifier)) as Loose;
		return mod["Models"];
	} catch {
		return undefined;
	}
}

/**
 * The pipeline for a governed Google client: the installed `@google/genai`'s `Models` class, accepted
 * after the behavioural probe; else none, and its requests are refused. The client's own class is
 * not read: for the SDK's own client it IS that class, and any other is never run.
 */
export async function resolveGooglePipeline(
	_client: unknown,
	vertexAI: boolean,
): Promise<GooglePipeline | undefined> {
	// The client's own Models class would be accepted only when it IS the installed SDK's, which is
	// the class used here either way: an unverified constructor is never run, not even by the probe.
	const installed = await probeModels(await installedModels());
	return installed !== undefined ? { Models: installed, vertexAI } : undefined;
}

// ── One governed request ──

/**
 * A thrown value's class, for the audit record: never its message, which may carry the caller's
 * content (a getter can throw anything). Read without running caller code (own data properties only,
 * no Proxy), and only when it is a plain identifier; anything else is "a non-error value" or "Error".
 */
export function errorClass(error: unknown): string {
	if (typeof error !== "object" || error === null) return "a non-error value";
	let proto: unknown = error;
	for (let depth = 0; depth < 64 && typeof proto === "object" && proto !== null; depth++) {
		if (utilTypes.isProxy(proto)) break;
		const ctor = Object.getOwnPropertyDescriptor(proto, "constructor")?.value;
		if (typeof ctor === "function" && !utilTypes.isProxy(ctor)) {
			const name = Object.getOwnPropertyDescriptor(ctor, "name")?.value;
			if (typeof name === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(name)) return name;
			break;
		}
		proto = Object.getPrototypeOf(proto);
	}
	return utilTypes.isNativeError(error) ? "Error" : "a non-error value";
}

function sameRequests(a: RecordedRequest[], b: RecordedRequest[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Snapshot one governed request: run the SDK's pipeline over the caller's `params` (CAPTURE),
 * materialize the mirror twice, run the pipeline again over the self-check tree, and compare.
 *
 * - `ok`: `params` is the send tree (plain data the SDK has never seen; callable tools by reference,
 *   values the SDK never read, such as an AbortSignal, by reference), and `afcRan` is the SDK's AFC
 *   decision.
 * - `afcStream`: on `generateContentStream`, the SDK would run its AFC loop (refused by the governor:
 *   a streamed loop is not metered round by round).
 * - `refuse`: the mirror cannot reproduce what the SDK sends for the caller's request ("can't tell").
 * - `optionRefused`: an `httpOptions` the SDK reached past an accessor holds what the per-call
 *   option check refuses (an accessor key, a key off the list, a Proxy), named as it names them.
 * - `sdkError`: the SDK's pipeline threw over the caller's request, as it would natively.
 *
 * `pinned` is the request's `config.httpOptions` as the call-start check read and copied it (an own
 * data property): the dry run is served that copy for that key, so a later change to the caller's
 * options cannot reach the SDK; every other key is read live, at the SDK's own time.
 */
export async function snapshotGoogleRequest(
	pipeline: GooglePipeline,
	method: GoogleMethod,
	params: unknown,
	pinned?: PinnedHttpOptions,
): Promise<GoogleSnapshot> {
	const captured: RecordedRequest[] = [];
	const membrane = makeMembrane(() => captured.length > 0, pinned);
	const root = membrane.wrap(params, "params");
	try {
		await runPipeline(pipeline, method, root, captured, membrane.markTransport);
	} catch (error) {
		// Request options the per-call check refuses, as at call start, whatever the SDK did next.
		const names = membrane.optionRefusals();
		if (names.length > 0) return { kind: "optionRefused", names };
		// A caller function the SDK called was never run: whatever the SDK made of that, can't tell.
		const why = membrane.tripped();
		if (why !== undefined) return { kind: "refuse", reason: why };
		if (isCannotTell(error)) return { kind: "refuse", reason: error.reason };
		// Before any request, the error is the SDK's own local rejection of the caller's request.
		// After one, it answers the recorder's scripted reply, not anything the caller sent: natively
		// that request would have gone out first, so it is not a local error. Can't tell.
		if (captured.length > 0) {
			return { kind: "refuse", reason: "the SDK failed after its first request in the dry run" };
		}
		return { kind: "sdkError", error };
	}
	const names = membrane.optionRefusals();
	if (names.length > 0) return { kind: "optionRefused", names };
	const tripped = membrane.tripped();
	if (tripped !== undefined) return { kind: "refuse", reason: tripped };
	const afcRan = membrane.standIns.afcRan;
	if (afcRan && method === "generateContentStream") return { kind: "afcStream" };
	let check: unknown;
	let send: unknown;
	try {
		check = membrane.materialize(root, "check");
		send = membrane.materialize(root, "send");
	} catch (error) {
		if (isCannotTell(error)) return { kind: "refuse", reason: error.reason };
		throw error;
	}
	// The SELF-CHECK, on its own tree: the SDK is not idempotent across passes over one object
	// (its moves land on the object it is given), so the tree that is sent must not have been
	// through it before.
	membrane.standIns.afcRan = false;
	let rerun: RecordedRequest[];
	try {
		rerun = await runPipeline(pipeline, method, check);
	} catch {
		return { kind: "refuse", reason: "the SDK rejects the mirror of the request" };
	}
	if (!sameRequests(captured, rerun) || membrane.standIns.afcRan !== afcRan) {
		return {
			kind: "refuse",
			reason: "the mirror of the request does not send what the SDK sends for it",
		};
	}
	// Only where the dry run made a request: a run that made none (the stream's loop with a
	// maximumRemoteCalls of NaN runs zero rounds) has no loop to stop, and forcing the SDK's early
	// path would make it send one.
	if (!afcRan && captured.length > 0) forceAfcOff(send);
	const policy = carryPolicyFields(params, send);
	if ("refuse" in policy) return { kind: "refuse", reason: policy.refuse };
	return { kind: "ok", params: send, afcRan, policy: policy.fields };
}

/** The request fields the SDK builds its request from; every other top-level field is the caller's own. */
const SDK_REQUEST_FIELDS: ReadonlySet<string | symbol> = new Set(["model", "contents", "config"]);

/**
 * The caller's request fields the SDK does not read (a `metadata` a policy rule matches, say), for
 * the policy gate only: kept BESIDE the send tree, never on it, so nothing of them is serialized,
 * held for or sent. The top level is read once, here, as before this pipeline: `params` and its
 * prototype chain up to `Object.prototype` (a Proxy on the way ends the walk unread), own data as it
 * is, inherited data unless it is a function, a getter run once with `params` as `this`. Values go
 * BY REFERENCE: what is below them is read by the policy evaluator, when a rule asks for it, as
 * before. A null-prototype record, each key defined, never assigned, so an own `__proto__` is a
 * field like any other. A key the send tree holds is left out. A getter that throws: the reason the
 * request cannot be told.
 */
function carryPolicyFields(
	params: unknown,
	send: unknown,
): { fields: Record<string | symbol, unknown> } | { refuse: string } {
	const fields = Object.create(null) as Record<string | symbol, unknown>;
	if (params === null || (typeof params !== "object" && typeof params !== "function")) {
		return { fields };
	}
	const seen = new Set<string | symbol>(SDK_REQUEST_FIELDS);
	if (send !== null && typeof send === "object")
		for (const key of Reflect.ownKeys(send)) seen.add(key);
	for (
		let o: object | null = params;
		o !== null && o !== Object.prototype;
		o = Object.getPrototypeOf(o)
	) {
		if (utilTypes.isProxy(o)) break;
		for (const key of Reflect.ownKeys(o)) {
			if (seen.has(key)) continue;
			seen.add(key);
			const d = Object.getOwnPropertyDescriptor(o, key);
			if (d === undefined) continue;
			let value: unknown;
			if ("value" in d) {
				if (o !== params && typeof d.value === "function") continue;
				value = d.value;
			} else {
				try {
					value = d.get === undefined ? undefined : Reflect.apply(d.get, params, []);
				} catch {
					return { refuse: "a request field's getter threw" };
				}
			}
			Object.defineProperty(fields, key, {
				value,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
	}
	return { fields };
}

/**
 * The single-call forward, after the SDK's own decision (by the probe) said it runs no AFC loop:
 * its config carries an owned `automaticFunctionCalling` with `disable: true`, so the SDK's loop
 * cannot run on the forward whatever caller code does after the snapshot (a real `tool()` that
 * flips a field it shares with the request). The field is never sent on the wire, and the
 * self-check's tree keeps the recorded value, so the check still compares the SDK's own decision.
 */
function forceAfcOff(send: unknown): void {
	const config =
		send !== null && typeof send === "object"
			? Object.getOwnPropertyDescriptor(send, "config")?.value
			: undefined;
	if (config === null || typeof config !== "object" || Array.isArray(config)) return;
	const prior = Object.getOwnPropertyDescriptor(config, "automaticFunctionCalling")?.value;
	const afc: Loose = {
		...(prior !== null && typeof prior === "object" ? (prior as Loose) : {}),
		disable: true,
	};
	Object.defineProperty(config, "automaticFunctionCalling", {
		value: afc,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}
