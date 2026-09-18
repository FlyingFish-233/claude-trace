#!/usr/bin/env node

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

interface BundleManifest {
	schema_version: number;
	platform: string;
	arch: string;
	node_version: string;
	claude_trace_package: string;
	claude_trace_version: string;
}

/** Verify platform, embedded package identity, and every file checksum in a bundle. */
export function verifyOfflineBundle(root: string): BundleManifest {
	const resolvedRoot = path.resolve(root);
	const manifest = JSON.parse(
		fs.readFileSync(path.join(resolvedRoot, "manifest.json"), "utf8"),
	) as BundleManifest;
	if (process.platform !== manifest.platform || process.arch !== manifest.arch) {
		throw new Error(
			`Bundle requires ${manifest.platform}/${manifest.arch}, got ${process.platform}/${process.arch}`,
		);
	}
	if (process.version !== `v${manifest.node_version}`) {
		throw new Error(`Bundle requires Node ${manifest.node_version}, got ${process.version}`);
	}
	const packageManifestPath = path.join(
		resolvedRoot,
		"package",
		"node_modules",
		...manifest.claude_trace_package.split("/"),
		"package.json",
	);
	const packageManifest = JSON.parse(fs.readFileSync(packageManifestPath, "utf8")) as {
		name: string;
		version: string;
	};
	if (
		packageManifest.name !== manifest.claude_trace_package ||
		packageManifest.version !== manifest.claude_trace_version
	) {
		throw new Error(
			`Expected ${manifest.claude_trace_package}@${manifest.claude_trace_version}, ` +
				`got ${packageManifest.name}@${packageManifest.version}`,
		);
	}

	const checksumLines = fs
		.readFileSync(path.join(resolvedRoot, "SHA256SUMS"), "utf8")
		.trim()
		.split("\n");
	for (const line of checksumLines) {
		const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
		if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
		const filePath = path.resolve(resolvedRoot, match[2]);
		if (!filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
			throw new Error(`Checksum path escapes bundle: ${match[2]}`);
		}
		const actual = crypto
			.createHash("sha256")
			.update(fs.readFileSync(filePath))
			.digest("hex");
		if (actual !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
	}
	return manifest;
}

function main(): void {
	const root = process.argv[2];
	if (!root) {
		console.error("Usage: verify-offline-bundle BUNDLE_ROOT");
		process.exit(2);
	}
	console.log(JSON.stringify({ ok: true, ...verifyOfflineBundle(root) }));
}

if (require.main === module) main();
