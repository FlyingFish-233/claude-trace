/** @file train-report.test.ts @description Training report format and trace compatibility checks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reportTraces } from "../src/trace/report";

function embeddedData(html: string): any {
	const match = html.match(/atob\('([^']+)'\)/);
	assert.ok(match, "self-contained report embeds its payload");
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

test("train.jsonl reports keep each line independent and preserve trainable fields", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "train-report-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const input = path.join(dir, "train.jsonl");
	const output = path.join(dir, "report.html");
	const first = { messages: [
		{ role: "system", content: "policy", trainable: false },
		{ role: "assistant", content: "", reasoning_content: "thought", tool_calls: [{ id: "a", function: { name: "Read", arguments: { file: "x" } } }], trainable: true },
		{ role: "tool", tool_call_id: "a", content: "result", trainable: false },
	], tools: [{ name: "Read" }], metadata: { chain_id: "chain-0", segment_reason: "initial" } };
	const second = { messages: [{ role: "assistant", content: "answer", trainable: true }], metadata: { chain_id: "chain-1" } };
	fs.writeFileSync(input, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
	await reportTraces([input], output);
	const html = fs.readFileSync(output, "utf8");
	const data = embeddedData(html);
	assert.deepEqual(data.rawPairs, []);
	assert.equal(data.trainTrajectories.length, 2);
	assert.deepEqual(data.trainTrajectories[0].messages, first.messages);
	assert.deepEqual(data.trainTrajectories[1].messages, second.messages);
	assert.deepEqual(data.trainTrajectories[0].source, { file: fs.realpathSync(input), line: 1 });
	assert.equal(data.trainTrajectories[1].source.line, 2);
	assert.match(html, /train trace · 2 Trajectories/);
	assert.match(html, /conversation-view/);
	await assert.rejects(reportTraces([input], output), /output_already_exists/);
});

test("report rejects mixed trace and training records", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "train-report-mixed-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const input = path.join(dir, "mixed.jsonl");
	fs.writeFileSync(input, `${JSON.stringify({ messages: [] })}\n${JSON.stringify({ schema_version: 2 })}\n`);
	await assert.rejects(reportTraces([input], path.join(dir, "report.html")), /mixed_report_inputs/);
});
