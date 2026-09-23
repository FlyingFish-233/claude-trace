#!/usr/bin/env node

import { exportOpenAI } from "../export/openai";

async function main(args: string[]): Promise<void> {
	const inputs: string[] = [];
	let output: string | undefined;
	let diagnostics: string | undefined;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--input" && args[index + 1]) inputs.push(args[++index]);
		else if (args[index] === "--output" && args[index + 1] && !output) output = args[++index];
		else if (args[index] === "--diagnostics" && args[index + 1] && !diagnostics) diagnostics = args[++index];
		else if (args[index] === "--help" || args[index] === "-h") {
			console.log("Usage: claude-trace-export-openai --input PATH [--input PATH ...] --output FILE [--diagnostics FILE]");
			return;
		} else throw new Error(`unknown or incomplete argument: ${args[index]}`);
	}
	if (!output || inputs.length === 0) throw new Error("--input and --output are required");
	const result = await exportOpenAI(inputs, output, diagnostics);
	console.log(`Exported ${result.counts.trajectories} trajectories from ${result.counts.assigned || 0} requests`);
	for (const entry of result.requests) {
		if (entry.status !== "assigned") console.warn(`${entry.status}: ${entry.source.file}:${entry.source.line} (${entry.reason || "unknown"})`);
	}
	if (diagnostics) console.log(`Diagnostics: ${diagnostics}`);
}

if (require.main === module) {
	main(process.argv.slice(2)).catch((error) => {
		console.error((error as Error).message);
		process.exitCode = 1;
	});
}
