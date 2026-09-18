import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { validateTrace } from "../src/cli/validate-trace";

describe("Claude trace validation", () => {
	it("excludes count_tokens calls from message exchanges", () => {
		const traceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-validate-"));
		const countTokens = {
			request: {
				timestamp: 1,
				method: "POST",
				url: "https://api.example/v1/messages/count_tokens?beta=true",
				headers: {},
				body: {},
			},
			response: {
				timestamp: 2,
				status_code: 200,
				headers: {},
				body: { input_tokens: 42 },
			},
			logged_at: new Date(2).toISOString(),
		};
		const message = {
			request: {
				timestamp: 3,
				method: "POST",
				url: "https://api.example/v1/messages?beta=true",
				headers: {},
				body: {},
			},
			response: {
				timestamp: 4,
				status_code: 200,
				headers: {},
				body: { content: [{ type: "text", text: "done" }] },
			},
			logged_at: new Date(4).toISOString(),
		};

		try {
			fs.writeFileSync(
				path.join(traceDirectory, "trace.jsonl"),
				`${JSON.stringify(countTokens)}\n${JSON.stringify(message)}\n`,
			);
			const metadata = validateTrace({
				mode: "complete",
				claudePath: process.execPath,
				traceDirectory,
				environment: {},
			});

			assert.equal(metadata.message_exchange_count, 1);
			assert.deepEqual(metadata.validation_errors, []);
			assert.equal(metadata.status, "complete");
		} finally {
			fs.rmSync(traceDirectory, { recursive: true, force: true });
		}
	});
});
