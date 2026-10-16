/**
 * @file export-openai.ts
 * @description Handles Claude/Codex --export-openai utilities without starting a client.
 */

import { exportOpenAI } from "../export/openai";

/** Parse export-only arguments and write trajectories; existing outputs are never overwritten. */
export async function runExportOpenAI(args: string[], exporter: typeof exportOpenAI = exportOpenAI,
	codex = false): Promise<void> {
	const inputs: string[] = [];
	let output: string | undefined;
	let diagnostics: string | undefined;
	let filterSystemMessages = false;
	let mergeSystemMessages = false;
	let convertDeveloperToSystem = false;
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg !== "--input" && seen.has(arg)) throw new Error(`duplicate argument: ${arg}`);
		seen.add(arg);
		if (["--input", "--output", "--diagnostics"].includes(arg)) {
			const value = args[++index];
			if (!value || value.startsWith("-")) throw new Error(`missing value for ${arg}`);
			if (arg === "--input") inputs.push(value);
			else if (arg === "--output") output = value;
			else diagnostics = value;
		} else if (arg === "--filter-system-messages") filterSystemMessages = true;
		else if (arg === "--merge-system-messages") mergeSystemMessages = true;
		else if (arg === "--convert-developer-to-system" && codex) convertDeveloperToSystem = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!output || inputs.length === 0) throw new Error("--input and --output are required");
	if (codex && (filterSystemMessages || mergeSystemMessages) && !convertDeveloperToSystem) {
		throw new Error("--filter-system-messages and --merge-system-messages require --convert-developer-to-system");
	}
	const options = { convertDeveloperToSystem, filterSystemMessages, mergeSystemMessages };
	const result = await exporter(inputs, output, diagnostics, options);
	console.log(`Exported ${result.counts.trajectories} trajectories from ${result.counts.assigned || 0} requests`);
	for (const entry of result.requests) {
		if (entry.status !== "assigned") console.warn(`${entry.status}: ${entry.source.file}:${entry.source.line} (${entry.reason || "unknown"})`);
	}
	if (diagnostics) console.log(`Diagnostics: ${diagnostics}`);
}
