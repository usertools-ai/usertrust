import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_TABS } from "./sdk-tabs";

test("every tab pins the trust() line at the same index with the constant key", () => {
	const positions = PROVIDER_TABS.map((t) => t.lines.findIndex((l) => l.trust));
	assert.ok(positions[0] >= 0);
	assert.ok(
		positions.every((p) => p === positions[0]),
		`trust line moved: ${positions}`,
	);
	for (const t of PROVIDER_TABS) {
		const line = t.lines.find((l) => l.trust);
		assert.ok(line);
		assert.equal(line.key, "trust"); // constant key ⇒ never enters/exits AnimatePresence ⇒ never moves
		assert.match(line.text, /^const client = await trust\(new .+\);$/);
	}
});

test("line keys are unique within each tab", () => {
	for (const t of PROVIDER_TABS) {
		assert.equal(new Set(t.lines.map((l) => l.key)).size, t.lines.length, t.id);
	}
});

test("a shared key means shared text — the morph touches only provider-specific lines", () => {
	const byKey = new Map<string, string>();
	for (const t of PROVIDER_TABS) {
		for (const l of t.lines) {
			if (l.trust) continue; // the constructor inside the pinned line differs by design
			const prev = byKey.get(l.key);
			if (prev !== undefined) assert.equal(l.text, prev, `key "${l.key}" diverges across tabs`);
			byKey.set(l.key, l.text);
		}
	}
});
