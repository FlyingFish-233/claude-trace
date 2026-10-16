/** @file store.ts @description Append-only attempt records and manifest-scoped offline discovery. */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { TraceRecord, Json, Protocol } from "../protocols/types";
import { detectProtocol } from "../protocols/registry";
import { processHeaders } from "../intercept/header-redaction";
import * as zlib from "zlib";

/** Decode transport encodings for storage only; forwarding always uses the original bytes. */
export function decode(buffer: Buffer, headers: Json): { text?: string; encoded?: Json } {
  const encoding = String(headers["content-encoding"] || "").toLowerCase();
  try {
    let decoded = buffer;
    if (encoding === "gzip") decoded = zlib.gunzipSync(buffer);
    else if (encoding === "br") decoded = zlib.brotliDecompressSync(buffer);
    else if (encoding === "deflate") decoded = zlib.inflateSync(buffer);
    else if (encoding === "zstd" && typeof (zlib as any).zstdDecompressSync === "function") decoded = (zlib as any).zstdDecompressSync(buffer);
    else if (encoding && encoding !== "identity") return { encoded: { encoding, base64: buffer.toString("base64") } };
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(decoded) };
  } catch { return { encoded: { encoding: encoding || "binary", base64: buffer.toString("base64") } }; }
}

/** Captured payload shared by forward/reverse proxy transports and replay. */
export interface Exchange {
  method: string; url: string; requestHeaders: Json; requestBody: Buffer;
  statusCode?: number; responseHeaders?: Json; responseChunks: Buffer[];
  requestTimestamp: number; responseTimestamp?: number; firstChunkTimestamp?: number;
  status?: TraceRecord["status"]; error?: TraceRecord["error"]; protocol?: Protocol | "unknown";
  source?: TraceRecord["source"];
}

/** One writer per run; existing captures are never truncated. */
export class TraceWriter {
  readonly runId = randomUUID();
  readonly file: string;
  readonly manifestPath: string;
  readonly manifest: Json;
  private stopped = false;
  constructor(readonly directory: string, readonly options: { client?: string; clientVersion?: string; config?: Json; sensitive?: boolean } = {}) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, "trace.jsonl");
    this.manifestPath = path.join(directory, "manifest.json");
    if (fs.existsSync(this.file) || fs.existsSync(this.manifestPath)) throw new Error(`capture_directory_already_used: ${directory}`);
    fs.writeFileSync(this.file, "", { flag: "wx" });
    this.manifest = { schema_version: 2, run_id: this.runId, trace_file: "trace.jsonl", client: options.client || null,
      client_version: options.clientVersion || null, collector_version: require("../../package.json").version,
      config: options.config || {}, started_at: new Date().toISOString(), finished_at: null, outcome: "running" };
    this.saveManifest();
  }
  /** Serialize an attempt, retaining raw application text and independently parsed native JSON. */
  write(exchange: Exchange): TraceRecord {
    const request = decode(exchange.requestBody, exchange.requestHeaders);
    let body: any = null;
    if (request.text) { try { body = JSON.parse(request.text); } catch { body = request.text; } }
    else if (request.encoded) body = { _encoded: request.encoded };
    const protocol = exchange.protocol && exchange.protocol !== "unknown" ? exchange.protocol : detectProtocol(exchange.url, body);
    const response = exchange.statusCode === undefined ? null : {
      timestamp: exchange.responseTimestamp || Date.now(), status_code: exchange.statusCode,
      headers: processHeaders(exchange.responseHeaders || {}, this.options.sensitive),
    } as NonNullable<TraceRecord["response"]>;
    if (response) {
      const raw = decode(Buffer.concat(exchange.responseChunks), exchange.responseHeaders || {});
      if (raw.text !== undefined) {
        response.body_raw = raw.text;
        if (!String(exchange.responseHeaders?.["content-type"] || "").includes("text/event-stream")) {
          try { response.body = JSON.parse(raw.text); } catch { /* Keep non-JSON exactly as text. */ }
        }
      } else response.body = { _encoded: raw.encoded };
      response.api_format = protocol;
    }
    const record: TraceRecord = { schema_version: 2, run_id: this.runId, request_id: randomUUID(), protocol,
      ...(protocol === "unknown" ? { diagnostics: ["unknown_protocol"] } : {}),
      status: exchange.status || "complete", ...(exchange.error ? { error: exchange.error } : {}),
      request: { timestamp: exchange.requestTimestamp, method: exchange.method, url: exchange.url,
        headers: processHeaders(exchange.requestHeaders, this.options.sensitive), body,
        ...({ body_raw: request.text, body_encoded: request.encoded } as any) },
      response, timing: { start_ms: exchange.requestTimestamp, headers_ms: exchange.responseTimestamp ?? null,
        first_chunk_ms: exchange.firstChunkTimestamp ?? null, end_ms: Date.now() }, logged_at: new Date().toISOString(),
      ...(exchange.source ? { source: exchange.source } : {}) };
    fs.appendFileSync(this.file, JSON.stringify(record) + "\n");
    return record;
  }
  /** Finalize the manifest after all active transports have flushed. */
  stop(outcome: "complete" | "incomplete" = "complete"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.manifest.finished_at = new Date().toISOString(); this.manifest.outcome = outcome; this.saveManifest();
  }
  private saveManifest(): void {
    const temporary = `${this.manifestPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.manifest, null, 2) + "\n"); fs.renameSync(temporary, this.manifestPath);
  }
}

export interface LocatedRecord { record: TraceRecord; file: string; line: number }

/** Direct files are explicit; directory inputs only discover manifest-owned traces. */
export function inputFiles(inputs: string[]): string[] {
  const files = new Set<string>(), seen = new Set<string>();
  function visit(input: string, explicit: boolean): void {
    const real = fs.realpathSync(input);
    if (seen.has(real)) return;
    seen.add(real);
    if (fs.statSync(real).isFile()) { if (explicit) files.add(real); return; }
    const manifestPath = path.join(real, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.schema_version !== 2 || manifest.trace_file !== "trace.jsonl") throw new Error(`invalid_manifest: ${manifestPath}`);
      files.add(fs.realpathSync(path.join(real, manifest.trace_file)));
    }
    for (const entry of fs.readdirSync(real).sort()) {
      const child = path.join(real, entry);
      if (fs.statSync(child).isDirectory()) visit(child, false);
    }
  }
  inputs.forEach(input => visit(input, true));
  if (!files.size) throw new Error("no_trace_inputs");
  return [...files].sort();
}

/** Read only the current schema, retaining stable physical line numbers for provenance. */
export function readRecords(inputs: string[]): LocatedRecord[] {
  const result: LocatedRecord[] = [];
  for (const file of inputFiles(inputs)) {
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      let record: TraceRecord;
      try { record = JSON.parse(line); } catch { throw new Error(`invalid_json: ${file}:${index + 1}`); }
      if (record.schema_version !== 2 || !record.run_id || !record.request_id || !record.request || !record.timing) throw new Error(`invalid_trace_record: ${file}:${index + 1}`);
      result.push({ record, file, line: index + 1 });
    });
  }
  return result;
}

/** Refuse output overwrites before an operation can perform network or file side effects. */
export function assertNewOutput(file: string): void {
  if (fs.existsSync(file)) throw new Error(`output_already_exists: ${file}`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

/** Create a JSON artifact exclusively. */
export function writeJson(file: string, value: any): void {
  assertNewOutput(file); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
