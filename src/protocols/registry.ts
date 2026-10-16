/** @file registry.ts @description Three wire adapters with strict completion checks and loss-aware text conversion. */
import { PROTOCOLS, Protocol, ProtocolAdapter, TraceRecord, Json, ConvertedTurn, ValidationResult } from "./types";

/** Require structured JSON rather than silently coercing broken wire data. */
export function object(value: any, name = "object"): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${name}`);
  return value;
}

/** Detect per request, using explicit annotation followed by endpoint and body shape. */
export function detectProtocol(url: string, body?: any): Protocol | "unknown" {
  let pathname = "";
  try { pathname = new URL(url).pathname.replace(/\/+$/, ""); } catch { return "unknown"; }
  if (pathname.endsWith("/chat/completions")) return "openai-chat-completions";
  if (pathname.endsWith("/responses")) return "openai-responses";
  if (pathname.endsWith("/messages")) return "anthropic-messages";
  if (body && (body.input !== undefined || body.output !== undefined)) return "openai-responses";
  if (body?.choices || body?.messages?.some((m: any) => m.role === "tool" || m.tool_calls)) return "openai-chat-completions";
  return "unknown";
}

/** Parse complete SSE frames, including multiline data, without inventing arrival timestamps. */
export function parseSSE(raw: string): { events: Json[]; done: boolean } {
  const events: Json[] = [];
  let done = false;
  for (const frame of raw.replace(/\r\n/g, "\n").split("\n\n")) {
    const lines = frame.split("\n");
    const data = lines.filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    if (data.trim() === "[DONE]") { done = true; continue; }
    let parsed: Json;
    try { parsed = object(JSON.parse(data), "sse_data"); } catch { throw new Error("invalid_sse_json"); }
    const event = lines.find(l => l.startsWith("event:"))?.slice(6).trim();
    events.push(event && !parsed.type ? { ...parsed, type: event } : parsed);
  }
  return { events, done };
}

/** Join only supported text blocks; unsupported modalities must remain raw, not become fake text. */
function text(value: any, separator = ""): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error("invalid_text_content");
  return value.map(part => {
    if (typeof part === "string") return part;
    if (!["text", "input_text", "output_text"].includes(part?.type) || typeof part.text !== "string") throw new Error(`unsupported_content_${part?.type}`);
    return part.text;
  }).filter(part => part !== "").join(separator);
}

/** Remove billing attribution from derived system text; captured bodies remain untouched. */
function systemText(value: any, protocol: Protocol): string {
  const parts = Array.isArray(value) ? value : [value];
  return parts.map(part => {
    const content = text(part == null || typeof part === "string" ? part : [part]);
    if (!content.startsWith("x-anthropic-billing-header")) return content;
    return protocol === "anthropic-messages" ? "" : content.split("\n").slice(1).join("\n");
  }).filter(Boolean).join(protocol === "anthropic-messages" ? "" : "\n");
}

/** Parse tool arguments as JSON objects, retaining the original string only in raw storage. */
function argumentsObject(value: any): Json {
  try { return object(typeof value === "string" ? JSON.parse(value) : value, "tool_arguments"); }
  catch { throw new Error("invalid_tool_arguments"); }
}

/** Normalize OpenAI function schemas, including Responses namespaces. */
function tools(value: any, protocol: Protocol): Json[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("invalid_tools");
  const result = value.flatMap((entry: Json) => {
    if (protocol === "anthropic-messages") {
      if (entry.type && entry.type !== "custom") throw new Error(`unsupported_tool_${entry.type}`);
      if (typeof entry.name !== "string") throw new Error("invalid_tool_name");
      return [{ type: "function", function: { name: entry.name, description: entry.description || "", parameters: entry.input_schema || {} } }];
    }
    const members = entry.type === "namespace" ? entry.tools : [entry];
    if (!Array.isArray(members)) throw new Error("invalid_tool_namespace");
    return members.map((member: Json) => {
      if (member.type !== "function") throw new Error(`unsupported_tool_${member.type}`);
      const fn = protocol === "openai-chat-completions" ? object(member.function) : member;
      if (typeof fn.name !== "string") throw new Error("invalid_tool_name");
      const { type: _type, ...definition } = fn;
      if (protocol === "openai-responses") {
        const { name, description, parameters, strict, defer_loading, ...extensions } = definition;
        return { type: "function", function: {
          name: entry.type === "namespace" ? `${entry.name}__${name}` : name,
          description: description ?? null, parameters: parameters ?? null,
          ...(strict != null ? { strict } : {}), ...(defer_loading != null ? { defer_loading } : {}), ...extensions,
        } };
      }
      return { type: "function", function: { ...definition, name: entry.type === "namespace" ? `${entry.name}__${fn.name}` : fn.name } };
    });
  });
  if (new Set(result.map(t => t.function.name)).size !== result.length) throw new Error("duplicate_tool_name");
  return result;
}

/** Normalize ordinary chat messages while keeping developer-specific fields. */
function chatMessage(value: any): Json {
  const message = object(value, "message");
  if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) throw new Error(`unsupported_role_${message.role}`);
  const result: Json = { role: message.role, content: message.role === "system" ? systemText(message.content, "openai-chat-completions") : text(message.content, "\n") };
  for (const key of ["name", "task", "tools", "tool_call_id", "reasoning_content"]) if (message[key] !== undefined) result[key] = message[key];
  if (message.reasoning !== undefined) {
    if (typeof message.reasoning !== "string") throw new Error("unsupported_reasoning_structure");
    if (result.reasoning_content !== undefined && result.reasoning_content !== message.reasoning) throw new Error("unsupported_conflicting_reasoning_fields");
    result.reasoning_content = message.reasoning;
  }
  if (message.role === "developer") {
    for (const [key, value] of Object.entries(message)) {
      if (!["type", "id", "status", "role", "content"].includes(key)) result[key] = value;
    }
  }
  if (message.function_call) throw new Error("unsupported_legacy_function_call");
  if (message.tool_calls) {
    if (!Array.isArray(message.tool_calls)) throw new Error("invalid_tool_calls");
    const calls = message.tool_calls.map((call: Json) => {
      if (call.type !== "function" || !call.id || !call.function?.name) throw new Error("invalid_tool_call");
      return { id: call.id, type: "function", function: { name: call.function.name, arguments: argumentsObject(call.function.arguments) } };
    });
    if (calls.length) result.tool_calls = calls;
  }
  if (message.role === "tool" && !message.tool_call_id) throw new Error("missing_tool_call_id");
  return result;
}

/** Preserve Anthropic user/tool-result order and separate thinking from visible text. */
function anthropicMessage(message: Json): Json[] {
  if (message.role === "system") {
    const content = systemText(message.content, "anthropic-messages");
    return content ? [{ role: "system", content }] : [];
  }
  if (typeof message.content === "string") return [chatMessage(message)];
  if (!Array.isArray(message.content)) throw new Error("invalid_message_content");
  if (["system", "developer"].includes(message.role)) return [chatMessage(message)];
  if (message.role === "assistant") {
    const result: Json = { role: "assistant", content: "" };
    for (const block of message.content) {
      if (block.type === "text") result.content += text(block.text);
      else if (block.type === "thinking") result.reasoning_content = (result.reasoning_content || "") + text(block.thinking);
      else if (block.type === "tool_use") {
        if (!block.id || !block.name) throw new Error("invalid_tool_call");
        (result.tool_calls ||= []).push({ id: block.id, type: "function", function: { name: block.name, arguments: argumentsObject(block.input) } });
      } else throw new Error(`unsupported_assistant_block_${block.type}`);
    }
    return [result];
  }
  if (message.role !== "user") throw new Error(`unsupported_role_${message.role}`);
  const result: Json[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      const previous = result[result.length - 1];
      if (previous?.role === "user") previous.content += text(block.text);
      else result.push({ role: "user", content: text(block.text) });
    } else if (block.type === "tool_result") {
      if (!block.tool_use_id) throw new Error("missing_tool_call_id");
      result.push({ role: "tool", tool_call_id: block.tool_use_id, content: text(block.content), ...(block.is_error ? { is_error: true } : {}) });
    } else throw new Error(`unsupported_user_block_${block.type}`);
  }
  return result;
}

/** Convert Responses items; summaries and encrypted reasoning are provenance, never full thinking. */
function responseItems(items: any, reasoning: Json[]): Json[] {
  if (!Array.isArray(items)) throw new Error("invalid_responses_items");
  const result: Json[] = [];
  for (const raw of items) {
    const item = object(raw);
    if (["incomplete", "in_progress"].includes(item.status)) throw new Error("partial_response_item");
    let assistant = result[result.length - 1];
    if (assistant?.role !== "assistant") assistant = undefined as any;
    if (item.type === "function_call") {
      if (!item.call_id || !item.name) throw new Error("invalid_tool_call");
      if (!assistant) result.push(assistant = { role: "assistant", content: "" });
      (assistant.tool_calls ||= []).push({ id: item.call_id, type: "function", function: {
        name: item.namespace ? `${item.namespace}__${item.name}` : item.name, arguments: argumentsObject(item.arguments),
      } });
    } else if (item.type === "function_call_output") {
      if (!item.call_id) throw new Error("missing_tool_call_id");
      result.push({ role: "tool", tool_call_id: item.call_id, content: text(item.output, "\n") });
    } else if (item.type === "reasoning") {
      if (item.summary?.length || item.encrypted_content) reasoning.push({ id: item.id, summary: item.summary, encrypted: Boolean(item.encrypted_content) });
      const full = (item.content || []).map((block: Json) => {
        if (block.type !== "reasoning_text") throw new Error(`unsupported_reasoning_${block.type}`);
        return text(block.text);
      }).join("");
      if (full) {
        if (!assistant) result.push(assistant = { role: "assistant", content: "" });
        assistant.reasoning_content = (assistant.reasoning_content || "") + full;
      }
    } else if (!item.type || item.type === "message") {
      const message = chatMessage(item);
      if (message.role === "assistant" && assistant) assistant.content += message.content;
      else result.push(message);
    } else throw new Error(`unsupported_responses_item_${item.type}`);
  }
  return result;
}

/** Reject state that cannot be reconstructed by a single-request replay/export. */
export function requireSelfContained(body: Json): void {
  for (const field of ["previous_response_id", "conversation", "previous_input_messages"]) {
    if (body[field]) throw new Error(`${field}_requires_server_history`);
  }
}

/** Validate only tool results already in history, allowing final outstanding calls. */
function checkToolResults(messages: Json[]): void {
  const calls = new Set<string>();
  for (const message of messages) {
    for (const call of message.tool_calls || []) {
      if (calls.has(call.id)) throw new Error("duplicate_pending_tool_call");
      calls.add(call.id);
    }
    if (message.role === "tool") {
      if (!calls.delete(message.tool_call_id)) throw new Error("unmatched_tool_result");
    }
  }
}

/** Reconstruct native JSON from SSE without replacing the captured wire payload. */
function parseResponse(record: TraceRecord, id: Protocol): Json {
  const response = record.response;
  if (!response) throw new Error("missing_response");
  if (response.body !== undefined) return object(response.body, "response");
  const { events, done } = parseSSE(response.body_raw || "");
  const streamError = events.find(e => e.type === "error" || e.error);
  if (streamError) return { error: object(streamError.error || streamError, "stream_error") };
  if (id === "openai-responses") {
    const terminal = events.filter(e => ["response.completed", "response.failed", "response.incomplete"].includes(e.type));
    if (terminal.length !== 1) throw new Error("missing_or_ambiguous_terminal_event");
    const response = { ...object(terminal[0].response, "response") };
    // Some compatible servers send output only in item events and an empty final envelope.
    if (Array.isArray(response.output) && response.output.length === 0) {
      const items = new Map<number, Json>();
      for (const event of events) {
        const index = event.output_index;
        if (event.type === "response.output_item.added") items.set(index, JSON.parse(JSON.stringify(event.item)));
        else if (event.type === "response.output_item.done") items.set(index, event.item);
        else if (event.type === "response.content_part.added") {
          const item = items.get(index); if (item) (item.content ||= [])[event.content_index] = { ...event.part };
        } else if (["response.output_text.delta", "response.reasoning_text.delta"].includes(event.type)) {
          const item = items.get(index);
          if (!item) throw new Error("delta_without_item");
          const content = item.content ||= [];
          const part = content[event.content_index ?? 0] ||= { type: event.type.includes("reasoning_text") ? "reasoning_text" : "output_text", text: "" };
          part.text += event.delta;
        } else if (event.type === "response.function_call_arguments.delta") {
          const item = items.get(index); if (!item) throw new Error("delta_without_item");
          item.arguments = (item.arguments || "") + event.delta;
        }
      }
      response.output = [...items.entries()].sort((a,b)=>a[0]-b[0]).map(([,item])=>item);
    }
    return response;
  }
  if (id === "anthropic-messages") {
    const start = events.filter(e => e.type === "message_start");
    if (start.length !== 1 || events.filter(e => e.type === "message_stop").length !== 1) throw new Error("missing_or_ambiguous_terminal_event");
    const result: Json = { ...object(start[0].message), content: [], usage: { ...start[0].message.usage } };
    const active = new Map<number, Json>();
    const argumentsByIndex = new Map<number, string>();
    for (const event of events) {
      if (event.type === "content_block_start") {
        if (result.content[event.index]) throw new Error("duplicate_content_block");
        const block = { ...object(event.content_block) };
        result.content[event.index] = block; active.set(event.index, block);
      } else if (event.type === "content_block_delta") {
        const block = active.get(event.index);
        if (!block) throw new Error("delta_without_block");
        const delta = object(event.delta);
        if (delta.type === "input_json_delta") argumentsByIndex.set(event.index, (argumentsByIndex.get(event.index) || "") + delta.partial_json);
        else {
          const field = ({ text_delta: "text", thinking_delta: "thinking", signature_delta: "signature" } as Json)[delta.type];
          if (!field) throw new Error(`unsupported_delta_${delta.type}`);
          block[field] = (block[field] || "") + delta[field];
        }
      } else if (event.type === "content_block_stop") {
        const block = active.get(event.index);
        if (!block) throw new Error("stop_without_block");
        if (argumentsByIndex.has(event.index)) block.input = argumentsObject(argumentsByIndex.get(event.index));
        active.delete(event.index);
      } else if (event.type === "message_delta") {
        Object.assign(result, event.delta); Object.assign(result.usage, event.usage);
      }
    }
    if (active.size) throw new Error("unclosed_content_block");
    return result;
  }
  if (!done) throw new Error("missing_done_marker");
  const result: Json = { choices: [], usage: {} };
  const choices = new Map<number, Json>();
  for (const event of events) {
    if (!Array.isArray(event.choices)) throw new Error("invalid_chat_chunk");
    if (event.usage) result.usage = event.usage;
    for (const choice of event.choices) {
      const index = choice.index ?? 0;
      let accumulated = choices.get(index);
      if (!accumulated) choices.set(index, accumulated = { index, message: { role: "assistant", content: "", tool_calls: [] }, finish_reason: null });
      if (choice.finish_reason) accumulated.finish_reason = choice.finish_reason;
      const delta = choice.delta || {};
      for (const field of ["content", "reasoning_content", "reasoning"]) if (typeof delta[field] === "string") accumulated.message[field] = (accumulated.message[field] || "") + delta[field];
      for (const call of delta.tool_calls || []) {
        const slot = call.index ?? 0;
        const calls = accumulated.message.tool_calls;
        calls[slot] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (call.id) calls[slot].id = call.id;
        if (call.type) calls[slot].type = call.type;
        if (call.function?.name) calls[slot].function.name += call.function.name;
        if (call.function?.arguments) calls[slot].function.arguments += call.function.arguments;
      }
    }
  }
  result.choices = [...choices.values()].sort((a, b) => a.index - b.index);
  return result;
}

/** Normalize a request/response without applying export policy. */
function convert(record: TraceRecord, id: Protocol): ConvertedTurn {
  const body = object(record.request.body, "request");
  const response = parseResponse(record, id);
  const metadata: Json[] = [];
  let history: Json[], answer: Json[];
  if (id === "openai-responses") {
    requireSelfContained(body);
    history = typeof body.input === "string" ? [{ role: "user", content: body.input }] : responseItems(body.input, metadata);
    const instructions = systemText(body.instructions, id);
    if (instructions) history.unshift({ role: "system", content: instructions });
    answer = responseItems(response.output, metadata);
  } else {
    if (!Array.isArray(body.messages)) throw new Error("invalid_messages");
    if (id === "anthropic-messages") {
      history = body.messages.flatMap(anthropicMessage);
      const system = systemText(body.system, id);
      if (system) history.unshift({ role: "system", content: system });
      answer = anthropicMessage(response);
    } else {
      history = body.messages.map(chatMessage);
      if (!Array.isArray(response.choices) || response.choices.length !== 1) throw new Error("unsupported_choice_count");
      answer = [chatMessage(response.choices[0].message)];
    }
  }
  checkToolResults(history);
  return { history, answer, tools: tools(body.tools, id), usage: response.usage || {}, reasoning_metadata: metadata };
}

/** Separate wire validity from model success and text-export support. */
function validate(record: TraceRecord, id: Protocol): ValidationResult {
  const explicitConnectionError = record.status === "error" && !record.response && !!record.error && record.error.code !== "route_error";
  const result: ValidationResult = { capture_complete: (record.status === "complete" && !!record.response) || explicitConnectionError, protocol_valid: true,
    http_success: !!record.response && record.response.status_code >= 200 && record.response.status_code < 300,
    model_complete: false, errors: [], warnings: [] };
  try {
    const request = object(record.request.body, "request");
    if (typeof request.model !== "string" || !request.model) throw new Error("missing_model");
    if (id === "openai-responses") {
      if (request.input === undefined && !request.previous_response_id && !request.conversation) throw new Error("missing_input");
    } else if (!Array.isArray(request.messages)) throw new Error("invalid_messages");
    if (!record.response) {
      if (explicitConnectionError) { result.warnings.push(`transport_${record.error!.code}`); return result; }
      throw new Error("missing_response");
    }
    if (!result.http_success) { result.warnings.push(`http_${record.response.status_code}`); return result; }
    const response = parseResponse(record, id);
    if (response.error) { result.warnings.push("model_error"); return result; }
    if (id === "openai-responses") {
      if (!["completed", "failed", "incomplete"].includes(response.status) || !Array.isArray(response.output)) throw new Error("invalid_response_status_or_output");
      result.model_complete = response.status === "completed";
    } else if (id === "anthropic-messages") {
      if (response.role !== "assistant" || !Array.isArray(response.content) || !response.stop_reason) throw new Error("invalid_message_response");
      result.model_complete = ["end_turn", "tool_use", "stop_sequence"].includes(response.stop_reason);
    } else {
      if (!Array.isArray(response.choices) || !response.choices.length || response.choices.some((c: Json) => !c.finish_reason || !c.message)) throw new Error("invalid_chat_choices");
      result.model_complete = response.choices.every((c: Json) => ["stop", "tool_calls"].includes(c.finish_reason));
    }
    if (!result.model_complete) result.warnings.push("model_not_complete");
    try { convert(record, id); } catch (error) {
      const reason = (error as Error).message;
      if (reason.startsWith("unsupported_") || reason.includes("requires_server_history") || (!result.model_complete && ["partial_response_item", "invalid_tool_arguments"].includes(reason))) result.warnings.push(reason);
      else throw error;
    }
  } catch (error) { result.protocol_valid = false; result.errors.push((error as Error).message); }
  return result;
}

/** Registry entries keep protocol behavior independent of client names. */
export const adapters: Record<Protocol, ProtocolAdapter> = Object.fromEntries(PROTOCOLS.map(id => [id, {
  id, operation: id === "anthropic-messages" ? "messages" : id === "openai-responses" ? "responses" : "chat/completions",
  parseResponse: (record: TraceRecord) => parseResponse(record, id),
  validate: (record: TraceRecord) => validate(record, id),
  convert: (record: TraceRecord) => convert(record, id),
  replay(body: Json, options: { model?: string; maxTokens?: number; stream: "preserve" | "on" | "off" }): Json {
    object(body, "request");
    if (id === "openai-responses") requireSelfContained(body);
    const output = { ...body };
    if (options.model) output.model = options.model;
    if (options.stream !== "preserve") output.stream = options.stream === "on";
    if (options.maxTokens !== undefined) {
      const field = id === "openai-responses" ? "max_output_tokens" : id === "openai-chat-completions" && "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens";
      delete output.max_tokens; delete output.max_completion_tokens; delete output.max_output_tokens;
      output[field] = options.maxTokens;
    }
    return output;
  },
}])) as Record<Protocol, ProtocolAdapter>;
