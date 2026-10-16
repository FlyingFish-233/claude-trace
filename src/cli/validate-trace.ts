/**
 * @file validate-trace.ts
 * @description Validates WorkflowExp traces and serves claude-trace --validate.
 * Validation may redact trace contents and always writes metadata.json.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { SENSITIVE_HEADER_PARTS } from "../intercept/header-redaction";
import type { RawPair } from "../types";

/** Caller-declared capture outcome; incomplete captures never become complete. */
export type ValidationMode = "complete" | "incomplete";

/** Persisted integrity, response and provenance information for one trace directory. */
export interface TraceMetadata {
	schema_version: 1;
	status: ValidationMode;
	trace_format: "@uvl000/claude-trace-jsonl";
	trace_file: "trace.jsonl";
	trace_sha256: string | null;
	trace_bytes: number;
	exchange_count: number;
	message_exchange_count: number;
	http_status_codes: Record<string, number>;
	started_at: string | null;
	finished_at: string | null;
	headers_fully_redacted: boolean;
	include_all_requests: true;
	claude_version: string | null;
	claude_trace_version: string;
	node_version: string;
	validation_errors: string[];
}

/** Inputs for validation; the trace directory must be absolute. */
export interface ValidateTraceOptions {
	mode: ValidationMode;
	claudePath: string;
	traceDirectory: string;
	environment?: NodeJS.ProcessEnv;
}

/** Reproduce upstream partial redaction so residual secret fragments can be removed. */
function upstreamRedaction(value: string): string {
	if (value.length > 14) return `${value.substring(0, 10)}...${value.slice(-4)}`;
	if (value.length > 4) return `${value.substring(0, 2)}...${value.slice(-2)}`;
	return "[REDACTED]";
}

/** Accept epoch seconds, epoch milliseconds or parseable date strings. */
function timestampMillis(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 1_000_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

function isMessageExchange(record: RawPair): boolean {
	if (record.request?.method !== "POST") return false;
	try {
		const pathname = new URL(String(record.request.url || "")).pathname.replace(/\/+$/, "");
		return pathname.endsWith("/v1/messages");
	} catch {
		return false;
	}
}

/** Error responses are diagnosed separately; successful responses must contain data. */
function hasMeaningfulSuccessfulResponse(record: RawPair): boolean {
	const response = record.response;
	if (!response) return false;
	const status = Number(response.status_code);
	if (status < 200 || status >= 300) return true;
	if (typeof response.body_raw === "string" && response.body_raw.trim()) return true;
	if (Array.isArray(response.events) && response.events.length > 0) return true;
	const body = response.body;
	return Boolean(
		body &&
			typeof body === "object" &&
			((Array.isArray(body.content) && body.content.length > 0) || body.error),
	);
}

function readPackageVersion(): string {
	const packageRoot = path.resolve(__dirname, "..", "..");
	const manifest = JSON.parse(
		fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
	) as { version: string };
	return manifest.version;
}

/** Validate a WorkflowExp JSONL trace and atomically write metadata.json. */
export function validateTrace(options: ValidateTraceOptions): TraceMetadata {
	const environment = options.environment || process.env;
	if (!path.isAbsolute(options.traceDirectory)) {
		throw new Error("trace directory must be an absolute path");
	}
	fs.mkdirSync(options.traceDirectory, { recursive: true });

	const tracePath = path.join(options.traceDirectory, "trace.jsonl");
	const metadataPath = path.join(options.traceDirectory, "metadata.json");
	const errors: string[] = [];
	let redactionViolation = false;
	let raw = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : "";

	const secrets = [environment.ANTHROPIC_API_KEY, environment.ANTHROPIC_AUTH_TOKEN].filter(
		(value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
	);
	for (const secret of secrets) {
		const candidates = [
			secret,
			upstreamRedaction(secret),
			upstreamRedaction(`Bearer ${secret}`),
		].filter((value) => value !== "[REDACTED]");
		for (const candidate of candidates) {
			if (!raw.includes(candidate)) continue;
			raw = raw.split(candidate).join("[REDACTED]");
			redactionViolation = true;
			errors.push("secret material was found and removed");
		}
	}
	if (fs.existsSync(tracePath)) fs.writeFileSync(tracePath, raw);

	const records: RawPair[] = [];
	if (!raw.trim()) {
		errors.push("trace.jsonl is missing or empty");
	} else {
		for (const [index, line] of raw.split(/\r?\n/).entries()) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as RawPair;
				if (!record.request || !record.response) {
					errors.push(`line ${index + 1} is not a request/response pair`);
				}
				records.push(record);
			} catch (error) {
				errors.push(`line ${index + 1} is invalid JSON: ${(error as Error).message}`);
			}
		}
	}

	for (const [index, record] of records.entries()) {
		for (const side of [record.request, record.response]) {
			const headers = side?.headers;
			if (!headers || typeof headers !== "object") continue;
			for (const [key, value] of Object.entries(headers)) {
				const sensitive = SENSITIVE_HEADER_PARTS.some((part) =>
					key.toLowerCase().includes(part),
				);
				if (sensitive && value !== "[REDACTED]") {
					redactionViolation = true;
					errors.push(`line ${index + 1} contains an unredacted ${key} header`);
				}
			}
		}
	}

	const messageExchanges = records.filter(isMessageExchange);
	if (messageExchanges.length === 0) {
		errors.push("no /v1/messages request/response exchange was recorded");
	}
	if (
		messageExchanges.length > 0 &&
		!messageExchanges.some((record) => {
			const status = Number(record.response?.status_code);
			return status >= 200 && status < 300;
		})
	) {
		errors.push("no successful /v1/messages response was recorded");
	}
	for (const [index, record] of messageExchanges.entries()) {
		if (!hasMeaningfulSuccessfulResponse(record)) {
			errors.push(`/v1/messages exchange ${index + 1} has an empty successful response`);
		}
	}

	const statusCodes: Record<string, number> = {};
	for (const record of records) {
		const status = String(record.response?.status_code || "unknown");
		statusCodes[status] = (statusCodes[status] || 0) + 1;
	}
	const timestamps = records
		.flatMap((record) => [record.logged_at, record.request?.timestamp, record.response?.timestamp])
		.map(timestampMillis)
		.filter((value): value is number => value !== null)
		.sort((left, right) => left - right);
	const hash = raw ? crypto.createHash("sha256").update(Buffer.from(raw)).digest("hex") : null;

	let claudeVersion: string | null = null;
	const versionResult = spawnSync(options.claudePath, ["--version"], {
		encoding: "utf8",
		env: { ...environment, CLAUDE_TRACE_ENABLED: "0" },
	});
	if (versionResult.status === 0) {
		claudeVersion = (versionResult.stdout || versionResult.stderr || "").trim();
	}

	const uniqueErrors = [...new Set(errors)];
	const metadata: TraceMetadata = {
		schema_version: 1,
		status: options.mode === "complete" && uniqueErrors.length === 0 ? "complete" : "incomplete",
		trace_format: "@uvl000/claude-trace-jsonl",
		trace_file: "trace.jsonl",
		trace_sha256: hash,
		trace_bytes: Buffer.byteLength(raw),
		exchange_count: records.length,
		message_exchange_count: messageExchanges.length,
		http_status_codes: statusCodes,
		started_at: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
		finished_at:
			timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
		headers_fully_redacted: !redactionViolation,
		include_all_requests: true,
		claude_version: claudeVersion,
		claude_trace_version: readPackageVersion(),
		node_version: process.version,
		validation_errors: uniqueErrors,
	};
	const metadataTemporary = `${metadataPath}.tmp`;
	fs.writeFileSync(metadataTemporary, `${JSON.stringify(metadata, null, 2)}\n`);
	fs.renameSync(metadataTemporary, metadataPath);
	return metadata;
}

/** Run validation and return the existing exit status: usage 2, failed complete 1, otherwise 0. */
export function runValidateTrace(args: string[]): number {
	let mode: ValidationMode | undefined;
	let claudePath: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg === "--validate" && !mode && (value === "complete" || value === "incomplete")) {
			mode = value;
			index++;
		} else if (arg === "--claude-path" && !claudePath && value && !value.startsWith("-")) {
			claudePath = value;
			index++;
		} else {
			console.error(`Unknown, duplicate or incomplete validation argument: ${arg}`);
			return 2;
		}
	}
	if (!mode || !claudePath) {
		console.error("Usage: claude-trace --validate <complete|incomplete> --claude-path CLAUDE_PATH");
		return 2;
	}
	const traceDirectory = process.env.CLAUDE_TRACE_LOG_DIR;
	if (!traceDirectory || !path.isAbsolute(traceDirectory)) {
		console.error("CLAUDE_TRACE_LOG_DIR must be set to an absolute path");
		return 2;
	}
	const metadata = validateTrace({ mode, claudePath, traceDirectory });
	console.log(JSON.stringify(metadata));
	return mode === "complete" && metadata.validation_errors.length > 0 ? 1 : 0;
}
