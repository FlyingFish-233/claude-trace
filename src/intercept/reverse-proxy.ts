/** @file reverse-proxy.ts @description Profile routing with the shared raw capture transport. */
import * as http from "http";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { IncomingHttpHeaders } from "http";
import { traceDebug } from "../cli/cli-common";
import { resolveCodexRouteTarget } from "../routing/codex-routing";
import { normalizeUpstreamPath, resolveModelRoute } from "../routing/proxy-routing";
import { ModelRoute, ProviderRoute } from "../tools/types";
import { Protocol } from "../protocols/types";
import { TraceWriter, decode } from "../trace/store";
import { CaptureTransport } from "./transport";
interface ParsedTarget { protocol: string; targetHost: string; targetPort: number; pathPrefix: string }
/** Join an API prefix without duplicating a prefix already sent by a client. */
function joinApiPath(prefix: string, incoming: string): string {
  if (prefix && (incoming === prefix || incoming.startsWith(prefix + "/") || incoming.startsWith(prefix + "?"))) return incoming;
  if (prefix.endsWith("/v1") && incoming.startsWith("/v1/")) incoming = incoming.slice(3);
  return prefix + incoming;
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

/** Build the transport agent selected by HTTP(S)_PROXY and NO_PROXY. */
export function createOutboundAgent(targetUrl: string): http.Agent | undefined {
	const proxyUrl = resolveOutboundProxy(targetUrl);
	if (!proxyUrl) return undefined;
	return new URL(targetUrl).protocol === "https:"
		? new HttpsProxyAgent(proxyUrl)
		: new HttpProxyAgent(proxyUrl);
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
		const upstreamDisplayPath = joinApiPath(fallback.pathPrefix, reqUrl || "/");
		return { ...fallback, upstreamDisplayPath };
	}

	// OpenCode encodes provider selection in the path: /p/{providerId}/remainder
	const match = reqUrl.match(/^\/p\/([^/]+)(\/.*)?$/);
	if (!match) {
		const upstreamDisplayPath = joinApiPath(fallback.pathPrefix, reqUrl);
		return { ...fallback, upstreamDisplayPath };
	}

	const providerId = decodeURIComponent(match[1]);
	const remainder = match[2] || "/";
	const upstreamBaseUrl = routes[providerId];

	if (!upstreamBaseUrl) {
		const upstreamDisplayPath = joinApiPath(fallback.pathPrefix, reqUrl);
		return { ...fallback, upstreamDisplayPath };
	}

	const target = parseTargetBaseUrl(upstreamBaseUrl);
	const upstreamDisplayPath = joinApiPath(target.pathPrefix, remainder);
	return {
		...target,
		upstreamDisplayPath,
	};
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
	const upstreamDisplayPath = `${joinApiPath(target.pathPrefix, urlPath)}${query ? `?${query}` : ""}`;

	traceDebug(
		`opencode-trace: ${reqUrl || "/"} | model=${model} → provider=${modelRoute.providerId} (${modelRoute.apiFormat}) → ${modelRoute.upstreamBaseUrl}`,
	);

	return {
		...target,
		upstreamDisplayPath,
		modelRoute,
	};
}


/** Reverse proxy configuration; protocol selection is independent of the client label. */
export interface ReverseProxyConfig {
  port?: number; host?: string; logDirectory: string; logSensitiveHeaders?: boolean;
  targetBaseUrl: string; routes?: Record<string,string>; modelRoutes?: Record<string,ModelRoute>;
  providerRoutes?: ProviderRoute[]; client?: string; clientVersion?: string; apiFormat?: Protocol;
}
/** Single-upstream capture server with optional profile-supplied routing. */
export class ReverseProxyServer {
  readonly writer: TraceWriter;
  private readonly transport: CaptureTransport;
  private readonly server: http.Server;
  constructor(readonly config: ReverseProxyConfig) {
    const target = new URL(config.targetBaseUrl);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error("invalid_upstream_url");
    this.writer = new TraceWriter(config.logDirectory, { client: config.client, clientVersion: config.clientVersion,
      sensitive: config.logSensitiveHeaders, config: { upstream: target.toString(), api_format: config.apiFormat || "auto" } });
    this.transport = new CaptureTransport(this.writer);
    this.server = http.createServer((req,res) => this.transport.forward(req,res, body => {
      const fallback = parseTargetBaseUrl(config.targetBaseUrl);
      const route = (config.modelRoutes && resolveModelTarget(req.url, decode(body, req.headers).text || "",config.modelRoutes,fallback)) ||
        (config.providerRoutes?.some(r => r.matchPathPrefixes?.length) ? resolveCodexRouteTarget(req.url,config.providerRoutes,fallback) : resolveRouteTarget(req.url,config.routes,fallback));
      const url = `${route.protocol}//${route.targetHost}:${route.targetPort}${route.upstreamDisplayPath}`;
      return { url, agent: createOutboundAgent(url) };
    }, config.apiFormat));
  }
  /** Bind loopback on an ephemeral port by default. */
  async start(): Promise<{port:number;url:string}> {
    return new Promise((resolve,reject) => {
      this.server.once("error",reject);
      this.server.listen(this.config.port ?? 0,this.config.host || "127.0.0.1",() => {
        this.server.off("error",reject);
        const port = (this.server.address() as import("net").AddressInfo).port;
        resolve({port,url:`http://${this.config.host || "127.0.0.1"}:${port}`});
      });
    });
  }
  /** Stop accepting traffic and persist all in-flight attempts. */
  stop(): void { this.transport.stop(); this.server.close(); this.server.closeAllConnections(); }
}
