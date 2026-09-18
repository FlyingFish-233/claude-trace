import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseTraceArgs } from "../src/cli/cli-common";
import { ReverseProxyServer } from "../src/intercept/reverse-proxy";

describe("Claude JSONL-only tracing", () => {
	it("maps --no-open to JSONL-only tracing", () => {
		const parsed = parseTraceArgs(["--no-open", "--log", "trace", "--run-with", "-p", "hello"]);
		assert.equal(parsed.openInBrowser, false);
		assert.equal(parsed.jsonlOnly, true);
		assert.deepEqual(parsed.toolArgs, ["-p", "hello"]);
	});

	it("does not initialize derived files in JSONL-only proxy mode", async () => {
		const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-jsonl-only-"));
		const proxy = new ReverseProxyServer({
			logDirectory,
			logBaseName: "trace",
			jsonlOnly: true,
		});

		await proxy.start();
		await (proxy as any).writePairToLog({
			request: { timestamp: 1, method: "POST", url: "https://api.example/v1/messages", headers: {}, body: {} },
			response: { timestamp: 2, status_code: 200, headers: {}, body: {} },
			logged_at: new Date().toISOString(),
		});
		proxy.stop();

		assert.equal(fs.existsSync(path.join(logDirectory, "trace.jsonl")), true);
		assert.equal(fs.readFileSync(path.join(logDirectory, "trace.jsonl"), "utf8").trim().length > 0, true);
		assert.equal(fs.existsSync(path.join(logDirectory, "trace.json")), false);
		assert.equal(fs.existsSync(path.join(logDirectory, "trace.html")), false);
	});
});
