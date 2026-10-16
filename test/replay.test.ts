import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";

function cli(name: "cli" | "codex-cli", args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--require", require.resolve("tsx/cjs"),
			path.resolve(__dirname, `../src/cli/${name}.ts`), ...args], {
			cwd, env: { ...process.env, REPLAY_TEST_KEY: "destination-secret", CLAUDE_TRACE_LOG_DIR: "relative" },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

it("replays selected Claude and Codex lines, saves responses, and replaces captured credentials", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "trace-replay-"));
	const received: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
	const server = http.createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			received.push({ url: request.url!, headers: request.headers, body });
			response.writeHead(request.url?.includes("fail=1") ? 503 : 200,
				{ "content-type": body.stream ? "text/event-stream" : "application/json" });
			response.end(body.stream ? "event: done\ndata: ok\n\n" : JSON.stringify({ answer: "ready" }));
		});
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const trace = path.join(root, "trace.jsonl");
		fs.writeFileSync(trace, ["invalid JSON", JSON.stringify({ request: {
			method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {
				"x-api-key": "captured-secret", authorization: "Bearer captured-secret", "content-encoding": "gzip", "anthropic-version": "2023-06-01",
			}, body: { model: "old-claude", stream: true, messages: [] },
		} }), JSON.stringify({ request: {
			method: "POST", url: "https://chatgpt.com/backend-api/codex/responses?test=1", headers: { cookie: "captured-cookie" },
			body: { model: "old-codex", stream: true, input: "Task" },
		} })].join("\n") + "\n");
		const claudeOutput = path.join(root, "claude.json");
		const claude = await cli("cli", ["--replay", trace, "--line-number", "2", "--base-url", base,
			"--model", "new-claude", "--max-tokens", "7", "--api-key-env", "REPLAY_TEST_KEY", "--output", claudeOutput], root);
		assert.equal(claude.status, 0, claude.stderr);
		assert(claude.stdout.includes("response status: 200"));
		assert.deepEqual(received[0].body, { model: "new-claude", stream: false, messages: [], max_tokens: 7 });
		assert.equal(received[0].url, "/v1/messages");
		assert.equal(received[0].headers["x-api-key"], "destination-secret");
		assert.equal(received[0].headers["content-encoding"], undefined);
		assert.equal(received[0].headers["anthropic-version"], "2023-06-01");
		const claudeRecord = JSON.parse(fs.readFileSync(claudeOutput, "utf8"));
		assert.deepEqual(claudeRecord.replay_response.body, { answer: "ready" });
		assert(!fs.readFileSync(claudeOutput, "utf8").includes("captured-secret"));
		assert(!fs.readFileSync(claudeOutput, "utf8").includes("destination-secret"));
		const codexOutput = path.join(root, "codex.json");
		const codex = await cli("codex-cli", ["--replay", trace, "--line-number", "3", "--base-url", base,
			"--max-tokens", "9", "--preserve-stream", "--output", codexOutput], root);
		assert.equal(codex.status, 0, codex.stderr);
		assert.equal(received[1].url, "/v1/responses?test=1");
		assert.equal(received[1].body.stream, true);
		assert.equal(received[1].body.max_output_tokens, 9);
		assert.equal(received[1].headers.cookie, undefined);
		assert.equal(JSON.parse(fs.readFileSync(codexOutput, "utf8")).replay_response.body, "event: done\ndata: ok\n\n");
		assert.equal((await cli("cli", ["--replay", trace, "--line-number", "2", "--base-url", base,
			"--output", claudeOutput], root)).status, 1);
		assert.equal(received.length, 2);
		const failureTrace = path.join(root, "failure.jsonl");
		fs.writeFileSync(failureTrace, JSON.stringify({ request: {
			method: "POST", url: "https://example.invalid/v1/messages?fail=1", headers: {}, body: { model: "fixture", messages: [] },
		} }) + "\n");
		const failureOutput = path.join(root, "failure.json");
		const failure = await cli("cli", ["--replay", failureTrace, "--seed", "17", "--base-url", `${base}/v1`,
			"--output", failureOutput], root);
		assert.equal(failure.status, 1, failure.stderr);
		const failureRecord = JSON.parse(fs.readFileSync(failureOutput, "utf8"));
		assert.equal(failureRecord.eligible_request_count, 1);
		assert.equal(failureRecord.replay_response.status_code, 503);
		assert.equal(received[2].url, "/v1/messages?fail=1");
		assert.equal((await cli("cli", ["--replay", trace, "--line-number", "1", "--base-url", base], root)).status, 1);
		assert.equal((await cli("codex-cli", ["--replay", trace, "--index"], root)).status, 1);
		assert.equal((await cli("cli", ["--replay", trace, "--run-with", "chat"], root)).status, 1);
		assert.equal(received.length, 3);
	} finally {
		server.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("replays repeated trace lines with a bounded concurrency and ordered results", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "trace-replay-batch-"));
	let active = 0;
	let peak = 0;
	let received = 0;
	const server = http.createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			active++;
			received++;
			peak = Math.max(peak, active);
			setTimeout(() => {
				response.writeHead(request.url?.includes("fail=1") ? 503 : 200, { "content-type": "application/json" });
				response.end(JSON.stringify({ path: request.url }));
				active--;
			}, 80);
		});
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const trace = path.join(root, "trace.jsonl");
		const entry = (url: string) => JSON.stringify({ request: { method: "POST", url, headers: {}, body: { model: "fixture" } } });
		fs.writeFileSync(trace, [entry("https://example.invalid/v1/messages?line=1"),
			entry("https://example.invalid/v1/responses?fail=1"), "invalid JSON",
			entry("https://example.invalid/backend-api/codex/responses?line=4")].join("\n") + "\n");
		const output = path.join(root, "batch.json");
		const before = await cli("cli", ["--replay", trace, "--trace-line", "4", "--trace-line", "3",
			"--concurrency", "2", "--base-url", base, "--output", output], root);
		assert.equal(before.status, 1);
		assert.equal(received, 0);
		assert(!fs.existsSync(output));
		const batch = await cli("cli", ["--replay", trace, "--trace-line", "4", "--line-number", "1",
			"--trace-line", "2", "--concurrency", "2", "--base-url", base, "--output", output], root);
		assert.equal(batch.status, 1, batch.stderr);
		assert.equal(peak, 2);
		assert.equal(received, 3);
		const result = JSON.parse(fs.readFileSync(output, "utf8"));
		assert.deepEqual(result.selected_line_numbers, [4, 1, 2]);
		assert.equal(result.concurrency_limit, 2);
		assert.deepEqual(result.counts, { requests: 3, succeeded: 2, failed: 1 });
		assert.deepEqual(result.results.map((record: { selected_line_number: number }) => record.selected_line_number), [4, 1, 2]);
		assert.deepEqual(result.results.map((record: { replay_response: { status_code: number } }) => record.replay_response.status_code), [200, 200, 503]);
		assert.equal(result.results[0].replay_request.url, `${base}/v1/responses?line=4`);
		for (const flags of [
			["--trace-line", "1", "--line-number", "1"], ["--trace-line", "1", "--seed", "2"],
			["--trace-line", "1", "--concurrency", "0"],
		]) {
			assert.equal((await cli("codex-cli", ["--replay", trace, ...flags, "--base-url", base], root)).status, 1);
		}
		assert.equal(received, 3);
		const codexOutput = path.join(root, "codex-batch.json");
		peak = 0;
		const codex = await cli("codex-cli", ["--replay", trace, "--trace-line", "4", "--trace-line", "1",
			"--base-url", base, "--output", codexOutput], root);
		assert.equal(codex.status, 0, codex.stderr);
		assert.equal(peak, 1);
		assert.equal(received, 5);
		assert.deepEqual(JSON.parse(fs.readFileSync(codexOutput, "utf8")).selected_line_numbers, [4, 1]);
		assert((await cli("cli", ["--help"], root)).stdout.includes("--concurrency"));
	} finally {
		server.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
