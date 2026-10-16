/**
 * @file export-openai.test.ts
 * @description Tests SFT reconstruction, system placement, history matching and provenance.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { exportOpenAI } from "../src/export/openai";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const answer = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

/** Build a successful Anthropic exchange with overridable request and response fields. */
function pair(timestamp: number, messages: any[], response: any, extra: any = {}): any {
	return {
		request: {
			timestamp, method: "POST", url: "https://api.example/v1/messages", headers: { "x-claude-code-session-id": "shared" },
			body: { model: "test-model", max_tokens: 100, system: "Instructions", tools: [], messages, ...extra.body },
		},
		response: response === null ? null : { timestamp: timestamp + 1, status_code: 200, headers: {}, body: response, ...extra.response },
		logged_at: new Date(timestamp * 1000).toISOString(),
	};
}

/** Create isolated trace directories and remove them after the assertion callback. */
async function fixture(files: Record<string, any[]>, run: (root: string, output: string) => Promise<void>): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-export-"));
	try {
		for (const [folder, records] of Object.entries(files)) {
			const directory = path.join(root, folder);
			fs.mkdirSync(directory, { recursive: true });
			fs.writeFileSync(path.join(directory, "trace.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
		}
		await run(root, path.join(root, "output.jsonl"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function read(output: string): any[] {
	return fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
}

describe("OpenAI trace export", () => {
	it("joins a resumed chain, appends the final response, and deduplicates snapshots", async () => {
		const first = pair(100, [user("task")], answer("one"));
		const second = pair(200, [user("task"), assistant("one"), user("next")], answer("two"));
		await fixture({ first: [first], resume: [first, second] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			const trajectories = read(output);
			assert.equal(trajectories.length, 1);
			assert.equal(diagnostics.counts.assigned, 2);
			assert.equal(diagnostics.counts.duplicate, 1);
			assert.deepEqual(trajectories[0].messages.map((message: any) => message.trainable), [false, false, true, false, true]);
			assert.equal(trajectories[0].messages.at(-1).content, "two");
			assert.equal(trajectories[0].metadata.response_sources.length, 2);
			assert.equal(trajectories[0].metadata.parent_trace_id, null);
			assert.equal(trajectories[0].metadata.relation_status, "unknown");
			assert.equal(fs.existsSync(`${output}.diagnostics.json`), false);
			await assert.rejects(exportOpenAI([root], output), /already exists/);
		});
	});

	it("writes a diagnostics file only when explicitly requested", async () => {
		await fixture({ source: [pair(100, [user("task")], answer("done"))] }, async (root, output) => {
			const diagnosticsPath = path.join(root, "diagnostics.json");
			const diagnostics = await exportOpenAI([root], output, diagnosticsPath);
			assert.deepEqual(JSON.parse(fs.readFileSync(diagnosticsPath, "utf8")), diagnostics);
			assert.equal(fs.existsSync(`${output}.diagnostics.json`), false);
		});
	});

	it("hoists inline system text and removes billing headers without breaking resumed chains", async () => {
		const inlineSystem = { role: "system", content: [{ type: "text", text: "# Environment" }] };
		const body = (header: string) => ({ system: [
			{ type: "text", text: `x-anthropic-billing-header: ${header}` },
			{ type: "text", text: "Instructions" },
		] });
		const first = pair(100, [user("task"), inlineSystem], answer("one"), { body: body("first") });
		const second = pair(200, [user("task"), inlineSystem, assistant("one"), user("next")], answer("two"), { body: body("second") });
		await fixture({ source: [first, second] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output, undefined, { mergeSystemMessages: true });
			const record = read(output)[0];
			assert.equal(diagnostics.counts.continued, 1);
			assert.deepEqual(record.messages.map((message: any) => message.role),
				["system", "user", "assistant", "user", "assistant"]);
			assert.equal(record.messages[0].content, "Instructions# Environment");
			assert.equal(record.messages.at(-1).content, "two");
		});
	});

	it("keeps parallel branches separate despite the same first user message and header session", async () => {
		const records = [
			pair(100, [user("same")], answer("branch A")),
			pair(101, [user("same")], answer("branch B")),
			pair(200, [user("same"), assistant("branch A"), user("continue A")], answer("A done")),
			pair(201, [user("same"), assistant("branch B"), user("continue B")], answer("B done")),
		];
		await fixture({ source: records }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			const trajectories = read(output);
			assert.equal(trajectories.length, 2);
			assert.deepEqual(trajectories.map((entry) => entry.metadata.rounds.length), [2, 2]);
			assert.equal(diagnostics.counts.assigned, 4);
			assert(trajectories.every((entry) => entry.metadata.header_session_ids[0] === "shared"));
		});
	});

	it("does not guess a chain when identical prior responses make the prefix ambiguous", async () => {
		const records = [
			pair(100, [user("same")], answer("same answer")),
			pair(101, [user("same")], answer("same answer")),
			pair(200, [user("same"), assistant("same answer"), user("continue")], answer("done")),
		];
		await fixture({ source: records }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			assert.equal(read(output).length, 3);
			assert.equal(diagnostics.counts.ambiguous_prefix, 1);
			assert.equal(diagnostics.counts.prefix_conflicts, 1);
		});
	});

	it("treats cache annotations and equivalent text representation as the same history", async () => {
		const first = pair(100, [{ role: "user", content: [{ type: "text", text: "task", cache_control: { type: "ephemeral" } }] }], answer("one"));
		const second = pair(200, [user("task"), { role: "assistant", content: "one" }, user("next")], answer("two"), {
			body: { system: [{ type: "text", text: "Instructions", cache_control: { type: "ephemeral" } }] },
		});
		await fixture({ source: [first, second] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			assert.equal(read(output).length, 1);
			assert.equal(diagnostics.counts.continued, 1);
		});
	});

	it("starts a new trajectory when Claude Code rewrites a Bash command", async () => {
		const tool = (command: string) => ({ type: "tool_use", id: "call-1", name: "Bash", input: { command } });
		const firstResponse = { role: "assistant", content: [
			{ type: "text", text: "Run this" }, tool("cd /testbed && git status"), { type: "text", text: "\n" },
		] };
		const rewritten = { role: "assistant", content: [
			{ type: "text", text: "Run this" }, tool("git status"),
		] };
		const first = pair(100, [user("task")], firstResponse);
		const second = pair(200, [user("task"), rewritten, user("result")], answer("done"));
		await fixture({ source: [first, second] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			const records = read(output);
			assert.equal(diagnostics.counts.divergent_history, 1);
			assert.equal(records.length, 2);
			assert.equal(records[0].messages.find((message: any) => message.tool_calls).tool_calls[0].function.arguments.command,
				"cd /testbed && git status");
			assert.equal(records[1].messages.find((message: any) => message.tool_calls).tool_calls[0].function.arguments.command,
				"git status");
		});
	});

	it("drops blank text blocks from text-only response content when matching history", async () => {
		const first = pair(100, [user("task")], { role: "assistant", content: [
			{ type: "text", text: "one" }, { type: "text", text: "\n" },
		] });
		const second = pair(200, [user("task"), { role: "assistant", content: [{ type: "text", text: "one" }] }, user("next")], answer("done"));
		await fixture({ source: [first, second] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			assert.equal(diagnostics.counts.continued, 1);
			assert.equal(read(output).length, 1);
		});
	});

	it("does not equate different Bash commands", async () => {
		const tool = (command: string) => ({ role: "assistant", content: [
			{ type: "tool_use", id: "call-1", name: "Bash", input: { command } },
		] });
		await fixture({ source: [
			pair(100, [user("task")], tool("cd /testbed && git status")),
			pair(200, [user("task"), tool("git diff"), user("next")], answer("done")),
		] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			assert.equal(read(output).length, 2);
			assert.equal(diagnostics.counts.divergent_history, 1);
		});
	});

	it("optionally removes system messages after the first before merging", async () => {
		const initial = { role: "system", content: [{ type: "text", text: "Agent types", cache_control: { type: "ephemeral" } }] };
		const reminder = { role: "system", content: [{ type: "text", text: "Reminder" }] };
		const first = pair(100, [user("task"), initial], answer("one"));
		const second = pair(200, [user("task"), { role: "system", content: "Agent types" }, assistant("one"), user("next"), reminder], answer("two"));
		await fixture({ source: [first, second] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output, undefined, { filterSystemMessages: true, mergeSystemMessages: true });
			const record = read(output)[0];
			assert.equal(read(output).length, 1);
			assert.equal(diagnostics.counts.continued, 1);
			assert.equal(diagnostics.counts.filtered_system_messages, 1);
			assert.equal(record.messages[0].content, "InstructionsAgent types");
			assert.equal(record.messages.at(-1).content, "two");
		});
		await fixture({ source: [first, second] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output, undefined, { mergeSystemMessages: true });
			assert.equal(read(output).length, 2);
			assert.equal(diagnostics.counts.system_or_tools_changed, 1);
		});
	});

	for (const filterSystemMessages of [false, true]) {
		for (const mergeSystemMessages of [false, true]) {
			it(`handles independent system filtering=${filterSystemMessages} and merging=${mergeSystemMessages}`, async () => {
				const messages = [user("task"), { role: "system", content: "First" }, user("next"),
					{ role: "system", content: [{ type: "text", text: "Second" }] }];
				await fixture({ source: [pair(100, messages, answer("done"))] }, async (root, output) => {
					await exportOpenAI([root], output, undefined, { filterSystemMessages, mergeSystemMessages });
					const result = read(output)[0].messages;
					const expected = mergeSystemMessages
						? ["InstructionsFirst" + (filterSystemMessages ? "" : "Second"), "task", "next", "done"]
						: ["Instructions", "task", "First", "next", ...(filterSystemMessages ? [] : ["Second"]), "done"];
					assert.deepEqual(result.map((message: any) => message.content), expected);
					assert(result.filter((message: any) => message.role === "system").every((message: any) => message.trainable === false));
				});
			});
		}
	}

	it("preserves inline system boundaries by default, including without a top-level system", async () => {
		const messages = [user("task"), { role: "system", content: "First" },
			{ role: "system", content: [{ type: "text", text: "Second" }] }, user("next")];
		await fixture({ source: [pair(100, messages, answer("done"), { body: { system: undefined } })] }, async (root, output) => {
			await exportOpenAI([root], output);
			assert.deepEqual(read(output)[0].messages.map((message: any) => [message.role, message.content]), [
				["user", "task"], ["system", "First"], ["system", "Second"], ["user", "next"], ["assistant", "done"],
			]);
		});
	});

	it("extends default trajectories with new inline instructions without hoisting or duplication", async () => {
		const initial = { role: "system", content: "Initial" };
		const reminder = { role: "system", content: [{ type: "text", text: "Reminder" }] };
		const firstHistory = [user("task"), initial];
		const secondHistory = [...firstHistory, assistant("one"), user("next"), reminder];
		const thirdHistory = [...secondHistory, assistant("two"), user("last")];
		await fixture({ source: [pair(100, firstHistory, answer("one")), pair(200, secondHistory, answer("two")),
			pair(300, thirdHistory, answer("three"))] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			const records = read(output);
			assert.equal(records.length, 1);
			assert.equal(diagnostics.counts.continued, 2);
			assert.deepEqual(records[0].messages.map((message: any) => message.content),
				["Instructions", "task", "Initial", "one", "next", "Reminder", "two", "last", "three"]);
			assert.deepEqual(records[0].messages.filter((message: any) => message.trainable).map((message: any) => message.content),
				["one", "two", "three"]);
			assert.equal(records[0].metadata.response_sources.length, 3);
		});
	});

	it("still segments default trajectories when the top-level system or existing inline history changes", async () => {
		const history = [user("task"), { role: "system", content: "Initial" }];
		const first = pair(100, history, answer("one"));
		const changedTop = pair(200, [...history, assistant("one"), user("next")], answer("two"), { body: { system: "Changed" } });
		const changedInline = pair(300, [user("task"), { role: "system", content: "Rewritten" }, assistant("one"), user("next")], answer("three"));
		await fixture({ source: [first, changedTop, changedInline] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			assert.equal(read(output).length, 3);
			assert.equal(diagnostics.counts.system_or_tools_changed, 1);
			assert.equal(diagnostics.counts.divergent_history, 1);
		});
	});

	for (const mergeSystemMessages of [false, true]) {
		it(`removes string/block billing headers without breaking history (merge=${mergeSystemMessages})`, async () => {
			const history = (tag: string) => [user("task"),
				{ role: "system", content: `x-anthropic-billing-header: ${tag}` },
				{ role: "system", content: [{ type: "text", text: `x-anthropic-billing-header: ${tag}` }, { type: "text", text: "Keep" }] }];
			const top = { body: { system: "x-anthropic-billing-header: top" } };
			await fixture({ source: [pair(100, history("a"), answer("one"), top),
				pair(200, [...history("b"), assistant("one"), user("next")], answer("two"), top)] }, async (root, output) => {
				const diagnostics = await exportOpenAI([root], output, undefined, { mergeSystemMessages });
				assert.equal(read(output).length, 1);
				assert.equal(diagnostics.counts.continued, 1);
				assert(!fs.readFileSync(output, "utf8").includes("x-anthropic-billing-header"));
				assert.deepEqual(read(output)[0].messages.map((message: any) => message.content),
					mergeSystemMessages ? ["Keep", "task", "one", "next", "two"] : ["task", "Keep", "one", "next", "two"]);
			});
		});
	}

	it("starts a new segment for each explicit compaction context", async () => {
		const records = [
			pair(100, [user("original task")], answer("work")),
			pair(200, [user("Create a summary of the conversation so far")], answer("summary one")),
			pair(300, [user("<summary>summary one</summary>")], answer("post compact")),
			pair(350, [user("<summary>summary one</summary>"), assistant("post compact"), user("continue")], answer("continued")),
			pair(360, [user("<summary>summary one</summary>"), assistant("post compact"), user("alternative")], answer("branched")),
			pair(400, [user("Create a summary of the conversation so far, second pass")], answer("summary two")),
			pair(500, [user("<summary>summary two</summary>")], answer("last")),
		];
		await fixture({ source: records }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			assert.equal(read(output).length, 6);
			assert.equal(diagnostics.counts.assigned, 7);
			assert.equal(diagnostics.counts.compaction, 4);
			assert.equal(diagnostics.counts.divergent_history, 1);
			assert.equal(read(output).find((entry) => entry.metadata.rounds.length === 2)?.messages.at(-1).content, "continued");
			assert(read(output).every((entry) => entry.messages.at(-1).trainable === true));
		});
	});

	it("ignores summaries embedded in task notifications", async () => {
		const first = pair(100, [user("task")], answer("work"));
		const notification = "[SYSTEM NOTIFICATION]\n<task-notification>\n<summary>Agent \"Find QDP reader code\" finished</summary>\n</task-notification>";
		const second = pair(200, [user("task"), assistant("work"), user(notification)], answer("continued"));
		await fixture({ source: [first, second] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			const trajectory = read(output)[0];
			assert.equal(diagnostics.counts.compaction || 0, 0);
			assert.equal(diagnostics.counts.continued, 1);
			assert.equal(trajectory.metadata.segment_reason, "initial");
			assert.equal(trajectory.messages.at(-1).content, "continued");
		});
	});

	it("converts streamed thinking, tool calls and tool results", async () => {
		const events = [
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "Read", input: {} } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file":"a.py"}' } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_stop" },
		];
		const response = { role: "assistant", content: [
			{ type: "thinking", thinking: "reason" },
			{ type: "tool_use", id: "call-1", name: "Read", input: { file: "a.py" } },
		] };
		const first = pair(100, [user("read")], {}, { response: { body: undefined, events: events.map((data) => ({ event: data.type, data, timestamp: "" })) } });
		const second = pair(200, [user("read"), response, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }] }], answer("done"), {
			body: { tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }] },
		});
		first.request.body.tools = second.request.body.tools;
		await fixture({ source: [first, second] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			const record = read(output)[0];
			assert.equal(diagnostics.counts.assigned, 2);
			assert.equal(record.messages.find((message: any) => message.role === "tool").tool_call_id, "call-1");
			assert.equal(record.messages.find((message: any) => message.tool_calls).reasoning_content, "reason");
			assert.deepEqual(record.messages.find((message: any) => message.tool_calls).tool_calls[0].function.arguments, { file: "a.py" });
			assert.equal(record.tools[0].function.name, "Read");
		});
	});

	it("diagnoses failed, absent and partial responses without training them", async () => {
		const failed = pair(100, [user("fail")], {}, { response: { status_code: 500 } });
		const absent = pair(200, [user("absent")], null);
		const partial = pair(300, [user("partial")], {}, { response: { body: undefined, body_raw: 'data: {"type":"message_start"}\n' } });
		const good = pair(400, [user("good")], answer("yes"));
		await fixture({ source: [failed, absent, partial, good] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			assert.equal(diagnostics.counts.assigned, 1);
			assert.equal(diagnostics.counts.http_500, 1);
			assert.equal(diagnostics.counts.missing_response, 1);
			assert.equal(diagnostics.counts.unparseable_stream_response, 1);
			assert.equal(read(output).length, 1);
		});
	});

	it("keeps a complete exchange when an earlier snapshot has the same request without a response", async () => {
		const missing = pair(100, [user("task")], null);
		const complete = pair(100, [user("task")], answer("done"));
		await fixture({ first: [missing], second: [complete] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			assert.equal(diagnostics.counts.missing_response, 1);
			assert.equal(diagnostics.counts.assigned, 1);
			assert.equal(diagnostics.counts.duplicate || 0, 0);
			assert.equal(read(output)[0].messages.at(-1).content, "done");
		});
	});

	it("splits changed system and tools and reports unmatched tool results", async () => {
		const first = pair(100, [user("task")], answer("first"));
		const changed = pair(200, [user("task"), assistant("first"), { role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "bad" }] }], answer("second"), {
			body: { system: "New instructions", tools: [{ name: "Tool", input_schema: { type: "object" } }] },
		});
		await fixture({ source: [first, changed] }, async (root, output) => {
			const diagnostics = await exportOpenAI([root], output);
			assert.equal(read(output).length, 2);
			assert.equal(diagnostics.counts.system_or_tools_changed, 1);
			assert.equal(diagnostics.counts.prefix_conflicts, 1);
			assert.equal(diagnostics.counts.unmatched_tool_results, 1);
		});
	});
});
