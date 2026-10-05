/**
 * The page half of the resolver's `Usertrust-Reader-IP` gate: what the SSR
 * resolver fetch sends, and from which header the reader IP may come.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MIN_SERVICE_KEY_LENGTH,
	readerIpFromPlatformHeaders,
	resolverAttributionHeaders,
	serviceKeyFromEnv,
} from "./reader-attribution";
import { resolveVerifyPageState } from "./resolve";

const KEY = "k".repeat(MIN_SERVICE_KEY_LENGTH);
const ROUTE_ID = "ut1_WskkNFGvdE3dwzwzFyxcNC";

function headerBag(entries: Record<string, string>): { get(name: string): string | null } {
	const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
	return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

test("the reader IP comes ONLY from x-vercel-forwarded-for (Vercel sets it; the visitor cannot)", () => {
	assert.equal(
		readerIpFromPlatformHeaders(headerBag({ "x-vercel-forwarded-for": "203.0.113.7" })),
		"203.0.113.7",
	);
	assert.equal(
		readerIpFromPlatformHeaders(headerBag({ "x-vercel-forwarded-for": " 2001:db8::1 " })),
		"2001:db8::1",
	);
	// visitor-controllable headers are never read
	assert.equal(
		readerIpFromPlatformHeaders(
			headerBag({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }),
		),
		undefined,
	);
});

test("a malformed platform value is dropped, never guessed (no 'take the first' of a list)", () => {
	for (const bad of [
		"",
		"   ",
		"203.0.113.7, 198.51.100.1",
		"not-an-ip",
		"999.1.1.1",
		"x".repeat(46),
	]) {
		assert.equal(
			readerIpFromPlatformHeaders(headerBag({ "x-vercel-forwarded-for": bad })),
			undefined,
			bad,
		);
	}
});

test("the service key is server-only env, trimmed, and ignored when shorter than the resolver accepts", () => {
	assert.equal(serviceKeyFromEnv({ USERTRUST_RESOLVER_SERVICE_KEY: ` ${KEY}\n` }), KEY);
	assert.equal(serviceKeyFromEnv({ USERTRUST_RESOLVER_SERVICE_KEY: "short" }), undefined);
	assert.equal(serviceKeyFromEnv({}), undefined);
	assert.equal(serviceKeyFromEnv({ NEXT_PUBLIC_USERTRUST_RESOLVER_SERVICE_KEY: KEY }), undefined);
});

test("no key → no attribution headers, even with a reader IP (an unkeyed reader IP is worthless and leaks nothing)", () => {
	assert.deepEqual(resolverAttributionHeaders(undefined, "203.0.113.7"), {});
	assert.deepEqual(resolverAttributionHeaders("short", "203.0.113.7"), {});
});

test("key → Bearer in the Authorization header; reader IP only when valid (else the keyed floor)", () => {
	assert.deepEqual(resolverAttributionHeaders(KEY, "203.0.113.7"), {
		Authorization: `Bearer ${KEY}`,
		"Usertrust-Reader-IP": "203.0.113.7",
	});
	assert.deepEqual(resolverAttributionHeaders(KEY, undefined), { Authorization: `Bearer ${KEY}` });
	assert.deepEqual(resolverAttributionHeaders(KEY, "nope"), { Authorization: `Bearer ${KEY}` });
});

test("the resolver fetch carries the key and reader IP as HEADERS — never in the URL", async () => {
	let seenUrl = "";
	let seenHeaders: Headers = new Headers();
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		seenUrl = String(url);
		seenHeaders = new Headers(init?.headers);
		return new Response(
			JSON.stringify({ apiVersion: "1", receiptId: ROUTE_ID, status: "unknown" }),
			{
				status: 404,
				headers: { "content-type": "application/json" },
			},
		);
	}) as typeof fetch;
	await resolveVerifyPageState(ROUTE_ID, {
		fetchImpl,
		baseUrl: "https://resolver.test/v1/receipts",
		serviceKey: KEY,
		readerIp: "203.0.113.7",
	});
	assert.equal(seenHeaders.get("authorization"), `Bearer ${KEY}`);
	assert.equal(seenHeaders.get("usertrust-reader-ip"), "203.0.113.7");
	assert.equal(seenHeaders.get("accept"), "application/json");
	assert.ok(!seenUrl.includes(KEY), "the key must never appear in the URL");
	assert.equal(seenUrl, `https://resolver.test/v1/receipts/${ROUTE_ID}?include=checkpointHistory`);

	await resolveVerifyPageState(ROUTE_ID, {
		fetchImpl,
		baseUrl: "https://resolver.test/v1/receipts",
		serviceKey: "",
		readerIp: "203.0.113.7",
	});
	assert.equal(seenHeaders.get("authorization"), null);
	assert.equal(seenHeaders.get("usertrust-reader-ip"), null);
});
