// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — emitter sinks: S3 (native SigV4) and Rekor (hashedrekord witness).
 * Plan T3 with deltas D1 (no 409 recovery, strict 201 validation), D6 (S3
 * addressing + error hygiene), D7 (`createSink(config, rootDir?)`) and D13
 * (proposal canonicalized locally, receipt entryBody stored VERBATIM).
 *
 * Both sinks talk to the network through an injected transport, so every
 * assertion here is about bytes we send and bytes we persist — never about a
 * live log. The load-bearing test is the round trip: a receipt this sink writes
 * from a synthetic 201 must satisfy the independent verifier
 * (`verifyRekorReceipt`) under the fixture log key. A sink that writes receipts
 * its own verifier rejects would ship silent, undetectable evidence loss.
 */

import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnchorEmitter, createSink, readAnchorIdentity } from "../../../src/audit/anchor.js";
import { type AnchorRecord, anchorPayloadHash } from "../../../src/audit/anchor-verify.js";
import { canonicalize } from "../../../src/audit/canonical.js";
import { type HttpTransport, rekorSink, s3Sink } from "../../../src/audit/rekor.js";
import {
	parseRekorReceipt,
	type RekorReceipt,
	verifyRekorReceipt,
} from "../../../src/audit/rekor-verify.js";
import { hashPayload } from "../../../src/audit/sigv4.js";
import { VAULT_DIR } from "../../../src/shared/constants.js";
import {
	type AnchoredSetup,
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	rotateOnce,
} from "./fixtures.js";
import { makeSyntheticLog } from "./rekor-fixtures.js";

afterEach(() => {
	vi.unstubAllEnvs();
	cleanupAll();
});

const REKOR_URL = "https://rekor.example.test";
const ENTRIES_PATH = "/api/v1/log/entries";

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Buffer;
}

/** Transport that records what it was asked to send and replies from `respond`. */
function fakeTransport(respond: (call: Call) => { status: number; body: string }): {
	transport: HttpTransport;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		transport: async (opts) => {
			const call: Call = { ...opts, body: Buffer.from(opts.body) };
			calls.push(call);
			return respond(call);
		},
	};
}

async function anchored(): Promise<{ setup: AnchoredSetup; record: AnchorRecord }> {
	const setup = await makeAnchoredVault(3);
	return { setup, record: await anchorOnce(setup) };
}

function stubCreds(): void {
	vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
	vi.stubEnv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY");
	vi.stubEnv("AWS_SESSION_TOKEN", "");
}

/** The sink's per-log receipt name: `<seq12>.<8 hex of sha256(log url)>.json`. */
const receiptPath = (root: string, anchorSeq: number, logUrl = REKOR_URL): string =>
	join(
		root,
		VAULT_DIR,
		"audit",
		"anchors",
		"rekor",
		`${String(anchorSeq).padStart(12, "0")}.${createHash("sha256")
			.update(logUrl, "utf8")
			.digest("hex")
			.slice(0, 8)}.json`,
	);

/**
 * A synthetic Rekor 201. The log is modelled honestly: it stores its OWN
 * serialization of the proposal (pretty-printed here, so the stored bytes
 * differ from the bytes we posted), the entry's global `logIndex` differs from
 * its index within the proven tree, and the response carries fields we do not
 * consume. Only bytes the log returned may end up in the receipt.
 */
function rekorAccepted(
	proposal: Buffer,
	opts: { logSize?: number; logIndex?: number; integratedTime?: number; origin?: string } = {},
): { body: string; storedB64: string; logPubkeyPem: string } {
	const stored = Buffer.from(
		`${JSON.stringify(JSON.parse(proposal.toString("utf8")) as unknown, null, 2)}\n`,
		"utf8",
	);
	const logSize = opts.logSize ?? 5;
	const logIndex = opts.logIndex ?? 3;
	const entries = Array.from({ length: logSize }, (_, i) =>
		i === logIndex ? stored : randomBytes(32),
	);
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const log = makeSyntheticLog(entries, privateKey, opts.origin ?? new URL(REKOR_URL).host);
	const storedB64 = stored.toString("base64");
	const integratedTime = opts.integratedTime ?? 1_760_000_111;
	return {
		body: JSON.stringify({
			"24296fb24b8ad77a51a1f0e4e0f0c0f2c8a1f0d0e2b3a4c5d6e7f8091a2b3c4d5": {
				apiVersion: "0.0.1",
				body: storedB64,
				integratedTime,
				logID: log.logId,
				logIndex: 90_000_000,
				verification: {
					inclusionProof: {
						checkpoint: log.checkpoint,
						hashes: log.pathFor(logIndex),
						logIndex,
						rootHash: log.rootHex,
						treeSize: logSize,
					},
					// The log's real signature over integratedTime — the only reason
					// the receipt this produces can attest a time at all.
					signedEntryTimestamp: log.setFor({ body: storedB64, integratedTime, logIndex }),
				},
			},
		}),
		storedB64,
		logPubkeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
	};
}

describe("s3 anchor sink (native SigV4)", () => {
	it("PUTs the canonical record bytes to the virtual-host URL, SigV4-signed", async () => {
		stubCreds();
		const { record } = await anchored();
		const { transport, calls } = fakeTransport(() => ({ status: 200, body: "" }));

		await s3Sink({ bucket: "b", region: "us-east-1" }, transport).publish(record);

		expect(calls).toHaveLength(1);
		const call = calls[0] as Call;
		expect(call.method).toBe("PUT");
		expect(call.url).toBe(
			`https://b.s3.us-east-1.amazonaws.com/anchors/${record.vaultId}/000000000001.json`,
		);
		// Exactly the canonical record — no trailing newline, no envelope.
		expect(call.body.toString("utf8")).toBe(canonicalize(record));
		expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
		expect(call.headers["x-amz-content-sha256"]).toBe(hashPayload(call.body));
		expect(call.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
	});

	it("accepts any 2xx, not just 200", async () => {
		stubCreds();
		const { record } = await anchored();
		const { transport } = fakeTransport(() => ({ status: 204, body: "" }));
		await expect(
			s3Sink({ bucket: "b", region: "eu-west-1" }, transport).publish(record),
		).resolves.toBeUndefined();
	});

	it("addresses a configured endpoint path-style", async () => {
		stubCreds();
		const { record } = await anchored();
		const { transport, calls } = fakeTransport(() => ({ status: 200, body: "" }));

		await s3Sink(
			{
				bucket: "vault-anchors",
				region: "us-east-1",
				prefix: "prod/anchors",
				endpoint: "http://127.0.0.1:9000",
			},
			transport,
		).publish(record);

		expect(calls[0]?.url).toBe(
			`http://127.0.0.1:9000/vault-anchors/prod/anchors/${record.vaultId}/000000000001.json`,
		);
	});

	it("refuses an endpoint without a scheme or with plaintext http off-localhost", async () => {
		stubCreds();
		const { record } = await anchored();
		const { transport } = fakeTransport(() => ({ status: 200, body: "" }));

		await expect(
			s3Sink({ bucket: "b", region: "us-east-1", endpoint: "s3.example.com" }, transport).publish(
				record,
			),
		).rejects.toThrow(/endpoint must include a scheme/);
		await expect(
			s3Sink(
				{ bucket: "b", region: "us-east-1", endpoint: "http://s3.example.com" },
				transport,
			).publish(record),
		).rejects.toThrow(/https/);
	});

	it("rejects a non-2xx store response without echoing request headers", async () => {
		stubCreds();
		const { record } = await anchored();
		const { transport } = fakeTransport(() => ({
			status: 403,
			body: `<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>${"x".repeat(400)}`,
		}));

		const err = await s3Sink({ bucket: "b", region: "us-east-1" }, transport)
			.publish(record)
			.then(
				() => null,
				(e: unknown) => e as Error,
			);
		expect(err?.message).toMatch(/^s3 sink: HTTP 403/);
		expect(err?.message).toContain("AccessDenied");
		expect(err?.message.length).toBeLessThanOrEqual(160);
		expect(err?.message).not.toMatch(/AWS4-HMAC-SHA256|authorization|x-amz-security-token/i);
	});

	it("rejects when AWS credentials are absent from the environment", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
		const { record } = await anchored();
		const { transport, calls } = fakeTransport(() => ({ status: 200, body: "" }));

		await expect(
			s3Sink({ bucket: "b", region: "us-east-1" }, transport).publish(record),
		).rejects.toThrow("s3 sink: AWS credentials not found in environment");
		expect(calls).toHaveLength(0);
	});
});

describe("rekor anchor sink (hashedrekord witness)", () => {
	it("proposes an entry bound to the record's payload hash, signature and vault key", async () => {
		const { setup, record } = await anchored();
		const { transport, calls } = fakeTransport((call) => ({
			status: 201,
			body: rekorAccepted(call.body).body,
		}));

		await rekorSink(setup.root, REKOR_URL, transport).publish(record);

		expect(calls).toHaveLength(1);
		const call = calls[0] as Call;
		expect(call.method).toBe("POST");
		expect(call.url).toBe(`${REKOR_URL}${ENTRIES_PATH}`);
		const entry = JSON.parse(call.body.toString("utf8")) as {
			apiVersion: string;
			kind: string;
			spec: {
				data: { hash: { algorithm: string; value: string } };
				signature: { content: string; publicKey: { content: string } };
			};
		};
		expect(entry.kind).toBe("hashedrekord");
		expect(entry.apiVersion).toBe("0.0.1");
		expect(entry.spec.data.hash).toEqual({
			algorithm: "sha256",
			value: anchorPayloadHash(record),
		});
		expect(entry.spec.signature.content).toBe(record.sig);
		// D13: the public key travels as base64 of exact PEM text bytes, LF-only.
		const pem = Buffer.from(entry.spec.signature.publicKey.content, "base64").toString("utf8");
		const spki = readAnchorIdentity(setup.root)?.publicKeySpki as string;
		expect(pem).toBe(`-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----\n`);
		expect(pem).not.toContain("\r");
	});

	it("writes a receipt the independent verifier accepts under the log's key", async () => {
		const { setup, record } = await anchored();
		let accepted: ReturnType<typeof rekorAccepted> | null = null;
		const { transport } = fakeTransport((call) => {
			accepted = rekorAccepted(call.body, { integratedTime: 1_760_000_222 });
			return { status: 201, body: accepted.body };
		});

		await rekorSink(setup.root, REKOR_URL, transport).publish(record);

		const path = receiptPath(setup.root, record.anchorSeq);
		expect(existsSync(path)).toBe(true);
		const { receipt, error } = parseRekorReceipt(readFileSync(path, "utf-8"));
		expect(error).toBeNull();
		if (receipt === null) throw new Error("receipt did not parse");

		const fixture = accepted as unknown as ReturnType<typeof rekorAccepted>;
		// D13: the receipt carries the LOG's bytes, not a reserialization of ours.
		expect(receipt.entryBody).toBe(fixture.storedB64);
		// The proof's index is the one that proves inclusion — not the global one.
		expect(receipt.log).toMatchObject({ url: REKOR_URL, logIndex: 3, treeSize: 5 });
		expect(receipt.log.integratedTime).toBe(1_760_000_222);

		const verification = verifyRekorReceipt(receipt, record, [fixture.logPubkeyPem]);
		expect(verification.errors).toEqual([]);
		expect(verification.ok).toBe(true);
		expect(verification.attestedTimeMs).toBe(1_760_000_222_000);
	});

	it("rejects a failed publish and writes no receipt", async () => {
		const { setup, record } = await anchored();
		const { transport } = fakeTransport(() => ({ status: 500, body: "upstream unavailable" }));

		await expect(rekorSink(setup.root, REKOR_URL, transport).publish(record)).rejects.toThrow(
			/^rekor sink: HTTP 500/,
		);
		expect(existsSync(receiptPath(setup.root, record.anchorSeq))).toBe(false);
	});

	it("treats 409 as a failure rather than recovering the duplicate entry (D1)", async () => {
		const { setup, record } = await anchored();
		const { transport, calls } = fakeTransport(() => ({
			status: 409,
			body: "entry already exists",
		}));

		await expect(rekorSink(setup.root, REKOR_URL, transport).publish(record)).rejects.toThrow(
			/^rekor sink: HTTP 409/,
		);
		expect(calls).toHaveLength(1);
		expect(existsSync(receiptPath(setup.root, record.anchorSeq))).toBe(false);
	});

	it("rejects a 201 whose inclusion proof is malformed or ambiguous", async () => {
		const { setup, record } = await anchored();
		type Entry = Record<string, unknown>;
		/** `mutate` rewrites the whole `{uuid: entry}` response the log returned. */
		const publishWith = (mutate: (response: Record<string, Entry>) => unknown): Promise<void> => {
			const { transport } = fakeTransport((call) => {
				const response = JSON.parse(rekorAccepted(call.body).body) as Record<string, Entry>;
				return { status: 201, body: JSON.stringify(mutate(response)) };
			});
			return rekorSink(setup.root, REKOR_URL, transport).publish(record);
		};
		const entryOf = (response: Record<string, Entry>): Entry => Object.values(response)[0] as Entry;
		const proofOf = (response: Record<string, Entry>): Entry =>
			(entryOf(response).verification as Entry).inclusionProof as Entry;

		await expect(
			publishWith((response) => {
				proofOf(response).rootHash = "NOTHEX";
				return response;
			}),
		).rejects.toThrow(/rekor sink: invalid 201 response/);

		await expect(
			publishWith((response) => {
				entryOf(response).verification = {};
				return response;
			}),
		).rejects.toThrow(/rekor sink: invalid 201 response/);

		await expect(
			publishWith((response) => {
				proofOf(response).treeSize = 2;
				return response;
			}),
		).rejects.toThrow(/rekor sink: invalid 201 response/);

		// Two top-level keys: which entry the log means is undecidable.
		await expect(
			publishWith((response) => ({ a: entryOf(response), b: entryOf(response) })),
		).rejects.toThrow(/rekor sink: invalid 201 response/);

		expect(existsSync(receiptPath(setup.root, record.anchorSeq))).toBe(false);
	});

	it("publishes through the emitter's outbox path", async () => {
		const setup = await makeAnchoredVault(3);
		const { transport, calls } = fakeTransport((call) => ({
			status: 201,
			body: rekorAccepted(call.body).body,
		}));
		const emitter = createAnchorEmitter(setup.root, {
			signer: { type: "pem", file: setup.keyFile },
			sinks: [rekorSink(setup.root, REKOR_URL, transport)],
		});

		const result = await emitter.anchorNow();
		await emitter.stop();

		expect(result.emitted).toBe(true);
		expect(calls).toHaveLength(1);
		expect(existsSync(receiptPath(setup.root, 1))).toBe(true);
		expect(emitter.status().outboxDepth).toBe(0);
	});
});

describe("rekor sink: P2 review remediation (409 / response binding / URL / keys / per-log)", () => {
	it("FIX C: a 409 redelivery resolves when the local receipt already witnesses the record", async () => {
		const { setup, record } = await anchored();
		let attempt = 0;
		const { transport, calls } = fakeTransport((call) => {
			attempt++;
			return attempt === 1
				? { status: 201, body: rekorAccepted(call.body).body }
				: { status: 409, body: "entry already exists" };
		});
		const sink = rekorSink(setup.root, REKOR_URL, transport);

		await sink.publish(record);
		// The honest 409: a crash between writing the receipt and clearing the
		// outbox, so the emitter redelivers a record the log already holds. The
		// evidence is on disk; refusing forever would wedge the outbox over an
		// entry we can already prove.
		await expect(sink.publish(record)).resolves.toBeUndefined();
		expect(calls).toHaveLength(2);
		expect(existsSync(receiptPath(setup.root, record.anchorSeq))).toBe(true);
	});

	it("FIX C: a 409 with no local receipt still rejects — a duplicate is not evidence", async () => {
		const { setup, record } = await anchored();
		const { transport } = fakeTransport(() => ({ status: 409, body: "entry already exists" }));

		await expect(rekorSink(setup.root, REKOR_URL, transport).publish(record)).rejects.toThrow(
			/duplicate without local receipt/,
		);
		expect(existsSync(receiptPath(setup.root, record.anchorSeq))).toBe(false);
	});

	it("FIX C: a receipt for a DIFFERENT record does not satisfy this record's 409", async () => {
		const { setup, record } = await anchored();
		const { transport } = fakeTransport((call) => ({
			status: 201,
			body: rekorAccepted(call.body).body,
		}));
		await rekorSink(setup.root, REKOR_URL, transport).publish(record);

		// Anchor #2 is a different record; the receipt on disk is #1's.
		await appendEvents(setup.root, 2, 4);
		const second = await anchorOnce(setup);
		const { transport: conflicting } = fakeTransport(() => ({ status: 409, body: "" }));
		await expect(rekorSink(setup.root, REKOR_URL, conflicting).publish(second)).rejects.toThrow(
			/duplicate without local receipt/,
		);
	});

	it("FIX D: a 201 describing somebody else's entry is refused and writes no receipt", async () => {
		const { setup, record } = await anchored();
		/** A well-formed 201 built from a proposal we did NOT send. */
		const publishWithForgedProposal = (
			mutate: (proposal: Record<string, unknown>) => void,
		): Promise<void> => {
			const { transport } = fakeTransport((call) => {
				const proposal = JSON.parse(call.body.toString("utf8")) as Record<string, unknown>;
				mutate(proposal);
				return {
					status: 201,
					body: rekorAccepted(Buffer.from(JSON.stringify(proposal), "utf8")).body,
				};
			});
			return rekorSink(setup.root, REKOR_URL, transport).publish(record);
		};
		type Spec = {
			data: { hash: { value: string } };
			signature: { content: string };
		};

		// The log answers with an entry that is internally perfect — valid
		// inclusion proof, signed checkpoint — for a different artifact.
		await expect(
			publishWithForgedProposal((proposal) => {
				(proposal.spec as Spec).data.hash.value = randomBytes(32).toString("hex");
			}),
		).rejects.toThrow(/not this record's/);

		// Same shape, right artifact, somebody else's signature: without the
		// signature binding, anyone could log the (public) payload hash of our
		// anchor and hand us back the receipt.
		await expect(
			publishWithForgedProposal((proposal) => {
				(proposal.spec as Spec).signature.content = randomBytes(64).toString("base64");
			}),
		).rejects.toThrow(/not this record's/);

		expect(existsSync(receiptPath(setup.root, record.anchorSeq))).toBe(false);
	});

	it("FIX E: a plaintext log URL is refused at construction, before any record is offered", async () => {
		const setup = await makeAnchoredVault(1);
		const { transport, calls } = fakeTransport(() => ({ status: 201, body: "" }));

		expect(() => rekorSink(setup.root, "http://attacker.example", transport)).toThrow(
			/rekor sink: endpoint must be https/,
		);
		expect(() => rekorSink(setup.root, "rekor.example.test", transport)).toThrow(
			/rekor sink: endpoint must include a scheme/,
		);
		// Loopback stays reachable for a dev log instance, as for the s3 sink.
		expect(() => rekorSink(setup.root, "http://127.0.0.1:3000", transport)).not.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("FIX F: a record redelivered after a rotation proposes the key that SIGNED it", async () => {
		const setup = await makeAnchoredVault(3);
		const record = await anchorOnce(setup);
		const genesisSpki = readAnchorIdentity(setup.root)?.publicKeySpki as string;

		await rotateOnce(setup);
		const identity = readAnchorIdentity(setup.root);
		expect(identity?.publicKeySpki).not.toBe(genesisSpki);
		expect(identity?.keyHistory?.map((k) => k.keyId)).toContain(record.keyId);

		const { transport, calls } = fakeTransport((call) => ({
			status: 201,
			body: rekorAccepted(call.body).body,
		}));
		await rekorSink(setup.root, REKOR_URL, transport).publish(record);

		const entry = JSON.parse((calls[0] as Call).body.toString("utf8")) as {
			spec: { signature: { publicKey: { content: string } } };
		};
		const pem = Buffer.from(entry.spec.signature.publicKey.content, "base64").toString("utf8");
		// The pre-rotation record is still signed by the pre-rotation key. Logging
		// the live key beside that signature would put a permanently unverifiable
		// entry in an append-only log.
		expect(pem).toBe(`-----BEGIN PUBLIC KEY-----\n${genesisSpki}\n-----END PUBLIC KEY-----\n`);
	});

	it("FIX F: a keyId absent from the history is refused rather than guessed at", async () => {
		const { setup, record } = await anchored();
		const { transport, calls } = fakeTransport(() => ({ status: 201, body: "" }));
		const foreign = { ...record, keyId: `sha256:${"9".repeat(64)}` };

		await expect(rekorSink(setup.root, REKOR_URL, transport).publish(foreign)).rejects.toThrow(
			/no public key for keyId/,
		);
		expect(calls).toHaveLength(0);
	});

	it("FIX G: two logs produce two receipt files for one record, not one overwrite", async () => {
		const { setup, record } = await anchored();
		const SECOND_URL = "https://rekor2.example.test";
		for (const url of [REKOR_URL, SECOND_URL]) {
			const { transport } = fakeTransport((call) => ({
				status: 201,
				body: rekorAccepted(call.body, { origin: new URL(url).host }).body,
			}));
			await rekorSink(setup.root, url, transport).publish(record);
		}

		const dir = join(setup.root, VAULT_DIR, "audit", "anchors", "rekor");
		const names = readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.sort();
		// Two witnesses configured, two independent attestations kept. Keying by
		// anchorSeq alone silently left the operator with one.
		expect(names).toHaveLength(2);
		expect(existsSync(receiptPath(setup.root, record.anchorSeq, REKOR_URL))).toBe(true);
		expect(existsSync(receiptPath(setup.root, record.anchorSeq, SECOND_URL))).toBe(true);
		const urls = names.map(
			(name) =>
				(parseRekorReceipt(readFileSync(join(dir, name), "utf-8")).receipt as RekorReceipt).log.url,
		);
		expect([...urls].sort()).toEqual([REKOR_URL, SECOND_URL].sort());
	});
});

describe("createSink (D7 — rootDir is optional and only rekor needs it)", () => {
	it("builds the declarative s3 and rekor sinks", async () => {
		const setup = await makeAnchoredVault(1);
		expect(createSink({ type: "s3", bucket: "b", region: "us-east-1" }).name).toBe("s3:b/anchors");
		expect(createSink({ type: "rekor" }, setup.root).name).toBe("rekor:https://rekor.sigstore.dev");
		expect(createSink({ type: "rekor", url: REKOR_URL }, setup.root).name).toBe(
			`rekor:${REKOR_URL}`,
		);
	});

	it("refuses a rekor sink with no vault to persist receipts into", () => {
		expect(() => createSink({ type: "rekor" })).toThrow("rekor sink requires rootDir");
	});
});
