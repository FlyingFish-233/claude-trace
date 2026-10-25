# claude-trace 5

Documentation (中文): [npm publishing](doc/npm-publishing.md) · [Architecture](doc/architecture.md) · [CLI usage](doc/usage.md) · [vLLM/Qwen training export](doc/vllm-qwen-export.md).

Capture and inspect LLM HTTP traffic independently of the client. Three protocol adapters support `anthropic-messages`, `openai-responses`, and `openai-chat-completions`. Claude Code, Codex and OpenCode have capture launchers; other clients can set their base URL manually.

Requires Node.js 20+. Build from source with `npm install`, `npm --prefix frontend install`, and `npm run build`. Run `node dist/cli/llm-trace.js --help`, or use the npm bin entry points after installing this package. No client is needed for offline commands.

## Commands

```sh
llm-trace capture --upstream https://provider.example/v1 --log-dir captures/run-001
# Point any client's API base URL at the printed loopback URL.
llm-trace validate --input captures/run-001 --output validation.json
llm-trace export --input captures/run-001 --output training.jsonl
llm-trace report --input captures/run-001 --output report.html
llm-trace replay --input captures/run-001/trace.jsonl --line-number 1 \
  --base-url https://target.example/v1 --api-key-env TARGET_API_KEY --output replay/run-001

claude-trace --log-dir captures/claude-001 -- --print "hello"
codex-trace --log-dir captures/codex-001 -- exec "hello"
opencode-trace --log-dir captures/opencode-001 -- run "hello"
```

`capture` starts only a reverse proxy. It defaults to `127.0.0.1` and an ephemeral port. `--host` and `--port` override binding; `--api-format auto|FORMAT` overrides per-request format detection. One generic proxy has one upstream. Existing profiles retain provider and model routing. The printed proxy root can be used with clients that append `/v1` or the operation themselves; a `/v1` already present in the upstream prefix is not duplicated. An upstream URL must not contain credentials, a query or a fragment.

Client launchers accept `--log-dir`, `--binary`, `--api-format`, and `--include-sensitive-headers`. All arguments after `--` go to the client. Defaults create unique runs below `.claude-trace`, `.codex-trace`, or `.opencode-trace`. Config overlays preserve original user config. Client name/version are recorded when available; version lookup happens only when launching a client.

`vibe-coding-proxy --log-dir captures/forward-001 --mitm-host api.example.com` provides an independent forward proxy. Use `--target-url` or `--mitm-host` repeatedly to scope HTTPS inspection. Trust the printed CA in the client, e.g. via `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS`. Other CONNECT destinations are tunneled without body capture. `--no-mitm` disables TLS inspection. `--include-all-requests` also captures non-target plain/decrypted HTTP exchanges. No CA is installed automatically.

## Artifacts and semantics

Each run directory contains only `manifest.json` and append-only `trace.jsonl` by default. One schema-v2 line represents one HTTP attempt, including retries, with run/request IDs, protocol, request, native JSON response or full raw SSE, status/error and millisecond timings (start, headers, first chunk, end). Compression is decoded for inspection only; undecodable bytes are retained as base64. Forwarded payloads are unchanged. Unknown protocols are retained with diagnostics. Interrupted streams, client cancellation and graceful stop preserve partial records; SIGKILL/power-loss recovery is not promised.

Authorization, cookies and other configured sensitive headers are redacted by default. This is header redaction, not a general prompt/body/query scrubber. Raw preservation is subject to this rule. `--include-sensitive-headers` is an explicit capture opt-out. Validate diagnoses unredacted credentials; it never rewrites input.

Offline `--input` is repeatable for export, validate and report. Explicit files are accepted; directories discover only schema-v2 manifest-owned traces recursively, avoiding training exports and replay reports. Existing output files and capture directories are not overwritten. Historical schema-v1 logs are not supported or modified.

### Export

Output is JSONL of `messages + tools + metadata`. `trainable: true` marks actual complete successful assistant returns; historical messages are false. Protocol, source line/request IDs, usage, reasoning provenance and segmentation reasons are recorded. Unsupported multimodal/tool structures and incomplete/failed responses are skipped with reasons in `<output>.diagnostics.json`. Responses reasoning text is separate from summaries; encrypted reasoning remains in raw records and is marked in provenance.

All transformations default off and apply after normalization, in this order:

1. `--convert-developer-to-system`: convert developer in place; diagnose semantics that cannot be preserved.
2. `--filter-system-messages`: retain only the first system message.
3. `--merge-system-messages`: join remaining systems with two newlines and move them to the beginning.

`--merge-system-separator TEXT` overrides the separator only when merging is enabled.
For vLLM Messages targets that concatenate inline systems without a delimiter, use
`--merge-system-messages --merge-system-separator ''`. The default remains two newlines
for every protocol. Export normalization removes billing attribution from system
content, joins OpenAI text blocks with newlines and emits Responses function fields
in stable template order. Raw capture and replay requests retain their original content.

Anthropic `system` and Responses `instructions` first become leading system messages. Filter/merge work without developer conversion. Association uses pre-transformation histories, partitioned by run, protocol and explicit session header. Changed tools, ambiguity, compaction or divergent histories create new segments. No cross-run merging.

### Validate and report

Validation writes an independent JSON report distinguishing capture completeness, protocol validity, HTTP success and model completion. By default, non-POST auxiliary traffic and aborted attempts remain in `entries` with `excluded: true` but do not fail the overall result; at least one model request must remain, and duplicate IDs, unredacted headers, invalid timing and incomplete run outcomes still fail. Use `--strict` to require every recorded request to pass, including auxiliary and aborted attempts. A fully captured 401/429 can be a valid complete capture but is not a training target. Length-limited results are separate from malformed protocol data. Tool history is checked without requiring a result for the final newly generated tool call. `--outcome incomplete` cannot be upgraded. Exit codes: 0 valid/complete; 1 invalid/incomplete; 2 CLI usage error. `report` generates the self-contained conversation viewer offline; validation remains available through `validate`.

### Replay

Supply `--base-url` as the complete API prefix (e.g. `https://host/v1`, not the operation endpoint), and repeat `--line-number N` for selected physical lines of one trace file. Alternatively use `--seed N [--count N]` for deterministic sampling. Selection modes are mutually exclusive. `--output DIR` defaults to a new `replay-<timestamp>` directory.

`--stream preserve|on|off` defaults to preserve. `--model`, `--max-tokens`, `--concurrency` (default 1), `--timeout-ms` (default 120000), and `--api-key-env` configure the target. Token fields are mapped by protocol. Source authentication is never reused; the target key becomes `x-api-key` for Messages or Bearer authorization for OpenAI protocols. `--auth-scheme protocol|bearer|x-api-key` defaults to `protocol`; select `bearer` explicitly for targets such as vLLM that require it even on Messages. Responses server-history references (`previous_response_id`, `conversation`, `previous_input_messages`) are rejected before sending. Parameters are otherwise retained. No cross-protocol translation, tool execution, or automatic next turn.

Replay writes a fresh standard capture plus `replay.json` with source indices and independent outcomes. The actual sent request is in the new trace and can be validated, exported and reported again. HTTP 200 alone is not model success.

## Development and migration

Run `npm run typecheck`, `npm run test:unit`, and `npm run build`. Mock upstream tests cover protocols, raw preservation, cancellation, history association, replay and controlled profile launchers. The build removes stale dist files. `scripts/pack-workflowexp.sh` checks all entry points and requires a clean Git worktree before producing a package; it does not publish.

See [MIGRATION.md](MIGRATION.md) for removed interfaces and external WorkflowExp call-site changes. No external project, installed runtime or historical trace is migrated automatically.

Built/offline acceptance: `npm run test:built` (after build; local temporary npm tarball only).
