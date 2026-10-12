// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Default-deny on Google clients.
 *
 * A trust() client governs `models.generateContent` and `models.generateContentStream`. Every
 * OTHER function reached off a Google client, at any depth, is free (a read, a list, a delete, a
 * named POST), listed in `allowUngoverned`, or refused: the call rejects with a PolicyDeniedError,
 * one `policy_denied` event naming the path lands on the chain, and the SDK is never called. The
 * SDK's raw transport (`apiClient`, `getNextGenClient()`, `_nextGenClient`, a next-gen resource's
 * `_client`, the Live auth and socket factory) is refused by name.
 *
 * Driven through the REAL @google/genai 1.52.0 client, Gemini and Vertex, over a recording
 * `globalThis.fetch` (the SDK has no injectable fetch): no network, no real keys.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerateVideosOperation, GoogleGenAI } from "@google/genai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_METHODS, GOVERNED_PATHS } from "../../src/default-deny.js";
import {
	GOOGLE_REFUSED_METHODS,
	type TrustEngine,
	type TrustOpts,
	trust,
} from "../../src/govern.js";
import { AUDIT_DIR, VAULT_DIR } from "../../src/shared/constants.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	CreateTransferStatus: {},
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// biome-ignore lint/suspicious/noExplicitAny: the rows reach SDK members the TrustedClient type hides.
type Loose = any;

// ── The classification of @google/genai 1.52.0 (every function on both clients) ──

/** Refused by the rule: billable, `*Internal`, raw-transport helpers, and the unnamed POSTs. */
const CLASSIFIED_REFUSED: ReadonlySet<string> = new Set([
	"getNextGenClient",
	"models.embedContent",
	"models.generateImages",
	"models.editImage",
	"models.upscaleImage",
	"models.generateVideos",
	"models.recontextImage",
	"models.segmentImage",
	"models.processAfcStream",
	"models.generateContentInternal",
	"models.generateContentStreamInternal",
	"models.embedContentInternal",
	"models.generateImagesInternal",
	"models.editImageInternal",
	"models.upscaleImageInternal",
	"models.listInternal",
	"models.generateVideosInternal",
	"live.connect",
	"live.music.connect",
	"batches.create",
	"batches.createEmbeddings",
	"batches.createInternal",
	"batches.createEmbeddingsInternal",
	"batches.listInternal",
	"chats.create",
	"caches.create",
	"caches.update",
	"caches.listInternal",
	"files.upload",
	"files.registerFiles",
	"files._registerFiles",
	"files.listInternal",
	"files.createInternal",
	"files.registerFilesInternal",
	"operations.getVideosOperationInternal",
	"operations.fetchPredictVideosOperationInternal",
	"authTokens.create",
	"tunings.tune",
	"tunings.getInternal",
	"tunings.listInternal",
	"tunings.tuneInternal",
	"tunings.tuneMldevInternal",
	"fileSearchStores.uploadToFileSearchStore",
	"fileSearchStores.create",
	"fileSearchStores.listInternal",
	"fileSearchStores.uploadToFileSearchStoreInternal",
	"fileSearchStores.importFile",
	"fileSearchStores.documents.listInternal",
	"interactions.create",
	// No reason named yet: configuration endpoints whose billing the source does not show.
	"webhooks.create",
	"webhooks.update",
	"webhooks.ping",
	"webhooks.rotateSigningSecret",
	// Private local helpers: no request, and no caller need.
	"models.maybeMoveToResponseJsonSchem",
	"models.processParamsMaybeAddMcpUsage",
	"models.initAfcToolsMap",
	"live.isCallableTool",
	"batches.createInlinedGenerateContentRequest",
	"batches.getGcsUri",
	"batches.getBigqueryUri",
	"batches.formatDestination",
]);

/** The free POSTs (and the one PATCH), each with its reason. Every other free entry is GET/DELETE. */
const FREE_WRITES: Record<string, { verbs: string[]; reason: string }> = {
	"models.update": { verbs: ["PATCH"], reason: "metadata only" },
	"models.countTokens": { verbs: ["POST"], reason: "counts tokens; runs no generation" },
	"models.computeTokens": { verbs: ["POST"], reason: "tokenization; runs no generation" },
	"batches.cancel": { verbs: ["POST"], reason: "cancel: stops work" },
	"tunings.cancel": { verbs: ["POST"], reason: "cancel: stops work" },
	"interactions.cancel": { verbs: ["POST"], reason: "cancel: stops work" },
	"operations.get": { verbs: ["POST"], reason: "polls an existing operation (POST on Vertex)" },
	"operations.getVideosOperation": {
		verbs: ["POST"],
		reason: "polls an existing operation (POST on Vertex)",
	},
};

/** A path through the raw `Models` or the cached next-gen resources: decided at its own path. */
const ALIAS_PREFIXES: Array<[string, string]> = [
	["chats.modelsModule.", "models."],
	["_interactions.", "interactions."],
	["_webhooks.", "webhooks."],
];

// ── Harness ──

const realFetch = globalThis.fetch;
let hits: string[] = [];

/** Every request the SDK sends lands here: `METHOD /path`. */
async function recordingFetch(input: unknown, init?: RequestInit): Promise<Response> {
	const url = new URL(String(input instanceof Request ? input.url : input));
	hits.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
	if (url.pathname === "/upload/v1beta/files") {
		return new Response("{}", {
			status: 200,
			headers: { "x-goog-upload-url": "https://upload.test/session/1" },
		});
	}
	if (url.pathname === "/session/1") {
		return new Response(JSON.stringify({ file: { name: "files/1", mimeType: "text/plain" } }), {
			status: 200,
			headers: { "content-type": "application/json", "x-goog-upload-status": "final" },
		});
	}
	return new Response(JSON.stringify({ name: "x/1", done: true }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeAll(() => {
	globalThis.fetch = recordingFetch as typeof fetch;
	// `interactions` prints an "experimental" warning on its first read.
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

let vault: string;
let open: Array<{ destroy(): Promise<void> }>;

beforeEach(() => {
	vault = join(tmpdir(), `google-default-deny-${randomUUID()}`);
	mkdirSync(vault, { recursive: true });
	hits = [];
	open = [];
});

afterEach(async () => {
	for (const c of open) await c.destroy().catch(() => {});
	rmSync(vault, { recursive: true, force: true });
});

function mockEngine() {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
	} satisfies TrustEngine;
}

const HTTP_OPTIONS = { headers: { "x-test": "1" }, retryOptions: { attempts: 1 }, timeout: 30_000 };

function rawClient(vertex: boolean, httpOptions?: unknown): Loose {
	return vertex
		? new GoogleGenAI({ vertexai: true, apiKey: "k", ...(httpOptions ? { httpOptions } : {}) })
		: new GoogleGenAI({ apiKey: "k", ...(httpOptions ? { httpOptions } : {}) });
}

/** `prepare` runs on the raw client before `trust()` wraps it. */
async function google(
	opts: Partial<TrustOpts> = {},
	setup: { vertex?: boolean; httpOptions?: unknown; prepare?: (raw: Loose) => void } = {},
) {
	const engine = mockEngine();
	const raw = rawClient(setup.vertex === true, setup.httpOptions);
	setup.prepare?.(raw);
	const client = await trust(raw, {
		budget: 1_000_000,
		vaultBase: vault,
		_engine: engine,
		...opts,
	});
	open.push(client);
	return { client: client as Loose, raw, engine };
}

/** A duck-typed Google client: plain objects, as #326's fakes are. */
async function fakeGoogle(namespaces: Record<string, unknown>, opts: Partial<TrustOpts> = {}) {
	const engine = mockEngine();
	const raw = { models: { generateContent: vi.fn(async () => ({})) }, ...namespaces };
	const client = await trust(raw, {
		budget: 1_000_000,
		vaultBase: vault,
		_engine: engine,
		...opts,
	});
	open.push(client);
	return { client: client as Loose, raw: raw as Loose, engine };
}

interface ChainEvent {
	kind: string;
	hash: string;
	data: Record<string, unknown>;
}

function chainEvents(): ChainEvent[] {
	let text: string;
	try {
		text = readFileSync(join(vault, VAULT_DIR, AUDIT_DIR, "events.jsonl"), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as ChainEvent);
}

/**
 * The observables every refusal row asserts: a PolicyDeniedError, exactly one `policy_denied`
 * event naming `path`, the error's hash equal to that event's, no request sent and nothing held.
 * Not the hint text: a stand-in refusal and a default refusal word it differently.
 */
async function expectRefused(
	path: string,
	call: () => unknown,
	engine: ReturnType<typeof mockEngine>,
): Promise<void> {
	const before = chainEvents().length;
	const sentBefore = hits.length;
	let caught: unknown;
	try {
		await call();
	} catch (err) {
		caught = err;
	}
	expect(caught, `${path}: rejects with PolicyDeniedError`).toBeInstanceOf(PolicyDeniedError);
	expect(hits.slice(sentBefore), `${path}: no provider request`).toEqual([]);
	expect(engine.spendPending, `${path}: nothing was held`).not.toHaveBeenCalled();
	const added = chainEvents().slice(before);
	expect(
		added.map((e) => e.kind),
		`${path}: one policy_denied event`,
	).toEqual(["policy_denied"]);
	expect(added[0]?.data.actionName).toBe(path);
	expect(added[0]?.data.decision).toBe("deny");
	expect((caught as PolicyDeniedError).auditEventHash).toBe(added[0]?.hash);
}

function resolve(root: Loose, path: string): { holder: Loose; name: string } {
	const segments = path.split(".");
	const name = segments.pop() as string;
	let holder = root;
	for (const s of segments) holder = holder[s];
	return { holder, name };
}

const GP = { model: "gemini-2.5-flash", contents: "hi" };

// ── The classification pin ──

/** Names that pass whatever they hold (default-deny's inert names). */
function isInert(name: string): boolean {
	return name in Object.prototype || name === "toJSON";
}

/** String-keyed member names: own, and inherited below Object.prototype. */
function memberNames(o: object): string[] {
	const names = new Set<string>();
	for (
		let p: object | null = o;
		p !== null && p !== Object.prototype;
		p = Object.getPrototypeOf(p)
	) {
		for (const n of Object.getOwnPropertyNames(p)) if (!isInert(n)) names.add(n);
	}
	return [...names];
}

/** A function member or an accessor, own or inherited below Object.prototype (no getter runs). */
function hasCallableShape(o: object): boolean {
	for (
		let p: object | null = o;
		p !== null && p !== Object.prototype;
		p = Object.getPrototypeOf(p)
	) {
		for (const n of Object.getOwnPropertyNames(p)) {
			const d = Object.getOwnPropertyDescriptor(p, n);
			if (d !== undefined && (!("value" in d) || typeof d.value === "function")) return true;
		}
	}
	return false;
}

function isTransportMember(path: string, key: string): boolean {
	return (
		key === "apiClient" ||
		key === "_client" ||
		key === "_nextGenClient" ||
		((key === "auth" || key === "webSocketFactory") &&
			(path === "live" || path.startsWith("live.")))
	);
}

interface PinReport {
	functions: string[];
	aliases: string[];
	standIns: string[];
	data: string[];
	problems: string[];
}

/**
 * Walk the governed client beside the raw one. Every function must be classified; an object with
 * a callable member must come back guarded (never the raw object); a transport must come back as
 * a stand-in; plain data must come back as it is, with nothing callable anywhere inside it.
 */
function pinWalk(governed: Loose, raw: Loose, classified: ReadonlySet<string>): PinReport {
	const rep: PinReport = { functions: [], aliases: [], standIns: [], data: [], problems: [] };
	const dataWalk = (value: object, at: string, seen: Set<object>): void => {
		if (seen.has(value)) return;
		seen.add(value);
		const entries = Array.isArray(value)
			? value.map((v, i) => [String(i), v] as const)
			: Object.keys(value).map((k) => [k, (value as Loose)[k]] as const);
		for (const [k, v] of entries) {
			const where = `${at}.${k}`;
			if (typeof v === "function") rep.problems.push(`${where}: a function inside data`);
			else if (v !== null && typeof v === "object") {
				if (!Array.isArray(v) && hasCallableShape(v))
					rep.problems.push(`${where}: an object with a callable member inside data`);
				else dataWalk(v, where, seen);
			}
		}
	};
	const walk = (g: Loose, r: object, path: string, ancestors: Set<object>): void => {
		for (const key of memberNames(r)) {
			const at = path === "" ? key : `${path}.${key}`;
			const rv: unknown = Reflect.get(r, key, r);
			const gv: unknown = g[key];
			if (rv !== null && typeof rv === "object" && isTransportMember(path, key)) {
				if (gv === rv) rep.problems.push(`${at}: a transport returned raw`);
				rep.standIns.push(at);
				continue;
			}
			if (typeof rv === "function") {
				if (typeof gv !== "function" || gv === rv)
					rep.problems.push(`${at}: a function returned raw`);
				const alias = ALIAS_PREFIXES.find(([prefix]) => at.startsWith(prefix));
				if (alias !== undefined) {
					const canonical = alias[1] + at.slice(alias[0].length);
					if (!classified.has(canonical))
						rep.problems.push(`${at}: unclassified (as ${canonical})`);
					if (FREE_METHODS.google.has(at)) rep.problems.push(`${at}: an alias on the free list`);
					rep.aliases.push(at);
				} else {
					if (!classified.has(at)) rep.problems.push(`${at}: an unclassified function`);
					rep.functions.push(at);
				}
				continue;
			}
			if (rv === null || typeof rv !== "object") continue;
			if (Array.isArray(rv) || !hasCallableShape(rv)) {
				if (gv !== rv) rep.problems.push(`${at}: data not returned as it is`);
				rep.data.push(at);
				dataWalk(rv, at, new Set());
				continue;
			}
			if (gv === rv) {
				rep.problems.push(`${at}: an object with a callable member returned raw`);
				continue;
			}
			if (ancestors.has(rv)) continue;
			walk(gv, rv, at, new Set([...ancestors, rv]));
		}
	};
	walk(governed, raw, "", new Set([raw]));
	return rep;
}

const CLASSIFIED: ReadonlySet<string> = new Set([
	...GOVERNED_PATHS.google,
	...FREE_METHODS.google,
	...CLASSIFIED_REFUSED,
]);

/** Warm the lazy members on the RAW client, so `_nextGenClient`, `_interactions` and `_webhooks` exist. */
function warm(raw: Loose): void {
	void raw.interactions;
	void raw.webhooks;
	raw.getNextGenClient();
}

describe("the classification pin: every function on a real client is classified", () => {
	it("the table is 98 methods: 2 governed, 35 free, 61 refused", () => {
		expect(GOVERNED_PATHS.google.size).toBe(2);
		expect(FREE_METHODS.google.size).toBe(35);
		expect(CLASSIFIED_REFUSED.size).toBe(61);
		expect(CLASSIFIED.size).toBe(98);
	});

	for (const vertex of [false, true]) {
		it(`${vertex ? "Vertex" : "Gemini"}: the walk finds the 98, nothing unclassified, nothing callable left raw`, async () => {
			const { client, raw } = await google(
				{},
				{ vertex, httpOptions: HTTP_OPTIONS, prepare: warm },
			);
			const rep = pinWalk(client, raw, CLASSIFIED);
			expect(rep.problems).toEqual([]);
			expect([...rep.functions].sort()).toEqual([...CLASSIFIED].sort());
			// Positive controls: the walk reached the aliases, the transports and the data.
			expect(rep.aliases).toContain("chats.modelsModule.generateContent");
			expect(rep.aliases).toContain("_interactions.create");
			expect(rep.aliases).toContain("_webhooks.list");
			expect(rep.standIns).toEqual(
				expect.arrayContaining([
					"apiClient",
					"_nextGenClient",
					"models.apiClient",
					"interactions._client",
					"live.auth",
					"live.webSocketFactory",
					"live.music.auth",
					"live.music.webSocketFactory",
				]),
			);
			expect(rep.data).toContain("httpOptions");
			expect(client.httpOptions).toBe(raw.httpOptions);
			expect(hits).toEqual([]);
		});
	}

	it("control: the walk reports an unclassified function, a raw callable object and one hidden in data", async () => {
		class Helper {
			run(): string {
				return "ran";
			}
		}
		const { client, raw } = await google(
			{},
			{
				prepare: (r) => {
					warm(r);
					r.models.brandNew = () => "x";
					r.extraData = { nested: [{ deep: new Helper() }] };
				},
			},
		);
		const rep = pinWalk(client, raw, CLASSIFIED);
		expect(rep.problems).toEqual(
			expect.arrayContaining([
				"models.brandNew: an unclassified function",
				"extraData.nested.0.deep: an object with a callable member inside data",
			]),
		);
		// And a classification missing one entry is caught.
		const short = new Set(CLASSIFIED);
		short.delete("files.upload");
		expect(pinWalk(client, raw, short).problems).toContain(
			"files.upload: an unclassified function",
		);
	});
});

// ── Every free entry sends only GET/DELETE, or its named write ──

const OP = (): unknown => Object.assign(new GenerateVideosOperation(), { name: "operations/1" });
const VB = "projects/p/locations/l/batchPredictionJobs/1";

/** Arguments per free entry, per client (Vertex overrides where the name format differs). */
function freeArgs(path: string, vertex: boolean): unknown[] {
	const dl = join(vault, "download.bin");
	const table: Record<string, unknown[]> = {
		"models.list": [{}],
		"models.get": [{ model: "gemini-2.5-flash" }],
		"models.delete": [{ model: "tunedModels/1" }],
		"models.update": [{ model: "tunedModels/1", config: { displayName: "d" } }],
		"models.countTokens": [GP],
		"models.computeTokens": [GP],
		"batches.list": [{}],
		"batches.get": [{ name: vertex ? VB : "batches/1" }],
		"batches.delete": [{ name: vertex ? VB : "batches/1" }],
		"batches.cancel": [{ name: vertex ? VB : "batches/1" }],
		"caches.list": [{}],
		"caches.get": [{ name: "cachedContents/1" }],
		"caches.delete": [{ name: "cachedContents/1" }],
		"files.list": [{}],
		"files.get": [{ name: "files/1" }],
		"files.delete": [{ name: "files/1" }],
		"files.download": [{ file: "files/1", downloadPath: dl }],
		"tunings.list": [{}],
		"tunings.get": [{ name: "tuningJobs/1" }],
		"tunings.cancel": [{ name: "tuningJobs/1" }],
		"fileSearchStores.list": [{}],
		"fileSearchStores.get": [{ name: "fileSearchStores/1" }],
		"fileSearchStores.delete": [{ name: "fileSearchStores/1" }],
		"fileSearchStores.downloadMedia": ["fileSearchStores/1/media/1"],
		"fileSearchStores.documents.list": [{ parent: "fileSearchStores/1" }],
		"fileSearchStores.documents.get": [{ name: "fileSearchStores/1/documents/1" }],
		"fileSearchStores.documents.delete": [{ name: "fileSearchStores/1/documents/1" }],
		"operations.get": [{ operation: OP() }],
		"operations.getVideosOperation": [{ operation: OP() }],
		"interactions.get": ["i_1"],
		"interactions.delete": ["i_1"],
		"interactions.cancel": ["i_1"],
		"webhooks.list": [],
		"webhooks.get": ["w_1"],
		"webhooks.delete": ["w_1"],
	};
	const args = table[path];
	if (args === undefined) throw new Error(`no arguments for free entry ${path}`);
	return args;
}

const NEXT_GEN_FREE = [
	"interactions.get",
	"interactions.delete",
	"interactions.cancel",
	"webhooks.list",
	"webhooks.get",
	"webhooks.delete",
];

describe("every free entry sends only GET or DELETE, or its named write, unaudited", () => {
	it("the named writes name only free entries", () => {
		for (const path of Object.keys(FREE_WRITES))
			expect(FREE_METHODS.google.has(path), path).toBe(true);
	});

	it.each([...FREE_METHODS.google].sort())("%s", async (path) => {
		let sent = 0;
		for (const vertex of [false, true]) {
			// A FRESH client per run: the next-gen rows reach `interactions` / `webhooks` through the
			// root getter with no warm-up, and that read must not be refused.
			const { client } = await google({}, { vertex });
			hits = [];
			const { holder, name } = resolve(client, path);
			let caught: unknown;
			try {
				await holder[name](...freeArgs(path, vertex));
			} catch (err) {
				caught = err;
			}
			// An SDK-side error (a method one API does not serve) is fine; a refusal is not.
			expect(caught, `${path} (${vertex ? "Vertex" : "Gemini"}) was refused`).not.toBeInstanceOf(
				PolicyDeniedError,
			);
			const allowed = ["GET", "DELETE", ...(FREE_WRITES[path]?.verbs ?? [])];
			for (const r of hits) expect(allowed, `${path} sent ${r}`).toContain(r.split(" ")[0]);
			sent += hits.length;
			await client.destroy();
		}
		// Positive control: at least one API served it, so the verb check had a subject.
		expect(sent, `${path} sent a request`).toBeGreaterThan(0);
		// Unaudited: no event at all, and no policy_denied from the getter read.
		expect(chainEvents()).toEqual([]);
	});

	it.each(NEXT_GEN_FREE)(
		"%s is reached through the root getter on a fresh client, and the read writes nothing",
		async (path) => {
			const { client, raw } = await google();
			expect(Object.hasOwn(raw, "_nextGenClient"), "the client is fresh").toBe(false);
			const ns = path.split(".")[0] as string;
			const resource = client[ns];
			expect(chainEvents(), "reading the getter wrote nothing").toEqual([]);
			expect(resource).toBe(client[ns]);
			hits = [];
			await resource[path.split(".")[1] as string](...freeArgs(path, false));
			expect(hits.length).toBe(1);
			expect(chainEvents()).toEqual([]);
		},
	);
});

// ── Escape hatches: each refused, by path ──

class Callbacks {
	onopen(): void {}
	onmessage(): void {}
	onerror(): void {}
	onclose(): void {}
}

/** [the refused path, how to reach it, what to do to the raw client before trust()]. */
const ESCAPES: Array<[string, (c: Loose) => unknown, ((raw: Loose) => void)?]> = [
	["getNextGenClient", (c) => c.getNextGenClient()],
	[
		"_nextGenClient",
		(c) => c._nextGenClient.interactions.create({ model: "gemini-2.5-flash", input: "hi" }),
		(raw) => raw.getNextGenClient(),
	],
	[
		"apiClient",
		(c) =>
			c.apiClient.request({
				path: "models/gemini-2.5-flash:generateContent",
				httpMethod: "POST",
				body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
			}),
	],
	[
		"models.apiClient",
		(c) =>
			c.models.apiClient.request({
				path: "models/gemini-2.5-flash:generateContent",
				httpMethod: "POST",
				body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
			}),
	],
	["models.generateContentInternal", (c) => c.models.generateContentInternal(GP)],
	["chats.modelsModule.generateContent", (c) => c.chats.modelsModule.generateContent(GP)],
	["live.auth", (c) => c.live.auth.addAuthHeaders(new Headers(), "https://live.test")],
	[
		"live.webSocketFactory",
		(c) => c.live.webSocketFactory.create("wss://live.test", {}, new Callbacks()),
	],
	["live.music.auth", (c) => c.live.music.auth.addAuthHeaders(new Headers(), "https://live.test")],
	[
		"live.music.webSocketFactory",
		(c) => c.live.music.webSocketFactory.create("wss://live.test", {}, new Callbacks()),
	],
	[
		"_interactions.create",
		(c) => c._interactions.create({ model: "gemini-2.5-flash", input: "hi" }),
		(raw) => void raw.interactions,
	],
	["_webhooks.list", (c) => c._webhooks.list(), (raw) => void raw.webhooks],
	[
		"interactions._client",
		(c) =>
			c.interactions._client.post("/v1beta/interactions", { body: { model: "m", input: "hi" } }),
	],
	["authTokens.create", (c) => c.authTokens.create({ config: { uses: 1 } })],
	[
		"files.upload",
		(c) => c.files.upload({ file: new Blob(["hi"]), config: { mimeType: "text/plain" } }),
	],
];

describe("escape hatches are refused, by path, with nothing sent", () => {
	it.each(ESCAPES)("%s", async (path, call, prepare) => {
		const { client, engine } = await google({}, prepare === undefined ? {} : { prepare });
		await expectRefused(path, () => call(client), engine);
	});

	it("a duck-typed class instance carrying a function, hung off a namespace, is guarded: its call is refused", async () => {
		const run = vi.fn(async () => "ran");
		class Helper {
			run = run;
		}
		const { client, engine } = await google(
			{},
			{ prepare: (raw) => (raw.models.helper = new Helper()) },
		);
		await expectRefused("models.helper.run", () => client.models.helper.run(), engine);
		expect(run).not.toHaveBeenCalled();
	});
});

describe("every name #326 refused is refused on the real client too", () => {
	const paths = Object.entries(GOOGLE_REFUSED_METHODS).flatMap(([ns, ms]) =>
		ms.map((m) => `${ns}.${m}`),
	);
	it.each(paths)("%s", async (path) => {
		const { client, engine } = await google();
		const { holder, name } = resolve(client, path);
		await expectRefused(path, () => holder[name](GP), engine);
	});
});

// ── Duck-typed clients: guarded by shape ──

describe("a duck-typed Google client is guarded by shape", () => {
	it("a plain-object namespace's unnamed method is refused", async () => {
		const doThing = vi.fn(async () => "done");
		const { client, engine } = await fakeGoogle({ extras: { doThing } });
		await expectRefused("extras.doThing", () => client.extras.doThing(), engine);
		expect(doThing).not.toHaveBeenCalled();
	});

	it("a namespace whose only function sits behind a getter is a resource: the call is refused, the getter never ran early", async () => {
		const send = vi.fn(async () => "sent");
		let reads = 0;
		const extras = {
			get send() {
				reads++;
				return send;
			},
		};
		const { client, engine } = await fakeGoogle({ extras });
		expect(reads, "trust() and the shape test ran no getter").toBe(0);
		await expectRefused("extras.send", () => client.extras.send(), engine);
		expect(send).not.toHaveBeenCalled();
	});

	it("plain data stays data: httpOptions reads through as it is", async () => {
		const { client, raw } = await google({}, { httpOptions: HTTP_OPTIONS });
		expect(raw.httpOptions).toEqual(HTTP_OPTIONS);
		expect(client.httpOptions).toBe(raw.httpOptions);
		expect(client.httpOptions.headers).toBe(raw.httpOptions.headers);
		expect(chainEvents()).toEqual([]);
	});
});

// ── allowUngoverned on Google ──

describe("allowUngoverned on a Google client", () => {
	it("a listed files.upload runs on the raw namespace, audited as ungoverned_call (and unredacted)", async () => {
		const { client, engine } = await google({ allowUngoverned: ["files.upload"] });
		const file = await client.files.upload({
			file: new Blob(["hello"], { type: "text/plain" }),
			config: { mimeType: "text/plain" },
		});
		expect(file.name).toBe("files/1");
		expect(hits).toEqual(["POST /upload/v1beta/files", "POST /session/1"]);
		expect(engine.spendPending).not.toHaveBeenCalled();
		await client.destroy();
		const events = chainEvents();
		expect(events.map((e) => e.kind)).toEqual(["ungoverned_call"]);
		expect(events[0]?.data).toEqual({ method: "files.upload", provider: "google" });
	});

	it("authTokens.create stays listable: a minted key used outside governance is out of scope, like apiKey", async () => {
		const { client } = await google({ allowUngoverned: ["authTokens.create"] });
		await client.authTokens.create({ config: { uses: 1 } }).catch(() => undefined);
		expect(hits).toEqual(["POST /v1beta/auth_tokens"]);
		await client.destroy();
		expect(chainEvents().map((e) => e.kind)).toEqual(["ungoverned_call"]);
	});

	it("a method that is not listed is still refused", async () => {
		const { client, engine } = await google({ allowUngoverned: ["files.upload"] });
		await expectRefused("models.embedContent", () => client.models.embedContent(GP), engine);
	});

	const RAW = "it reaches the SDK's raw client, which is always refused.";
	it.each([
		["models.list", "it is free on a Google client and already runs without governance."],
		["interactions.get", "it is free on a Google client and already runs without governance."],
		["models.generateContent", "it is governed on a Google client."],
		["models.generateContentStream", "it is governed on a Google client."],
		["apiClient.request", RAW],
		["models.apiClient.request", RAW],
		["interactions._client.post", RAW],
		["_nextGenClient.interactions.create", RAW],
		["_interactions.create", RAW],
		["_webhooks.list", RAW],
		["live.auth.addAuthHeaders", RAW],
		["live.webSocketFactory.create", RAW],
		["live.music.webSocketFactory.create", RAW],
		["getNextGenClient", RAW],
		[
			"chats.create",
			"it hands out or drives further billable calls that its one ungoverned_call record would not cover.",
		],
		[
			"models.processAfcStream",
			"it hands out or drives further billable calls that its one ungoverned_call record would not cover.",
		],
		[
			"chats.modelsModule.processAfcStream",
			"it hands out or drives further billable calls that its one ungoverned_call record would not cover.",
		],
	])("%s is refused at creation, by name", async (path, why) => {
		await expect(
			trust(rawClient(false), { dryRun: true, vaultBase: vault, allowUngoverned: [path] }),
		).rejects.toMatchObject({
			name: "TypeError",
			message: `usertrust: allowUngoverned cannot list "${path}": ${why}`,
		});
	});
});

// ── Writes and identity ──

describe("writes through a governed Google client never reach the raw SDK", () => {
	it("assignment, defineProperty and delete throw on the client and on a namespace", async () => {
		const { client, raw } = await google();
		const models = raw.models;
		const list = raw.models.list;
		expect(() => {
			client.models = {};
		}).toThrow(TypeError);
		expect(() => Object.defineProperty(client, "apiKey", { value: "other" })).toThrow(TypeError);
		expect(() => {
			delete client.files;
		}).toThrow(TypeError);
		expect(() => {
			client.models.list = () => "mine";
		}).toThrow(TypeError);
		expect(() => Object.defineProperty(client.models, "get", { value: () => 1 })).toThrow(
			TypeError,
		);
		expect(() => {
			delete client.models.delete;
		}).toThrow(TypeError);
		expect(raw.models).toBe(models);
		expect(raw.models.list).toBe(list);
		expect(raw.apiKey).toBe("k");
		expect(typeof raw.files).toBe("object");
		expect(typeof raw.models.delete).toBe("function");
	});
});

describe("a method keeps its identity across reads", () => {
	it("free, listed and refused methods are the same function on every read", async () => {
		const { client } = await google({ allowUngoverned: ["files.upload"] });
		expect(client.models.list).toBe(client.models.list);
		expect(client.files.upload).toBe(client.files.upload);
		expect(client.models.embedContent).toBe(client.models.embedContent);
		expect(client.interactions.get).toBe(client.interactions.get);
	});

	it("the same raw function at two paths gets two wrappers, each deciding by its own path", async () => {
		const { client, raw, engine } = await google();
		expect(raw.chats.modelsModule.list).toBe(raw.models.list);
		const free = client.models.list;
		const gated = client.chats.modelsModule.list;
		expect(free).not.toBe(gated);
		await expectRefused("chats.modelsModule.list", () => gated({}), engine);
		await free({});
		expect(hits).toEqual(["GET /v1beta/models"]);
		expect(chainEvents().map((e) => e.kind)).toEqual(["policy_denied"]);
	});

	it("two calls of one cached refused wrapper give two errors, each with its own event", async () => {
		const { client } = await google();
		const refused = client.models.embedContent;
		const first = await refused(GP).catch((e: unknown) => e);
		const second = await refused(GP).catch((e: unknown) => e);
		expect(first).toBeInstanceOf(PolicyDeniedError);
		expect(second).toBeInstanceOf(PolicyDeniedError);
		expect(first).not.toBe(second);
		const events = chainEvents();
		expect(events.map((e) => e.kind)).toEqual(["policy_denied", "policy_denied"]);
		expect((first as PolicyDeniedError).auditEventHash).toBe(events[0]?.hash);
		expect((second as PolicyDeniedError).auditEventHash).toBe(events[1]?.hash);
		expect(events[0]?.hash).not.toBe(events[1]?.hash);
	});
});
