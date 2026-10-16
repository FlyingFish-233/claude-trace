/**
 * @file codex-output.test.ts
 * @description Checks Codex CLI output modes through a real local proxy exchange.
 * The fixture client and upstream require neither Codex nor model credentials.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execute = promisify(execFile);

/** Run source CLI in unit tests, or the built CLI in post-build smoke checks. */
async function cli(args: string[], root: string): Promise<void> {
	const entry = process.env.CODEX_TRACE_TEST_ENTRY;
	await execute(process.execPath, [
		...(entry ? [path.resolve(entry)] : ["--require", require.resolve("tsx/cjs"),
			path.resolve(__dirname, "../src/cli/codex-cli.ts")]), ...args,
	], {
		cwd: root, timeout: 20000,
		env: {
			...process.env,
			// Isolate both source config and the persistent overlay from real user state.
			HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, "config"),
			PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
			HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
			http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "127.0.0.1,localhost",
		},
	});
}

describe("Codex CLI output artifacts", { skip: process.platform === "win32" }, () => {
	for (const mode of ["jsonl-only", "default", "forwarded-no-open"] as const) {
		it(`${mode}: records an exchange with the expected artifacts`, async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-trace-output-"));
			let requests = 0;
			const upstream = http.createServer((req, res) => {
				requests++;
				req.resume();
				res.writeHead(200, { "content-type": "application/json", "connection": "close" });
				res.end(JSON.stringify({ id: "resp_fixture", object: "response", status: "completed",
					model: "fixture", output: [{ type: "message", role: "assistant",
						content: [{ type: "output_text", text: "Done" }] }] }));
			});
			try {
				await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
				const address = upstream.address();
				assert(address && typeof address === "object");
				fs.mkdirSync(path.join(root, "config"));
				fs.writeFileSync(path.join(root, "config/config.toml"),
					`openai_base_url = "http://127.0.0.1:${address.port}/v1"\n`);
				fs.mkdirSync(path.join(root, "bin"));
				// Keep default-mode browser launch harmless and confined to the fixture.
				for (const opener of ["xdg-open", "open"]) {
					fs.writeFileSync(path.join(root, "bin", opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
				}
				const client = path.join(root, "client.cjs");
				fs.writeFileSync(client, `
const fs = require("node:fs");
const http = require("node:http");
const config = fs.readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8");
const base = config.match(/^openai_base_url\\s*=\\s*"([^"]+)"/m)[1];
fs.writeFileSync("client-args.json", JSON.stringify(process.argv.slice(2)));
const request = http.request(base + "/responses", {
  method: "POST", headers: { "content-type": "application/json", "connection": "close" }
}, response => {
  if (response.statusCode !== 200) process.exitCode = 1;
  response.resume();
});
request.on("error", error => { console.error(error); process.exitCode = 1; });
request.end(JSON.stringify({ model: "fixture", input: [{ role: "user", content: "Hello" }] }));
`);
				const forwarded = mode === "forwarded-no-open" ? ["--no-open"] : [];
				await cli(["--codex-path", process.execPath, "--log", "trace",
					...(mode === "jsonl-only" ? ["--no-open"] : []),
					"--run-with", client, ...forwarded], root);
				assert.equal(requests, 1);
				assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "client-args.json"), "utf8")), forwarded);
				const logs = path.join(root, ".codex-trace");
				assert.deepEqual(fs.readdirSync(logs).sort(), mode === "jsonl-only"
					? ["trace.jsonl"] : ["trace.html", "trace.json", "trace.jsonl"]);
				const pairs = fs.readFileSync(path.join(logs, "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
				assert.equal(pairs.length, 1);
				assert.equal(pairs[0].request.body.input[0].content, "Hello");
				assert.equal(pairs[0].response.status_code, 200);
				assert.equal(pairs[0].response.body.content[0].text, "Done");
				if (mode === "jsonl-only") {
					await cli(["--generate-html", path.join(logs, "trace.jsonl"),
						path.join(root, "report.html"), "--no-open"], root);
					assert.match(fs.readFileSync(path.join(root, "report.html"), "utf8"), /<!doctype html>/i);
					assert.deepEqual(fs.readdirSync(logs), ["trace.jsonl"]);
				}
			} finally {
				await new Promise<void>((resolve) => upstream.close(() => resolve()));
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
