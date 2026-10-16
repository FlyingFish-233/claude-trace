/** @file transport.ts @description Shared streaming HTTP attempt lifecycle for both proxies. */
import * as http from "http";
import * as https from "https";
import { Exchange, TraceWriter } from "../trace/store";
import { Protocol } from "../protocols/types";

/** A route is selected after the request body is captured without changing its bytes. */
export interface TransportTarget { url: string; agent?: http.Agent }

/** Own active exchanges so cancellation and graceful shutdown each persist exactly once. */
export class CaptureTransport {
  private active = new Set<() => void>();
  constructor(readonly writer: TraceWriter) {}
  /** Forward a request and preserve original application payloads, including partial streams. */
  forward(req: http.IncomingMessage, res: http.ServerResponse, route: (body: Buffer) => TransportTarget, protocol?: Protocol, log = true): void {
    const chunks: Buffer[] = [];
    const exchange: Exchange = { method: req.method || "GET", url: req.url || "/", requestHeaders: req.headers,
      requestBody: Buffer.alloc(0), responseChunks: [], requestTimestamp: Date.now(), protocol };
    try { exchange.url = route(Buffer.alloc(0)).url; } catch { /* Resolve again when routing fields arrive. */ }
    let done = false;
    let upstream: http.ClientRequest | undefined;
    let upstreamResponse: http.IncomingMessage | undefined;
    const finish = (status: "complete" | "error" | "aborted", code?: string) => {
      if (done) return;
      done = true; this.active.delete(stop);
      exchange.requestBody = Buffer.concat(chunks); exchange.status = status;
      if (code) exchange.error = { code, message: code };
      if (log) this.writer.write(exchange);
    };
    const cancel = (code: string) => { finish("aborted", code); upstream?.destroy(); upstreamResponse?.destroy(); res.destroy(); };
    const stop = () => cancel("proxy_shutdown");
    this.active.add(stop);
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("aborted", () => cancel("client_cancelled"));
    req.on("error", () => cancel("request_stream_error"));
    res.on("error", () => cancel("client_response_error"));
    res.on("close", () => { if (!done) cancel("client_cancelled"); });
    req.on("end", () => {
      if (done) return;
      try {
        const target = route(Buffer.concat(chunks)); exchange.url = target.url;
        const url = new URL(target.url);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported_upstream_protocol");
        const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host };
        const hop = ["connection", "proxy-connection", "proxy-authorization", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", ...String(req.headers.connection || "").split(",").map(s => s.trim().toLowerCase())];
        for (const name of hop) delete headers[name];
        upstream = (url.protocol === "https:" ? https : http).request(url, { method: req.method, headers, agent: target.agent }, response => {
          upstreamResponse = response;
          exchange.responseTimestamp = Date.now(); exchange.statusCode = response.statusCode; exchange.responseHeaders = response.headers;
          res.writeHead(response.statusCode || 502, response.headers);
          response.on("data", chunk => {
            exchange.firstChunkTimestamp ??= Date.now(); exchange.responseChunks.push(Buffer.from(chunk));
          });
          response.on("end", () => finish("complete"));
          response.on("error", () => { finish("error", "upstream_stream_error"); res.destroy(); });
          response.on("aborted", () => { finish("error", "upstream_stream_interrupted"); res.destroy(); });
          response.pipe(res);
        });
        upstream.on("error", (error: NodeJS.ErrnoException) => {
          finish("error", error.code || "upstream_connection_error");
          if (!res.headersSent) res.writeHead(502);
          res.end("Upstream connection failed");
        });
        upstream.end(Buffer.concat(chunks));
      } catch {
        finish("error", "route_error"); if (!res.headersSent) res.writeHead(502); res.end("Upstream route failed");
      }
    });
  }
  /** Flush active attempts synchronously before finalizing the manifest. */
  stop(): void { const incomplete = this.active.size > 0; for (const stop of [...this.active]) stop(); this.writer.stop(incomplete ? "incomplete" : "complete"); }
}
