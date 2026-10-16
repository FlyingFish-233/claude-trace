#!/usr/bin/env node

/**
 * @file codex-cli.ts
 * @description Entry point for the `codex-trace` command.
 *
 * Thin CLI wrapper that parses arguments, dispatches to utility modes
 * (OpenAI export, HTML generation, index building), or delegates interactive tracing to
 * `trace-runner.ts` via the Codex CLI tool profile.
 *
 * Architecture:
 * ```
 * codex-cli.ts → codexProfile (tools/codex.ts) → trace-runner.ts
 *                                                  └─ reverse-proxy.ts (always)
 * ```
 *
 * Codex is a Rust native binary — always uses reverse-proxy interception with
 * a `$CODEX_HOME` config overlay that rewrites upstream base URLs. Path-based
 * routing in `codex-routing.ts` dispatches OpenAI API Key vs ChatGPT OAuth
 * traffic to the correct upstream.
 *
 * Registered as the `codex-trace` bin in package.json.
 */

import { exportCodexOpenAI } from "../export/responses";
import { runExportOpenAI } from "./export-openai";
import { runReplay } from "./replay";
import { runWithTracing } from "./trace-runner";
import {
	colors,
	log,
	parseTraceArgs,
	parseGenerateHtmlArgs,
	generateHTMLFromCLI,
	generateIndex,
} from "./cli-common";

/**
 * Print usage help for all `codex-trace` modes and options to stdout.
 *
 * Documents Codex-specific config discovery (`CODEX_HOME`, `config.toml`)
 * and the overlay-based interception approach.
 */
function showHelp(): void {
	console.log(`
${colors.blue}Codex Trace${colors.reset}
Record all your interactions with Codex CLI as you develop your projects

${colors.yellow}USAGE:${colors.reset}
  codex-trace [OPTIONS] [--run-with CODEX_ARG...]

${colors.yellow}OPTIONS:${colors.reset}
  --export-openai   Export Responses traces as OpenAI SFT JSONL; never starts Codex
  --replay FILE     Replay Responses requests from a trace JSONL file; never starts Codex
  --line-number N   Replay a 1-based JSONL line; repeat to select multiple lines
  --trace-line N    Alias for --line-number (also repeatable)
  --concurrency N  Maximum simultaneous replay requests (default: 1)
  --base-url URL    Destination API base URL (default: http://127.0.0.1:30011)
  --model NAME      Override the captured model for replay
  --max-tokens N    Override max_output_tokens for replay
  --timeout SEC     Replay HTTP timeout (default: 1800)
  --seed N          Reproducible random request selection
  --api-key-env VAR Read destination API key from an environment variable
  --preserve-stream Keep streaming enabled; save SSE as text (default: stream=false)
  --input PATH      Export input JSONL file or directory (repeatable)
  --output FILE     Export destination; existing files are never overwritten
  --diagnostics FILE Write per-request export diagnostics
  --convert-developer-to-system Convert developer messages to system in place
  --filter-system-messages After conversion, keep the first system and drop later systems
  --merge-system-messages After conversion, merge all systems at the beginning
                    Filter and merge require developer conversion; all default off
  --generate-html    Generate HTML report from JSONL file
  --index           Generate conversation summaries and index for .codex-trace/ directory
  --run-with         Pass all following arguments to Codex process
  --include-all-requests Include all proxied API traffic, not just LLM API paths
  --include-sensitive-headers Log sensitive headers (auth tokens, cookies) without redaction
  --no-open          Live tracing: write JSONL only; --generate-html: don't open browser
  --log              Specify custom log file base name (without extension)
  --codex-path       Specify custom path to Codex binary
  --help, -h         Show this help message

${colors.yellow}MODES:${colors.reset}
  ${colors.green}Interactive logging:${colors.reset}
    codex-trace                               Start Codex TUI with traffic logging
    codex-trace --log my-session              Start Codex with custom log file name
    codex-trace --run-with exec "Explain closures"  Run Codex headless with a prompt

  ${colors.green}HTML generation:${colors.reset}
    codex-trace --generate-html file.jsonl          Generate HTML from JSONL file
    codex-trace --generate-html file.jsonl out.html Generate HTML with custom output name

  ${colors.green}Indexing:${colors.reset}
    codex-trace --index                             Generate conversation summaries and index

${colors.yellow}EXAMPLES:${colors.reset}
  # Export successful Responses rounds for training or template rendering
  codex-trace --export-openai --input .codex-trace --output sft.jsonl
  codex-trace --export-openai --input session.jsonl --output sft.jsonl --convert-developer-to-system --merge-system-messages

  # Replay a captured request against a model server
  codex-trace --replay session.jsonl --line-number 12 --base-url http://127.0.0.1:30011
  codex-trace --replay session.jsonl --trace-line 12 --trace-line 15 --concurrency 2 --output replays.json

  # Start Codex TUI with logging
  codex-trace

  # Run a one-shot prompt with logging
  codex-trace --run-with exec "Explain async/await"

  # Generate HTML report
  codex-trace --generate-html .codex-trace/log-2025-01-01-12-00-00.jsonl

  # Use custom Codex binary path
  codex-trace --codex-path /usr/local/bin/codex

${colors.yellow}CONFIG:${colors.reset}
  Codex config is read from (in order):
    1. CODEX_HOME environment variable
    2. ~/.codex/config.toml

  Intercepts OpenAI API Key, ChatGPT OAuth, and custom model_providers via
  CODEX_HOME config overlay. Your original config file is never modified.

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to: ${colors.green}.codex-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}${colors.reset}
  With --log NAME:   ${colors.green}.codex-trace/NAME.{jsonl,json,html}${colors.reset}
  With --no-open:    Only the .jsonl trace is written (no .json or .html).

For more information, visit: https://github.com/FlyingFish-233/claude-trace
`);
}

/**
 * Main CLI dispatcher.
 *
 * Export rejects conflicting modes and live-tracing arguments before loading a tool profile.
 * Other modes are checked in priority order:
 * 1. `--help` / `-h` — print usage and exit
 * 2. `--generate-html` — offline HTML report from an existing JSONL log
 * 3. `--index` — rebuild conversation summaries in `.codex-trace/`
 * 4. Default — launch Codex with live traffic tracing via `runWithTracing`
 *
 * Arguments after `--run-with` are passed verbatim to the Codex child process.
 */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { traceArgs, toolArgs, includeAllRequests, openInBrowser, jsonlOnly, logSensitiveHeaders, logBaseName } =
		parseTraceArgs(args);

	if (traceArgs.includes("--help") || traceArgs.includes("-h")) {
		showHelp();
		process.exit(0);
	}
	if (traceArgs.includes("--export-openai") || traceArgs.includes("--replay")) {
		const modes = new Set(["--export-openai", "--replay", "--validate", "--extract-token", "--generate-html", "--index"]);
		if (traceArgs.filter((arg) => modes.has(arg)).length !== 1 || args.includes("--run-with")) {
			throw new Error("Export/replay must be used alone, without other modes or --run-with");
		}
		if (traceArgs.includes("--replay")) process.exitCode = await runReplay(traceArgs);
		else await runExportOpenAI(traceArgs.filter((arg) => arg !== "--export-openai"), exportCodexOpenAI, true);
		return;
	}
	const offlineOptions = ["--input", "--output", "--diagnostics", "--convert-developer-to-system", "--filter-system-messages", "--merge-system-messages",
		"--line-number", "--trace-line", "--concurrency", "--base-url", "--model", "--max-tokens", "--timeout", "--seed", "--api-key-env", "--preserve-stream"];
	if (traceArgs.some((arg) => offlineOptions.includes(arg))) throw new Error("Offline utility options require --export-openai or --replay");
	const { codexProfile } = require("../tools/codex") as typeof import("../tools/codex");

	// `--codex-path` takes the next positional arg as the binary location.
	let customCodexPath: string | undefined;
	const codexPathIndex = traceArgs.indexOf("--codex-path");
	if (codexPathIndex !== -1 && traceArgs[codexPathIndex + 1]) {
		customCodexPath = traceArgs[codexPathIndex + 1];
	}

	if (traceArgs.includes("--generate-html")) {
		const { inputFile, outputFile } = parseGenerateHtmlArgs(traceArgs);

		if (!inputFile) {
			log(`Missing input file for --generate-html`, "red");
			log(`Usage: codex-trace --generate-html input.jsonl [output.html]`, "yellow");
			process.exit(1);
		}

		await generateHTMLFromCLI(inputFile, outputFile, includeAllRequests, openInBrowser, "codex");
		return;
	}

	if (traceArgs.includes("--index")) {
		await generateIndex(codexProfile.logDirectory);
		return;
	}

	// Default mode: start reverse proxy + spawn Codex with $CODEX_HOME overlay.
	await runWithTracing(codexProfile, toolArgs, {
		includeAllRequests,
		openInBrowser,
		jsonlOnly,
		logBaseName,
		logSensitiveHeaders,
		customBinaryPath: customCodexPath,
	});
}

main().catch((error) => {
	const err = error as Error;
	log(`Unexpected error: ${err.message}`, "red");
	process.exit(1);
});
