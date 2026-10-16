/** Replay captured Messages or Responses requests against another HTTP endpoint. */
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import * as readline from "node:readline";
import { TextDecoder } from "node:util";

type JsonObject = Record<string, unknown>;
type Endpoint = "messages" | "responses";

interface ReplayOptions {
	file: string;
	lineNumbers: number[];
	concurrency: number;
	baseUrl: string;
	output?: string;
	model?: string;
	maxTokens?: number;
	timeout: number;
	seed?: number;
	apiKeyEnv?: string;
	preserveStream: boolean;
}

const excludedHeaders = new Set([
	"accept-encoding", "authorization", "connection", "content-encoding", "content-length", "content-type",
	"cookie", "host", "proxy-authorization", "transfer-encoding", "x-api-key",
]);

function object(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function endpoint(url: unknown): Endpoint | undefined {
	if (typeof url !== "string") return undefined;
	try {
		const pathname = new URL(url).pathname.replace(/\/+$/, "");
		if (pathname.endsWith("/v1/messages")) return "messages";
		if (pathname.endsWith("/v1/responses") || ["/responses", "/backend-api/codex/responses"].includes(pathname)) return "responses";
	} catch { /* Invalid captured URL. */ }
	return undefined;
}

function capturedRequest(entry: unknown): JsonObject | undefined {
	if (!object(entry) || !object(entry.request)) return undefined;
	const request = entry.request;
	return String(request.method).toUpperCase() === "POST" && object(request.body) && endpoint(request.url) ? request : undefined;
}

function positiveNumber(value: string | undefined, name: string, integer = false): number {
	const number = Number(value);
	if (!value || !Number.isFinite(number) || number <= 0 || (integer && !Number.isSafeInteger(number))) {
		throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}`);
	}
	return number;
}

function parseArgs(args: string[]): ReplayOptions {
	const options: ReplayOptions = { file: "", lineNumbers: [], concurrency: 1,
		baseUrl: "http://127.0.0.1:30011", timeout: 1800, preserveStream: false };
	const seen = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (!["--line-number", "--trace-line"].includes(flag)) {
			if (seen.has(flag)) throw new Error(`repeated argument: ${flag}`);
			seen.add(flag);
		}
		if (flag === "--preserve-stream") { options.preserveStream = true; continue; }
		if (!["--replay", "--line-number", "--trace-line", "--concurrency", "--base-url", "--output", "--model", "--max-tokens", "--timeout", "--seed", "--api-key-env"].includes(flag)) {
			throw new Error(`unknown replay argument: ${flag}`);
		}
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
		if (flag === "--replay") options.file = value;
		else if (flag === "--line-number" || flag === "--trace-line") options.lineNumbers.push(positiveNumber(value, flag, true));
		else if (flag === "--concurrency") options.concurrency = positiveNumber(value, flag, true);
		else if (flag === "--base-url") options.baseUrl = value;
		else if (flag === "--output") options.output = value;
		else if (flag === "--model") options.model = value;
		else if (flag === "--max-tokens") options.maxTokens = positiveNumber(value, flag, true);
		else if (flag === "--timeout") options.timeout = positiveNumber(value, flag);
		else if (flag === "--seed") {
			const seed = Number(value);
			if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
			options.seed = seed;
		} else options.apiKeyEnv = value;
	}
	if (!options.file) throw new Error("--replay requires a trace JSONL file");
	if (new Set(options.lineNumbers).size !== options.lineNumbers.length) throw new Error("replay line numbers must be unique");
	if (options.lineNumbers.length && options.seed !== undefined) throw new Error("--seed cannot be combined with explicit line numbers");
	const base = new URL(options.baseUrl);
	if (!["http:", "https:"].includes(base.protocol) || !base.hostname || base.username || base.password || base.search || base.hash) {
		throw new Error("--base-url must be an HTTP(S) URL without credentials, query or fragment");
	}
	if (options.apiKeyEnv && !process.env[options.apiKeyEnv]) throw new Error(`API key environment variable is missing or empty: ${options.apiKeyEnv}`);
	return options;
}

async function selectRequests(options: ReplayOptions): Promise<{ requests: Array<{ lineNumber: number; request: JsonObject }>; eligible: number; malformed: number }> {
	const lines = readline.createInterface({ input: fs.createReadStream(options.file, { encoding: "utf8" }), crlfDelay: Infinity });
	let lineNumber = 0;
	let eligible = 0;
	let malformed = 0;
	let selected: { lineNumber: number; request: JsonObject } | undefined;
	const wanted = new Set(options.lineNumbers);
	const found = new Map<number, JsonObject>();
	let state = (options.seed ?? Math.floor(Math.random() * 0x100000000)) >>> 0;
	for await (const line of lines) {
		lineNumber++;
		if (wanted.size && !wanted.has(lineNumber)) continue;
		let entry: unknown;
		try { entry = JSON.parse(line); }
		catch {
			if (wanted.size) throw new Error(`line ${lineNumber} is not valid JSON`);
			if (line.trim()) malformed++;
			continue;
		}
		const request = capturedRequest(entry);
		if (wanted.size) {
			if (!request) throw new Error(`line ${lineNumber} is not a replayable Messages or Responses POST request`);
			found.set(lineNumber, request);
			if (found.size === wanted.size) break;
			continue;
		}
		if (!request) continue;
		eligible++;
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		if (state / 0x100000000 < 1 / eligible) selected = { lineNumber, request };
	}
	if (wanted.size) {
		for (const number of options.lineNumbers) if (!found.has(number)) throw new Error(`line ${number} does not exist in ${options.file}`);
		return { requests: options.lineNumbers.map((number) => ({ lineNumber: number, request: found.get(number)! })),
			eligible: wanted.size, malformed: 0 };
	}
	if (!selected) throw new Error(`no replayable Messages or Responses POST request in ${options.file}`);
	return { requests: [selected], eligible, malformed };
}

function decodeBody(data: Buffer): unknown {
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
	catch { return { encoding: "base64", data: data.toString("base64") }; }
	try { return JSON.parse(text); } catch { return text; }
}

function redact(headers: JsonObject): JsonObject {
	return Object.fromEntries(Object.entries(headers).map(([name, value]) =>
		[name, ["authorization", "proxy-authorization", "x-api-key", "cookie"].includes(name.toLowerCase()) ? "<redacted>" : value]));
}

function send(url: URL, headers: Record<string, string>, body: JsonObject, timeout: number): Promise<JsonObject> {
	return new Promise((resolve, reject) => {
		const request = (url.protocol === "https:" ? https : http).request(url, {
			method: "POST", headers, timeout: timeout * 1000,
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("error", reject);
			response.on("end", () => resolve({
				status_code: response.statusCode ?? null,
				reason: response.statusMessage ?? "",
				headers: response.headers,
				body: decodeBody(Buffer.concat(chunks)),
			}));
		});
		request.on("timeout", () => request.destroy(new Error(`request timed out after ${timeout} seconds`)));
		request.on("error", reject);
		request.end(JSON.stringify(body));
	});
}

async function replayOne(options: ReplayOptions, selected: { lineNumber: number; request: JsonObject }, eligible: number, malformed: number): Promise<JsonObject> {
	const original = selected.request;
	const kind = endpoint(original.url)!;
	const base = new URL(options.baseUrl);
	const sourceUrl = new URL(String(original.url));
	const prefix = base.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
	const target = new URL(base.origin);
	target.pathname = `${prefix}/v1/${kind}`;
	target.search = sourceUrl.search;
	const body: JsonObject = { ...original.body as JsonObject };
	if (!options.preserveStream) body.stream = false;
	if (options.model) body.model = options.model;
	if (options.maxTokens) body[kind === "responses" ? "max_output_tokens" : "max_tokens"] = options.maxTokens;
	const headers: Record<string, string> = {};
	if (object(original.headers)) for (const [name, value] of Object.entries(original.headers)) {
		if (!excludedHeaders.has(name.toLowerCase()) && typeof value === "string") headers[name] = value;
	}
	headers["content-type"] = "application/json";
	if (!options.preserveStream) headers.accept = "application/json";
	if (options.apiKeyEnv) {
		const apiKey = process.env[options.apiKeyEnv]!;
		headers["x-api-key"] = apiKey;
		headers.authorization = `Bearer ${apiKey}`;
	}
	const started = Date.now();
	const record: JsonObject = {
		started_at: new Date(started).toISOString(),
		source_trace: path.resolve(options.file),
		selected_line_number: selected.lineNumber,
		eligible_request_count: eligible,
		malformed_line_count: malformed,
		sample_seed: options.seed ?? null,
		original_request: { ...original, headers: redact(object(original.headers) ? original.headers : {}) },
		replay_request: { method: "POST", url: target.toString(), headers: redact(headers), body },
	};
	try { record.replay_response = await send(target, headers, body, options.timeout); }
	catch (error) {
		const failure = error as Error;
		record.replay_response = { status_code: null, error_type: failure.name, error: failure.message };
	}
	record.elapsed_seconds = (Date.now() - started) / 1000;
	record.finished_at = new Date().toISOString();
	return record;
}

function succeeded(record: JsonObject): boolean {
	const status = (record.replay_response as JsonObject).status_code;
	return typeof status === "number" && status >= 200 && status < 300;
}

/** Run the shared offline CLI mode. Returns the intended process exit code. */
export async function runReplay(args: string[]): Promise<number> {
	const options = parseArgs(args);
	const selected = await selectRequests(options);
	const output = path.resolve(options.output ?? path.join(path.dirname(options.file), "replays", `trace_replay_${new Date().toISOString().replace(/[-:.]/g, "")}_${process.pid}.json`));
	if (fs.existsSync(output)) throw new Error(`output file already exists: ${output}`);
	const records: JsonObject[] = new Array(selected.requests.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(options.concurrency, records.length) }, async () => {
		while (next < records.length) {
			const index = next++;
			records[index] = await replayOne(options, selected.requests[index], selected.eligible, selected.malformed);
		}
	}));
	const successCount = records.filter(succeeded).length;
	const result = records.length === 1 ? records[0] : {
		source_trace: path.resolve(options.file),
		selected_line_numbers: selected.requests.map(({ lineNumber }) => lineNumber),
		concurrency_limit: options.concurrency,
		counts: { requests: records.length, succeeded: successCount, failed: records.length - successCount },
		results: records,
	};
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
	if (records.length === 1) {
		console.log(`selected line: ${selected.requests[0].lineNumber} / ${selected.eligible} replayable requests`);
		console.log(`response status: ${(records[0].replay_response as JsonObject).status_code}`);
		console.log(`replay record: ${output}`);
	} else {
		for (const record of records) console.log(`line ${record.selected_line_number}: ${(record.replay_response as JsonObject).status_code}`);
		console.log(`replayed: ${successCount}/${records.length} succeeded (concurrency limit ${options.concurrency})`);
		console.log(`replay records: ${output}`);
	}
	return successCount === records.length ? 0 : 1;
}
