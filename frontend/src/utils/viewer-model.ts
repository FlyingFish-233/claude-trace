/** @file Pure trace/train adapters for the shared conversation viewer. */
import type { ContentBlockParam, Message, TextBlockParam, ToolUnion } from "@anthropic-ai/sdk/resources/messages";
import type { ProcessedPair, SimpleConversation } from "../../../src/report/shared-conversation-processor";
import type { TrainMessage, TrainTrajectory } from "../../../src/types";

export type ViewerItem = {
	label: string;
	roleClass: string;
	raw: unknown;
	showContextBlocks?: boolean;
} & (
	| { kind: "response"; response: Message }
	| { kind: "content"; content: string | ContentBlockParam[] }
);

export type ViewerContext =
	| { kind: "system"; label: string; system: string | TextBlockParam[]; raw: unknown }
	| { kind: "message"; label: string; content: string | ContentBlockParam[]; raw: unknown }
	| { kind: "tools"; label: string; tools: ToolUnion[]; raw: unknown };

export interface ViewerStep {
	id: string;
	number: number;
	meta: string;
	trainable: boolean;
	items: ViewerItem[];
}

export interface ViewerConversation {
	id: string;
	title: string;
	subtitle: string;
	compacted: boolean;
	context: ViewerContext[];
	steps: ViewerStep[];
}

function anchorPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Stable anchors shared by the sidebar and conversation renderer. */
export function conversationAnchorId(id: string): string { return `trace-conversation-${anchorPart(id)}`; }
export function contextAnchorId(id: string, index: number): string { return `trace-context-${anchorPart(id)}-${index}`; }
export function stepAnchorId(id: string): string { return `trace-step-${anchorPart(id)}`; }

function traceItem(label: string, roleClass: string, raw: unknown, content: string | ContentBlockParam[], showContextBlocks = true): ViewerItem {
	return { kind: "content", label, roleClass, raw, content, showContextBlocks };
}

function requestMessages(pair: ProcessedPair, first: boolean): Array<{ role: string; content: string | ContentBlockParam[] }> {
	const messages = (pair.request.messages || []) as Array<{ role: string; content: string | ContentBlockParam[] }>;
	const visible = messages.filter((message) => message.role !== "system");
	if (first) return visible;
	for (let index = visible.length - 1; index >= 0; index--) {
		if (visible[index].role === "user") return [visible[index]];
	}
	return visible.length ? [visible[visible.length - 1]] : [];
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const value = count / 1_000_000;
		return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (count >= 10_000) {
		const value = count / 1000;
		return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, "")}k`;
	}
	return count.toLocaleString();
}

function traceSubtitle(conversation: SimpleConversation): string {
	const metadata = conversation.metadata;
	const parts = [`${new Date(metadata.startTime).toLocaleString()}`, `${conversation.messages.length + 1} messages`];
	if (conversation.apiFormatDisplay) parts.push(conversation.apiFormatDisplay);
	const lastIn = metadata.lastTurnInputTokens ?? metadata.inputTokens ?? 0;
	const sessionOut = metadata.sessionOutputTokens ?? metadata.outputTokens ?? 0;
	if (lastIn || sessionOut) {
		parts.push(`↑${formatTokenCount(lastIn)} in`);
		parts.push(`↓${formatTokenCount(sessionOut)} out`);
		if (metadata.totalPairs > 1) parts.push(`${metadata.totalPairs} calls`);
		if ((metadata.cacheReadTokens ?? 0) > 0) parts.push(`cache ${formatTokenCount(metadata.cacheReadTokens!)} read`);
		if ((metadata.cacheCreationTokens ?? 0) > 0) parts.push(`cache ${formatTokenCount(metadata.cacheCreationTokens!)} write`);
	}
	return parts.join(" · ");
}

/** Retains the existing first-input, previous-response and final-response timeline. */
export function traceToViewerConversation(conversation: SimpleConversation, visiblePairIds?: ReadonlySet<string>): ViewerConversation {
	const pairs = conversation.allPairs.filter((pair) => !visiblePairIds || visiblePairIds.has(pair.id));
	const context: ViewerContext[] = [];
	if (conversation.system) context.push({ kind: "system", label: "System message", system: conversation.system, raw: conversation.system });
	const firstRequest = (conversation.allPairs[0]?.request.messages || []) as Array<{ role: string; content: string | ContentBlockParam[] }>;
	firstRequest.filter((message) => message.role === "system").forEach((message, index) =>
		context.push({ kind: "message", label: `System message ${index + 1}`, content: message.content, raw: message }));
	const tools = conversation.finalPair.request.tools || [];
	if (tools.length) context.push({ kind: "tools", label: "Tools", tools: tools as ToolUnion[], raw: tools });
	const steps: ViewerStep[] = [];
	if (pairs.length) {
		const firstUser = requestMessages(pairs[0], true).find((message) => message.role === "user");
		steps.push({ id: pairs[0].id, number: 1, meta: traceMeta(pairs[0]), trainable: false,
			items: firstUser ? [traceItem("User message", "trace-message-user", firstUser, firstUser.content)] : [] });
		for (let index = 1; index < pairs.length; index++) {
			const previous = pairs[index - 1], current = pairs[index];
			const nextMessage = requestMessages(current, false)[0];
			const items: ViewerItem[] = [{ kind: "response", label: "Thinking / message / tool call", roleClass: "trace-message-assistant",
				raw: previous.response, response: previous.response }];
			if (nextMessage) items.push(traceItem(traceMessageLabel(nextMessage), "trace-message-user", nextMessage, nextMessage.content, false));
			steps.push({ id: current.id, number: index + 1, meta: traceMeta(current), trainable: false, items });
		}
		const finalPair = pairs[pairs.length - 1];
		steps.push({ id: `final-response-${conversation.id}`, number: pairs.length + 1, meta: traceMeta(finalPair), trainable: false,
			items: [{ kind: "response", label: "Final response", roleClass: "trace-message-assistant", raw: finalPair.response, response: finalPair.response }] });
	}
	return { id: conversation.id, title: Array.from(conversation.models).join(", "), subtitle: traceSubtitle(conversation),
		compacted: !!conversation.compacted, context, steps };
}

function traceMeta(pair: ProcessedPair): string {
	return `${pair.model} · ${pair.isStreaming ? "streaming" : "non-streaming"} · ${new Date(pair.timestamp).toLocaleString()}`;
}

function traceMessageLabel(message: { role: string; content: string | ContentBlockParam[] }): string {
	if (Array.isArray(message.content) && message.content.length) {
		if (message.content.every((block) => block?.type === "tool_result")) return "Tool result";
		if (message.content.some((block) => block?.type === "tool_use")) return "Tool call";
	}
	return message.role === "user" ? "User message" : `${message.role || "Message"} message`;
}

function trainContent(value: unknown): string | ContentBlockParam[] {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((block) => block && typeof block === "object" && "type" in block)) return value as ContentBlockParam[];
	return value == null ? "" : JSON.stringify(value);
}

function trainAssistantResponse(message: TrainMessage): Message {
	const content: any[] = [];
	if (message.reasoning_content) content.push({ type: "thinking", thinking: String(message.reasoning_content) });
	if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
	else if (Array.isArray(message.content) && message.content.every((block) => block && typeof block === "object" && "type" in block)) content.push(...message.content);
	else if (message.content) content.push({ type: "text", text: JSON.stringify(message.content) });
	for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
		let input = call.function?.arguments;
		if (typeof input === "string") {
			try { input = JSON.parse(input); } catch { /* Preserve malformed argument text for inspection. */ }
		}
		content.push({ type: "tool_use", id: call.id || "", name: call.function?.name || "unknown", input });
	}
	return { role: "assistant", content } as unknown as Message;
}

function trainMessageItem(message: TrainMessage): ViewerItem {
	const role = message.role;
	const label = role === "tool" ? "Tool result" : `${role[0]?.toUpperCase() || ""}${role.slice(1)} message`;
	const roleClass = role === "tool" ? "trace-message-tool" : role === "system" || role === "developer" ? "trace-message-system" : "trace-message-user";
	const content = role === "tool"
		? [{ type: "tool_result", tool_use_id: message.tool_call_id || "", content: trainContent(message.content) }] as ContentBlockParam[]
		: trainContent(message.content);
	return { kind: "content", label, roleClass, raw: message, content, showContextBlocks: role !== "tool" };
}

function normalizeTools(tools: unknown[]): ToolUnion[] {
	return tools.map((tool: any) => {
		if (tool === null || typeof tool !== "object") return { name: "Unknown tool", description: String(tool), input_schema: { type: "object", properties: {} } } as ToolUnion;
		if (tool?.name) return tool as ToolUnion;
		if (tool?.function?.name) return { name: tool.function.name, description: tool.function.description,
			input_schema: tool.function.parameters || { type: "object", properties: {} } } as ToolUnion;
		return tool as ToolUnion;
	});
}

/** Groups one exported JSONL line into the same Step contract used by trace. */
export function trainToViewerConversation(trajectory: TrainTrajectory, trajectoryIndex: number): ViewerConversation {
	const leading: TrainMessage[] = [];
	const groups: Array<{ assistant: TrainMessage; following: TrainMessage[] }> = [];
	for (const message of trajectory.messages) {
		if (message.role === "assistant") groups.push({ assistant: message, following: [] });
		else if (groups.length) groups[groups.length - 1].following.push(message);
		else leading.push(message);
	}
	const context: ViewerContext[] = leading.filter((message) => message.role === "system" || message.role === "developer")
		.map((message, index) => ({ kind: "message", label: `${message.role === "developer" ? "Developer" : "System"} message ${index + 1}`,
			content: trainContent(message.content), raw: message }));
	const tools = Array.isArray(trajectory.tools) ? trajectory.tools : [];
	if (tools.length) context.push({ kind: "tools", label: "Tools", tools: normalizeTools(tools), raw: tools });
	const rounds = Array.isArray(trajectory.metadata?.rounds) ? trajectory.metadata.rounds : [];
	const model = rounds[0]?.model || trajectory.metadata?.protocol || "Training trajectory";
	const inputs = leading.filter((message) => message.role !== "system" && message.role !== "developer");
	const steps: ViewerStep[] = [];
	if (inputs.length) steps.push({ id: `train-${trajectoryIndex}-1`, number: 1, meta: String(model), trainable: false, items: inputs.map(trainMessageItem) });
	for (const [index, group] of groups.entries()) {
		const round = rounds[index];
		const usage = round?.usage;
		const meta = `${round?.model || model}${usage ? ` · input ${usage.input_tokens ?? 0} / output ${usage.output_tokens ?? 0}` : ""}`;
		const final = index === groups.length - 1 && !(Array.isArray(group.assistant.tool_calls) ? group.assistant.tool_calls : []).length;
		steps.push({ id: `train-${trajectoryIndex}-${steps.length + 1}`, number: steps.length + 1, meta, trainable: group.assistant.trainable === true,
			items: [{ kind: "response", label: final ? "Final response" : "Thinking / message / tool call", roleClass: "trace-message-assistant",
				raw: group.assistant, response: trainAssistantResponse(group.assistant) }, ...group.following.map(trainMessageItem)] });
	}
	return { id: `train-${trajectoryIndex}`, title: `${model} · ${trajectory.metadata?.chain_id || "Training trajectory"}`,
		subtitle: `${trajectory.metadata?.segment_reason || ""} · ${groups.length} rounds · ${trajectory.messages.length} messages · ${trajectory.source.file}:${trajectory.source.line}`,
		compacted: false, context, steps };
}
