// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — REKOR RECEIPT VERIFICATION (plan T2)
 *
 * A Rekor receipt is caller-supplied, attacker-shaped input whose only job is
 * to convince an auditor that a specific anchor record was published to a
 * transparency log at a specific time. Every check that stands between those
 * two claims is exercised here adversarially: inclusion math against an
 * independent RFC 6962 reference, the entry->record binding, checkpoint
 * origin/size/root/signature, and the trust-pinning rule for custom logs.
 */

import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	anchorPayloadHash as pkgAnchorPayloadHash,
	parseRekorReceipt as pkgParseRekorReceipt,
	REKOR_PROD_PUBKEY_PEM as pkgRekorProdPubkeyPem,
	verifyIndexInclusion as pkgVerifyIndexInclusion,
	verifyRekorReceipt as pkgVerifyRekorReceipt,
} from "../../../../verify/src/index.js";
import {
	type AnchorRecord,
	anchorPayloadHash,
	parseAnchorRecord,
} from "../../../src/audit/anchor-verify.js";
import {
	parseRekorReceipt,
	parseSignedNote,
	REKOR_PROD_PUBKEY_PEM,
	verifyIndexInclusion,
	verifyRekorReceipt,
} from "../../../src/audit/rekor-verify.js";
import {
	type AnchoredSetup,
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
} from "./fixtures.js";
import {
	bogusSignatureLine,
	hashedRekordEntry,
	inclusionPath,
	leafHash,
	makeRekorReceipt,
	mth,
	signedEntryTimestamp,
	signedNote,
} from "./rekor-fixtures.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

let setup: AnchoredSetup;
let record: AnchorRecord;

beforeAll(async () => {
	setup = await makeAnchoredVault(4);
	record = await anchorOnce(setup);
});

afterAll(() => {
	cleanupAll();
});

describe("HARDEN: RFC 9162 index inclusion vs the RFC 6962 PATH reference", () => {
	it("1. accepts the reference path for every (treeSize <= 20, index) pair", () => {
		let checked = 0;
		for (let n = 1; n <= 20; n++) {
			const entries = Array.from({ length: n }, () => randomBytes(32));
			const rootHex = mth(entries).toString("hex");
			for (let i = 0; i < n; i++) {
				const path = inclusionPath(i, entries).map((h) => h.toString("hex"));
				const leaf = leafHash(entries[i] as Buffer).toString("hex");
				expect(verifyIndexInclusion(leaf, i, n, path, rootHex)).toBe(true);
				checked++;
			}
		}
		expect(checked).toBe(210);
	});

	it("2. rejects a path with ANY single element replaced by an unrelated hash", () => {
		for (let n = 2; n <= 20; n++) {
			const entries = Array.from({ length: n }, () => randomBytes(32));
			const rootHex = mth(entries).toString("hex");
			for (let i = 0; i < n; i++) {
				const path = inclusionPath(i, entries).map((h) => h.toString("hex"));
				const leaf = leafHash(entries[i] as Buffer).toString("hex");
				for (let j = 0; j < path.length; j++) {
					const mutated = [...path];
					mutated[j] = randomBytes(32).toString("hex");
					expect(verifyIndexInclusion(leaf, i, n, mutated, rootHex)).toBe(false);
				}
			}
		}
	});

	it("3. rejects wrong leaf, wrong index, out-of-range index, wrong root, and truncated paths", () => {
		const entries = Array.from({ length: 11 }, () => randomBytes(32));
		const rootHex = mth(entries).toString("hex");
		const index = 6;
		const path = inclusionPath(index, entries).map((h) => h.toString("hex"));
		const leaf = leafHash(entries[index] as Buffer).toString("hex");

		expect(verifyIndexInclusion(leaf, index, 11, path, rootHex)).toBe(true);
		expect(verifyIndexInclusion(randomBytes(32).toString("hex"), index, 11, path, rootHex)).toBe(
			false,
		);
		expect(verifyIndexInclusion(leaf, 5, 11, path, rootHex)).toBe(false);
		expect(verifyIndexInclusion(leaf, 11, 11, path, rootHex)).toBe(false);
		expect(verifyIndexInclusion(leaf, -1, 11, path, rootHex)).toBe(false);
		expect(verifyIndexInclusion(leaf, 1.5, 11, path, rootHex)).toBe(false);
		expect(verifyIndexInclusion(leaf, index, 11, path.slice(1), rootHex)).toBe(false);
		expect(verifyIndexInclusion(leaf, index, 11, [...path, path[0] as string], rootHex)).toBe(
			false,
		);
		expect(verifyIndexInclusion(leaf, index, 11, path, randomBytes(32).toString("hex"))).toBe(
			false,
		);
		// Malformed hex anywhere is a rejection, never a throw.
		expect(verifyIndexInclusion("zz", index, 11, path, rootHex)).toBe(false);
		expect(verifyIndexInclusion(leaf, index, 11, ["nothex"], rootHex)).toBe(false);
		expect(verifyIndexInclusion(leaf, 0, 1, [], leaf)).toBe(true);
	});
});

describe("HARDEN: signed-note checkpoint parsing", () => {
	it("4. parses the canonical 5-line note and exposes the signed body verbatim", () => {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const root = randomBytes(32);
		const note = signedNote("rekor.sigstore.dev", 42, root, privateKey);
		const parsed = parseSignedNote(note);
		expect(parsed).not.toBeNull();
		expect(parsed?.origin).toBe("rekor.sigstore.dev");
		expect(parsed?.treeSize).toBe(42);
		expect(parsed?.rootHashHex).toBe(root.toString("hex"));
		expect(parsed?.body).toBe(`rekor.sigstore.dev\n42\n${root.toString("base64")}\n`);
		// The 4-byte key hint is advisory and stripped; the rest is the DER sig.
		expect(parsed?.sigs).toHaveLength(1);
		expect((parsed?.sigs[0]?.length ?? 0) > 8).toBe(true);
	});

	it("5. rejects CRLF, wrong line counts, short roots, and malformed signature lines", () => {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const root = randomBytes(32);
		const good = signedNote("log.example.org", 9, root, privateKey);
		expect(parseSignedNote(good)).not.toBeNull();

		expect(parseSignedNote(good.replace(/\n/g, "\r\n"))).toBeNull();
		expect(parseSignedNote("")).toBeNull();
		expect(parseSignedNote("origin\n9\n")).toBeNull();
		// No blank separator line.
		expect(parseSignedNote(good.replace("\n\n—", "\n—"))).toBeNull();
		// Witness co-signatures are the accepted shape; a malformed one is not.
		expect(parseSignedNote(`${good}${bogusSignatureLine()}\n`)?.sigs).toHaveLength(2);
		expect(parseSignedNote(`${good}not-a-signature-line\n`)).toBeNull();
		expect(parseSignedNote(`${good}\n`)).toBeNull();
		// Non-numeric / oversized tree size.
		expect(parseSignedNote(good.replace("\n9\n", "\nnine\n"))).toBeNull();
		// Root that does not decode to 32 bytes.
		expect(
			parseSignedNote(signedNote("log.example.org", 9, randomBytes(16), privateKey)),
		).toBeNull();
		// Signature line without the em-dash marker.
		expect(parseSignedNote(good.replace("—", "-"))).toBeNull();
		// Signature payload shorter than the 4-byte key hint.
		expect(parseSignedNote(good.replace(/— (\S+) (\S+)/, "— $1 AAAA"))).toBeNull();
		// An 8 KiB+ checkpoint is refused outright.
		expect(parseSignedNote(good + "x".repeat(9000))).toBeNull();
	});
});

describe("HARDEN: receipt verification against a real anchor record", () => {
	it("6. a well-formed receipt for the record verifies and attests its time", () => {
		const f = makeRekorReceipt(record, { integratedTime: 1_700_000_042 });
		const result = verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]);
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.attestedTimeMs).toBe(1_700_000_042_000);
	});

	it("7. verifies at every position of the log, not just the tail", () => {
		for (const logIndex of [0, 1, 4, 6]) {
			const f = makeRekorReceipt(record, { logSize: 7, logIndex });
			expect(verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]).ok).toBe(true);
		}
	});

	it("8. round-trips through parseRekorReceipt (the CLI ingestion path)", () => {
		const f = makeRekorReceipt(record);
		const { receipt, error } = parseRekorReceipt(JSON.stringify(f.receipt));
		expect(error).toBeNull();
		expect(receipt).not.toBeNull();
		expect(verifyRekorReceipt(receipt as never, record, [f.logPubkeyPem]).ok).toBe(true);
	});
});

describe("HARDEN: adversarial receipt mutations (every one must fail closed)", () => {
	const expectFailure = (mutated: unknown, keys: string[], needle: string): void => {
		const result = verifyRekorReceipt(mutated as never, record, keys);
		expect(result.ok).toBe(false);
		expect(result.attestedTimeMs).toBeNull();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.every((e) => e.startsWith("rekor-receipt-invalid: "))).toBe(true);
		expect(result.errors.join(" | ")).toContain(needle);
	};

	it("9. wrong vaultId / wrong anchorSeq — the receipt is for a different record", () => {
		const f = makeRekorReceipt(record);
		expectFailure(
			f.tamper((r) => {
				r.vaultId = "vault_other";
			}),
			[f.logPubkeyPem],
			"record mismatch",
		);
		expectFailure(
			f.tamper((r) => {
				r.anchorSeq = record.anchorSeq + 1;
			}),
			[f.logPubkeyPem],
			"record mismatch",
		);
	});

	it("10. artifactHash that is not the record's anchor payload hash", () => {
		const f = makeRekorReceipt(record);
		expectFailure(
			f.tamper((r) => {
				r.artifactHash = randomBytes(32).toString("hex");
			}),
			[f.logPubkeyPem],
			"artifactHash",
		);
	});

	it("11. entryBody hash value diverges from artifactHash", () => {
		const f = makeRekorReceipt(record);
		const forged = { ...JSON.parse(f.entryBody.toString("utf8")) } as {
			spec: { data: { hash: { value: string } } };
		};
		forged.spec.data.hash.value = randomBytes(32).toString("hex");
		expectFailure(
			f.tamper((r) => {
				r.entryBody = Buffer.from(JSON.stringify(forged), "utf8").toString("base64");
			}),
			[f.logPubkeyPem],
			"spec.data.hash.value",
		);
	});

	it("12. entryBody signature is not the anchor record's signature", () => {
		const f = makeRekorReceipt(record);
		const forged = JSON.parse(f.entryBody.toString("utf8")) as {
			spec: { signature: { content: string } };
		};
		forged.spec.signature.content = randomBytes(64).toString("base64");
		expectFailure(
			f.tamper((r) => {
				r.entryBody = Buffer.from(JSON.stringify(forged), "utf8").toString("base64");
			}),
			[f.logPubkeyPem],
			"signature",
		);
	});

	it("13. entryBody of the wrong kind, or not JSON at all", () => {
		const f = makeRekorReceipt(record);
		const forged = JSON.parse(f.entryBody.toString("utf8")) as { kind: string };
		forged.kind = "intoto";
		expectFailure(
			f.tamper((r) => {
				r.entryBody = Buffer.from(JSON.stringify(forged), "utf8").toString("base64");
			}),
			[f.logPubkeyPem],
			"hashedrekord",
		);
		expectFailure(
			f.tamper((r) => {
				r.entryBody = Buffer.from("not json", "utf8").toString("base64");
			}),
			[f.logPubkeyPem],
			"entryBody",
		);
	});

	it("14. wrong logIndex — the entry is not where the receipt claims", () => {
		const f = makeRekorReceipt(record, { logSize: 8, logIndex: 5 });
		expectFailure(
			f.tamper((r) => {
				r.log.logIndex = 4;
			}),
			[f.logPubkeyPem],
			"inclusion proof",
		);
	});

	it("15. a tampered inclusion-path element", () => {
		const f = makeRekorReceipt(record);
		expectFailure(
			f.tamper((r) => {
				r.log.hashes[0] = randomBytes(32).toString("hex");
			}),
			[f.logPubkeyPem],
			"inclusion proof",
		);
	});

	it("16. checkpoint attests a different tree size than the proof was built for", () => {
		const f = makeRekorReceipt(record, { logSize: 8 });
		expectFailure(
			f.tamper((r) => {
				r.log.checkpoint = signedNote(
					"rekor.sigstore.dev",
					9,
					Buffer.from(r.log.rootHash, "hex"),
					f.logPrivateKey,
				);
			}),
			[f.logPubkeyPem],
			"treeSize",
		);
	});

	it("17. checkpoint attests a different root than the proof reconstructs", () => {
		const f = makeRekorReceipt(record, { logSize: 8 });
		expectFailure(
			f.tamper((r) => {
				r.log.checkpoint = signedNote(
					"rekor.sigstore.dev",
					r.log.treeSize,
					randomBytes(32),
					f.logPrivateKey,
				);
			}),
			[f.logPubkeyPem],
			"root hash",
		);
	});

	it("18. checkpoint origin is not the host of log.url", () => {
		const f = makeRekorReceipt(record, { logSize: 8 });
		expectFailure(
			f.tamper((r) => {
				r.log.checkpoint = signedNote(
					"evil.example.org",
					r.log.treeSize,
					Buffer.from(r.log.rootHash, "hex"),
					f.logPrivateKey,
				);
			}),
			[f.logPubkeyPem],
			"origin",
		);
	});

	it("19. checkpoint signed by a key the auditor did not pin", () => {
		const f = makeRekorReceipt(record);
		const foreign = generateKeyPairSync("ec", { namedCurve: "P-256" });
		expectFailure(
			f.receipt,
			[foreign.publicKey.export({ type: "spki", format: "pem" }) as string],
			"signature does not verify",
		);
		// A keyring is a keyring: the right key ANYWHERE in it passes.
		const ring = [
			foreign.publicKey.export({ type: "spki", format: "pem" }) as string,
			f.logPubkeyPem,
		];
		expect(verifyRekorReceipt(f.receipt, record, ring).ok).toBe(true);
	});

	it("20. a receipt bound to a DIFFERENT record of the same vault does not transfer", async () => {
		await appendEvents(setup.root, 2);
		const second = await anchorOnce(setup);
		const f = makeRekorReceipt(second);
		expect(verifyRekorReceipt(f.receipt, second, [f.logPubkeyPem]).ok).toBe(true);
		expectFailure(f.receipt, [f.logPubkeyPem], "record mismatch");
	});
});

describe("HARDEN: attested time is only ever a SIGNED time (P2 review, FIX A)", () => {
	it("40. editing integratedTime alone now fails — the SET is the only signature over it", () => {
		const f = makeRekorReceipt(record, { integratedTime: 1_700_000_042 });
		expect(verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]).attestedTimeMs).toBe(
			1_700_000_042_000,
		);

		// Everything else in the receipt is untouched: the inclusion proof still
		// reconstructs the root and the checkpoint still verifies. The ONLY thing
		// standing between an operator and a freely chosen "witness-attested" time
		// is a signature they do not hold the key for.
		const backdated = f.tamper((r) => {
			r.log.integratedTime = 1_600_000_000;
		});
		const result = verifyRekorReceipt(backdated, record, [f.logPubkeyPem]);
		expect(result.ok).toBe(false);
		expect(result.attestedTimeMs).toBeNull();
		expect(result.errors.join(" | ")).toContain("signedEntryTimestamp does not verify");
	});

	it("41. re-signing the backdated time with the attacker's own key does not help either", () => {
		const f = makeRekorReceipt(record, { integratedTime: 1_700_000_042 });
		const foreign = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const forged = f.tamper((r) => {
			r.log.integratedTime = 1_600_000_000;
			r.log.signedEntryTimestamp = signedEntryTimestamp(
				{
					body: r.entryBody,
					integratedTime: r.log.integratedTime,
					logID: r.log.logID as string,
					logIndex: r.log.logIndex,
				},
				foreign.privateKey,
			);
		});
		const result = verifyRekorReceipt(forged, record, [f.logPubkeyPem]);
		expect(result.ok).toBe(false);
		expect(result.errors.join(" | ")).toContain("signedEntryTimestamp does not verify");
	});

	it("42. the SET covers the logID, not just the time", () => {
		const f = makeRekorReceipt(record);
		const swapped = f.tamper((r) => {
			r.log.logID = randomBytes(32).toString("hex");
		});
		expect(verifyRekorReceipt(swapped, record, [f.logPubkeyPem]).ok).toBe(false);
	});

	it("43. a receipt with NO SET proves inclusion and attests no time", () => {
		const f = makeRekorReceipt(record, { integratedTime: 1_700_000_042, withSet: false });
		const result = verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]);

		// Inclusion is a separate claim and it still holds — a log that emits no
		// signed entry timestamp is not a broken receipt, just a quieter one.
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.attestedTimeMs).toBeNull();
		// And it is not a loophole: with no SET, integratedTime buys nothing at all.
		const rewritten = f.tamper((r) => {
			r.log.integratedTime = 1;
		});
		const after = verifyRekorReceipt(rewritten, record, [f.logPubkeyPem]);
		expect(after.ok).toBe(true);
		expect(after.attestedTimeMs).toBeNull();
		expect(pkgVerifyRekorReceipt(f.receipt, record, [f.logPubkeyPem])).toEqual(result);
	});
});

describe("HARDEN: trust pinning for custom logs (plan-review D4)", () => {
	it("21. the embedded production key is data, not a dependency: P-256 and only for rekor.sigstore.dev", () => {
		expect(REKOR_PROD_PUBKEY_PEM).toContain("-----BEGIN PUBLIC KEY-----");
		expect(REKOR_PROD_PUBKEY_PEM).toBe(pkgRekorProdPubkeyPem);
		// An unpinned custom log must never supply its own trust root.
		const custom = makeRekorReceipt(record, { url: "https://log.example.org" });
		const unpinned = verifyRekorReceipt(custom.receipt, record, []);
		expect(unpinned.ok).toBe(false);
		expect(unpinned.errors.join(" | ")).toContain("custom log requires");
		// With the key supplied, the very same receipt verifies.
		expect(verifyRekorReceipt(custom.receipt, record, [custom.logPubkeyPem]).ok).toBe(true);
	});

	it("22. an unpinned rekor.sigstore.dev receipt is checked against the embedded key (and fails when forged)", () => {
		const f = makeRekorReceipt(record, { url: "https://rekor.sigstore.dev" });
		const result = verifyRekorReceipt(f.receipt, record, []);
		expect(result.ok).toBe(false);
		// It got as far as the signature check — the embedded key WAS consulted.
		expect(result.errors.join(" | ")).toContain("signature does not verify");
		expect(result.errors.join(" | ")).not.toContain("custom log requires");
	});
});

describe("HARDEN: a supplied keyring that all got discarded is never the embedded key (P1-1)", () => {
	const REFUSAL = "refusing to fall back to the embedded key";
	const EMBEDDED_PATH = "does not verify under any pinned log public key";

	it("31. an empty --rekor-pubkey entry refuses instead of silently reverting to the embedded key", () => {
		// The dangerous case: the log host IS the one the embedded key speaks for,
		// so a fallback here would verify under a key the auditor never chose and
		// pass a merge gate they believed they had pinned.
		const f = makeRekorReceipt(record, { url: "https://rekor.sigstore.dev" });
		const result = verifyRekorReceipt(f.receipt, record, [""]);

		expect(result.ok).toBe(false);
		expect(result.errors.join(" | ")).toContain(REFUSAL);
		expect(result.errors.join(" | ")).not.toContain(EMBEDDED_PATH);
		// Both packages refuse identically — this is a merge gate, not a nicety.
		expect(pkgVerifyRekorReceipt(f.receipt, record, [""])).toEqual(result);
	});

	it("32. a PEM over the 16 KiB cap is discarded material, not an absent pin", () => {
		const f = makeRekorReceipt(record, { url: "https://rekor.sigstore.dev" });
		const oversized = `${"x".repeat(17 * 1024)}\n`;
		const result = verifyRekorReceipt(f.receipt, record, [oversized]);

		expect(result.ok).toBe(false);
		expect(result.errors.join(" | ")).toContain(REFUSAL);
		expect(result.errors.join(" | ")).not.toContain(EMBEDDED_PATH);
		// The blob itself is never echoed back.
		expect(result.errors.join(" | ")).not.toContain("xxxx");
	});

	it("33. supplying NOTHING still reaches the embedded key, and a real pin still verifies", () => {
		const f = makeRekorReceipt(record, { url: "https://rekor.sigstore.dev" });
		// Unchanged behavior: no material supplied ⇒ the embedded key is consulted.
		expect(verifyRekorReceipt(f.receipt, record, []).errors.join(" | ")).toContain(EMBEDDED_PATH);
		expect(verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]).ok).toBe(true);
		// A custom log with discarded material names the supply failure, which is
		// the more useful truth than "no pin for this host".
		const custom = makeRekorReceipt(record, { url: "https://log.example.org" });
		expect(verifyRekorReceipt(custom.receipt, record, [""]).errors.join(" | ")).toContain(REFUSAL);
	});
});

describe("HARDEN: live-Rekor checkpoint shapes (P2-1)", () => {
	it("34. the production origin form `<host> - <treeID>` verifies", () => {
		const f = makeRekorReceipt(record, { treeId: "2605736670972794746" });
		expect(f.receipt.log.checkpoint.split("\n")[0]).toBe(
			"rekor.sigstore.dev - 2605736670972794746",
		);
		expect(verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]).errors).toEqual([]);
		expect(verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]).ok).toBe(true);
	});

	it("35. a witness co-signed checkpoint verifies on the signature the auditor pinned", () => {
		// The log's own signature is emitted LAST, behind a witness line no pinned
		// key verifies — a verifier that stopped at the first line would fail here.
		const f = makeRekorReceipt(record, {
			treeId: "2605736670972794746",
			extraSignatureLines: [bogusSignatureLine()],
		});
		expect(parseSignedNote(f.receipt.log.checkpoint)?.sigs).toHaveLength(2);
		expect(verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]).ok).toBe(true);
	});

	it("36. zero signatures verifying under the keyring still fails closed", () => {
		const f = makeRekorReceipt(record);
		const foreign = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const cosignedByStrangers = f.tamper((r) => {
			r.log.checkpoint = signedNote(
				"rekor.sigstore.dev",
				r.log.treeSize,
				Buffer.from(r.log.rootHash, "hex"),
				foreign.privateKey,
				undefined,
				[bogusSignatureLine()],
			);
		});
		const result = verifyRekorReceipt(cosignedByStrangers, record, [f.logPubkeyPem]);
		expect(result.ok).toBe(false);
		expect(result.errors.join(" | ")).toContain("signature does not verify");
	});

	it("37. the origin still has to NAME the log.url host — prefix, never suffix", () => {
		for (const origin of ["rekor.sigstore.dev.evil.net", "evil.example.org"]) {
			const f = makeRekorReceipt(record, { origin, treeId: "2605736670972794746" });
			const result = verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]);
			expect(result.ok).toBe(false);
			expect(result.errors.join(" | ")).toContain("origin");
		}
		// And the treeID half is not a place to hide the host either.
		const smuggled = makeRekorReceipt(record, {
			origin: "evil.example.org",
			treeId: "rekor.sigstore.dev",
		});
		expect(verifyRekorReceipt(smuggled.receipt, record, [smuggled.logPubkeyPem]).ok).toBe(false);
	});
});

describe("HARDEN: error strings are terminal-safe (P2-3)", () => {
	const ESCAPE = "\u001b[2K\rANCHOR STATE: VERIFIED";

	it("38. a receipt field name carrying terminal escapes is stripped, not echoed", () => {
		const obj = JSON.parse(JSON.stringify(makeRekorReceipt(record).receipt)) as Record<
			string,
			unknown
		>;
		obj[ESCAPE] = 1;
		const { receipt, error } = parseRekorReceipt(JSON.stringify(obj));

		expect(receipt).toBeNull();
		expect(error).toContain("unknown field");
		expect(error).not.toContain("\u001b");
		expect(error).not.toContain("\r");
		// The readable remainder still names what was wrong.
		expect(error).toContain("ANCHOR STATE: VERIFIED");
	});

	it("39. the same holds for an anchor record's unknown-field echo", () => {
		const { record: parsed, error } = parseAnchorRecord(JSON.stringify({ [ESCAPE]: 1 }));

		expect(parsed).toBeNull();
		expect(error).toContain("unknown field");
		expect(error).not.toContain("\u001b");
		expect(error).not.toContain("\r");
		// A very long key is truncated as well, so the echo cannot fill a screen.
		const long = parseAnchorRecord(JSON.stringify({ [`${"k".repeat(400)}`]: 1 })).error as string;
		expect(long.length).toBeLessThan(160);
	});
});

describe("HARDEN: strict receipt parsing", () => {
	const base = (): Record<string, unknown> =>
		JSON.parse(JSON.stringify(makeRekorReceipt(record).receipt)) as Record<string, unknown>;

	const rejects = (mutate: (r: Record<string, unknown>) => void, needle: string): void => {
		const obj = base();
		mutate(obj);
		const { receipt, error } = parseRekorReceipt(JSON.stringify(obj));
		expect(receipt).toBeNull();
		expect(error).toContain("rekor-receipt-invalid: ");
		expect(error).toContain(needle);
	};

	it("23. rejects non-JSON, non-objects, and oversized input", () => {
		expect(parseRekorReceipt("{").error).toContain("not valid JSON");
		expect(parseRekorReceipt("[]").error).toContain("not an object");
		expect(parseRekorReceipt("null").error).toContain("not an object");
		expect(parseRekorReceipt(`"${"x".repeat(300 * 1024)}"`).error).toContain("256 KiB");
	});

	it("24. rejects unknown fields at both levels (the schema is frozen)", () => {
		rejects((r) => {
			r.extra = 1;
		}, 'unknown field "extra"');
		rejects((r) => {
			(r.log as Record<string, unknown>).extra = 1;
		}, 'unknown log field "extra"');
	});

	it("25. rejects malformed scalars and range violations", () => {
		rejects((r) => {
			r.v = 2;
		}, "unsupported version");
		rejects((r) => {
			r.vaultId = "";
		}, "vaultId");
		rejects((r) => {
			r.anchorSeq = 0;
		}, "anchorSeq");
		rejects((r) => {
			r.artifactHash = "ABC";
		}, "artifactHash");
		rejects((r) => {
			r.artifactHash = (r.artifactHash as string).toUpperCase();
		}, "artifactHash");
		rejects((r) => {
			r.entryBody = "";
		}, "entryBody");
		rejects((r) => {
			(r.log as Record<string, unknown>).url = "ftp://example.org";
		}, "log.url");
		rejects((r) => {
			(r.log as Record<string, unknown>).logIndex = 1.5;
		}, "log.logIndex");
		rejects((r) => {
			(r.log as Record<string, unknown>).logIndex = 99;
		}, "logIndex must be < log.treeSize");
		rejects((r) => {
			(r.log as Record<string, unknown>).rootHash = "not-hex";
		}, "log.rootHash");
		rejects((r) => {
			(r.log as Record<string, unknown>).hashes = ["nope"];
		}, "log.hashes");
		rejects((r) => {
			(r.log as Record<string, unknown>).hashes = Array.from({ length: 65 }, () =>
				randomBytes(32).toString("hex"),
			);
		}, "log.hashes");
		rejects((r) => {
			(r.log as Record<string, unknown>).checkpoint = "x".repeat(9000);
		}, "log.checkpoint");
		rejects((r) => {
			(r.log as Record<string, unknown>).integratedTime = 0;
		}, "log.integratedTime");
	});

	it("44. rejects an integratedTime whose milliseconds leave the ECMAScript Date range", () => {
		// `integratedTime * 1000` is printed as an ISO timestamp downstream, and
		// toISOString throws past ±8.64e15 ms — an attacker-chosen number must not
		// be able to crash the verdict it appears in.
		rejects((r) => {
			(r.log as Record<string, unknown>).integratedTime = 8_640_000_000_000;
		}, "log.integratedTime");
		rejects((r) => {
			(r.log as Record<string, unknown>).integratedTime = Number.MAX_SAFE_INTEGER;
		}, "log.integratedTime");
		// The boundary value itself still parses.
		const ok = base();
		(ok.log as Record<string, unknown>).integratedTime = 8_639_999_999_999;
		expect(parseRekorReceipt(JSON.stringify(ok)).error).toBeNull();
	});

	it("45. rejects malformed SET material, and a SET with no logID to verify it against", () => {
		rejects((r) => {
			(r.log as Record<string, unknown>).logID = "not-hex";
		}, "log.logID");
		rejects((r) => {
			(r.log as Record<string, unknown>).signedEntryTimestamp = "x".repeat(1100);
		}, "log.signedEntryTimestamp");
		rejects((r) => {
			(r.log as Record<string, unknown>).signedEntryTimestamp = "not base64!!";
		}, "log.signedEntryTimestamp");
		// The logID is inside the payload the SET signs, so a SET without one can
		// never be checked by anyone — it is refused, not silently ignored.
		rejects((r) => {
			delete (r.log as Record<string, unknown>).logID;
		}, "requires log.logID");
	});

	it("26. error strings never echo untrusted blobs (plan-review D5)", () => {
		const f = makeRekorReceipt(record);
		const long = "q".repeat(400);
		const mutated = f.tamper((r) => {
			r.vaultId = long;
		});
		const result = verifyRekorReceipt(mutated, record, [f.logPubkeyPem]);
		const joined = result.errors.join(" | ");
		expect(joined).not.toContain(long);
		expect(joined).not.toContain(f.receipt.entryBody);
		expect(joined).not.toContain(f.receipt.log.checkpoint);
		expect(joined).not.toContain(f.logPubkeyPem);
		for (const e of result.errors) {
			expect(e.length).toBeLessThan(240);
		}
	});
});

describe("HARDEN: core <-> verify parity", () => {
	it("27. rekor-verify.ts is byte-identical across packages modulo import paths", () => {
		const strip = (s: string): string =>
			s
				.split("\n")
				.filter((l) => !l.includes('from "'))
				.join("\n");
		const pkgCopy = readFileSync(
			join(REPO_ROOT, "packages", "verify", "src", "rekor-verify.ts"),
			"utf-8",
		);
		const coreCopy = readFileSync(
			join(REPO_ROOT, "packages", "core", "src", "audit", "rekor-verify.ts"),
			"utf-8",
		);
		expect(strip(coreCopy)).toBe(strip(pkgCopy));
	});

	it("28. behavior parity: identical inputs produce identical results in both packages (D12)", () => {
		const f = makeRekorReceipt(record, { integratedTime: 1_699_999_999 });
		const raw = JSON.stringify(f.receipt);

		expect(pkgAnchorPayloadHash(record)).toBe(anchorPayloadHash(record));
		expect(pkgParseRekorReceipt(raw)).toEqual(parseRekorReceipt(raw));
		expect(pkgVerifyRekorReceipt(f.receipt, record, [f.logPubkeyPem])).toEqual(
			verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]),
		);

		// Failure paths must agree too — identical error strings, not just verdicts.
		const tampered = f.tamper((r) => {
			r.log.hashes[0] = randomBytes(32).toString("hex");
		});
		expect(pkgVerifyRekorReceipt(tampered, record, [f.logPubkeyPem])).toEqual(
			verifyRekorReceipt(tampered, record, [f.logPubkeyPem]),
		);
		expect(pkgVerifyRekorReceipt(f.receipt, record, [])).toEqual(
			verifyRekorReceipt(f.receipt, record, []),
		);

		const entries = Array.from({ length: 13 }, () => randomBytes(32));
		const rootHex = mth(entries).toString("hex");
		const path = inclusionPath(9, entries).map((h) => h.toString("hex"));
		const leaf = leafHash(entries[9] as Buffer).toString("hex");
		expect(pkgVerifyIndexInclusion(leaf, 9, 13, path, rootHex)).toBe(
			verifyIndexInclusion(leaf, 9, 13, path, rootHex),
		);
	});

	it("29. the leaf hash is sha256(0x00 || the log's stored bytes), never a reserialization", () => {
		const f = makeRekorReceipt(record, { logSize: 1, logIndex: 0 });
		const expected = createHash("sha256")
			.update(Buffer.from([0x00]))
			.update(f.entryBody)
			.digest("hex");
		expect(f.receipt.log.rootHash).toBe(expected);
		// Re-serializing the entry (even to equivalent JSON) breaks inclusion.
		const reserialized = Buffer.from(`${f.entryBody.toString("utf8")} `, "utf8").toString("base64");
		const result = verifyRekorReceipt(
			f.tamper((r) => {
				r.entryBody = reserialized;
			}),
			record,
			[f.logPubkeyPem],
		);
		expect(result.ok).toBe(false);
		expect(result.errors.join(" | ")).toContain("inclusion proof");
	});

	it("30. the entry body the sink will build (T3) is exactly what this verifier accepts", () => {
		const pem = "-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----\n";
		const entry = hashedRekordEntry(record, pem);
		const parsed = JSON.parse(entry.toString("utf8")) as Record<string, unknown>;
		expect(parsed.apiVersion).toBe("0.0.1");
		expect(parsed.kind).toBe("hashedrekord");
		const f = makeRekorReceipt(record, { publicKeyPem: pem });
		expect(f.entryBody.equals(entry)).toBe(true);
		expect(verifyRekorReceipt(f.receipt, record, [f.logPubkeyPem]).ok).toBe(true);
	});
});
