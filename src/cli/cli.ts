#!/usr/bin/env node

/**
 * @file cli.ts
 * @description Entry point for the `claude-trace` command.
 *
 * Thin CLI wrapper that parses arguments, dispatches to utility modes
 * (validation, export, token extraction, HTML generation, index building), or delegates interactive
 * tracing to `trace-runner.ts` via the Claude Code tool profile.
 *
 * Architecture:
 * ```
 * cli.ts → claudeProfile (tools/claude.ts) → trace-runner.ts
 *                                              ├─ reverse-proxy.ts  (V2+ native)
 *                                              └─ interceptor.ts    (V1 Node.js)
 * ```
 *
 * All shared argument parsing, logging, and HTML/index helpers live in
 * `cli-common.ts` so `opencode-cli.ts` and `codex-cli.ts` stay consistent.
 *
 * Registered as the `claude-trace` bin in package.json.
 */

import { runWithTracing } from "./trace-runner";
import { runExportOpenAI } from "./export-openai";
import { runValidateTrace } from "./validate-trace";
import {
	colors,
	log,
	parseTraceArgs,
	parseGenerateHtmlArgs,
	generateHTMLFromCLI,
	generateIndex,
} from "./cli-common";

/**
 * Print usage help for all `claude-trace` modes and options to stdout.
 *
 * Documents interactive tracing, `--extract-token`, `--generate-html`,
 * `--index`, and all shared flags (`--run-with`, `--log`, etc.).
 */
function showHelp(): void {
	console.log(`
${colors.blue}Claude Trace${colors.reset}
Record all your interactions with Claude Code as you develop your projects

${colors.yellow}USAGE:${colors.reset}
  claude-trace [OPTIONS] [--run-with CLAUDE_ARG...]

${colors.yellow}OPTIONS:${colors.reset}
  --extract-token    Extract OAuth token and exit (reproduces claude-token.py)
  --generate-html    Generate HTML report from JSONL file
  --index           Generate conversation summaries and index for .claude-trace/ directory
  --validate MODE   Validate a trace: complete or incomplete; requires --claude-path
                    and an absolute CLAUDE_TRACE_LOG_DIR; writes metadata.json
  --export-openai   Export traces as OpenAI SFT JSONL (requires --input and --output)
  --input PATH      Export input directory or trace.jsonl (repeatable)
  --output FILE     Export destination; existing files are never overwritten
  --diagnostics FILE Write optional per-request export diagnostics
  --filter-system-messages Keep only the first inline system message before export
  --merge-system-messages Merge inline system messages into the leading system message
                    Export defaults to preserving inline system message positions
  --run-with         Pass all following arguments to Claude process
  --include-all-requests Include all requests made through fetch, otherwise only requests to v1/messages with more than 2 messages in the context
  --include-sensitive-headers Log sensitive headers (auth tokens, cookies) without redaction
  --no-open          In tracing mode, write only JSONL; in HTML mode, don't open browser
  --log              Specify custom log file base name (without extension)
  --claude-path      Specify custom path to Claude binary
  --help, -h         Show this help message

${colors.yellow}MODES:${colors.reset}
  ${colors.green}Interactive logging:${colors.reset}
    claude-trace                               Start Claude with traffic logging
    claude-trace --log my-session              Start Claude with custom log file name
    claude-trace --run-with chat                    Run Claude with specific command
    claude-trace --run-with chat --model sonnet-3.5 Run Claude with multiple arguments

  ${colors.green}Token extraction:${colors.reset}
    claude-trace --extract-token               Extract OAuth token for SDK usage

  ${colors.green}HTML generation:${colors.reset}
    claude-trace --generate-html file.jsonl          Generate HTML from JSONL file
    claude-trace --generate-html file.jsonl out.html Generate HTML with custom output name
    claude-trace --generate-html file.jsonl          Generate HTML and open in browser (default)
    claude-trace --generate-html file.jsonl --no-open Generate HTML without opening browser

  ${colors.green}Indexing:${colors.reset}
    claude-trace --index                             Generate conversation summaries and index

  ${colors.green}Validation and export (exclusive utility modes):${colors.reset}
    claude-trace --validate complete --claude-path /path/to/claude
    claude-trace --validate incomplete --claude-path /path/to/claude
    claude-trace --export-openai --input /path/to/run --output sft.jsonl
    claude-trace --export-openai --input /path/to/run --output sft.jsonl --merge-system-messages

${colors.yellow}EXAMPLES:${colors.reset}
  # Start Claude with logging
  claude-trace

  # Start Claude with custom log file name
  claude-trace --log my-session

  # Run Claude chat with logging
  claude-trace --run-with chat

  # Run Claude with specific model
  claude-trace --run-with chat --model sonnet-3.5

  # Pass multiple arguments to Claude
  claude-trace --run-with --model gpt-4o --temperature 0.7

  # Extract token for Anthropic SDK
  export ANTHROPIC_API_KEY=$(claude-trace --extract-token)

  # Generate HTML report
  claude-trace --generate-html logs/traffic.jsonl report.html

  # Generate HTML report and open in browser (default)
  claude-trace --generate-html logs/traffic.jsonl

  # Generate HTML report without opening browser
  claude-trace --generate-html logs/traffic.jsonl --no-open

  # Generate conversation index
  claude-trace --index

  # Use custom Claude binary path
  claude-trace --claude-path /usr/local/bin/claude

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to: ${colors.green}.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}${colors.reset}
  With --no-open:    ${colors.green}.claude-trace/log-YYYY-MM-DD-HH-MM-SS.jsonl${colors.reset}
  With --log NAME:   ${colors.green}.claude-trace/NAME.{jsonl,json,html}${colors.reset}

${colors.yellow}MIGRATION:${colors.reset}
  This tool replaces Python-based claude-logger and claude-token.py scripts
  with a pure Node.js implementation. All output formats are compatible.

For more information, visit: https://github.com/FlyingFish-233/claude-trace
`);
}

/**
 * Main CLI dispatcher.
 *
 * Help takes precedence. Validation and export reject conflicting utility modes
 * and live tracing arguments, then return without starting a proxy or client.
 * Other utility modes retain their existing dispatch behavior.
 *
 * Arguments after `--run-with` are passed verbatim to the Claude child process.
 * All other flags are consumed by `parseTraceArgs` before dispatch.
 */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { traceArgs, toolArgs, includeAllRequests, openInBrowser, jsonlOnly, logSensitiveHeaders, logBaseName } =
		parseTraceArgs(args);

	if (traceArgs.includes("--help") || traceArgs.includes("-h")) {
		showHelp();
		process.exit(0);
	}

	const utilityModes = ["--validate", "--export-openai"];
	const utilityMode = traceArgs.find((arg) => utilityModes.includes(arg));
	if (utilityMode) {
		const modes = new Set([...utilityModes, "--extract-token", "--generate-html", "--index"]);
		if (traceArgs.filter((arg) => modes.has(arg)).length !== 1 || args.includes("--run-with")) {
			console.error("Validation/export must be used alone, without other modes or --run-with");
			process.exitCode = utilityMode === "--validate" ? 2 : 1;
			return;
		}
		if (utilityMode === "--validate") process.exitCode = runValidateTrace(traceArgs);
		else await runExportOpenAI(traceArgs.filter((arg) => arg !== "--export-openai"));
		return;
	}
	const exportOptions = ["--input", "--output", "--diagnostics", "--filter-system-messages", "--merge-system-messages"];
	if (traceArgs.some((arg) => exportOptions.includes(arg))) {
		throw new Error("Export options require --export-openai");
	}

	// Loading the profile resolves capture settings; offline utilities must not depend on them.
	const { claudeProfile, extractClaudeToken } = await import("../tools/claude");

	// `--claude-path` takes the next positional arg as the binary location.
	let customClaudePath: string | undefined;
	const claudePathIndex = traceArgs.indexOf("--claude-path");
	if (claudePathIndex !== -1 && traceArgs[claudePathIndex + 1]) {
		customClaudePath = traceArgs[claudePathIndex + 1];
	}

	if (traceArgs.includes("--extract-token")) {
		await extractClaudeToken(customClaudePath);
		return;
	}

	if (traceArgs.includes("--generate-html")) {
		const { inputFile, outputFile } = parseGenerateHtmlArgs(traceArgs);

		if (!inputFile) {
			log(`Missing input file for --generate-html`, "red");
			log(`Usage: claude-trace --generate-html input.jsonl [output.html]`, "yellow");
			process.exit(1);
		}

		await generateHTMLFromCLI(inputFile, outputFile, includeAllRequests, openInBrowser, "claude");
		return;
	}

	if (traceArgs.includes("--index")) {
		await generateIndex(claudeProfile.logDirectory);
		return;
	}

	// Default mode: start proxy/interceptor + spawn Claude with logging.
	await runWithTracing(claudeProfile, toolArgs, {
		includeAllRequests,
		openInBrowser,
		jsonlOnly,
		logBaseName,
		logSensitiveHeaders,
		customBinaryPath: customClaudePath,
	});
}

main().catch((error) => {
	const err = error as Error;
	log(`Unexpected error: ${err.message}`, "red");
	process.exit(1);
});
