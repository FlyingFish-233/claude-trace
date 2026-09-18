/**
 * @file Local HTTP reverse proxy for intercepting LLM API traffic from native binaries.
 *
 * Used when the target coding agent (Claude Code V2+, OpenCode, Codex CLI) is a native
 * binary that cannot be launched with Node's `--require` interceptor hook. The proxy
 * listens on 127.0.0.1, rewrites upstream URLs based on tool-specific routing rules,
 * forwards requests transparently, and logs request/response pairs to JSONL/JSON/HTML.
 */

import * as https from "https";
import * as http from "http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "http";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { spawn } from "child_process";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { traceDebug, traceRuntimeError } from "../cli/cli-common";
import { processHeaders as redactHeaders } from "./header-redaction";
import { HTMLGenerator } from "../report/html-generator";
import { SharedConversationProcessor } from "../report/shared-conversation-processor";
import {
	buildOpenAIChatCompletionFromSSE,
	buildOpenAIResponsesFromSSE,
	parseOpenAIChatCompletionBody,
	parseOpenAIResponsesBody,
} from "../adapt/openai-adapter";
import { inferApiFormatFromUrl } from "../adapt/api-format";
import { resolveCodexRouteTarget } from "../routing/codex-routing";
import { normalizeUpstreamPath, resolveModelRoute, inferApiFormatFromPath } from "../routing/proxy-routing";
import type { RawPair, SSEEvent } from "../types";
import type { ApiFormat, ModelRoute, ProviderRoute } from "../tools/types";
import type { Message } from "@anthropic-ai/sdk/resources/messages";

/** Configuration options for {@link ReverseProxyServer}. */
export interface ReverseProxyConfig {
	/** TCP port to bind; `0` lets the OS assign an ephemeral port. */
	port?: number;
	/** Directory for trace log files. */
	logDirectory?: string;
	/** Base name for log files; defaults to a timestamped `log-YYYY-MM-DD-...`. */
	logBaseName?: string;
	/** When true, log every proxied request, not just LLM API paths. */
	includeAllRequests?: boolean;
	/** Open the HTML report in the default browser when the proxy stops. */
	openBrowser?: boolean;
	/** When true, write only the append-only JSONL trace. */
	jsonlOnly?: boolean;
	/** When true, log auth headers verbatim instead of redacting them. */
	logSensitiveHeaders?: boolean;
	/** Default upstream base URL when no route matches (typically Anthropic API). */
	targetBaseUrl?: string;
	/** OpenCode provider-id → upstream base URL map for `/p/{providerId}/...` paths. */
	routes?: Record<string, string>;
	/** OpenCode model name → upstream route metadata. */
	modelRoutes?: Record<string, ModelRoute>;
	/** Codex path-prefix → upstream route metadata. */
	providerRoutes?: ProviderRoute[];
	/** Tool identifier stamped into HTML reports (`claude`, `opencode`, `codex`). */
	tool?: string;
}

/** Resolved listen address returned by {@link ReverseProxyServer.start}. */
export interface ProxyInfo {
	/** Actual TCP port the server bound to (may differ from config when port was `0`). */
	port: number;
	/** Full loopback base URL clients should use (`http://127.0.0.1:{port}`). */
	url: string;
}

/** Parsed components of an upstream base URL used to build outbound requests. */
interface ParsedTarget {
	/** URL scheme (`https:` or `http:`). */
	protocol: string;
	/** Upstream hostname for TLS SNI and the HTTP `Host` header. */
	targetHost: string;
	/** Upstream TCP port (443/80 when omitted from the URL). */
	targetPort: number;
	/** Path prefix from the base URL, without trailing slash (e.g. `/v1`). */
	pathPrefix: string;
}

/** Whether this Node runtime can decode zstd-compressed API responses. */
export function supportsZstd(): boolean {
	return typeof (zlib as ZlibWithZstd).zstdDecompressSync === "function";
}

/** Remove zstd from Accept-Encoding when the current Node cannot decode it. */
export function normalizeAcceptEncoding(
	value: string | string[] | undefined,
	zstdSupported: boolean = supportsZstd(),
): string | undefined {
	if (value === undefined || zstdSupported) return Array.isArray(value) ? value.join(", ") : value;
	const encodings = (Array.isArray(value) ? value.join(",") : value)
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item && item.split(";", 1)[0].toLowerCase() !== "zstd");
	return encodings.length > 0 ? encodings.join(", ") : undefined;
}

function noProxyMatches(targetUrl: URL, noProxy: string): boolean {
	const hostname = targetUrl.hostname.toLowerCase();
	const port = targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80");
	for (const rawEntry of noProxy.split(",")) {
		let entry = rawEntry.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "*") return true;
		let entryPort = "";
		const portIndex = entry.lastIndexOf(":");
		if (portIndex > 0 && /^\d+$/.test(entry.slice(portIndex + 1))) {
			entryPort = entry.slice(portIndex + 1);
			entry = entry.slice(0, portIndex);
		}
		if (entryPort && entryPort !== port) continue;
		entry = entry.replace(/^\*\./, ".");
		if (entry.startsWith(".")) {
			if (hostname === entry.slice(1) || hostname.endsWith(entry)) return true;
		} else if (hostname === entry || hostname.endsWith(`.${entry}`)) {
			return true;
		}
	}
	return false;
}

/** Resolve the process-level outbound proxy for one upstream URL, respecting NO_PROXY. */
export function resolveOutboundProxy(
	targetUrl: string,
	environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const parsed = new URL(targetUrl);
	const noProxy = environment.NO_PROXY || environment.no_proxy || "";
	if (noProxyMatches(parsed, noProxy)) return undefined;
	if (parsed.protocol === "https:") {
		return (
			environment.HTTPS_PROXY ||
			environment.https_proxy ||
			environment.HTTP_PROXY ||
			environment.http_proxy ||
			environment.ALL_PROXY ||
			environment.all_proxy
		);
	}
	return (
		environment.HTTP_PROXY ||
		environment.http_proxy ||
		environment.ALL_PROXY ||
		environment.all_proxy
	);
}

function createOutboundAgent(targetUrl: string): http.Agent | undefined {
	const proxyUrl = resolveOutboundProxy(targetUrl);
	if (!proxyUrl) return undefined;
	return new URL(targetUrl).protocol === "https:"
		? new HttpsProxyAgent(proxyUrl)
		: new HttpProxyAgent(proxyUrl);
}

/** Decode a buffered upstream response for structured JSON/SSE logging. */
export function decodeResponseBody(buffer: Buffer, contentEncoding: string): string {
	try {
		if (contentEncoding === "zstd") {
			const decompress = (zlib as ZlibWithZstd).zstdDecompressSync;
			if (decompress) return decompress(buffer).toString("utf-8");
		}
		if (contentEncoding === "gzip") return zlib.gunzipSync(buffer).toString("utf-8");
		if (contentEncoding === "br") return zlib.brotliDecompressSync(buffer).toString("utf-8");
		if (contentEncoding === "deflate") return zlib.inflateSync(buffer).toString("utf-8");
	} catch {
		// Preserve the raw body below so validation can reject an unparseable exchange.
	}
	return buffer.toString("utf-8");
}

/**
 * Parses a base URL string into host, port, protocol, and path prefix.
 *
 * @param targetBaseUrl - Full base URL (e.g. `https://api.anthropic.com/v1`).
 * @returns Parsed target suitable for constructing upstream requests.
 */
function parseTargetBaseUrl(targetBaseUrl?: string): ParsedTarget {
	const parsed = new URL(targetBaseUrl || "https://api.anthropic.com");
	// Strip trailing slash from pathname so path concatenation stays predictable.
	const pathPrefix = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
	return {
		protocol: parsed.protocol,
		targetHost: parsed.hostname,
		targetPort: parsed.port
			? parseInt(parsed.port, 10)
			: parsed.protocol === "https:" ? 443 : 80,
		pathPrefix,
	};
}

/**
 * URL path segments that identify LLM API endpoints worth logging.
 * Matched via substring check so query strings and provider prefixes still match.
 */
const LLM_API_PATHS = [
	"/v1/messages",
	"/messages",
	"/v1/chat/completions",
	"/chat/completions",
	"/v1/responses",
	"/responses",
	"/responses/compact",
	"/backend-api/codex/responses",
];

/**
 * Returns true when the request path targets a known LLM API endpoint.
 *
 * @param urlPath - Raw request URL path (may include query string).
 */
function isLlmApiPath(urlPath: string | undefined): boolean {
	if (!urlPath) {
		return false;
	}
	return LLM_API_PATHS.some((segment) => urlPath.includes(segment));
}

/**
 * Resolves upstream target for OpenCode provider-prefixed paths (`/p/{providerId}/...`).
 *
 * When the path does not match the `/p/` convention or the provider is unknown,
 * falls back to the default target and preserves the original path.
 *
 * @param reqUrl - Incoming request URL from the client.
 * @param routes - Provider-id → upstream base URL map.
 * @param fallback - Default upstream when routing does not apply.
 * @returns Parsed upstream target plus the full path used for logging and forwarding.
 */
function resolveRouteTarget(
	reqUrl: string | undefined,
	routes: Record<string, string> | undefined,
	fallback: ParsedTarget,
): ParsedTarget & { upstreamDisplayPath: string } {
	if (!reqUrl || !routes || Object.keys(routes).length === 0) {
		const upstreamDisplayPath = `${fallback.pathPrefix}${reqUrl || "/"}`;
		return { ...fallback, upstreamDisplayPath };
	}

	// OpenCode encodes provider selection in the path: /p/{providerId}/remainder
	const match = reqUrl.match(/^\/p\/([^/]+)(\/.*)?$/);
	if (!match) {
		const upstreamDisplayPath = `${fallback.pathPrefix}${reqUrl}`;
		return { ...fallback, upstreamDisplayPath };
	}

	const providerId = decodeURIComponent(match[1]);
	const remainder = match[2] || "/";
	const upstreamBaseUrl = routes[providerId];

	if (!upstreamBaseUrl) {
		const upstreamDisplayPath = `${fallback.pathPrefix}${reqUrl}`;
		return { ...fallback, upstreamDisplayPath };
	}

	const target = parseTargetBaseUrl(upstreamBaseUrl);
	const upstreamDisplayPath = `${target.pathPrefix}${remainder}`;
	return {
		...target,
		upstreamDisplayPath,
	};
}

/** Node `zlib` with optional zstd support (Node 22+). */
type ZlibWithZstd = typeof zlib & { zstdDecompressSync?: (buffer: Buffer) => Buffer };

/**
 * Returns the request `Content-Encoding` header normalized to lowercase.
 *
 * @param headers - Incoming HTTP headers from the client request.
 */
function getRequestContentEncoding(headers: IncomingHttpHeaders): string {
	return (headers["content-encoding"] || "").toLowerCase();
}

/**
 * Decompresses a request body buffer when Codex (or other clients) send compressed JSON.
 *
 * Supports zstd (Codex ChatGPT OAuth), gzip, br, and deflate. Returns the original
 * buffer when encoding is absent or decompression is unavailable/fails.
 *
 * @param buffer - Raw request body bytes from the client.
 * @param contentEncoding - Lowercase `Content-Encoding` header value.
 */
function decompressRequestBodyBuffer(buffer: Buffer, contentEncoding: string): Buffer {
	if (!buffer.length || !contentEncoding) {
		return buffer;
	}

	try {
		if (contentEncoding === "zstd") {
			const zstdDecompressSync = (zlib as ZlibWithZstd).zstdDecompressSync;
			if (zstdDecompressSync) {
				return zstdDecompressSync(buffer);
			}
			return buffer;
		}
		if (contentEncoding === "gzip") {
			return zlib.gunzipSync(buffer);
		}
		if (contentEncoding === "br") {
			return zlib.brotliDecompressSync(buffer);
		}
		if (contentEncoding === "deflate") {
			return zlib.inflateSync(buffer);
		}
	} catch {
		return buffer;
	}

	return buffer;
}

/**
 * Decodes a request body for JSON parsing and logs.
 *
 * @param headers - Incoming HTTP headers (for `Content-Encoding`).
 * @param buffer - Raw request body bytes.
 * @returns UTF-8 text after decompression, or empty string when buffer is empty.
 */
function decodeRequestBodyText(headers: IncomingHttpHeaders, buffer: Buffer): string {
	if (!buffer.length) {
		return "";
	}
	const decoded = decompressRequestBodyBuffer(buffer, getRequestContentEncoding(headers));
	return decoded.toString("utf-8");
}

/**
 * Parses a request body for structured logging.
 *
 * Binary or compressed bodies are decompressed when possible; otherwise a short
 * metadata placeholder is stored instead of corrupted binary text.
 *
 * @param headers - Incoming HTTP headers.
 * @param buffer - Raw request body bytes.
 */
function parseRequestBodyForLog(headers: IncomingHttpHeaders, buffer: Buffer): unknown {
	if (!buffer.length) {
		return null;
	}

	const encoding = getRequestContentEncoding(headers);
	const decoded = decompressRequestBodyBuffer(buffer, encoding);
	if (encoding === "zstd" && decoded === buffer && !(zlib as ZlibWithZstd).zstdDecompressSync) {
		return { _note: "zstd compressed request body", byteLength: buffer.length };
	}

	const text = decoded.toString("utf-8");
	try {
		return JSON.parse(text);
	} catch {
		if (encoding && decoded !== buffer) {
			return text;
		}
		if (encoding) {
			return { _note: `${encoding} compressed request body`, byteLength: buffer.length };
		}
		return text;
	}
}

/**
 * Extracts the `model` field from a JSON request body.
 *
 * @param requestBody - Raw request body string.
 * @returns Model identifier or `null` when absent or unparseable.
 */
function extractModelFromBody(requestBody: string): string | null {
	if (!requestBody) {
		return null;
	}

	try {
		const parsed = JSON.parse(requestBody) as { model?: unknown };
		return typeof parsed.model === "string" ? parsed.model : null;
	} catch {
		return null;
	}
}

/**
 * Resolves upstream target based on the `model` field in the request body.
 *
 * Used by OpenCode when `modelRoutes` is configured. Returns `null` when the
 * model cannot be extracted or is not registered in the route table.
 *
 * @param reqUrl - Incoming request URL (path may be normalized for the provider).
 * @param requestBody - Raw JSON request body.
 * @param modelRoutes - Model name → route metadata map.
 * @param fallback - Default upstream when model routing fails.
 * @returns Routed target with optional {@link ModelRoute} metadata, or `null`.
 */
function resolveModelTarget(
	reqUrl: string | undefined,
	requestBody: string,
	modelRoutes: Record<string, ModelRoute>,
	fallback: ParsedTarget,
): (ParsedTarget & { upstreamDisplayPath: string; modelRoute?: ModelRoute }) | null {
	const model = extractModelFromBody(requestBody);
	if (!model) {
		return null;
	}

	const modelRoute = resolveModelRoute(model, modelRoutes);
	if (!modelRoute) {
		traceDebug(`opencode-trace: unknown model "${model}", cannot route request`);
		return null;
	}

	const target = parseTargetBaseUrl(modelRoute.upstreamBaseUrl);
	const [rawPath, query = ""] = (reqUrl || "/").split("?");
	// Adjust path for provider-specific API conventions (e.g. /messages → /v1/messages).
	const urlPath = normalizeUpstreamPath(rawPath, modelRoute, target.pathPrefix);
	const upstreamDisplayPath = `${target.pathPrefix}${urlPath}${query ? `?${query}` : ""}`;

	traceDebug(
		`opencode-trace: ${reqUrl || "/"} | model=${model} → provider=${modelRoute.providerId} (${modelRoute.apiFormat}) → ${modelRoute.upstreamBaseUrl}`,
	);

	return {
		...target,
		upstreamDisplayPath,
		modelRoute,
	};
}

/**
 * HTTP reverse proxy that intercepts, logs, and forwards LLM API traffic.
 *
 * Supports three routing modes:
 * - **Default**: single `targetBaseUrl` (Claude Code V2+).
 * - **OpenCode**: `modelRoutes` and/or `routes` for multi-provider routing.
 * - **Codex**: `providerRoutes` for path-based upstream selection.
 */
export class ReverseProxyServer {
	/** Active Node HTTP server, or `null` after {@link stop}. */
	private server: http.Server | null = null;
	/** In-memory aggregate of all logged request/response pairs. */
	private pairs: RawPair[] = [];
	/** Guards against duplicate cleanup when {@link stop} is called more than once. */
	private stopped = false;
	/** Default upstream protocol from config `targetBaseUrl`. */
	private readonly targetProtocol: string;
	/** Default upstream hostname from config `targetBaseUrl`. */
	private readonly targetHost: string;
	/** Default upstream port from config `targetBaseUrl`. */
	private readonly targetPort: number;
	/** Default upstream path prefix from config `targetBaseUrl`. */
	private readonly pathPrefix: string;
	/** Whether the default upstream uses TLS. */
	private readonly useHttps: boolean;
	/** Resolved logging and listen options with defaults applied. */
	private readonly config: Required<
		Pick<
			ReverseProxyConfig,
			| "port"
			| "logDirectory"
			| "logBaseName"
			| "includeAllRequests"
			| "openBrowser"
			| "jsonlOnly"
			| "logSensitiveHeaders"
		>
	>;
	/** Append-only JSONL log file path. */
	private readonly logFile: string;
	/** Pretty-printed JSON array mirror of `pairs`. */
	private readonly jsonFile: string;
	/** Self-contained HTML report output path. */
	private readonly htmlFile: string;
	/** Frontend bundle renderer for HTML reports. */
	private readonly htmlGenerator: HTMLGenerator;
	/** Tool label embedded in generated HTML (`claude`, `opencode`, `codex`). */
	private readonly tool?: string;
	/** OpenCode provider-id routing table (`/p/{id}/...` paths). */
	private readonly routes?: Record<string, string>;
	/** OpenCode model-based routing table. */
	private readonly modelRoutes?: Record<string, ModelRoute>;
	/** Codex path-prefix routing table. */
	private readonly providerRoutes?: ProviderRoute[];

	/**
	 * Creates a new reverse proxy instance and initializes empty log files.
	 *
	 * @param config - Proxy and logging configuration.
	 */
	constructor(config: ReverseProxyConfig = {}) {
		const target = parseTargetBaseUrl(config.targetBaseUrl);
		this.targetProtocol = target.protocol;
		this.targetHost = target.targetHost;
		this.targetPort = target.targetPort;
		this.pathPrefix = target.pathPrefix;
		this.useHttps = target.protocol === "https:";
		this.tool = config.tool;
		this.routes = config.routes;
		this.modelRoutes = config.modelRoutes;
		this.providerRoutes = config.providerRoutes;

		this.config = {
			port: config.port || 0,
			logDirectory: config.logDirectory || ".claude-trace",
			logBaseName: config.logBaseName || "",
			includeAllRequests: config.includeAllRequests || false,
			openBrowser: config.openBrowser || false,
			jsonlOnly: config.jsonlOnly || false,
			logSensitiveHeaders: config.logSensitiveHeaders || false,
		};

		if (!fs.existsSync(this.config.logDirectory)) {
			fs.mkdirSync(this.config.logDirectory, { recursive: true });
		}

		const fileBaseName =
			this.config.logBaseName ||
			`log-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5)}`;

		this.logFile = path.join(this.config.logDirectory, `${fileBaseName}.jsonl`);
		this.jsonFile = path.join(this.config.logDirectory, `${fileBaseName}.json`);
		this.htmlFile = path.join(this.config.logDirectory, `${fileBaseName}.html`);

		fs.writeFileSync(this.logFile, "");
		if (!this.config.jsonlOnly) {
			fs.writeFileSync(this.jsonFile, "[]");
		}
		this.htmlGenerator = new HTMLGenerator();
	}

	/**
	 * Converts Node HTTP headers to a flat string map, optionally redacting secrets.
	 *
	 * Sensitive keys (authorization, cookies, etc.) are truncated to show only
	 * prefix/suffix unless `logSensitiveHeaders` is enabled.
	 *
	 * @param headers - Raw Node `IncomingHttpHeaders` from request or response.
	 * @returns Flat string map safe for JSON serialization.
	 */
	private processHeaders(headers: IncomingHttpHeaders): Record<string, string> {
		return redactHeaders(headers, this.config.logSensitiveHeaders);
	}

	/**
	 * Parses a Server-Sent Events (SSE) response body into structured events.
	 *
	 * Handles both Anthropic-style (`event:` + `data:`) and OpenAI-style
	 * (type embedded in JSON data) event formats.
	 *
	 * @param body - Decompressed SSE text from the upstream response.
	 * @returns Ordered list of parsed events with ISO timestamps.
	 */
	private parseSSEEvents(body: string): SSEEvent[] {
		const events: SSEEvent[] = [];
		const lines = body.split("\n");
		let currentEvent = "";

		for (const line of lines) {
			if (line.startsWith("event: ")) {
				currentEvent = line.substring(7).trim();
			} else if (line.startsWith("data: ")) {
				const data = line.substring(6).trim();
				if (data === "[DONE]") break;
				try {
					const parsed: unknown = JSON.parse(data);
					// Fall back to JSON `type` field when no explicit `event:` line was seen.
					const eventType =
						currentEvent ||
						(typeof parsed === "object" && parsed !== null && "type" in parsed
							? String((parsed as { type: unknown }).type)
							: "unknown");
					events.push({
						event: eventType,
						data: parsed,
						timestamp: new Date().toISOString(),
					});
				} catch {
					// Skip unparseable SSE data lines rather than failing the whole response log.
				}
			}
		}

		return events;
	}

	/** Appends a request/response pair to JSONL and optionally rewrites the JSON mirror. */
	private writePairToLog(pair: RawPair): void {
		try {
			const jsonLine = JSON.stringify(pair) + "\n";
			fs.appendFileSync(this.logFile, jsonLine);
			if (!this.config.jsonlOnly) {
				fs.writeFileSync(this.jsonFile, JSON.stringify(this.pairs, null, 2));
			}
		} catch (err) {
			traceRuntimeError(`Failed to write log: ${err}`, this.config.logDirectory);
		}
	}

	/** Regenerates the self-contained HTML report from all logged pairs. */
	private async generateHTML(): Promise<void> {
		if (this.config.jsonlOnly) return;
		try {
			await this.htmlGenerator.generateHTML(this.pairs, this.htmlFile, {
				timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
				includeAllRequests: this.config.includeAllRequests,
				tool: this.tool,
			});
		} catch (err) {
			traceRuntimeError(`Failed to generate HTML: ${err}`, this.config.logDirectory);
		}
	}

	/**
	 * Starts the proxy server on 127.0.0.1.
	 *
	 * @returns Resolved listen port and base URL (`http://127.0.0.1:{port}`).
	 */
	async start(): Promise<ProxyInfo> {
		return new Promise((resolve, reject) => {
			const httpServer = http.createServer((req, res) => {
				this.handleRequest(req, res);
			});

			this.server = httpServer;

			httpServer.on("error", (err) => {
				reject(err);
			});

			// Bind to loopback only — the proxy must not be reachable from the network.
			httpServer.listen(this.config.port, "127.0.0.1", () => {
				const address = httpServer.address();
				if (address && typeof address === "object") {
					const port = address.port;
					const url = `http://127.0.0.1:${port}`;
					console.error(`Logs will be written to:`);
					console.error(`  JSONL: ${path.resolve(this.logFile)}`);
					if (!this.config.jsonlOnly) {
						console.error(`  JSON:  ${path.resolve(this.jsonFile)}`);
						console.error(`  HTML:  ${path.resolve(this.htmlFile)}`);
					}
					resolve({ port, url });
				} else {
					reject(new Error("Failed to get server address"));
				}
			});
		});
	}

	/**
	 * Handles a single incoming HTTP request: route, forward, stream response, and log.
	 *
	 * Routing priority:
	 * 1. Model-based (OpenCode `modelRoutes`) — fails with 502 if model is unresolvable.
	 * 2. Provider-prefixed (`/p/{id}/...`) or default target.
	 * 3. Codex path-based (`providerRoutes`) overrides when `tool === "codex"`.
	 *
	 * @param req - Incoming client request from the coding agent.
	 * @param res - Response object streamed back to the client.
	 */
	private handleRequest(req: IncomingMessage, res: ServerResponse): void {
		const requestTimestamp = Date.now();
		const requestBodyChunks: Buffer[] = [];

		req.on("data", (chunk: Buffer | string) => {
			requestBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});

		req.on("end", () => {
			const requestBodyBuffer = Buffer.concat(requestBodyChunks);
			const requestBodyText = decodeRequestBodyText(req.headers, requestBodyBuffer);

			const fallback = {
				protocol: this.targetProtocol,
				targetHost: this.targetHost,
				targetPort: this.targetPort,
				pathPrefix: this.pathPrefix,
			};

			const modelTarget =
				this.modelRoutes && Object.keys(this.modelRoutes).length > 0
					? resolveModelTarget(req.url, requestBodyText, this.modelRoutes, fallback)
					: null;

			// OpenCode requires every request to resolve to a known model when modelRoutes is set.
			if (this.modelRoutes && Object.keys(this.modelRoutes).length > 0 && !modelTarget) {
				res.writeHead(502);
				res.end("opencode-trace: could not resolve model from request body");
				return;
			}

			let routeTarget =
				modelTarget ??
				resolveRouteTarget(req.url, this.routes, fallback);

			// Codex uses path-prefix routing instead of model-based routing.
			if (this.tool === "codex" && this.providerRoutes?.length) {
				routeTarget = resolveCodexRouteTarget(req.url, this.providerRoutes, fallback);
			}

			const upstreamPath = routeTarget.upstreamDisplayPath;
			const upstreamUrl = `${routeTarget.protocol}//${routeTarget.targetHost}${upstreamPath}`;
			const useHttps = routeTarget.protocol === "https:";

			const upstreamHeaders: IncomingHttpHeaders = {
				...req.headers,
				// Override Host so upstream TLS SNI and virtual-host routing match the target.
				host: routeTarget.targetHost,
			};
			const acceptEncodingKey = Object.keys(upstreamHeaders).find(
				(key) => key.toLowerCase() === "accept-encoding",
			);
			if (acceptEncodingKey) {
				const normalized = normalizeAcceptEncoding(upstreamHeaders[acceptEncodingKey]);
				if (normalized) upstreamHeaders[acceptEncodingKey] = normalized;
				else delete upstreamHeaders[acceptEncodingKey];
			}

			const options: https.RequestOptions = {
				hostname: routeTarget.targetHost,
				port: routeTarget.targetPort,
				path: upstreamPath,
				method: req.method,
				headers: upstreamHeaders,
				agent: createOutboundAgent(upstreamUrl),
			};

			const requestModule = useHttps ? https : http;
			const proxyReq = requestModule.request(options, (proxyRes) => {
				const responseTimestamp = Date.now();
				const responseChunks: Buffer[] = [];

				// Stream response to client immediately while buffering for logging.
				res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

				proxyRes.on("data", (chunk: Buffer | string) => {
					responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					res.write(chunk);
				});

				proxyRes.on("end", () => {
					void this.logResponse(
						req,
						proxyRes,
						requestTimestamp,
						responseTimestamp,
						requestBodyBuffer,
						responseChunks,
						upstreamUrl,
						modelTarget !== null,
						modelTarget?.modelRoute,
					);
					res.end();
				});
			});

			proxyReq.on("error", (err) => {
				traceRuntimeError(
					`Proxy request error: ${err.message} (upstream: ${upstreamUrl})`,
					this.config.logDirectory,
				);
				res.writeHead(502);
				res.end(`Proxy error: ${err.message}`);
			});

			if (requestBodyBuffer.length > 0) {
				proxyReq.write(requestBodyBuffer);
			}
			proxyReq.end();
		});
	}

	/**
	 * Parses, normalizes, and persists a completed request/response exchange.
	 *
	 * Decompresses gzip/brotli/deflate bodies before parsing. Converts OpenAI and
	 * Anthropic streaming responses into structured message objects when possible.
	 *
	 * @param req - Original client request (used for URL and method).
	 * @param proxyRes - Upstream response headers and status.
	 * @param requestTimestamp - Client request start time in milliseconds.
	 * @param responseTimestamp - Upstream response completion time in milliseconds.
	 * @param requestBody - Buffered raw request body bytes.
	 * @param responseChunks - Buffered raw response body chunks.
	 * @param upstreamUrl - Fully resolved upstream URL for logging.
	 * @param modelRouted - Whether model-based routing was used (forces logging).
	 * @param modelRoute - Resolved model route metadata, if any.
	 */
	private async logResponse(
		req: IncomingMessage,
		proxyRes: IncomingMessage,
		requestTimestamp: number,
		responseTimestamp: number,
		requestBody: Buffer,
		responseChunks: Buffer[],
		upstreamUrl: string,
		modelRouted: boolean = false,
		modelRoute?: ModelRoute,
	): Promise<void> {
		const shouldLog =
			this.config.includeAllRequests || isLlmApiPath(req.url) || modelRouted;

		if (!shouldLog) {
			traceDebug(`opencode-trace: skipped logging for ${req.method} ${req.url}`);
			return;
		}

		try {
		const parsedRequestBody = parseRequestBodyForLog(req.headers, requestBody);

		const rawBuffer = Buffer.concat(responseChunks);
		const contentEncoding = (proxyRes.headers["content-encoding"] || "").toLowerCase();
		const responseBody = decodeResponseBody(rawBuffer, contentEncoding);

		const apiFormat = this.resolveResponseApiFormat(req.url, upstreamUrl, modelRoute);
		const parsedResponseBody = this.parseResponseBody(proxyRes, responseBody, apiFormat, parsedRequestBody);
		const pair: RawPair = {
			request: {
				timestamp: requestTimestamp / 1000,
				method: req.method || "GET",
				url: upstreamUrl,
				headers: this.processHeaders(req.headers),
				body: parsedRequestBody,
			},
			response: {
				timestamp: responseTimestamp / 1000,
				status_code: proxyRes.statusCode || 0,
				headers: this.processHeaders(proxyRes.headers),
				api_format: apiFormat !== "unknown" ? apiFormat : undefined,
				...parsedResponseBody,
			},
			logged_at: new Date().toISOString(),
		};

		this.pairs.push(pair);
		this.writePairToLog(pair);
		await this.generateHTML();
		} catch (err) {
			traceRuntimeError(`opencode-trace: failed to log response: ${err}`, this.config.logDirectory);
		}
	}

	/**
	 * Determines the API format for response parsing.
	 *
	 * Priority: explicit model route → request path heuristics → upstream URL heuristics.
	 *
	 * @param reqUrl - Client-facing request URL path.
	 * @param upstreamUrl - Resolved upstream URL after routing.
	 * @param modelRoute - Optional model route with explicit `apiFormat`.
	 * @returns Best-effort API format for {@link parseResponseBody}.
	 */
	private resolveResponseApiFormat(
		reqUrl: string | undefined,
		upstreamUrl: string,
		modelRoute?: ModelRoute,
	): ApiFormat {
		if (modelRoute?.apiFormat && modelRoute.apiFormat !== "unknown") {
			return modelRoute.apiFormat;
		}
		const fromReq = inferApiFormatFromPath(reqUrl);
		if (fromReq !== "unknown") {
			return fromReq;
		}
		return inferApiFormatFromUrl(upstreamUrl);
	}

	/**
	 * Parses a response body into structured log fields based on content type and API format.
	 *
	 * For SSE streams, attempts to reconstruct complete message objects from event
	 * sequences; falls back to raw body text when parsing fails.
	 *
	 * @param proxyRes - Upstream response (for `content-type` header).
	 * @param responseBody - Decompressed response text.
	 * @param apiFormat - Resolved format from {@link resolveResponseApiFormat}.
	 * @param requestBody - Parsed request body (used to extract model name).
	 * @returns Subset of {@link RawPair.response} fields (`body`, `body_raw`, `events`).
	 */
	private parseResponseBody(
		proxyRes: IncomingMessage,
		responseBody: string,
		apiFormat: ApiFormat,
		requestBody: unknown,
	): Pick<NonNullable<RawPair["response"]>, "body" | "body_raw" | "events"> {
		const contentType = proxyRes.headers["content-type"] || "";
		const model =
			requestBody && typeof requestBody === "object" && "model" in requestBody
				? String((requestBody as { model: unknown }).model)
				: "unknown";

		try {
			if (contentType.includes("application/json")) {
				const parsed = JSON.parse(responseBody) as unknown;
				if (parsed && typeof parsed === "object" && "error" in parsed) {
					return { body: parsed };
				}
				if (apiFormat === "openai" || ("choices" in (parsed as object))) {
					return { body: parseOpenAIChatCompletionBody(parsed, model) };
				}
				if (apiFormat === "openai-responses" || ("output" in (parsed as object))) {
					return { body: parseOpenAIResponsesBody(parsed, model) };
				}
				return { body: parsed };
			}

			if (contentType.includes("text/event-stream")) {
				const events = this.parseSSEEvents(responseBody);

				if (apiFormat === "openai") {
					try {
						const completion = buildOpenAIChatCompletionFromSSE(responseBody, model);
						return { body: parseOpenAIChatCompletionBody(completion, model), events };
					} catch {
						return { body_raw: responseBody, events };
					}
				}

				if (apiFormat === "openai-responses") {
					try {
						const responsesBody = buildOpenAIResponsesFromSSE(responseBody, model);
						return { body: parseOpenAIResponsesBody(responsesBody, model), events };
					} catch {
						return { body_raw: responseBody, events };
					}
				}

				// Default SSE path: Anthropic Messages API streaming format.
				const processor = new SharedConversationProcessor();
				try {
					const message: Message = processor.parseStreamingResponse(responseBody);
					return { body: message, events };
				} catch {
					return { body_raw: responseBody, events };
				}
			}

			return { body_raw: responseBody };
		} catch {
			return { body_raw: responseBody };
		}
	}

	/**
	 * Stops the proxy server, prints summary stats, and optionally opens the HTML report.
	 */
	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;

		if (this.server) {
			this.server.close();
			this.server = null;
		}

		console.error(`Logged ${this.pairs.length} request/response pairs`);

		if (this.config.openBrowser && fs.existsSync(this.htmlFile)) {
			this.openHtmlInBrowser(this.htmlFile);
		}
	}

	/** Returns the absolute path to the generated HTML report file. */
	getHtmlFile(): string {
		return this.htmlFile;
	}

	/** Opens an HTML file in the platform default browser (Windows/macOS/Linux). */
	private openHtmlInBrowser(htmlFile: string): void {
		try {
			if (process.platform === "win32") {
				spawn("cmd", ["/c", "start", "", htmlFile], { detached: true, stdio: "ignore" }).unref();
			} else {
				const cmd = process.platform === "darwin" ? "open" : "xdg-open";
				spawn(cmd, [htmlFile], { detached: true, stdio: "ignore" }).unref();
			}
			console.error(`Opening ${htmlFile} in browser`);
		} catch (err) {
			console.error(`Failed to open browser: ${err}`);
		}
	}
}
