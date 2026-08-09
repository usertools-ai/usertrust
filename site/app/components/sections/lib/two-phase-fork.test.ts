import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FORK_HEIGHT,
	FORK_NODES,
	FORK_ROUTES,
	FORK_WIDTH,
	forkLabelPlacement,
} from "./two-phase-fork";

/**
 * The fork's labels are HTML positioned over the SVG rather than `<text>`
 * inside it, because a viewBox multiplies authored type by the render scale:
 * 14px in a 520-unit box is ~9.2px once the box is a 390px phone minus its
 * safe-area padding, under the 12px floor. These tests pin the two properties
 * that keep that true — placement is expressed in scale-invariant percentages
 * of the same geometry the traces use, and every label lands on its node.
 */

test("every label is placed in percentages of the diagram box", () => {
	for (const node of FORK_NODES) {
		const { left, top } = forkLabelPlacement(node);
		assert.match(left, /%$/, `${node.label} left must be a percentage, got ${left}`);
		assert.match(top, /%$/, `${node.label} top must be a percentage, got ${top}`);
		const l = Number.parseFloat(left);
		const t = Number.parseFloat(top);
		assert.ok(l >= 0 && l <= 100, `${node.label} left out of the box: ${left}`);
		assert.ok(t >= 0 && t <= 100, `${node.label} top out of the box: ${top}`);
	}
});

test("a label's percentage is its node's own coordinate, so the overlay cannot drift", () => {
	for (const node of FORK_NODES) {
		const { left, top } = forkLabelPlacement(node);
		assert.equal(Number.parseFloat(left), (node.x / FORK_WIDTH) * 100, node.label);
		assert.equal(Number.parseFloat(top), (node.y / FORK_HEIGHT) * 100, node.label);
	}
});

test("the anchor decides the horizontal shift and the side decides the vertical one", () => {
	const byLabel = Object.fromEntries(FORK_NODES.map((n) => [n.label, forkLabelPlacement(n)]));
	// hold sits above the trunk, its left edge on the node
	assert.match(byLabel.hold.transform, /^translate\(0, calc\(-100% - \d+px\)\)$/);
	// xor sits below the branch and LEFT of it — the void diagonal owns the
	// quadrant directly below the via-dot
	assert.match(byLabel.xor.transform, /^translate\(-100%, calc\(0% \+ \d+px\)\)$/);
	// the terminals end on their pads
	assert.match(byLabel.settle.transform, /^translate\(-100%, calc\(-100% - \d+px\)\)$/);
	assert.match(byLabel.void.transform, /^translate\(-100%, calc\(0% \+ \d+px\)\)$/);
});

test("the fork stays a fork: one trunk, one branch node, exactly two terminals", () => {
	assert.equal(FORK_ROUTES.length, 3);
	assert.equal(
		FORK_NODES.filter((n) => n.branch).length,
		1,
		"exactly one junction — a second one would stop being an XOR",
	);
	assert.equal(FORK_NODES.filter((n) => !n.branch).length, 3, "one input and two terminals");
	const [settle, voided] = FORK_ROUTES.filter((r) => r.key !== "hold");
	assert.equal(settle.x1, voided.x1, "both outcomes leave the same node");
	assert.equal(settle.y1, voided.y1, "both outcomes leave the same node");
	assert.notEqual(settle.y2, voided.y2, "and they do not land in the same place");
});
