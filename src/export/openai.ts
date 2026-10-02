import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { RawPair, SSEEvent } from "../types";

type JsonObject = Record<string, any>;

export interface SourceLocation {
	file: string;
	line: number;
	request_time: string;
}

export interface ExportedMessage extends JsonObject {
	role: string;
	trainable: boolean;
}

export interface ExportedTrajectory {
	messages: ExportedMessage[];
	tools: JsonObject[];
	metadata: {
		chain_id: string;
		header_session_ids: string[];
		segment_reason: string;
		parent_trace_id: null;
		relation_status: "unknown";
		rounds: Array<SourceLocation & { model: unknown; parameters: JsonObject }>;
		response_sources: SourceLocation[];
	};
}

export interface DiagnosticEntry {
	source: SourceLocation;
	status: "assigned" | "skipped" | "duplicate";
	chain_id?: string;
	reason?: string;
	duplicate_of?: SourceLocation;
}

export interface ExportDiagnostics {
	trace_files: string[];
	counts: Record<string, number>;
	requests: DiagnosticEntry[];
}

interface Exchange {
	pair: RawPair;
	source: SourceLocation;
	sequence: number;
}

interface Chain {
	record: ExportedTrajectory;
	lastRequest: any[];
	lastResponse: any;
	systemKey: string;
	toolsKey: string;
	compactionMarkers: Set<string>;
}

function stable(value: any): any {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value).filter((key) => key !== "cache_control" && !(key === "signature" && value[key] === "")).sort()
				.map((key) => [key, stable(value[key])]),
		);
	}
	return value;
}

function normalizeContent(content: any): any {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const meaningful = content.filter((block) => block?.type !== "text" || typeof block.text !== "string" || block.text.trim());
		if (meaningful.every((block) => block?.type === "text" && typeof block.text === "string")) {
			return meaningful.map((block) => block.text).join("");
		}
		return meaningful.map((block) => {
			if (block?.type === "tool_result") {
				return stable({ ...block, content: normalizeContent(block.content) });
			}
			return stable(block);
		});
	}
	return stable(content);
}

function normalizeMessage(message: any): any {
	return stable({ role: message.role, content: normalizeContent(message.content) });
}

function key(value: any): string {
	return JSON.stringify(stable(value));
}

function requestTime(value: number): string {
	return new Date(value < 1_000_000_000_000 ? value * 1000 : value).toISOString();
}

function isMessagesRequest(pair: RawPair): boolean {
	if (pair.request?.method?.toUpperCase() !== "POST") return false;
	try {
		return new URL(pair.request.url).pathname.replace(/\/+$/, "").endsWith("/v1/messages");
	} catch {
		return false;
	}
}

function collectTraceFiles(inputPaths: string[]): string[] {
	const files = new Set<string>();
	const directories = new Set<string>();
	function visit(input: string): void {
		const resolved = fs.realpathSync(input);
		const stat = fs.statSync(resolved);
		if (stat.isDirectory()) {
			if (directories.has(resolved)) return;
			directories.add(resolved);
			for (const child of fs.readdirSync(resolved).sort()) visit(path.join(resolved, child));
		} else if (stat.isFile() && path.basename(resolved) === "trace.jsonl") {
			files.add(resolved);
		} else if (stat.isFile() && inputPaths.some((candidate) => path.resolve(candidate) === path.resolve(input))) {
			throw new Error(`input file must be named trace.jsonl: ${input}`);
		}
	}
	for (const input of inputPaths) visit(input);
	return [...files].sort();
}

function parsedEvents(pair: RawPair): JsonObject[] {
	const response = pair.response;
	if (!response) return [];
	if (Array.isArray(response.events) && response.events.length) {
		return response.events.map((event: SSEEvent) => event.data).filter((data): data is JsonObject => Boolean(data && typeof data === "object"));
	}
	const raw = response.body_raw;
	if (!raw) return [];
	const events: JsonObject[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		try { events.push(JSON.parse(data)); } catch { throw new Error("invalid SSE JSON"); }
	}
	return events;
}

function responseMessage(pair: RawPair): JsonObject {
	const response = pair.response;
	if (!response) throw new Error("missing_response");
	if (response.status_code < 200 || response.status_code >= 300) throw new Error(`http_${response.status_code}`);
	const events = parsedEvents(pair);
	if (!events.length && response.body?.role === "assistant" && Array.isArray(response.body.content)) return response.body;
	if (!events.some((event) => event.type === "message_start") || !events.some((event) => event.type === "message_stop")) {
		throw new Error("unparseable_stream_response");
	}
	const blocks: JsonObject[] = [];
	const active = new Map<number, JsonObject>();
	const toolInputs = new Map<JsonObject, string>();
	for (const event of events) {
		if (event.type === "error") throw new Error("stream_error");
		if (event.type === "content_block_start") {
			const block = { ...event.content_block };
			blocks.push(block);
			active.set(event.index, block);
		}
		if (event.type === "content_block_delta") {
			const block = active.get(event.index);
			if (!block) throw new Error("stream_delta_without_block");
			const delta = event.delta;
			if (delta.type === "text_delta") block.text = (block.text || "") + delta.text;
			if (delta.type === "thinking_delta") block.thinking = (block.thinking || "") + delta.thinking;
			if (delta.type === "signature_delta") block.signature = (block.signature || "") + delta.signature;
			if (delta.type === "input_json_delta") toolInputs.set(block, (toolInputs.get(block) || "") + delta.partial_json);
		}
		if (event.type === "content_block_stop") {
			const block = active.get(event.index);
			if (block?.type === "tool_use" && toolInputs.has(block)) {
				try { block.input = JSON.parse(toolInputs.get(block)!); }
				catch {
					const parsedBlock = response.body?.content?.find((item: JsonObject) => item.type === "tool_use" && item.id === block.id);
					if (!parsedBlock || typeof parsedBlock.input !== "object") throw new Error("invalid_stream_tool_json");
					block.input = parsedBlock.input;
				}
			}
			active.delete(event.index);
		}
	}
	if (!blocks.length) throw new Error("empty_stream_response");
	return { role: "assistant", content: blocks };
}

function textContent(value: any): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((block) => block?.type === "text")) {
		return value.map((block) => block.text || "").join("");
	}
	if (value == null) return "";
	return JSON.stringify(value);
}

function systemBlocks(value: any): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((block) => block?.type === "text" && typeof block.text === "string"
		&& block.text && !block.text.startsWith("x-anthropic-billing-header"))
		.map((block) => block.text);
}

function effectiveSystem(body: JsonObject): string {
	const parts: string[] = typeof body.system === "string" ? [body.system] : systemBlocks(body.system);
	for (const message of body.messages) {
		if (message.role !== "system") continue;
		if (typeof message.content === "string") {
			if (message.content && !message.content.startsWith("x-anthropic-billing-header")) parts.push(message.content);
		} else parts.push(...systemBlocks(message.content));
	}
	return parts.join("");
}

function convertMessage(message: any, trainable: boolean): ExportedMessage[] {
	if (message.role === "system") return [{ role: "system", content: textContent(message.content), trainable }];
	if (message.role === "assistant") {
		const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		if (!Array.isArray(blocks)) throw new Error("invalid_assistant_content");
		const output: ExportedMessage = { role: "assistant", content: "", trainable };
		const texts: string[] = [];
		const thoughts: string[] = [];
		const calls: JsonObject[] = [];
		for (const block of blocks) {
			if (block.type === "text") texts.push(block.text || "");
			else if (block.type === "thinking") thoughts.push(block.thinking || "");
			else if (block.type === "tool_use") {
				if (!block.id || !block.name) throw new Error("invalid_tool_use");
				calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.input ?? {} } });
			} else if (block.type === "redacted_thinking") {
				output.redacted_thinking = [...(output.redacted_thinking || []), block.data];
			} else throw new Error(`unsupported_assistant_block_${block.type}`);
		}
		output.content = texts.join("");
		if (thoughts.length) output.reasoning_content = thoughts.join("");
		if (calls.length) output.tool_calls = calls;
		return [output];
	}
	if (message.role === "user") {
		if (typeof message.content === "string") return [{ role: "user", content: message.content, trainable }];
		if (!Array.isArray(message.content)) throw new Error("invalid_user_content");
		const output: ExportedMessage[] = [];
		let text = "";
		for (const block of message.content) {
			if (block.type === "text") text += block.text || "";
			else if (block.type === "tool_result") {
				if (!block.tool_use_id) throw new Error("invalid_tool_result");
				output.push({ role: "tool", tool_call_id: block.tool_use_id, content: textContent(block.content), trainable });
			} else throw new Error(`unsupported_user_block_${block.type}`);
		}
		if (text || output.length === 0) output.push({ role: "user", content: text, trainable });
		return output;
	}
	throw new Error(`unsupported_role_${message.role}`);
}

function convertTools(tools: any): JsonObject[] {
	if (!Array.isArray(tools)) return [];
	return tools.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description || "", parameters: tool.input_schema || {} },
	}));
}

function compactionMarkers(body: JsonObject): string[] {
	const contents = [body.system, ...body.messages.map((message: any) => message.content)];
	return contents.map((content) => textContent(content)).filter((content) => {
		// Task notifications can embed a generic <summary> block; only a standalone
		// summary block represents a compaction marker.
		const standaloneSummary = /^<summary\b[\s\S]*<\/summary>$/i.test(content.trim());
		return standaloneSummary || /<conversation_summary>|conversation (?:has been|was) compacted|summary of the conversation so far|this session is being continued from a previous conversation/i.test(content);
	});
}

function unmatchedToolResults(messages: any[]): number {
	const calls = new Set<string>();
	let unmatched = 0;
	for (const message of messages) {
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "tool_use" && block.id) calls.add(block.id);
			if (block.type === "tool_result" && !calls.has(block.tool_use_id)) unmatched++;
		}
	}
	return unmatched;
}

function prefixMatches(old: any[], next: any[]): boolean {
	return old.length < next.length && old.every((message, index) => key(normalizeMessage(message)) === key(normalizeMessage(next[index])));
}

function responseMatches(response: any, message: any): boolean {
	return key(normalizeMessage(response)) === key(normalizeMessage(message));
}

function filterSystemMessages(messages: any[]): { messages: any[]; removed: number } {
	let seenSystem = false;
	const filtered = messages.filter((message) => {
		if (message?.role !== "system") return true;
		if (seenSystem) return false;
		seenSystem = true;
		return true;
	});
	return { messages: filtered, removed: messages.length - filtered.length };
}

function parameters(body: JsonObject): JsonObject {
	const { messages: _messages, system: _system, tools: _tools, metadata: _metadata, ...remaining } = body;
	return stable(remaining);
}

function bump(counts: Record<string, number>, name: string, amount = 1): void {
	counts[name] = (counts[name] || 0) + amount;
}

export async function exportOpenAI(
	inputPaths: string[], outputPath: string, diagnosticsOutputPath?: string,
	options: { filterSystemMessages?: boolean } = {},
): Promise<ExportDiagnostics> {
	if (!inputPaths.length) throw new Error("at least one --input is required");
	const output = path.resolve(outputPath);
	const diagnosticsPath = diagnosticsOutputPath ? path.resolve(diagnosticsOutputPath) : null;
	if (diagnosticsPath === output) throw new Error("diagnostics path must differ from output");
	if (fs.existsSync(output) || (diagnosticsPath && fs.existsSync(diagnosticsPath)))
		throw new Error("output or diagnostics file already exists");
	const files = collectTraceFiles(inputPaths);
	if (!files.length) throw new Error("no trace.jsonl files found");
	const diagnostics: ExportDiagnostics = { trace_files: files, counts: {}, requests: [] };
	const exchanges: Exchange[] = [];
	let sequence = 0;
	for (const file of files) {
		const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
		let line = 0;
		for await (const raw of lines) {
			line++;
			if (!raw.trim()) continue;
			let pair: RawPair;
			try { pair = JSON.parse(raw); }
			catch {
				bump(diagnostics.counts, "invalid_json");
				diagnostics.requests.push({ source: { file, line, request_time: "unknown" }, status: "skipped", reason: "invalid_json" });
				continue;
			}
			if (!pair?.request || !isMessagesRequest(pair)) continue;
			const timestamp = Number(pair.request.timestamp);
			if (!Number.isFinite(timestamp)) {
				bump(diagnostics.counts, "invalid_timestamp");
				diagnostics.requests.push({ source: { file, line, request_time: "unknown" }, status: "skipped", reason: "invalid_timestamp" });
				continue;
			}
			exchanges.push({ pair, source: { file, line, request_time: requestTime(timestamp) }, sequence: sequence++ });
		}
	}
	exchanges.sort((a, b) => Number(a.pair.request.timestamp) - Number(b.pair.request.timestamp) || a.sequence - b.sequence);
	const chains: Chain[] = [];
	const seen = new Map<string, SourceLocation>();
	for (const exchange of exchanges) {
		const { pair, source } = exchange;
		const identity = crypto.createHash("sha256").update(key({ timestamp: pair.request.timestamp, url: pair.request.url, body: pair.request.body })).digest("hex");
		const first = seen.get(identity);
		if (first) {
			bump(diagnostics.counts, "duplicate");
			diagnostics.requests.push({ source, status: "duplicate", duplicate_of: first, reason: "duplicate_request" });
			continue;
		}
		let response: JsonObject;
		try { response = responseMessage(pair); }
		catch (error) {
			const reason = (error as Error).message;
			bump(diagnostics.counts, reason);
			diagnostics.requests.push({ source, status: "skipped", reason });
			continue;
		}
		const rawBody = pair.request.body;
		const filtered = options.filterSystemMessages && Array.isArray(rawBody?.messages)
			? filterSystemMessages(rawBody.messages) : null;
		const body = filtered ? { ...rawBody, messages: filtered.messages } : rawBody;
		if (!body || !Array.isArray(body.messages)) {
			bump(diagnostics.counts, "invalid_request_messages");
			diagnostics.requests.push({ source, status: "skipped", reason: "invalid_request_messages" });
			continue;
		}
		if (filtered?.removed) bump(diagnostics.counts, "filtered_system_messages", filtered.removed);
		const system = effectiveSystem(body);
		const systemKey = key(system);
		const toolsKey = key(body.tools || []);
		const prefixCandidates = chains.filter((chain) => prefixMatches(chain.lastRequest, body.messages));
		const candidates = prefixCandidates.filter((chain) => chain.systemKey === systemKey && chain.toolsKey === toolsKey
			&& responseMatches(chain.lastResponse, body.messages[chain.lastRequest.length]));
		const longest = Math.max(0, ...candidates.map((chain) => chain.lastRequest.length));
		const best = candidates.filter((chain) => chain.lastRequest.length === longest);
		const chosen = best.length === 1 ? best[0] : null;
		const markers = compactionMarkers(body);
		const hasNewCompactionMarker = markers.some((marker) => !chains.some((chain) => chain.compactionMarkers.has(marker)));
		const reason = chosen ? "continued" : best.length > 1 ? "ambiguous_prefix"
			: hasNewCompactionMarker ? "compaction"
			: prefixCandidates.some((chain) => chain.systemKey !== systemKey || chain.toolsKey !== toolsKey)
				? "system_or_tools_changed" : chains.length ? "divergent_history" : "initial";
		if (!chosen && prefixCandidates.length) bump(diagnostics.counts, "prefix_conflicts");
		try {
			const appended = chosen
				? body.messages.slice(chosen.lastRequest.length + 1).filter((message: any) => message.role !== "system")
					.flatMap((message: any) => convertMessage(message, false))
				: [
					...(system ? [{ role: "system", content: system, trainable: false }] : []),
					...body.messages.filter((message: any) => message.role !== "system")
						.flatMap((message: any) => convertMessage(message, false)),
				];
			const answer = convertMessage(response, true);
			const chain = chosen || {
				record: {
					messages: [], tools: convertTools(body.tools),
					metadata: { chain_id: `chain-${String(chains.length).padStart(4, "0")}`, header_session_ids: [],
						segment_reason: reason, parent_trace_id: null, relation_status: "unknown", rounds: [], response_sources: [] },
				},
				lastRequest: [], lastResponse: null, systemKey, toolsKey, compactionMarkers: new Set<string>(),
			};
			if (!chosen) chains.push(chain);
			chain.record.messages.push(...appended, ...answer);
			chain.lastRequest = body.messages;
			chain.lastResponse = response;
			for (const marker of markers) chain.compactionMarkers.add(marker);
			const sessionId = Object.entries(pair.request.headers || {}).find(([name]) => name.toLowerCase() === "x-claude-code-session-id")?.[1];
			if (sessionId && !chain.record.metadata.header_session_ids.includes(sessionId)) chain.record.metadata.header_session_ids.push(sessionId);
			chain.record.metadata.rounds.push({ ...source, model: body.model ?? null, parameters: parameters(body) });
			chain.record.metadata.response_sources.push(source);
			seen.set(identity, source);
			bump(diagnostics.counts, "assigned");
			bump(diagnostics.counts, reason);
			const mismatch = unmatchedToolResults(body.messages);
			if (mismatch) bump(diagnostics.counts, "unmatched_tool_results", mismatch);
			diagnostics.requests.push({ source, status: "assigned", chain_id: chain.record.metadata.chain_id, reason });
		} catch (error) {
			const failure = (error as Error).message;
			bump(diagnostics.counts, failure);
			diagnostics.requests.push({ source, status: "skipped", reason: failure });
		}
	}
	diagnostics.counts.trace_files = files.length;
	diagnostics.counts.message_requests = exchanges.length;
	diagnostics.counts.trajectories = chains.length;
	fs.writeFileSync(output, chains.map((chain) => JSON.stringify(chain.record)).join("\n") + (chains.length ? "\n" : ""), { flag: "wx" });
	if (diagnosticsPath) fs.writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2) + "\n", { flag: "wx" });
	return diagnostics;
}
