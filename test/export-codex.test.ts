/**
 * @file export-codex.test.ts
 * @description Tests Responses conversion, stream completion, trajectory provenance and the
 * Codex offline CLI boundary without launching a real coding client or model service.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { convertResponsesItems, convertResponsesRequest } from "../src/export/responses-conversion";
import { exportCodexOpenAI } from "../src/export/responses";
import type { RawPair } from "../src/types";

/** Minimal complete Responses output fixture, also suitable as subsequent input history. */
const answer = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }];

/** Construct a local fixture with the same raw-pair shape as codex-trace logs. */
function pair(input: unknown = "Task", output: unknown = answer, timestamp = 100): RawPair {
	return { request: { timestamp, method: "POST", url: "https://example.invalid/backend-api/codex/responses", headers: {},
		body: { model: "fixture", instructions: "Rules", input, tools: [] } },
		response: { timestamp: timestamp + 1, status_code: 200, headers: {},
			body: { id: `resp_${timestamp}`, status: "completed", output } }, logged_at: "" };
}

/** Isolate files so failed tests cannot overwrite captured user traces. */
async function fixture(run: (root: string, input: string, output: string) => Promise<void>): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-export-"));
	try { await run(root, path.join(root, "named-session.jsonl"), path.join(root, "sft.jsonl")); }
	finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function write(file: string, pairs: RawPair[]): void { fs.writeFileSync(file, pairs.map((value) => JSON.stringify(value)).join("\n") + "\n"); }

/** Run the source CLI using the installed TS loader; fake client paths must never execute. */
function cli(args: string[], cwd: string) {
	const result = spawnSync(process.execPath, ["--require", require.resolve("tsx/cjs"), path.resolve(__dirname, "../src/cli/codex-cli.ts"), ...args],
		{ cwd, encoding: "utf8", timeout: 20000 });
	assert.ifError(result.error);
	return result;
}

describe("Responses template conversion", () => {
	it("matches vLLM's empty-block filtering and developer message fields", () => {
		assert.deepEqual(convertResponsesRequest({ input: [
			{ role: "developer", content: "Rules", name: "author" },
			{ role: "user", content: [{ type: "input_text", text: "A" }, { type: "input_text", text: "" }, { type: "input_text", text: "B" }] },
		] }).messages, [{ role: "developer", content: "Rules", tools: null, name: "author" }, { role: "user", content: "A\nB" }]);
		assert.deepEqual(convertResponsesItems([{ type: "function_call", call_id: "c1", name: "f", arguments: "" }])[0].tool_calls,
			[{ id: "c1", type: "function", function: { name: "f", arguments: {} } }]);
	});
	it("converts developers in place, then optionally filters or merges systems", () => {
		const body = { instructions: "Top", input: [
				{ role: "user", content: [{ type: "input_text", text: "A" }, { type: "input_text", text: "B" }] },
				{ role: "system", content: "First" }, { role: "developer", content: "Dev" },
				{ role: "system", content: [{ type: "input_text", text: "Second" }] },
			] };
		for (const convert of [false, true]) for (const filter of [false, true]) for (const merge of [false, true]) {
			const options = { convertDeveloperToSystem: convert, filterSystemMessages: filter, mergeSystemMessages: merge };
			if (!convert && (filter || merge)) {
				assert.throws(() => convertResponsesRequest(body, options), /require --convert-developer-to-system/);
				continue;
			}
			const converted = convertResponsesRequest(body, options);
			assert.deepEqual(converted.messages.map((message) => message.content), merge
				? [filter ? "Top" : "Top\n\nFirst\n\nDev\n\nSecond", "A\nB"]
				: filter ? ["Top", "A\nB"] : ["Top", "A\nB", "First", "Dev", "Second"]);
			assert.equal(converted.messages.some((message) => message.role === "developer"), !convert);
		}
	});
	it("filters later systems without instructions and removes converted developer tools without mutating input", () => {
		const body = { input: [
			{ role: "user", content: "Task" },
			{ role: "developer", content: "Dev", tools: [{ name: "local" }] },
			{ role: "system", content: "First" },
			{ role: "system", content: "Second" },
		] };
		const before = JSON.stringify(body);
		assert.deepEqual(convertResponsesRequest(body, { convertDeveloperToSystem: true }).messages.map((message) => message.role),
			["user", "system", "system", "system"]);
		assert.deepEqual(convertResponsesRequest(body, { convertDeveloperToSystem: true, filterSystemMessages: true }).messages.map((message) => message.content), ["Task", "Dev"]);
		assert.deepEqual(convertResponsesRequest(body, { convertDeveloperToSystem: true, mergeSystemMessages: true }).messages, [
			{ role: "system", content: "Dev\n\nFirst\n\nSecond" }, { role: "user", content: "Task" },
		]);
		assert.deepEqual(convertResponsesRequest(body, { convertDeveloperToSystem: true, filterSystemMessages: true, mergeSystemMessages: true }).messages, [
			{ role: "system", content: "Dev" }, { role: "user", content: "Task" },
		]);
		assert.equal(JSON.stringify(body), before);
		assert.deepEqual(convertResponsesRequest({ input: [{ role: "developer", content: "" }, { role: "system", content: "" }] },
			{ convertDeveloperToSystem: true, mergeSystemMessages: true }).messages, [{ role: "system", content: "" }]);
	});
	it("merges adjacent reasoning, text and calls and expands namespace names", () => {
		const messages = convertResponsesItems([
			{ type: "reasoning", content: [{ text: "Think" }], summary: [] }, ...answer,
			{ type: "function_call", namespace: "tools", name: "run", call_id: "c1", arguments: '{"x":1}' },
			{ type: "function_call", name: "other", call_id: "c2", arguments: "{}" },
			{ type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "ok" }] },
		]);
		assert.deepEqual(messages, [
			{ role: "assistant", reasoning: "Think", reasoning_content: "Think", content: "Done", tool_calls: [
				{ id: "c1", type: "function", function: { name: "tools__run", arguments: { x: 1 } } },
				{ id: "c2", type: "function", function: { name: "other", arguments: {} } },
			] }, { role: "tool", tool_call_id: "c1", content: "ok" },
		]);
		assert.deepEqual(convertResponsesRequest({ input: "Task", tools: [{ type: "namespace", name: "tools", tools: [
			{ type: "function", name: "run", description: "Run", parameters: { type: "object" }, strict: false },
		] }] }).tools, [{ type: "function", function: { name: "tools__run", description: "Run", parameters: { type: "object" }, strict: false } }]);
	});
	it("strips billing lines and rejects encrypted or unsupported/lossy content", () => {
		assert.equal(convertResponsesRequest({ input: [{ role: "system", content: "x-anthropic-billing-header: x\nRules" }] }).messages[0].content, "Rules");
		for (const input of [
			[{ type: "reasoning", encrypted_content: "hidden", summary: [] }],
			[{ type: "item_reference", id: "missing" }],
			[{ type: "function_call", call_id: "c1", name: "f", arguments: "bad json" }],
			[{ role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/x" }] }],
			[{ role: "assistant", content: "partial", status: "incomplete" }],
		]) assert.throws(() => convertResponsesRequest({ input }));
		assert.throws(() => convertResponsesRequest({ input: "Task", previous_response_id: "resp_missing" }), /server_history/);
		assert.throws(() => convertResponsesRequest({ input: "Task", tools: [{ type: "custom", name: "patch" }] }), /unsupported_responses_tool/);
	});
});

describe("Codex trajectories and CLI", () => {
	it("deduplicates custom filenames, stitches rounds, and marks only real outputs trainable", () => fixture(async (root, input, output) => {
		const first = pair([{ role: "user", content: "Task" }]);
		const second = pair([{ role: "user", content: "Task" }, ...answer, { role: "system", content: "New inline" }, { role: "user", content: "Next" }], answer, 200);
		write(input, [first, second]);
		write(path.join(root, "copy.jsonl"), [first]);
		const diagnostics = await exportCodexOpenAI([root, input], output);
		assert.equal(diagnostics.counts.assigned, 2);
		assert.equal(diagnostics.counts.duplicate, 1);
		assert.equal(diagnostics.counts.trajectories, 1);
		const record = JSON.parse(fs.readFileSync(output, "utf8"));
		assert.deepEqual(record.messages.map((message: { trainable: boolean }) => message.trainable), [false, false, true, false, false, true]);
		assert.deepEqual(record.metadata.response_message_ranges, [{ start: 2, end: 3 }, { start: 5, end: 6 }]);
		assert.equal(record.metadata.rounds.length, 2);
		await assert.rejects(exportCodexOpenAI([input], output), /already exists/);
	}));
	it("splits changed tools, changed systems, and ambiguous branches", () => fixture(async (root, input, output) => {
		const first = pair([{ role: "user", content: "Task" }]);
		const branch = pair([{ role: "user", content: "Task" }], answer, 150);
		const next = pair([{ role: "user", content: "Task" }, ...answer, { role: "user", content: "Next" }], answer, 200);
		write(input, [first, branch, next]);
		const diagnostics = await exportCodexOpenAI([input], output);
		assert.equal(diagnostics.counts.ambiguous_prefix, 1);
		assert.equal(diagnostics.counts.trajectories, 3);
		const changed = pair(next.request.body.input, answer, 300);
		changed.request.body.tools = [{ type: "function", name: "new", parameters: {} }];
		write(input, [first, changed]);
		assert.equal((await exportCodexOpenAI([input], path.join(root, "tools.jsonl"))).counts.trajectories, 2);
		changed.request.body.tools = [];
		changed.request.body.instructions = "Changed";
		write(input, [first, changed]);
		assert.equal((await exportCodexOpenAI([input], path.join(root, "systems.jsonl"))).counts.trajectories, 2);
	}));
	it("supports parsed SSE and raw SSE, and diagnoses incomplete, orphan and HTTP failures", () => fixture(async (root, input, output) => {
		const parsed = pair("One");
		parsed.response!.events = [{ event: "response.completed", timestamp: "", data: { type: "response.completed", response: parsed.response!.body } }];
		delete parsed.response!.body;
		const raw = pair("Two", answer, 200);
		raw.response!.body_raw = `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: raw.response!.body })}\r\n\r\ndata: [DONE]\r\n\r\n`;
		delete raw.response!.body;
		const incomplete = pair("Three", answer, 300); incomplete.response!.body.status = "incomplete";
		const orphan = pair("Four", answer, 400); orphan.response = null;
		const failed = pair("Five", answer, 500); failed.response!.status_code = 500;
		const partial = pair("Six", answer, 600); partial.response!.events = [{ event: "response.created", timestamp: "", data: { type: "response.created" } }];
		write(input, [parsed, raw, incomplete, orphan, failed, partial]);
		const diagnostics = await exportCodexOpenAI([input], output);
		assert.equal(diagnostics.counts.assigned, 2);
		for (const reason of ["response_not_completed", "missing_response", "http_500", "missing_or_ambiguous_completed_event"]) assert.equal(diagnostics.counts[reason], 1);
	}));
	it("records ranges when one response contains multiple assistant messages", () => fixture(async (_root, input, output) => {
		write(input, [pair("Task", [...answer, ...answer])]);
		await exportCodexOpenAI([input], output);
		const record = JSON.parse(fs.readFileSync(output, "utf8"));
		assert.deepEqual(record.metadata.response_message_ranges, [{ start: 2, end: 4 }]);
		assert.equal(record.metadata.rounds.length, 1);
	}));
	it("runs the export CLI, rejects conflicts and missing options, and documents usage", () => fixture(async (root, input, output) => {
		write(input, [pair()]);
		const diagnostics = path.join(root, "diagnostics.json");
		const result = cli(["--export-openai", "--input", input, "--input", input, "--output", output, "--diagnostics", diagnostics], root);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(fs.readFileSync(diagnostics, "utf8")).counts.assigned, 1);
		assert(cli(["--help"], root).stdout.includes("--export-openai"));
		assert(cli(["--help"], root).stdout.includes("--convert-developer-to-system"));
		write(input, [pair([{ role: "developer", content: "Dev" }, { role: "system", content: "Later" }, { role: "user", content: "Task" }])]);
		for (const filter of [false, true]) for (const merge of [false, true]) {
			const target = path.join(root, `flags-${filter}-${merge}.jsonl`);
			const exported = cli(["--export-openai", "--input", input, "--output", target,
				"--convert-developer-to-system",
				...(filter ? ["--filter-system-messages"] : []), ...(merge ? ["--merge-system-messages"] : [])], root);
			assert.equal(exported.status, 0, exported.stderr);
			const record = JSON.parse(fs.readFileSync(target, "utf8"));
			assert.deepEqual(record.messages.map((message: { content: string }) => message.content), merge
				? [filter ? "Rules" : "Rules\n\nDev\n\nLater", "Task", "Done"]
				: filter ? ["Rules", "Task", "Done"] : ["Rules", "Dev", "Later", "Task", "Done"]);
			assert.equal(record.messages.some((message: { role: string }) => message.role === "developer"), false);
			assert(record.messages.filter((message: { role: string }) => message.role === "system")
				.every((message: { trainable: boolean }) => !message.trainable));
		}
		for (const flag of ["--filter-system-messages", "--merge-system-messages"]) {
			const target = path.join(root, `invalid-${flag.slice(2)}.jsonl`);
			const invalid = cli(["--export-openai", "--input", input, "--output", target, flag], root);
			assert.equal(invalid.status, 1);
			assert.match(invalid.stdout + invalid.stderr, /require --convert-developer-to-system/);
			assert(!fs.existsSync(target));
		}
		await assert.rejects(exportCodexOpenAI([input], path.join(root, "invalid-programmatic.jsonl"), undefined,
			{ mergeSystemMessages: true }), /require --convert-developer-to-system/);
		for (const flags of [
			["--export-openai"], ["--input", input], ["--merge-system-messages"],
			["--convert-developer-to-system"],
			["--export-openai", "--index"], ["--export-openai", "--generate-html", input],
			["--export-openai", "--run-with", "exec"], ["--export-openai", "--codex-path", "/missing"],
			["--export-openai", "--input", input, "--output", output],
			["--export-openai", "--input"], ["--export-openai", "--export-openai"],
		]) assert.equal(cli(flags, root).status, 1, flags.join(" "));
		assert(!fs.existsSync(path.join(root, ".codex-trace")));
	}));
});
