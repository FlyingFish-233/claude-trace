/** @file offline.ts @description Protocol-neutral validation, trajectory association and export policy. */
import * as fs from "fs";
import { adapters } from "../protocols/registry";
import { ExportOptions, Json, TraceRecord } from "../protocols/types";
import { readRecords, inputFiles, assertNewOutput, writeJson } from "./store";
import { SENSITIVE_HEADER_PARTS } from "../intercept/header-redaction";
import * as path from "path";

/** Stable semantic equality independent of JSON key insertion order. */
function key(value: any): string {
  function stable(v: any): any { return Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v; }
  return JSON.stringify(stable(value));
}

/** One shared policy sequence: developer conversion, first-system filter, then merge. */
export function transformMessages(messages: Json[], options: ExportOptions): Json[] {
  if (options.mergeSystemSeparator !== undefined) {
    if (typeof options.mergeSystemSeparator !== "string") throw new Error("invalid_merge_system_separator");
    if (!options.mergeSystemMessages) throw new Error("merge_system_separator_requires_merge");
  }
  let output = messages.map(message => ({ ...message }));
  if (options.convertDeveloperToSystem) output = output.map(message => {
    if (message.role !== "developer") return message;
    if (Object.keys(message).some(key => !["role", "content", "trainable"].includes(key) && message[key] != null)) throw new Error("developer_metadata_cannot_convert_to_system");
    const { tools: _tools, ...rest } = message;
    return { ...rest, role: "system" };
  });
  if (options.filterSystemMessages) {
    let seen = false;
    output = output.filter(message => message.role !== "system" || (!seen && (seen = true)));
  }
  if (options.mergeSystemMessages) {
    const systems = output.filter(message => message.role === "system");
    output = [...(systems.length ? [{ role: "system", content: systems.map(m => m.content).join(options.mergeSystemSeparator ?? "\n\n"), trainable: false }] : []), ...output.filter(m => m.role !== "system")];
  }
  return output;
}

/** Validate capture, wire semantics and model outcomes without modifying inputs. */
export function validateTraces(inputs: string[], output: string, outcome: "complete" | "incomplete" = "complete"): Json {
  assertNewOutput(output);
  const entries: Json[] = [];
  const errors: string[] = [];
  let records: ReturnType<typeof readRecords> = [];
  try { records = readRecords(inputs); } catch (error) { errors.push((error as Error).message); }
  if (!records.length) errors.push("no_records");
  const seen = new Set<string>();
  for (const { record, file, line } of records) {
    const adapter = record.protocol === "unknown" ? undefined : adapters[record.protocol];
    const checked = adapter?.validate(record) || { capture_complete: record.status === "complete", protocol_valid: false, http_success: false, model_complete: false, errors: ["unknown_protocol"], warnings: [] };
    const id = `${record.run_id}/${record.request_id}`;
    if (seen.has(id)) checked.errors.push("duplicate_request_id");
    seen.add(id);
    for (const side of [record.request, record.response]) for (const [name, value] of Object.entries(side?.headers || {})) {
      if (SENSITIVE_HEADER_PARTS.some(part => name.toLowerCase().includes(part)) && value !== "[REDACTED]") checked.errors.push(`unredacted_header:${name}`);
    }
    if (!["complete", "error", "aborted"].includes(record.status)) checked.errors.push("invalid_capture_status");
    if (record.status !== "complete" && !record.error) checked.errors.push("missing_transport_error");
    const times = [record.timing.start_ms, record.timing.headers_ms, record.timing.first_chunk_ms, record.timing.end_ms].filter(t => t !== null) as number[];
    if (times.some((t, i) => !Number.isFinite(t) || (i > 0 && t < times[i - 1]))) checked.errors.push("invalid_timing");
    if (checked.errors.length) checked.protocol_valid = false;
    entries.push({ file, line, request_id: record.request_id, protocol: record.protocol, ...checked });
  }
  let manifestsComplete = true;
  try {
    for (const file of inputFiles(inputs)) {
      const manifestPath = path.join(path.dirname(file), "manifest.json");
      if (fs.existsSync(manifestPath) && JSON.parse(fs.readFileSync(manifestPath, "utf8")).outcome !== "complete") manifestsComplete = false;
    }
  } catch { manifestsComplete = false; }
  const report = { schema_version: 2, capture_complete: outcome === "complete" && manifestsComplete && !errors.length && entries.every(e => e.capture_complete),
    protocol_valid: !errors.length && entries.every(e => e.protocol_valid), errors,
    counts: { requests: entries.length, http_success: entries.filter(e => e.http_success).length, model_complete: entries.filter(e => e.model_complete).length }, entries };
  writeJson(output, report); return report;
}

/** Associate turns by raw normalized history, then apply export transformations once per chain. */
export function exportTraces(inputs: string[], output: string, options: ExportOptions = {}, diagnosticsPath = `${output}.diagnostics.json`): Json {
  if (path.resolve(output) === path.resolve(diagnosticsPath)) throw new Error("output_diagnostics_collision");
  assertNewOutput(output); assertNewOutput(diagnosticsPath);
  const chains: Array<{ partition: string; history: Json[]; toolsKey: string; model: any; messages: Json[]; tools: Json[]; metadata: Json; markers: Set<string> }> = [];
  const diagnostics: Json[] = [];
  const seen = new Set<string>();
  const records = readRecords(inputs).sort((a, b) => a.record.timing.start_ms - b.record.timing.start_ms || a.file.localeCompare(b.file) || a.line - b.line);
  for (const { record, file, line } of records) {
    const source = { file, line, request_id: record.request_id };
    try {
      const identity = `${record.run_id}/${record.request_id}`;
      if (seen.has(identity)) throw new Error("duplicate_request");
      seen.add(identity);
      if (record.protocol === "unknown" || !adapters[record.protocol]) throw new Error("unknown_protocol");
      const adapter = adapters[record.protocol];
      const validation = adapter.validate(record);
      if (!validation.capture_complete || !validation.protocol_valid || !validation.http_success || !validation.model_complete) throw new Error(validation.errors[0] || validation.warnings[0] || "incomplete_capture");
      const turn = adapter.convert(record);
      if (!turn.answer.length || turn.answer.some(m => m.role !== "assistant") || !turn.answer.some(m => m.content || m.reasoning_content || m.tool_calls?.length)) throw new Error("missing_assistant_target");
      // Check option applicability before altering a chain.
      transformMessages([...turn.history, ...turn.answer], options);
      const session = Object.entries(record.request.headers).find(([name]) => ["session_id", "session-id", "x-codex-session-id", "codex-session-id", "x-claude-code-session-id", "x-session-id"].includes(name.toLowerCase()))?.[1] || record.request.body?.metadata?.session_id || record.request.body?.session_id || null;
      const partition = key([record.run_id, record.protocol, session]);
      const toolsKey = key(turn.tools);
      const model = record.request.body.model;
      const markers = new Set(turn.history.map(m => String(m.content)).filter(t => /^<summary\b[\s\S]*<\/summary>$/i.test(t.trim()) || /<conversation_summary>|conversation (?:has been|was) compacted|summary of the conversation so far|this session is being continued from a previous conversation/i.test(t)));
      const siblings = chains.filter(c => c.partition === partition);
      const newCompaction = [...markers].some(marker => !siblings.some(c => c.markers.has(marker)));
      const candidates = siblings.filter(c => c.model === model && c.toolsKey === toolsKey && c.history.length <= turn.history.length && c.history.every((m, i) => key(m) === key(turn.history[i])));
      const longest = Math.max(-1, ...candidates.map(c => c.history.length));
      const best = candidates.filter(c => c.history.length === longest);
      let chain = !newCompaction && best.length === 1 ? best[0] : undefined;
      const reason = chain ? "continued" : newCompaction ? "compaction" : best.length > 1 ? "ambiguous_history" : !siblings.length ? "initial" : siblings.some(c => c.toolsKey !== toolsKey) ? "tools_changed" : "divergent_history";
      if (!chain) {
        chain = { partition, history: [], toolsKey, model, messages: [], tools: turn.tools, markers,
          metadata: { chain_id: `chain-${chains.length}`, run_id: record.run_id, protocol: record.protocol, session_id: session, segment_reason: reason, rounds: [], response_sources: [], reasoning_metadata: [] } };
        chains.push(chain);
      }
      const addition = turn.history.slice(chain.history.length);
      chain.messages.push(...addition.map(m => ({ ...m, trainable: false })), ...turn.answer.map(m => ({ ...m, trainable: true })));
      chain.history = [...turn.history, ...turn.answer];
      markers.forEach(marker => chain!.markers.add(marker));
      chain.metadata.rounds.push({ ...source, model, usage: turn.usage });
      chain.metadata.response_sources.push(source);
      chain.metadata.reasoning_metadata.push(...turn.reasoning_metadata.map(item => ({ ...item, source })));
      diagnostics.push({ ...source, status: "assigned", chain_id: chain.metadata.chain_id, reason });
    } catch (error) { diagnostics.push({ ...source, status: "skipped", reason: (error as Error).message }); }
  }
  const exported = chains.map(chain => ({ messages: transformMessages(chain.messages, options), tools: chain.tools, metadata: chain.metadata }));
  fs.writeFileSync(output, exported.map(value => JSON.stringify(value)).join("\n") + (exported.length ? "\n" : ""), { flag: "wx" });
  const report = { counts: { trajectories: exported.length, assigned: diagnostics.filter(d => d.status === "assigned").length, skipped: diagnostics.filter(d => d.status === "skipped").length }, requests: diagnostics };
  writeJson(diagnosticsPath, report); return report;
}
