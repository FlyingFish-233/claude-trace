/** @file viewer-model.test.ts @description Trace/train timeline adapter behavior. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProcessedPair, SimpleConversation } from "../src/report/shared-conversation-processor";
import type { TrainTrajectory } from "../src/types";
import { contextAnchorId, conversationAnchorId, stepAnchorId, traceToViewerConversation, trainToViewerConversation } from "../frontend/src/utils/viewer-model";
import { extractCodexContextSections, extractTaggedBlocks } from "../frontend/src/utils/context-sections";

const response = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const pair = (id: string, messages: unknown[], reply: string): ProcessedPair => ({
	id, model: "model-a", timestamp: "2026-10-27T00:00:00.000Z", isStreaming: false,
	request: { model: "model-a", messages, tools: [{ name: "Read", input_schema: { type: "object" } }] },
	response: response(reply),
}) as unknown as ProcessedPair;

test("conversation outline anchors are stable for trace and train sections", () => {
	assert.equal(conversationAnchorId("trace/one"), "trace-conversation-trace-one");
	assert.equal(contextAnchorId("trace/one", 2), "trace-context-trace-one-2");
	assert.equal(stepAnchorId("train-0-3"), "trace-step-train-0-3");
});

test("trace adapter preserves the initial, next-input and final-response timeline", () => {
	const first = pair("first", [{ role: "system", content: "policy" }, { role: "user", content: "task" }], "tool call");
	const second = pair("second", [{ role: "user", content: "task" },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "done" }] }], "answer");
	const conversation = {
		id: "conversation-1", models: new Set(["model-a"]), system: "top policy", messages: [],
		response: second.response, finalPair: second, allPairs: [first, second], compacted: true,
		metadata: { startTime: first.timestamp, endTime: second.timestamp, totalPairs: 2,
			inputTokens: 10, outputTokens: 6, lastTurnInputTokens: 10, lastTurnOutputTokens: 4, sessionOutputTokens: 6 },
	} as unknown as SimpleConversation;
	const view = traceToViewerConversation(conversation, new Set(["first", "second"]));
	assert.equal(view.compacted, true);
	assert.deepEqual(view.context.map((item) => item.kind), ["system", "message", "tools"]);
	assert.deepEqual(view.steps.map((step) => step.items.map((item) => item.label)), [
		["User message"], ["Thinking / message / tool call", "Tool result"], ["Final response"],
	]);
	assert.deepEqual(view.steps.map((step) => step.trainable), [false, false, false]);
	assert.equal(view.steps[2].id, "final-response-conversation-1");
	assert.equal(traceToViewerConversation(conversation, new Set(["first"])).steps.length, 2);
});

test("train adapter reuses steps while retaining tool data and step-only trainability", () => {
	const trajectory: TrainTrajectory = {
		source: { file: "/tmp/train.jsonl", line: 2 },
		metadata: { chain_id: "chain-1", segment_reason: "tools_changed", rounds: [
			{ model: "model-b", usage: { input_tokens: 12, output_tokens: 3 } }, { model: "model-b" },
		] },
		tools: [{ type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object" } } }],
		messages: [
			{ role: "system", content: "policy", trainable: false },
			{ role: "developer", content: "guidance", trainable: false },
			{ role: "user", content: "task", trainable: false },
			{ role: "assistant", reasoning_content: "think", tool_calls: [{ id: "call-1", function: { name: "Read", arguments: "{broken" } }], trainable: true },
			{ role: "tool", tool_call_id: "call-1", content: "file data", trainable: false },
			{ role: "assistant", content: "answer", trainable: false },
		],
	};
	const view = trainToViewerConversation(trajectory, 4);
	assert.deepEqual(view.context.map((item) => item.label), ["System message 1", "Developer message 2", "Tools"]);
	assert.deepEqual(view.steps.map((step) => step.trainable), [false, true, false]);
	assert.deepEqual(view.steps.map((step) => step.items.map((item) => item.label)), [
		["User message"], ["Thinking / message / tool call", "Tool result"], ["Final response"],
	]);
	assert.equal(view.steps[1].meta, "model-b · input 12 / output 3");
	const assistant = view.steps[1].items[0];
	assert.equal(assistant.kind, "response");
	if (assistant.kind === "response") assert.equal((assistant.response.content[1] as any).input, "{broken");
	const tools = view.context[2];
	assert.equal(tools.kind, "tools");
	if (tools.kind === "tools") assert.equal((tools.tools[0] as any).name, "Read");
});

test("train adapter tolerates missing rounds and assistant turns", () => {
	const view = trainToViewerConversation({ source: { file: "x", line: 1 }, messages: [{ role: "user", content: "only input" }] }, 0);
	assert.equal(view.steps.length, 1);
	assert.equal(view.steps[0].trainable, false);
	assert.equal(view.title, "Training trajectory · Training trajectory");
});

test("Codex context extraction retains nested examples and both tag spellings", () => {
	const codex = extractCodexContextSections("<environment_context>outer `<environment_context>example</environment_context>` tail</environment_context> task");
	assert.equal(codex.sections[0].blocks[0], "outer `<environment_context>example</environment_context>` tail");
	assert.equal(codex.remaining, "task");
	const reminder = extractTaggedBlocks("start &lt;system-reminder&gt;policy&lt;/system-reminder&gt; end", "system-reminder");
	assert.deepEqual(reminder.blocks, ["policy"]);
	assert.equal(reminder.remaining, "start  end");
});
