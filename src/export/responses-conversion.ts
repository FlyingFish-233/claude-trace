/**
 * @file responses-conversion.ts
 * @description Converts text Responses items into template-ready chat messages, following
 * vLLM's non-Harmony construct_input_messages, construct_tool_dicts and chat preprocessing.
 * Unsupported or encrypted content is rejected rather than silently used as training text.
 */
/** Optional system transformations for Responses exports; all default to false. */
export interface ExportCodexOpenAIOptions {
	/** Convert developer to system in place, removing developer-only tools. */
	convertDeveloperToSystem?: boolean;
	/** Keep only the first system after developer conversion, including instructions. */
	filterSystemMessages?: boolean;
	/** Hoist systems after developer conversion, joined by two newlines. */
	mergeSystemMessages?: boolean;
}

export function validateCodexExportOptions(options: ExportCodexOpenAIOptions): void {
	if ((options.filterSystemMessages || options.mergeSystemMessages) && !options.convertDeveloperToSystem) {
		throw new Error("--filter-system-messages and --merge-system-messages require --convert-developer-to-system");
	}
}

/** JSON object at the Responses wire boundary; fields are validated before use. */
export type ResponseObject = Record<string, unknown>;

/** Template-ready messages and function tools; no training provenance is added here. */
export interface ConvertedResponsesRequest {
	messages: ResponseObject[];
	tools: ResponseObject[];
}

/** Require an object rather than coercing malformed protocol data. */
export function responseObject(value: unknown): ResponseObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_responses_object");
	return value as ResponseObject;
}

function string(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`invalid_${field}`);
	return value;
}

/** vLLM's string-content path joins text blocks with newlines, not concatenation. */
function content(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) throw new Error("invalid_responses_content");
	return value.map((block) => {
		if (typeof block === "string") return block;
		const part = responseObject(block);
		if (!["text", "input_text", "output_text"].includes(String(part.type))) {
			throw new Error(`unsupported_content_${part.type}`);
		}
		return string(part.text, "text");
	}).filter((text) => text !== "").join("\n");
}

/** Strip the billing line in system content, as vLLM's chat preprocessing does. */
function systemContent(value: unknown): string {
	const parts = Array.isArray(value) ? value : [value];
	return parts.map((part) => content(part == null || typeof part === "string" ? part : [part]))
		.map((text) => text.startsWith("x-anthropic-billing-header") ? text.split("\n").slice(1).join("\n") : text)
		.filter((text) => text !== "").join("\n");
}

/** Convert response items, merging reasoning/text/calls only within the supplied item list. */
export function convertResponsesItems(items: unknown): ResponseObject[] {
	if (!Array.isArray(items)) throw new Error("invalid_responses_items");
	const messages: ResponseObject[] = [];
	for (const value of items) {
		const item = responseObject(value);
		const previous = messages[messages.length - 1];
		const assistant = previous?.role === "assistant" ? previous : undefined;
		const type = item.type ?? "message";
		if (item.status === "in_progress" || item.status === "incomplete") throw new Error("partial_input_item");
		if (type === "function_call") {
			const name = string(item.name, "function_name");
			const argumentsText = string(item.arguments, "function_arguments");
			let args: ResponseObject;
			try { args = argumentsText ? responseObject(JSON.parse(argumentsText)) : {}; }
			catch { throw new Error("invalid_function_arguments_json"); }
			const call = { id: string(item.call_id, "call_id"), type: "function", function: {
				name: item.namespace ? `${string(item.namespace, "namespace")}__${name}` : name, arguments: args,
			} };
			if (assistant) assistant.tool_calls = [...(assistant.tool_calls as unknown[] || []), call];
			else messages.push({ role: "assistant", tool_calls: [call] });
		} else if (type === "reasoning") {
			if (item.encrypted_content) throw new Error("encrypted_reasoning_not_supported");
			const blocks = Array.isArray(item.content) && item.content.length ? item.content : item.summary;
			if (Array.isArray(blocks) && blocks.length > 1) throw new Error("multiple_reasoning_blocks_not_supported");
			const reasoning = Array.isArray(blocks) && blocks.length ? string(responseObject(blocks[0]).text, "reasoning_text") : "";
			if (assistant && assistant.reasoning == null) assistant.reasoning = reasoning;
			else messages.push({ role: "assistant", reasoning });
		} else if (type === "function_call_output") {
			messages.push({ role: "tool", tool_call_id: string(item.call_id, "call_id"), content: content(item.output) });
		} else if (type === "message") {
			const role = string(item.role, "role");
			if (!["system", "developer", "user", "assistant"].includes(role)) throw new Error(`unsupported_role_${role}`);
			if (role === "assistant") {
				// vLLM takes only the first assistant content block. Reject lossy cases.
				if (Array.isArray(item.content) && item.content.length > 1) throw new Error("multiple_assistant_blocks_not_supported");
				const text = content(item.content);
				if (assistant && assistant.content == null) assistant.content = text;
				else messages.push({ role, content: text });
			} else messages.push({ role, content: role === "system" ? systemContent(item.content) : content(item.content),
				...(role === "developer" ? { tools: item.tools ?? null } : {}),
				...(typeof item.name === "string" ? { name: item.name } : {}),
				...(typeof item.task === "string" ? { task: item.task } : {}),
			});
		} else throw new Error(`unsupported_responses_item_${type}`);
	}
	return messages.map((message) => ({ ...message, content: message.content ?? "",
		...(message.reasoning != null ? { reasoning_content: message.reasoning } : {}) }));
}

/** Flatten function namespaces with vLLM's double-underscore separator. */
function tools(value: unknown): ResponseObject[] {
	if (value == null) return [];
	if (!Array.isArray(value)) throw new Error("invalid_responses_tools");
	const output: ResponseObject[] = [];
	for (const raw of value) {
		const tool = responseObject(raw);
		const children = tool.type === "namespace" ? tool.tools : [tool];
		if (!Array.isArray(children)) throw new Error("invalid_namespace_tools");
		for (const child of children) {
			const fn = responseObject(child);
			if (fn.type !== "function") throw new Error(`unsupported_responses_tool_${fn.type}`);
			const name = string(fn.name, "function_name");
			output.push({ type: "function", function: {
				name: tool.type === "namespace" ? `${string(tool.name, "namespace")}__${name}` : name,
				description: fn.description ?? null, parameters: fn.parameters ?? null,
				...(fn.strict != null ? { strict: fn.strict } : {}),
				...(fn.defer_loading != null ? { defer_loading: fn.defer_loading } : {}),
			} });
		}
	}
	const names = output.map((tool) => responseObject(tool.function).name);
	if (new Set(names).size !== names.length) throw new Error("duplicate_flattened_tool_name");
	return output;
}

/**
 * Convert a self-contained text Responses request for an ordinary chat template (not Harmony).
 * Instructions are prepended first. Optional developer conversion retains position;
 * filtering then keeps the first system, before optional consolidation with two newlines.
 * @throws On stateful history, partial inputs, unsupported modalities/tools, or invalid JSON arguments.
 */
export function convertResponsesRequest(body: ResponseObject, options: ExportCodexOpenAIOptions = {}): ConvertedResponsesRequest {
	validateCodexExportOptions(options);
	if (body.previous_response_id) throw new Error("previous_response_id_requires_server_history");
	if (body.previous_input_messages) throw new Error("previous_input_messages_not_supported");
	if (body.conversation) throw new Error("conversation_requires_server_history");
	const instructions = body.instructions == null ? "" : string(body.instructions, "instructions");
	let messages: ResponseObject[] = typeof body.input === "string" ? [{ role: "user", content: body.input }]
		: convertResponsesItems(body.input);
	const leading = instructions ? systemContent(instructions) : "";
	if (leading) messages.unshift({ role: "system", content: leading });
	if (options.convertDeveloperToSystem) {
		messages = messages.map((message) => {
			if (message.role !== "developer") return message;
			const { tools: _tools, ...rest } = message;
			return { ...rest, role: "system" };
		});
	}
	if (options.filterSystemMessages) {
		let seen = false;
		messages = messages.filter((message) => message.role !== "system" || (!seen && (seen = true)));
	}
	if (options.mergeSystemMessages) {
		const systems = messages.filter((message) => message.role === "system");
		const merged = systems.map((message) => String(message.content)).filter(Boolean).join("\n\n");
		messages = [...(systems.length ? [{ role: "system", content: merged }] : []), ...messages.filter((message) => message.role !== "system")];
	}
	return { messages, tools: tools(body.tools) };
}
