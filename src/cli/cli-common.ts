/**
 * @file cli-common.ts
 * @description Shared CLI utilities used by claude-trace, opencode-trace, and codex-trace.
 *
 * Provides colored console output and opt-in runtime diagnostics.
 */


/** ANSI escape codes for terminal-colored log output. */
export const colors = {
	red: "\x1b[0;31m",
	green: "\x1b[0;32m",
	yellow: "\x1b[1;33m",
	blue: "\x1b[0;34m",
	reset: "\x1b[0m",
} as const;

type ColorName = keyof typeof colors;

/**
 * Print a colored message to stdout.
 * @param message - Text to print
 * @param color - Color key from `colors` (default: no color)
 */
export function log(message: string, color: ColorName = "reset"): void {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

/** @returns true when OPENCODE_TRACE_DEBUG=1 or "true" (enables verbose proxy stderr). */
export function isTraceDebugEnabled(): boolean {
	const value = process.env.OPENCODE_TRACE_DEBUG;
	return value === "1" || value === "true";
}

/** Write to stderr only when OPENCODE_TRACE_DEBUG is set — avoids polluting OpenCode TUI. */
export function traceDebug(message: string): void {
	if (isTraceDebugEnabled()) {
		console.error(message);
	}
}

/**
 * Emit runtime transport diagnostics only in debug mode; attempts carry persisted errors.
 * @param message - Error description with context
 */
export function traceRuntimeError(message: string): void {
	traceDebug(message);
}
