import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { processHeaders } from "../src/intercept/header-redaction";
import {
	decodeResponseBody,
	normalizeAcceptEncoding,
	resolveOutboundProxy,
} from "../src/intercept/reverse-proxy";
import { getClaudeTraceLogDirectory } from "../src/tools/claude";
import { validateTrace } from "../src/cli/validate-trace";

describe("WorkflowExp integration", () => {
	it("fully redacts sensitive headers unless explicitly requested", () => {
		const headers = {
			authorization: "Bearer secret-value",
			"x-api-key": "secret-value",
			cookie: "session=secret",
			accept: "application/json",
		};
		assert.deepEqual(processHeaders(headers), {
			authorization: "[REDACTED]",
			"x-api-key": "[REDACTED]",
			cookie: "[REDACTED]",
			accept: "application/json",
		});
		assert.equal(processHeaders(headers, true).authorization, "Bearer secret-value");
	});

	it("uses only an absolute CLAUDE_TRACE_LOG_DIR", () => {
		assert.equal(getClaudeTraceLogDirectory({}), ".claude-trace");
		assert.equal(
			getClaudeTraceLogDirectory({ CLAUDE_TRACE_LOG_DIR: "/logs/agent/claude-trace" }),
			"/logs/agent/claude-trace",
		);
		assert.throws(
			() => getClaudeTraceLogDirectory({ CLAUDE_TRACE_LOG_DIR: "relative" }),
			/absolute path/,
		);
	});

	it("resolves HTTP and HTTPS proxies while respecting NO_PROXY", () => {
		const environment = {
			HTTP_PROXY: "http://proxy.example:8080",
			HTTPS_PROXY: "http://secure-proxy.example:8080",
		};
		assert.equal(
			resolveOutboundProxy("https://api.example.com/v1/messages", environment),
			"http://secure-proxy.example:8080",
		);
		assert.equal(
			resolveOutboundProxy("http://api.example.com/v1/messages", environment),
			"http://proxy.example:8080",
		);
		assert.equal(
			resolveOutboundProxy("https://api.example.com/v1/messages", {
				...environment,
				NO_PROXY: ".example.com",
			}),
			undefined,
		);
	});

	it("decodes supported response encodings and strips unsupported zstd", () => {
		const text = "data: response\n\n";
		assert.equal(decodeResponseBody(zlib.gzipSync(text), "gzip"), text);
		assert.equal(decodeResponseBody(zlib.brotliCompressSync(text), "br"), text);
		assert.equal(decodeResponseBody(zlib.deflateSync(text), "deflate"), text);
		const zstdCompressSync = (
			zlib as typeof zlib & { zstdCompressSync?: (buffer: string) => Buffer }
		).zstdCompressSync;
		if (zstdCompressSync) {
			assert.equal(decodeResponseBody(zstdCompressSync(text), "zstd"), text);
		}
		assert.equal(
			normalizeAcceptEncoding("gzip, br, zstd", false),
			"gzip, br",
		);
		assert.equal(
			normalizeAcceptEncoding("gzip, br, zstd", true),
			"gzip, br, zstd",
		);
	});

	it("writes complete metadata and removes derived reports", () => {
		const traceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-valid-"));
		const claudePath = path.join(traceDirectory, "claude-real");
		fs.writeFileSync(claudePath, "#!/bin/sh\necho '2.1.216 (Claude Code)'\n");
		fs.chmodSync(claudePath, 0o755);
		const record = {
			request: {
				timestamp: Date.now() / 1000,
				method: "POST",
				url: "https://api.example/v1/messages",
				headers: { authorization: "[REDACTED]" },
				body: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
			},
			response: {
				timestamp: Date.now() / 1000,
				status_code: 200,
				headers: { "set-cookie": "[REDACTED]" },
				body: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
			},
			logged_at: new Date().toISOString(),
		};
		fs.writeFileSync(path.join(traceDirectory, "trace.jsonl"), `${JSON.stringify(record)}\n`);
		fs.writeFileSync(path.join(traceDirectory, "trace.json"), "[]");
		fs.writeFileSync(path.join(traceDirectory, "trace.html"), "html");

		const metadata = validateTrace({
			mode: "complete",
			claudePath,
			traceDirectory,
		});
		assert.equal(metadata.status, "complete");
		assert.deepEqual(metadata.validation_errors, []);
		assert.equal(metadata.headers_fully_redacted, true);
		assert.equal(metadata.message_exchange_count, 1);
		assert.equal(fs.existsSync(path.join(traceDirectory, "trace.json")), false);
		assert.equal(fs.existsSync(path.join(traceDirectory, "trace.html")), false);
	});

	it("removes secret material and marks an incomplete trace", () => {
		const traceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-secret-"));
		const secret = "sk-workflowexp-secret-value";
		const record = {
			request: {
				timestamp: Date.now() / 1000,
				method: "POST",
				url: "https://api.example/v1/messages",
				headers: { authorization: `Bearer ${secret}` },
				body: {},
			},
			response: {
				timestamp: Date.now() / 1000,
				status_code: 200,
				headers: {},
				body: { content: [] },
			},
			logged_at: new Date().toISOString(),
		};
		const tracePath = path.join(traceDirectory, "trace.jsonl");
		fs.writeFileSync(tracePath, `${JSON.stringify(record)}\n`);
		const metadata = validateTrace({
			mode: "incomplete",
			claudePath: "/bin/false",
			traceDirectory,
			environment: { ANTHROPIC_API_KEY: secret },
		});
		assert.equal(metadata.status, "incomplete");
		assert.equal(metadata.headers_fully_redacted, false);
		assert.ok(metadata.validation_errors.length > 0);
		assert.equal(fs.readFileSync(tracePath, "utf8").includes(secret), false);
	});
});
