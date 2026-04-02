// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust skill verify <path>
 *
 * Validates a skill manifest against the supply-chain policy.
 */

import { readFileSync } from "node:fs";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import { validateManifest } from "../supply-chain/manifest.js";
import { enforceSkillLoad } from "../supply-chain/permissions.js";
import { verifySignature } from "../supply-chain/sign.js";
import { parseFlags } from "./flags.js";

export async function run(_unused?: unknown, opts?: { json?: boolean }): Promise<void> {
	const { json, positional } = parseFlags();
	const jsonOut = opts?.json ?? json;

	// positional: ["skill", "verify", path]
	const action = positional[1];
	const manifestPath = positional[2];

	if (action !== "verify") {
		const msg = action
			? `Unknown subcommand: ${action}`
			: "Usage: usertrust skill verify <manifest.json>";
		if (jsonOut)
			console.log(JSON.stringify({ command: "skill", success: false, data: { error: msg } }));
		else console.log(msg);
		return;
	}

	if (!manifestPath) {
		if (jsonOut)
			console.log(
				JSON.stringify({
					command: "skill verify",
					success: false,
					data: { error: "Path required" },
				}),
			);
		else console.log("Usage: usertrust skill verify <manifest.json>");
		return;
	}

	let rawText: string;
	try {
		rawText = readFileSync(manifestPath, "utf-8");
	} catch {
		const err = `File not found: ${manifestPath}`;
		if (jsonOut)
			console.log(
				JSON.stringify({ command: "skill verify", success: false, data: { error: err } }),
			);
		else console.log(pc.red(err));
		return;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(rawText);
	} catch {
		const err = `Invalid JSON in ${manifestPath}`;
		if (jsonOut)
			console.log(
				JSON.stringify({ command: "skill verify", success: false, data: { error: err } }),
			);
		else console.log(pc.red(err));
		return;
	}

	let manifest: ReturnType<typeof validateManifest>;
	try {
		manifest = validateManifest(raw);
	} catch (e) {
		const err = `Schema error: ${e instanceof Error ? e.message : String(e)}`;
		if (jsonOut)
			console.log(
				JSON.stringify({ command: "skill verify", success: false, data: { error: err } }),
			);
		else console.log(pc.red(err));
		return;
	}

	const sigValid = verifySignature(manifest);
	const config = await loadConfig(undefined, process.cwd());
	const result = enforceSkillLoad(manifest, config);

	const output = {
		id: manifest.id,
		publisher: manifest.publisher,
		signatureValid: sigValid,
		permissionsAllowed: result.permissionsAllowed,
		deniedPermissions: result.deniedPermissions,
		manifestHash: result.manifestHash,
	};

	if (jsonOut) {
		const success = sigValid && result.permissionsAllowed;
		console.log(
			JSON.stringify({
				command: "skill verify",
				success,
				data: success ? output : { ...output, error: "Verification failed" },
			}),
		);
	} else {
		console.log(`${pc.bold("Skill:")} ${manifest.id}`);
		console.log(`${pc.bold("Publisher:")} ${manifest.publisher}`);
		console.log(`${pc.bold("Signature:")} ${sigValid ? pc.green("valid") : pc.red("INVALID")}`);
		console.log(
			`${pc.bold("Permissions:")} ${result.permissionsAllowed ? pc.green("allowed") : pc.red(`denied: ${result.deniedPermissions.join(", ")}`)}`,
		);
		console.log(`${pc.bold("Manifest hash:")} ${result.manifestHash}`);
	}
}
