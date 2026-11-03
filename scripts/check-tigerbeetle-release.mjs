#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.
//
// Check that packages/core/src/ledger/tigerbeetle-release.json still describes the TigerBeetle release it pins:
// every distinct asset's sha256 and byte count must equal what GitHub publishes for that tag. The check fails when
// ONE of them differs, and names which. It reaches the network, so CI runs it only when the manifest changes.
//
//   node scripts/check-tigerbeetle-release.mjs              compare with GitHub's published digests (one API call)
//   node scripts/check-tigerbeetle-release.mjs --download   also download every asset and hash it ourselves
//
// The download mode is the stronger one: it does not rely on GitHub's digest field at all.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const MANIFEST_PATH = new URL(
	"../packages/core/src/ledger/tigerbeetle-release.json",
	import.meta.url,
);

/**
 * @param {{manifest: any, fetchImpl?: typeof fetch, download?: boolean}} opts
 * @returns {Promise<{ok: boolean, problems: string[], checked: number}>}
 */
export async function checkRelease({ manifest, fetchImpl = fetch, download = false }) {
	const problems = [];
	const distinct = new Map();
	for (const [key, asset] of Object.entries(manifest.assets)) {
		const seen = distinct.get(asset.file);
		if (seen === undefined) distinct.set(asset.file, { asset, keys: [key] });
		else {
			seen.keys.push(key);
			if (seen.asset.sha256 !== asset.sha256 || seen.asset.bytes !== asset.bytes) {
				problems.push(
					`${asset.file}: platforms ${seen.keys.join(", ")} disagree about the same file`,
				);
			}
		}
	}

	const tag = manifest.version;
	const res = await fetchImpl(
		`https://api.github.com/repos/tigerbeetle/tigerbeetle/releases/tags/${tag}`,
		{
			headers: {
				accept: "application/vnd.github+json",
				...(process.env.GITHUB_TOKEN
					? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
					: {}),
			},
		},
	);
	if (!res.ok) {
		return {
			ok: false,
			problems: [`GitHub answered HTTP ${res.status} for release ${tag}`],
			checked: 0,
		};
	}
	const release = await res.json();
	const published = new Map((release.assets ?? []).map((a) => [a.name, a]));

	for (const [file, { asset }] of distinct) {
		const remote = published.get(file);
		if (remote === undefined) {
			problems.push(`${file}: not an asset of release ${tag}`);
			continue;
		}
		const digest = String(remote.digest ?? "");
		if (digest !== `sha256:${asset.sha256}`) {
			problems.push(
				`${file}: manifest sha256 ${asset.sha256}, GitHub publishes ${digest || "no digest"}`,
			);
		}
		if (remote.size !== asset.bytes) {
			problems.push(`${file}: manifest says ${asset.bytes} bytes, GitHub says ${remote.size}`);
		}
		if (download) {
			const got = await fetchImpl(remote.browser_download_url);
			if (!got.ok) {
				problems.push(`${file}: download answered HTTP ${got.status}`);
				continue;
			}
			const bytes = Buffer.from(await got.arrayBuffer());
			const sha = createHash("sha256").update(bytes).digest("hex");
			if (sha !== asset.sha256)
				problems.push(
					`${file}: downloaded bytes hash to ${sha}, not the manifest's ${asset.sha256}`,
				);
			if (bytes.length !== asset.bytes)
				problems.push(
					`${file}: downloaded ${bytes.length} bytes, not the manifest's ${asset.bytes}`,
				);
		}
	}
	return { ok: problems.length === 0, problems, checked: distinct.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
	const result = await checkRelease({ manifest, download: process.argv.includes("--download") });
	if (!result.ok) {
		for (const p of result.problems) console.error(`tigerbeetle-release: ${p}`);
		console.error(
			`tigerbeetle-release: ${result.problems.length} problem(s) in the manifest for ${manifest.version}`,
		);
		process.exit(1);
	}
	console.log(
		`tigerbeetle-release: ${result.checked} asset(s) of ${manifest.version} match the manifest`,
	);
}
