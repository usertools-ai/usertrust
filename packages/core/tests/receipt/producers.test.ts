// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { formatReceipt, type ReceiptFields } from "../../src/receipt/format.js";

/**
 * `formatReceipt` calls an unsettled receipt "provisional" (not sealed) by what the receipt LACKS: no `usageSource`
 * and no `actionKind`, the shape of a stream's estimate handle, whose hash is a placeholder for a spend event that
 * is not on the chain yet. A rule that reads absence is only as good as the list of producers it was checked against,
 * so this table names every place in core that builds a `TrustReceipt` and the label its unsettled form gets. A new
 * producer fails the first test until it is classified here, and the second test holds each entry to what the source
 * of that producer actually sets.
 */

const SRC = join(import.meta.dirname, "..", "..", "src");
const FILES = ["govern.ts", "headless.ts"] as const;

type Label = "provisional" | "sealed";

/** Every producer, by file, the name it is bound to and its order among same-named ones, with the label it must get. */
const PRODUCERS: Record<string, Label> = {
	"govern.ts#buildEstimatedStreamReceipt#1": "provisional", // the stream's handle, before it is consumed
	"govern.ts#streamReceipt#1": "sealed", // a stream's final receipt: usageSource, real hash, may be an ambiguous settlement
	"govern.ts#receipt#1": "sealed", // a call's final receipt: usageSource, real hash, settled or ambiguous
	"govern.ts#receipt#2": "sealed", // a governed action's receipt: actionKind, real hash, settled or ambiguous
	"headless.ts#receipt#1": "sealed", // the headless governor's receipt: usageSource, real hash
};

interface Site {
	key: string;
	props: Set<string>;
}

/** Each object literal typed as a `TrustReceipt`, found from the syntax tree: a typed variable or an arrow's return. */
function sites(): Site[] {
	const found: Site[] = [];
	for (const file of FILES) {
		const source = ts.createSourceFile(
			file,
			readFileSync(join(SRC, file), "utf-8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const seen = new Map<string, number>();
		const add = (name: string, literal: ts.ObjectLiteralExpression): void => {
			const n = (seen.get(name) ?? 0) + 1;
			seen.set(name, n);
			const props = new Set<string>();
			for (const p of literal.properties) {
				if (ts.isSpreadAssignment(p)) {
					// `...(cond ? { name: x } : {})`: the names inside the spread's object literals count as set
					p.expression.forEachChild(function walk(node): void {
						if (ts.isObjectLiteralExpression(node))
							for (const q of node.properties) if (q.name) props.add(q.name.getText());
						node.forEachChild(walk);
					});
					if (ts.isObjectLiteralExpression(p.expression)) {
						for (const q of p.expression.properties) if (q.name) props.add(q.name.getText());
					}
				} else if (p.name) {
					props.add(p.name.getText());
				}
			}
			found.push({ key: `${file}#${name}#${n}`, props });
		};
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
				const typed = node.type?.getText() === "TrustReceipt";
				if (typed && ts.isObjectLiteralExpression(node.initializer))
					add(node.name.text, node.initializer);
				if (
					ts.isArrowFunction(node.initializer) &&
					node.initializer.type?.getText() === "TrustReceipt"
				) {
					const body = node.initializer.body;
					const ret = ts.isBlock(body)
						? body.statements.find(ts.isReturnStatement)?.expression
						: body;
					if (ret && ts.isObjectLiteralExpression(ret)) add(node.name.text, ret);
				}
			}
			node.forEachChild(visit);
		};
		visit(source);
	}
	return found;
}

const base: ReceiptFields = {
	transferId: "tx_a",
	cost: 4,
	budgetRemaining: 96,
	auditHash: "a3f8c1d92b4e7f01aa55",
	chainPath: ".usertrust/audit",
	receiptUrl: null,
	settled: false,
	model: "m",
	provider: "p",
	timestamp: "2026-03-16T12:00:00.000Z",
};

/** What the UNSETTLED form of a producer's receipt is called, given the fields its source sets. */
function labelOf(props: Set<string>): Label {
	const shape: ReceiptFields = {
		...base,
		...(props.has("usageSource") ? { usageSource: "provider" as const } : {}),
		...(props.has("actionKind") ? { actionKind: "tool" } : {}),
	};
	return formatReceipt(shape).includes("provisional:") ? "provisional" : "sealed";
}

describe("every place core builds a receipt is classified", () => {
	it("the syntax-tree scan finds the producers, and no unclassified one", () => {
		const keys = sites().map((s) => s.key);
		// the control: the scan sees the five known producers, so an empty scan cannot pass for 'none unclassified'
		expect(keys.length).toBeGreaterThanOrEqual(5);
		expect(
			keys.filter((k) => !(k in PRODUCERS)),
			"a receipt producer with no classification: add it to PRODUCERS",
		).toEqual([]);
		expect(
			Object.keys(PRODUCERS).filter((k) => !keys.includes(k)),
			"a classified producer that is gone",
		).toEqual([]);
	});

	it("each producer's source sets the fields its label needs", () => {
		for (const site of sites()) {
			expect(labelOf(site.props), site.key).toBe(PRODUCERS[site.key]);
		}
	});

	it("only the stream's estimate handle is provisional", () => {
		expect(
			Object.entries(PRODUCERS)
				.filter(([, v]) => v === "provisional")
				.map(([k]) => k),
		).toEqual(["govern.ts#buildEstimatedStreamReceipt#1"]);
	});
});
