/**
 * @file responses.ts
 * @description Exports captured Codex Responses exchanges as deduplicated SFT trajectories.
 * Uses vLLM-compatible text conversion, explicit response ranges, and conservative history matching.
 * Stateful server history and incomplete responses are diagnosed rather than fabricated.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { RawPair } from "../types";
import type { ExportDiagnostics, ExportedTrajectory, SourceLocation } from "./openai";
import { convertResponsesItems, convertResponsesRequest, responseObject, validateCodexExportOptions, ResponseObject, ExportCodexOpenAIOptions } from "./responses-conversion";

/** Responses can produce several assistant messages per round; ranges are half-open indexes. */
export interface ResponsesTrajectory extends ExportedTrajectory {
	metadata: ExportedTrajectory["metadata"] & {
		api_format: "openai-responses";
		response_ids: string[];
		response_message_ranges: Array<{ start: number; end: number }>;
	};
}

interface Chain {
	record: ResponsesTrajectory;
	history: ResponseObject[];
	toolsKey: string;
	session: string | undefined;
}

/** Canonicalize object key order without changing message or block order. */
function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
	return value;
}

function key(value: unknown): string { return JSON.stringify(stable(value)); }

/** Accept named Codex JSONLs as well as directories; deduplicate symlinks and directory cycles. */
function traceFiles(inputs: string[]): string[] {
	const files = new Set<string>();
	const directories = new Set<string>();
	function visit(input: string): void {
		const real = fs.realpathSync(input);
		const stat = fs.statSync(real);
		if (stat.isDirectory()) {
			if (directories.has(real)) return;
			directories.add(real);
			for (const name of fs.readdirSync(real).sort()) visit(path.join(real, name));
		} else if (stat.isFile() && real.endsWith(".jsonl")) files.add(real);
	}
	for (const input of inputs) visit(input);
	return [...files].sort();
}

function isResponses(pair: RawPair): boolean {
	if (pair?.request?.method?.toUpperCase() !== "POST") return false;
	try { return new URL(pair.request.url).pathname.replace(/\/+$/, "").endsWith("/responses"); }
	catch { return false; }
}

/** Require the terminal Responses envelope; never train on stream deltas or interrupted output. */
function completedResponse(pair: RawPair): ResponseObject {
	const response = pair.response;
	if (!response) throw new Error("missing_response");
	if (response.status_code < 200 || response.status_code >= 300) throw new Error(`http_${response.status_code}`);
	let events: ResponseObject[] = [];
	if (response.events?.length) events = response.events.map((event) => responseObject(event.data));
	else if (response.body_raw?.trimStart().startsWith("event:") || response.body_raw?.trimStart().startsWith("data:")) {
		for (const block of response.body_raw.split(/\r?\n\r?\n/)) {
			const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
			if (data && data !== "[DONE]") {
				try { events.push(responseObject(JSON.parse(data))); }
				catch { throw new Error("invalid_sse_json"); }
			}
		}
	}
	let final: ResponseObject;
	if (events.length) {
		if (events.some((event) => ["error", "response.failed", "response.incomplete"].includes(String(event.type)))) throw new Error("failed_or_incomplete_stream");
		const terminal = events.filter((event) => event.type === "response.completed");
		if (terminal.length !== 1) throw new Error("missing_or_ambiguous_completed_event");
		final = responseObject(terminal[0].response);
	} else {
		let body = response.body;
		if (body == null && response.body_raw) {
			try { body = JSON.parse(response.body_raw); } catch { throw new Error("invalid_response_json"); }
		}
		final = responseObject(body);
	}
	if (final.status !== "completed" || final.error) throw new Error("response_not_completed");
	if (!Array.isArray(final.output) || !final.output.length) throw new Error("empty_response_output");
	return final;
}

function sessionId(pair: RawPair): string | undefined {
	return Object.entries(pair.request.headers || {}).find(([name]) =>
		["session_id", "x-codex-session-id", "codex-session-id"].includes(name.toLowerCase()))?.[1];
}

function prefix(old: ResponseObject[], next: ResponseObject[]): boolean {
	return old.length <= next.length && old.every((item, index) => key(item) === key(next[index]));
}

/**
 * Export successful Responses exchanges, preserving inline systems unless explicitly transformed.
 * @returns Diagnostics for every relevant exchange, including unsupported inputs and duplicates.
 * @throws For invalid input/output paths or any attempt to overwrite output or diagnostics files.
 */
export async function exportCodexOpenAI(
	inputs: string[], outputPath: string, diagnosticsOutputPath?: string, options: ExportCodexOpenAIOptions = {},
): Promise<ExportDiagnostics> {
	validateCodexExportOptions(options);
	if (!inputs.length) throw new Error("at least one --input is required");
	const output = path.resolve(outputPath);
	const diagnosticsPath = diagnosticsOutputPath ? path.resolve(diagnosticsOutputPath) : undefined;
	if (output === diagnosticsPath) throw new Error("diagnostics path must differ from output");
	if (fs.existsSync(output) || (diagnosticsPath && fs.existsSync(diagnosticsPath))) throw new Error("output or diagnostics file already exists");
	const files = traceFiles(inputs);
	if (!files.length) throw new Error("no JSONL trace files found");
	const diagnostics: ExportDiagnostics = { trace_files: files, counts: {}, requests: [] };
	const bump = (name: string, amount = 1): void => { diagnostics.counts[name] = (diagnostics.counts[name] || 0) + amount; };
	const exchanges: Array<{ pair: RawPair; source: SourceLocation; timestamp: number }> = [];
	for (const file of files) {
		const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
		let line = 0;
		for await (const raw of lines) {
			line++;
			if (!raw.trim()) continue;
			let pair: RawPair;
			try { pair = JSON.parse(raw); }
			catch {
				bump("invalid_json");
				diagnostics.requests.push({ source: { file, line, request_time: "unknown" }, status: "skipped", reason: "invalid_json" });
				continue;
			}
			if (!isResponses(pair)) continue;
			const timestamp = Number(pair.request.timestamp);
			const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
			if (pair.request.timestamp == null || !Number.isFinite(timestamp) || !Number.isFinite(date.getTime())) {
				bump("invalid_timestamp");
				diagnostics.requests.push({ source: { file, line, request_time: "unknown" }, status: "skipped", reason: "invalid_timestamp" });
				continue;
			}
			exchanges.push({ pair, source: { file, line, request_time: date.toISOString() }, timestamp: date.getTime() });
		}
	}
	exchanges.sort((a, b) => a.timestamp - b.timestamp);
	const chains: Chain[] = [];
	const seen = new Map<string, SourceLocation>();
	for (const { pair, source } of exchanges) {
		const identity = crypto.createHash("sha256").update(key({ timestamp: pair.request.timestamp, url: pair.request.url, body: pair.request.body })).digest("hex");
		const duplicate = seen.get(identity);
		if (duplicate) {
			bump("duplicate");
			diagnostics.requests.push({ source, status: "duplicate", reason: "duplicate_request", duplicate_of: duplicate });
			continue;
		}
		try {
			const body = responseObject(pair.request.body);
			const response = completedResponse(pair);
			const converted = convertResponsesRequest(body, options);
			const answer = convertResponsesItems(response.output);
			if (!answer.length || answer.some((message) => message.role !== "assistant")) throw new Error("invalid_response_output_roles");
			const toolsKey = key(converted.tools);
			const session = sessionId(pair);
			const candidates = chains.filter((chain) => chain.toolsKey === toolsKey
				&& (!session || !chain.session || chain.session === session) && prefix(chain.history, converted.messages));
			const longest = Math.max(-1, ...candidates.map((chain) => chain.history.length));
			const best = candidates.filter((chain) => chain.history.length === longest);
			const chosen = best.length === 1 ? best[0] : undefined;
			const reason = chosen ? "continued" : best.length > 1 ? "ambiguous_prefix" : chains.length ? "divergent_history_or_tools" : "initial";
			const chain: Chain = chosen || {
				record: { messages: [], tools: converted.tools, metadata: {
					chain_id: `chain-${String(chains.length).padStart(4, "0")}`, header_session_ids: [], segment_reason: reason,
					parent_trace_id: null, relation_status: "unknown", rounds: [], response_sources: [],
					api_format: "openai-responses", response_ids: [], response_message_ranges: [],
				} }, history: [], toolsKey, session,
			};
			const appended = chosen ? converted.messages.slice(chosen.history.length) : converted.messages;
			chain.record.messages.push(...appended.map((message) => ({ ...message, role: String(message.role), trainable: false })));
			const start = chain.record.messages.length;
			chain.record.messages.push(...answer.map((message) => ({ ...message, role: "assistant", trainable: true })));
			chain.record.metadata.response_message_ranges.push({ start, end: chain.record.messages.length });
			chain.history = [...converted.messages, ...answer];
			const { input: _input, instructions: _instructions, tools: _tools, ...parameters } = body;
			chain.record.metadata.rounds.push({ ...source, model: body.model ?? null, parameters });
			chain.record.metadata.response_sources.push(source);
			chain.record.metadata.response_ids.push(typeof response.id === "string" ? response.id : "");
			if (session && !chain.record.metadata.header_session_ids.includes(session)) chain.record.metadata.header_session_ids.push(session);
			if (!chosen) chains.push(chain);
			seen.set(identity, source);
			bump("assigned"); bump(reason);
			diagnostics.requests.push({ source, status: "assigned", reason, chain_id: chain.record.metadata.chain_id });
		} catch (error) {
			const reason = (error as Error).message;
			bump(reason);
			diagnostics.requests.push({ source, status: "skipped", reason });
		}
	}
	diagnostics.counts.trace_files = files.length;
	diagnostics.counts.responses_requests = exchanges.length;
	diagnostics.counts.trajectories = chains.length;
	fs.writeFileSync(output, chains.map((chain) => JSON.stringify(chain.record)).join("\n") + (chains.length ? "\n" : ""), { flag: "wx" });
	if (diagnosticsPath) fs.writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2) + "\n", { flag: "wx" });
	return diagnostics;
}
