/** @file types.ts @description Protocol-neutral capture, conversion and validation contracts. */
import type { RawPair } from "../types";

export const PROTOCOLS = ["anthropic-messages", "openai-responses", "openai-chat-completions"] as const;
export type Protocol = typeof PROTOCOLS[number];
export type Json = Record<string, any>;

/** One completed transport attempt; raw payloads are never replaced by view objects. */
export interface TraceRecord extends RawPair {
  schema_version: 2;
  run_id: string;
  request_id: string;
  protocol: Protocol | "unknown";
  status: "complete" | "error" | "aborted";
  diagnostics?: string[];
  error?: { code: string; message: string };
  timing: { start_ms: number; headers_ms: number | null; first_chunk_ms: number | null; end_ms: number };
  source?: { file: string; line: number; request_id: string };
}

/** Transformations apply only after protocol normalization, never to captured traffic. */
export interface ExportOptions {
  convertDeveloperToSystem?: boolean;
  filterSystemMessages?: boolean;
  mergeSystemMessages?: boolean;
}

/** Independent transport, protocol and model outcomes for an exchange. */
export interface ValidationResult {
  capture_complete: boolean;
  protocol_valid: boolean;
  http_success: boolean;
  model_complete: boolean;
  errors: string[];
  warnings: string[];
}

/** Self-contained normalized text turn for trajectory association. */
export interface ConvertedTurn {
  history: Json[];
  answer: Json[];
  tools: Json[];
  usage: Json;
  reasoning_metadata: Json[];
}

/** All protocol-dependent behavior used by capture and offline services. */
export interface ProtocolAdapter {
  id: Protocol;
  operation: string;
  parseResponse(record: TraceRecord): Json;
  validate(record: TraceRecord): ValidationResult;
  convert(record: TraceRecord): ConvertedTurn;
  replay(body: Json, options: { model?: string; maxTokens?: number; stream: "preserve" | "on" | "off" }): Json;
}
