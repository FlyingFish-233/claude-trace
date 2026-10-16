/**
 * @file cli-utilities.test.ts
 * @description Exercises the public utility CLI, exit codes and client argument boundary.
 * All exchanges are local fixtures; no model service or Claude installation is needed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseTraceArgs } from "../src/cli/cli-common";

/** Execute the source CLI through the installed TypeScript loader in an isolated directory. */
function cli(args: string[], cwd: string, logDir = cwd) {
	const result = spawnSync(process.execPath, ["--require", require.resolve("tsx/cjs"),
		path.resolve(__dirname, "../src/cli/cli.ts"), ...args], {
		cwd, encoding: "utf8", timeout: 20000,
		env: { ...process.env, CLAUDE_TRACE_LOG_DIR: logDir },
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	return result;
}

/** Supply a local successful trace and clean up outputs even if an assertion fails. */
function fixture(run: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-cli-"));
	try {
		fs.writeFileSync(path.join(root, "trace.jsonl"), JSON.stringify({
			request: { timestamp: 100, method: "POST", url: "https://example.invalid/v1/messages", headers: {},
				body: { model: "fixture", system: "Top", messages: [
					{ role: "user", content: "Task" }, { role: "system", content: "Inline" },
					{ role: "user", content: "Next" }, { role: "system", content: "Reminder" },
				] } },
			response: { timestamp: 101, status_code: 200, headers: {}, body: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
			logged_at: new Date(101000).toISOString(),
		}) + "\n");
		run(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("claude-trace utility modes", () => {
	it("documents both utilities and the opt-in system merge in --help", () => fixture((root) => {
		const result = cli(["--help"], root);
		assert.equal(result.status, 0);
		for (const flag of ["--validate", "--export-openai", "--merge-system-messages"]) assert(result.stdout.includes(flag));
		assert(!fs.existsSync(path.join(root, "metadata.json")));
	}));

	it("exports through the main CLI with repeated inputs, diagnostics and independent transformations", () => fixture((root) => {
		for (const filter of [false, true]) {
			for (const merge of [false, true]) {
				const output = path.join(root, `sft-${filter}-${merge}.jsonl`);
				const diagnostics = output + ".diagnostics.json";
				const args = ["--export-openai", "--input", root, "--input", path.join(root, "trace.jsonl"),
					"--output", output, "--diagnostics", diagnostics,
					...(filter ? ["--filter-system-messages"] : []), ...(merge ? ["--merge-system-messages"] : [])];
				const result = cli(args, root);
				assert.equal(result.status, 0, result.stderr);
				const record = JSON.parse(fs.readFileSync(output, "utf8"));
				assert.deepEqual(record.messages.map((message: { content: string }) => message.content),
					merge ? ["TopInline" + (filter ? "" : "Reminder"), "Task", "Next", "Done"]
						: ["Top", "Task", "Inline", "Next", ...(filter ? [] : ["Reminder"]), "Done"]);
				assert.equal(JSON.parse(fs.readFileSync(diagnostics, "utf8")).counts.trace_files, 1);
				const before = fs.readFileSync(output, "utf8");
				assert.equal(cli(args, root).status, 1);
				assert.equal(fs.readFileSync(output, "utf8"), before);
			}
		}
	}));

	it("preserves complete/incomplete validation statuses and exit codes", () => fixture((root) => {
		for (const mode of ["complete", "incomplete"]) {
			const result = cli(["--validate", mode, "--claude-path", process.execPath], root);
			assert.equal(result.status, 0, result.stderr);
			const metadata = JSON.parse(result.stdout);
			assert.equal(metadata.status, mode);
			assert.deepEqual(metadata.validation_errors, []);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "metadata.json"), "utf8")), metadata);
		}
		fs.writeFileSync(path.join(root, "trace.jsonl"), "invalid JSON\n");
		for (const mode of ["complete", "incomplete"]) {
			const result = cli(["--validate", mode, "--claude-path", process.execPath], root);
			assert.equal(result.status, mode === "complete" ? 1 : 0, result.stderr);
			const metadata = JSON.parse(result.stdout);
			assert.equal(metadata.status, "incomplete");
			assert(metadata.validation_errors.length > 0);
		}
	}));

	it("exports without loading unrelated capture-directory settings", () => fixture((root) => {
		const result = cli(["--export-openai", "--input", root, "--output", path.join(root, "output.jsonl")], root, "relative");
		assert.equal(result.status, 0, result.stderr);
	}));

	it("rejects invalid validation arguments and missing or relative log directories with exit 2", () => fixture((root) => {
		const invalid = [
			["--validate"], ["--validate", "other", "--claude-path", process.execPath],
			["--validate", "complete"], ["--validate", "complete", "--claude-path"],
			["--validate", "complete", "--claude-path", process.execPath, "--unknown"],
			["--validate", "complete", "--claude-path", process.execPath, "--claude-path", process.execPath],
		];
		for (const args of invalid) assert.equal(cli(args, root).status, 2, args.join(" "));
		for (const logDir of ["", "relative"]) {
			assert.equal(cli(["--validate", "complete", "--claude-path", process.execPath], root, logDir).status, 2);
		}
		assert(!fs.existsSync(path.join(root, "metadata.json")));
	}));

	it("rejects incomplete, repeated and unknown export options without creating output", () => fixture((root) => {
		const output = path.join(root, "output.jsonl");
		const invalid = [
			["--export-openai"], ["--export-openai", "--input", "--output", output],
			["--export-openai", "--input", root, "--output"],
			["--export-openai", "--input", root, "--output", output, "--diagnostics"],
			["--export-openai", "--input", root, "--output", output, "--output", output],
			["--export-openai", "--input", root, "--output", output, "--unknown"],
			["--merge-system-messages"], ["--filter-system-messages"], ["--input", root],
		];
		for (const args of invalid) assert.equal(cli(args, root).status, 1, args.join(" "));
		assert(!fs.existsSync(output));
		assert(!fs.existsSync(path.join(root, ".claude-trace")));
	}));

	it("rejects conflicting modes and --run-with before any utility writes", () => fixture((root) => {
		for (const mode of ["--validate", "--export-openai"]) {
			for (const conflict of ["--validate", "--export-openai", "--index", "--generate-html", "--extract-token", "--run-with"]) {
				const args = mode === "--validate"
					? [mode, "complete", "--claude-path", process.execPath, conflict]
					: [mode, "--input", root, "--output", path.join(root, "output.jsonl"), conflict];
				assert.equal(cli(args, root).status, mode === "--validate" ? 2 : 1, args.join(" "));
			}
		}
		assert(!fs.existsSync(path.join(root, "metadata.json")));
		assert(!fs.existsSync(path.join(root, "output.jsonl")));
	}));

	it("keeps utility-looking flags after --run-with entirely in client arguments", () => {
		const forwarded = ["--validate", "complete", "--export-openai", "--merge-system-messages", "--help"];
		const parsed = parseTraceArgs(["--no-open", "--run-with", ...forwarded]);
		assert.deepEqual(parsed.traceArgs, ["--no-open"]);
		assert.deepEqual(parsed.toolArgs, forwarded);
	});
});
