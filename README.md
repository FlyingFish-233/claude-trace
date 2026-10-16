# claude-trace

[English](README.md) | [简体中文](README.zh-CN.md)

Record API traffic from **Claude Code**, **OpenCode**, **Codex CLI**, and allowlisted LLM endpoints through a standalone forward proxy. Inspect everything the tools hide — system prompts, tool outputs, thinking blocks, and raw request/response data — in a self-contained HTML viewer.

**Fork lineage:** this repository is forked from [hanqunfeng/claude-trace](https://github.com/hanqunfeng/claude-trace), which was itself forked from [badlogic/lemmy's claude-trace](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace). It extends the project with [Claude Code V2+](https://docs.anthropic.com/en/docs/claude-code) native-binary support, a dedicated **[OpenCode](https://opencode.ai)** CLI with multi-provider interception (Anthropic and OpenAI API formats), and **[Codex CLI](https://developers.openai.com/codex/cli) ChatGPT OAuth** tracing (login via ChatGPT account — the default Codex auth path for most users).

## Proxy modes (forward & reverse)

This project supports **both**:

- **Reverse proxy (built-in tool wrappers)**: `claude-trace`, `opencode-trace`, `codex-trace` start a local reverse proxy and launch the target tool with its upstream base URL redirected to the proxy (so traffic is logged automatically).
- **Forward proxy (standalone)**: `vibe-coding-proxy` starts an HTTP/HTTPS forward proxy only. You must **export `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` before starting the client** you want to trace.

## Supported tools

| Tool | CLI command | Log directory | Interception |
|------|-------------|---------------|--------------|
| **Claude Code** | `claude-trace` | `.claude-trace/` | V1: Node.js `fetch()` hook · V2+: reverse proxy via `ANTHROPIC_BASE_URL` |
| **OpenCode** | `opencode-trace` | `.opencode-trace/` | Reverse proxy + model routing; Anthropic & OpenAI API formats |
| **Codex CLI** | `codex-trace` | `.codex-trace/` | Reverse proxy via `CODEX_HOME` overlay; **ChatGPT OAuth** & OpenAI API Key (Responses API) |
| **Standalone proxy** | `vibe-coding-proxy` | `.vibe-coding-proxy/` | Forward proxy via `HTTP_PROXY` / `HTTPS_PROXY`; allowlist-scoped HTTPS MITM |

All commands share the same HTML report UI, JSONL/JSON export, and `--index` conversation summarization.

## Quick start

```bash
npm install -g @uvl000/claude-trace

# Claude Code
claude-trace

# OpenCode
opencode-trace

# Codex CLI
codex-trace

# Standalone forward proxy
vibe-coding-proxy --target-url https://api.deepseek.com/anthropic
```

When a session ends, the latest HTML report opens in your browser automatically. For Claude Code and Codex tracing, `--no-open` keeps only the JSONL trace; with `--generate-html`, it only suppresses opening the browser.

## Install

### From npm

```bash
npm install -g @uvl000/claude-trace
```

### From source

```bash
git clone https://github.com/FlyingFish-233/claude-trace.git
cd claude-trace
npm run setup   # installs root + frontend dependencies
npm run build
npm link        # optional: global `claude-trace`, `opencode-trace`, `codex-trace`, and `vibe-coding-proxy`
# Without link: node dist/cli/cli.js / node dist/cli/opencode-cli.js / node dist/cli/codex-cli.js / node dist/cli/vibe-coding-proxy-cli.js
```

## Claude Code (`claude-trace`)

### Usage

```bash
# Start Claude Code with logging (auto-detects V1 JS vs V2+ native binary)
claude-trace

# Include all API requests (proxy mode defaults to /v1/messages only)
claude-trace --include-all-requests

# Log auth headers without redaction (use with care)
claude-trace --include-sensitive-headers

# Pass arguments to Claude
claude-trace --run-with chat --model sonnet-3.5

# Custom Claude binary path
claude-trace --claude-path /usr/local/Caskroom/claude-code/2.1.153/claude

# Extract OAuth token (V1 Node.js path)
claude-trace --extract-token

# Generate HTML from a previous .jsonl log
claude-trace --generate-html logs.jsonl report.html

# Generate conversation summaries and searchable index
claude-trace --index

claude-trace --help
```

Logs: `.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}` in the current directory.

### CLI options

| Flag | Description |
|------|-------------|
| `--include-all-requests` | Log all API traffic, not just `/v1/messages` |
| `--include-sensitive-headers` | Log auth tokens and cookies without redaction |
| `--log NAME` | Custom log file base name (without extension) |
| `--claude-path PATH` | Path to Claude binary (auto-detected if omitted) |
| `--no-open` | Claude tracing: write JSONL only; `--generate-html`: don't open browser |
| `--run-with ARGS...` | Pass remaining arguments to Claude |
| `--extract-token` | Extract OAuth token and exit |
| `--generate-html FILE [OUT]` | Generate HTML report from JSONL |
| `--index` | Generate conversation summaries and index |
| `--validate MODE` | Validate `complete`/`incomplete` capture; requires `--claude-path` and absolute `CLAUDE_TRACE_LOG_DIR` |
| `--export-openai` | Export using `--input PATH` (repeatable) and `--output FILE` |
| `--diagnostics FILE` | With export: write per-request diagnostics |
| `--filter-system-messages` | With export: keep only the first inline system message |
| `--merge-system-messages` | With export: merge inline system messages into the leading system message; default off |

### Claude Code V2+ (native binary)

Claude Code V2 ships as a **native binary** (Mach-O / ELF / PE), not a Node.js script. The original `node --require interceptor claude` approach no longer works.

| Claude Code version | Binary type | Interception mode |
|---------------------|-------------|-------------------|
| V1.x | Node.js script | `interceptor-loader.js` via `--require` |
| **V2+** | Native binary | Local reverse proxy; `ANTHROPIC_BASE_URL` redirected |

Flow:

1. Start a local HTTP reverse proxy on `127.0.0.1`
2. Point Claude Code at the proxy via `ANTHROPIC_BASE_URL`
3. Forward traffic to the real upstream (`~/.claude/settings.json` or env)
4. Log request/response pairs to `.claude-trace/` in real time

If `~/.claude/settings.json` already sets `ANTHROPIC_BASE_URL`, a persistent config overlay is used (`~/.claude-trace/claude-config-overlay/`): only `settings.json` is rewritten without that key; other entries are symlinked back to your real config when possible (directory **junctions** on Windows; files fall back to copy). **A failed link for one entry does not block startup** — the proxy still works. Skipped entries are logged only when `CLAUDE_TRACE_DEBUG=1`.

### Third-party models (CC-Switch & custom endpoints)

Works with any setup that routes Claude Code through a custom `ANTHROPIC_BASE_URL` — [CC-Switch](https://github.com/farion1231/cc-switch), LiteLLM, corporate gateways, self-hosted proxies, etc.

```
Claude Code  →  claude-trace proxy (logs)  →  CC-Switch / custom endpoint  →  model provider
```

Example with CC-Switch:

```bash
# CC-Switch writes ~/.claude/settings.json; then:
claude-trace
```

Manual upstream:

```bash
export ANTHROPIC_BASE_URL="https://your-gateway.example.com"
claude-trace
```

Notes:

- Upstream must speak the **Anthropic Messages API** (`/v1/messages`), or use a gateway that translates to it
- API keys and other `env` entries from settings are preserved — only `ANTHROPIC_BASE_URL` is overridden locally
- HTML logs show the actual upstream URL and model name per request

### Request filtering (Claude)

**Proxy mode (V2+):** default `/v1/messages`; `--include-all-requests` logs all proxied traffic.

**Interceptor mode (V1, Node.js):** default logs `/v1/messages` with more than 2 messages in context; `--include-all-requests` logs all `api.anthropic.com` requests.

---

## OpenCode (`opencode-trace`)

### Usage

```bash
# Start OpenCode TUI with logging
opencode-trace

# One-shot prompt
opencode-trace --run-with run "Explain async/await"

# Specific model
opencode-trace --run-with run -m my-deepseek/deepseek-v4-flash "Refactor this module"

# Generate HTML from a previous session
opencode-trace --generate-html .opencode-trace/log-2025-01-01-12-00-00.jsonl

# Conversation index
opencode-trace --index

opencode-trace --help
```

Logs: `.opencode-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}` in the current directory. Proxy runtime errors are appended to `.opencode-trace/proxy-errors.log`.

### How interception works

OpenCode is a native binary. `opencode-trace` starts a local reverse proxy and injects a runtime config override via `OPENCODE_CONFIG_CONTENT` — **your original `opencode.json` is never modified**.

For every provider in your config, all `baseURL` values point at the local proxy. The proxy reads the `model` field from each request body, maps it to the correct provider and real upstream URL, then forwards the request. Supports **Anthropic** (`/v1/messages`) and **OpenAI** formats (`/v1/chat/completions`, `/v1/responses` via `@ai-sdk/openai-compatible` and `@ai-sdk/openai`).

```
OpenCode  →  opencode-trace proxy (logs)  →  provider baseURL (DeepSeek, MiniMax, etc.)
```

Config lookup order:

1. `OPENCODE_CONFIG` environment variable
2. `OPENCODE_CONFIG_DIR/opencode.json`
3. `~/.config/opencode/opencode.json`
4. `.opencode/opencode.json` in the current directory

### Supported API formats

| OpenCode `npm` package | API format | Endpoints | Conversation view label |
|------------------------|------------|-----------|-------------------------|
| `@ai-sdk/anthropic` | Anthropic Messages | `/v1/messages` | Anthropic Messages |
| `@ai-sdk/openai-compatible` | OpenAI Chat Completions | `/v1/chat/completions` | OpenAI Chat |
| `@ai-sdk/openai` | OpenAI Responses | `/v1/responses` | OpenAI Responses |

The proxy reads `model` from each request body and routes to the matching provider `baseURL`. Per-model `npm` overrides are supported when a single provider mixes chat and responses APIs. Provider-level fallback (`providerId/*`) handles models not explicitly listed in `opencode.json`.

### CLI options

| Flag | Description |
|------|-------------|
| `--opencode-path PATH` | Path to OpenCode binary (auto-detected if omitted) |
| `--include-all-requests` | Log all proxied API traffic, not just message endpoints |
| `--include-sensitive-headers` | Log auth tokens without redaction |
| `--log NAME` | Custom log file base name |
| `--no-open` | Don't open generated HTML in browser |
| `--run-with ARGS...` | Pass remaining arguments to OpenCode |

### Debugging

By default, runtime logs are **silent** so they do not pollute OpenCode's TUI input area.

| Output | Default | With `OPENCODE_TRACE_DEBUG=1` |
|--------|---------|-------------------------------|
| Per-request routing (model → provider → upstream) | Hidden | Printed to stderr |
| Proxy errors (e.g. upstream TLS failure) | Written to `.opencode-trace/proxy-errors.log` | Also printed to stderr |

```bash
OPENCODE_TRACE_DEBUG=1 opencode-trace
```

Use this when a model is not routed correctly, requests are missing from the log, or upstream connections fail.

### OpenCode limitations

- **Conversation view** supports Anthropic-format (`@ai-sdk/anthropic`) and OpenAI-format (`@ai-sdk/openai-compatible`, `@ai-sdk/openai`) providers; complex fields (multimodal, reasoning, etc.) may only appear fully in Raw/JSON views.
- Built-in `models.dev` providers not defined in your `opencode.json` are not intercepted yet.

---

## Replay captured requests

Both CLIs can send one captured request to a model server without launching the coding client:

```bash
claude-trace --replay trace.jsonl --line-number 12 --base-url http://127.0.0.1:30011 --output claude-replay.json
codex-trace --replay session.jsonl --line-number 34 --base-url http://127.0.0.1:30011 --model target-model --max-tokens 128
claude-trace --replay trace.jsonl --trace-line 12 --trace-line 15 --concurrency 2 --output claude-replays.json
codex-trace --replay session.jsonl --line-number 1 --line-number 3 --concurrency 2 --output codex-replays.json
```

`--line-number` (alias `--trace-line`) selects a physical, 1-based JSONL line and may be repeated. `--concurrency N` caps simultaneous requests, defaulting to 1. Every selected line is validated before any request is sent; duplicates are rejected. Multi-line results stay in argument order regardless of completion order. A single selected line retains the original record format; multiple lines produce one JSON file with `selected_line_numbers`, `concurrency_limit`, `counts`, and an ordered `results` array of the same per-line records. The command exits nonzero if any replay fails, while keeping all responses. Omit line options to sample one replayable POST request; `--seed N` makes that choice repeatable and cannot be combined with explicit lines. The target URL uses the destination base URL and `/v1/messages` or `/v1/responses`, including Codex traces captured at `/backend-api/codex/responses`. Query parameters from the captured URL are retained. `--model` and `--max-tokens` override the request body; the token field is `max_tokens` for Messages and `max_output_tokens` for Responses. By default replay sets `stream=false`; use `--preserve-stream` to retain streaming and save SSE as text. `--timeout SEC` defaults to 1800.

Captured authentication, cookies, compression, host and transport headers are not forwarded. Use `--api-key-env VAR` to supply a destination key; it is sent as `x-api-key` and Bearer authorization and redacted from the saved record. The JSON record contains the original request, sent request, response body/status and timing. `--output FILE` refuses to overwrite an existing file; without it, records go beside the trace in `replays/`. HTTP and network failures are saved and return exit code 1. Replay is exclusive with other utility modes and `--run-with`.

## Codex CLI (`codex-trace`)

### Export Responses traces for training and chat templates

```bash
codex-trace --export-openai --input .codex-trace --output sft.jsonl --diagnostics diagnostics.json
codex-trace --export-openai --input session.jsonl --output merged.jsonl --convert-developer-to-system --merge-system-messages
```

This offline mode never starts Codex. `--input` accepts any named `.jsonl` file
or a directory recursively and may be repeated. Existing output/diagnostics
files are refused. `--convert-developer-to-system` changes each developer role to
system in place and removes its developer-specific `tools` field.
`--filter-system-messages` then keeps the first system and drops all later ones;
top-level `instructions`, when present, count as the first.
`--merge-system-messages` instead moves all systems to the beginning and joins
their content with `\n\n`. Filter and merge both require developer conversion.
All three flags default off; when combined, the order is convert, filter, merge.
Export conflicts with
other utility modes and live-tracing options; arguments after `--run-with`
remain client arguments.

Conversion follows the **non-Harmony, text** path in the installed vLLM
`0.30.1rc1.dev619+g5f30fc703`: `renderers/online_renderer.py::render_responses`,
`entrypoints/openai/responses/utils.py::construct_input_messages` and
`construct_tool_dicts`, followed by string-content chat preprocessing.
It preserves system/developer/user positions, joins text blocks with newlines,
combines adjacent reasoning/text/function-call items, parses tool argument JSON
into objects, and flattens namespace functions as `namespace__name`.
Both `reasoning` and `reasoning_content` are supplied for template compatibility.

Each output line has `messages`, `tools`, and source `metadata`, like the Claude
exporter. Only observed complete model outputs have `trainable: true`; history,
system messages, and tool results are false. Compatible full histories form a
trajectory; changed or ambiguous histories start a new segment. Duplicate
captures are ignored. JSON and completed SSE responses are supported on both
API-key and ChatGPT `/responses` routes. `metadata.rounds` identifies source
file/line; `metadata.response_message_ranges` gives half-open message indexes
for each round, since a Responses output may contain several assistant messages.
Use these ranges instead of assuming one assistant message per round.

The exporter does not fetch server-side state. `previous_response_id`, stored
conversations, encrypted reasoning, multimodal/builtin/custom tools, partial
responses, and content that would be truncated by vLLM are skipped with explicit
diagnostics. It does not replace the Harmony renderer. `tool_choice=none` uses
vLLM's default behavior of retaining function tool definitions. Template kwargs
are kept in round parameters, not applied by this JSONL exporter.

Programmatic exports: `exportCodexOpenAI(inputs, output, diagnostics?, options?)`
and `convertResponsesRequest(body, options?)`. All three system options default off.
The latter returns template-ready `messages/tools` for one self-contained
request; the former adds trajectory and training provenance. For independent
prompt comparisons, render each round's prefix ending at its response range's
`start`, with the destination tokenizer/template and matching template kwargs.

For the current Qwen template, use `--convert-developer-to-system` with
`--merge-system-messages` to export the developer conversion and system consolidation normally done by vLLM's HF
renderer. The resulting messages can be rendered directly with this template.
Leave the transformations off for templates that accept the original roles and positions; the
exporter does not detect the destination template. Filtering is optional and
discards instructions, so leave it off when reproducing the complete prompt.
These Codex options have their own `ExportCodexOpenAIOptions` programmatic type;
Claude export retains its existing inline-only filter and concatenation semantics.

**Primary auth mode: ChatGPT OAuth.** If you use Codex signed in with your ChatGPT account (the default for most installs), `codex-trace` fully supports tracing that path — multi-turn conversations, zstd-compressed requests, and SSE streaming responses appear correctly in HTML reports.

### Usage

```bash
# Start Codex TUI with logging (ChatGPT OAuth or API Key)
codex-trace

# One-shot headless prompt
codex-trace --run-with exec "Explain async/await"

# Generate HTML from a previous session
codex-trace --generate-html .codex-trace/log-2025-01-01-12-00-00.jsonl

# Conversation index
codex-trace --index

codex-trace --help
```

Logs: `.codex-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}` in the current directory. With `--no-open`, only `.jsonl` is written.

### ChatGPT OAuth mode (recommended)

Most users run Codex with **ChatGPT login** (`codex login` or the TUI sign-in flow). `codex-trace` reads `~/.codex/auth.json` and, when `auth_mode` is `"chatgpt"`, routes all LLM traffic to the ChatGPT OAuth upstream (`chatgpt.com/backend-api/codex`) — **even if `OPENAI_BASE_URL` is set in your shell** for other tools (Cursor, LiteLLM, etc.).

| Check | Expected |
|-------|----------|
| Auth file | `~/.codex/auth.json` contains `"auth_mode": "chatgpt"` |
| Session data | Symlinked from your real `$CODEX_HOME`; OAuth tokens are not rewritten |
| HTML report | Multi-turn threads show each assistant reply, including the final turn |

```
Codex CLI (ChatGPT OAuth)  →  codex-trace proxy (logs)  →  chatgpt.com/backend-api/codex
```

**Tip:** Log in to Codex with ChatGPT *before* starting `codex-trace`. Switching auth inside Codex without restarting the trace session may require a fresh `codex-trace` run.

### OpenAI API Key mode

If you use Codex with an **OpenAI API Key** instead of ChatGPT login, traffic is routed via `openai_base_url` / `OPENAI_BASE_URL` / `api.openai.com` (or your custom gateway). Do not mix ChatGPT OAuth tokens with a custom `OPENAI_BASE_URL` gateway — use one auth mode at a time.

### How interception works

Codex CLI is a native Rust binary. `codex-trace` starts a local reverse proxy and builds a config overlay at `~/.claude-trace/codex-config-overlay/` — **your original `~/.codex/config.toml` is never modified**.

The overlay rewrites `openai_base_url`, `chatgpt_base_url`, and custom `model_providers.*.base_url` to point at the proxy. `auth.json` and session data are symlinked so ChatGPT OAuth continues to work. The proxy picks the upstream from **`auth.json` auth mode** (ChatGPT OAuth vs API Key) and request path:

- **ChatGPT OAuth** (`auth_mode: "chatgpt"`): `/responses`, `/v1/responses`, `/backend-api/codex/...` → `chatgpt.com`
- **ChatGPT Apps MCP** (`codex_apps`): `/api/codex/apps` → `chatgpt.com/backend-api/wham/apps`; `/backend-api/wham/...` → `chatgpt.com` (site origin)
- **OpenAI API Key**: `/v1/responses`, `/responses` → `openai_base_url` / `OPENAI_BASE_URL` / default OpenAI host
- **Custom `model_providers`**: non-reserved provider IDs with explicit `base_url`

```
Codex CLI  →  codex-trace proxy (logs)  →  chatgpt.com (OAuth) / api.openai.com / custom provider
```

Config lookup: `CODEX_HOME` (overlay) or `~/.codex/config.toml`.

### CLI options

| Flag | Description |
|------|-------------|
| `--codex-path PATH` | Path to Codex binary (auto-detected if omitted) |
| `--include-all-requests` | Log all proxied API traffic, not just LLM API paths |
| `--include-sensitive-headers` | Log auth tokens without redaction |
| `--log NAME` | Custom log file base name |
| `--no-open` | Live tracing: write JSONL only; `--generate-html`: don't open browser |
| `--run-with ARGS...` | Pass remaining arguments to Codex |

### Codex limitations

- WebSocket Responses transport is disabled in the overlay (`supports_websockets = false`) so HTTP/SSE traffic can be logged.
- Built-in provider IDs (`openai`, `ollama`, `lmstudio`) cannot be overridden via `model_providers`; ChatGPT OAuth uses `chatgpt_base_url`, API Key mode uses `openai_base_url`.
- **Ollama / LM Studio** built-in providers are not intercepted (traffic bypasses the proxy).
- Older `auth.json` files without `auth_mode` fall back to legacy heuristics; re-login with ChatGPT if OAuth routing misbehaves.
- **Node.js:** Codex ChatGPT OAuth tracing works on **Node.js 16+** (the proxy forwards zstd request bodies unchanged). **Node.js 22+** is recommended so zstd-compressed request bodies are decompressed in logs and HTML; on Node 16–21, request entries show a placeholder instead of parsed JSON (responses and proxy behavior are unaffected).

---

## Standalone forward proxy (`vibe-coding-proxy`)

`vibe-coding-proxy` starts only the proxy service. It does not spawn Claude Code, OpenCode, Codex, or any other client. Point any compatible CLI at the printed proxy URL with `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`.

### Compatibility & usage order

- **Tested clients**: Claude Code, OpenCode, Codex CLI. Other clients may work if they respect standard proxy env vars, but are not tested yet.
- **Order matters**: start `vibe-coding-proxy` → export env vars in the same shell/session → then start your client/tool. If you start the client first, it may not pick up the proxy settings.

### Usage

```bash
# Log a specific DeepSeek Anthropic-compatible endpoint
vibe-coding-proxy --target-url https://api.deepseek.com/anthropic

# Log every HTTPS request on a host
vibe-coding-proxy --mitm-host api.deepseek.com

# Use a fixed local port
vibe-coding-proxy --target-url https://api.deepseek.com --port 8888

# Generate HTML from a previous .jsonl log
vibe-coding-proxy --generate-html .vibe-coding-proxy/log-2025-01-01-12-00-00.jsonl
```

After startup, export the printed proxy URL:

```bash
export HTTP_PROXY=http://127.0.0.1:PORT
export HTTPS_PROXY=http://127.0.0.1:PORT
export ALL_PROXY=http://127.0.0.1:PORT
export NODE_TLS_REJECT_UNAUTHORIZED=0
export SSL_CERT_FILE=CA_CERT_PATH
```

Logs: `.vibe-coding-proxy/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}` in the current directory.

### HTTPS logging and CA trust

HTTPS requests sent through `HTTPS_PROXY` normally use `CONNECT host:443`, which hides JSON bodies from the proxy. To log request/response bodies, `vibe-coding-proxy` performs MITM only for `--target-url` / `--mitm-host` allowlist entries and prints a local CA certificate path.

Trust that CA only in clients whose model traffic you want to inspect. The command never installs the CA into your system trust store automatically. `NODE_TLS_REJECT_UNAUTHORIZED=0` only helps Node.js clients; Codex ChatGPT OAuth is a Rust client and may require `SSL_CERT_FILE` or OS-level trust for the printed CA. Non-allowlisted HTTPS traffic is passed through as a raw CONNECT tunnel and only logged as metadata when `--include-all-requests` is enabled.

### Local CA lifecycle

The local CA is reused across proxy runs from `~/.claude-trace/vibe-coding-proxy-ca/` unless you pass `--ca-dir`. `ca.crt` is valid for 10 years; per-host leaf certificates such as `api.deepseek.com.crt.pem` are valid for 1 year. Expired leaf certificates are reissued automatically. If the CA expires, it is regenerated and all cached leaf certificates are removed; you must trust the new CA again.


### CLI options

| Flag | Description |
|------|-------------|
| `--target-url URL` | URL prefix to decrypt and fully log (repeatable) |
| `--mitm-host HOST` | Hostname to decrypt and fully log (repeatable) |
| `--host HOST` | Listen host (default `127.0.0.1`) |
| `--port PORT` | Listen port (default `0`, random) |
| `--log-dir DIR` | Log directory (default `.vibe-coding-proxy`) |
| `--log NAME` | Custom log file base name |
| `--ca-dir DIR` | Local CA and leaf certificate cache directory |
| `--no-mitm` | Disable TLS MITM; HTTPS CONNECT is pass-through only |
| `--include-all-requests` | Log pass-through CONNECT metadata and non-target HTTP traffic |
| `--include-sensitive-headers` | Log auth headers without redaction |
| `--no-open` | Don't open generated HTML on exit |
| `--generate-html FILE [OUT]` | Generate HTML report from JSONL |

---

## Shared features

### HTML report

By default, each session produces a self-contained HTML file (embedded CSS/JS) you can open offline, and the browser opens on exit. For Claude Code and Codex, `--no-open` records JSONL only; generate a report later with `--generate-html trace.jsonl --no-open`. For OpenCode and the forward proxy, `--no-open` keeps report generation and suppresses the browser.

### What you'll see

- **System prompts** — hidden instructions sent to the model
- **Tool definitions & outputs** — parameters and raw tool results
- **Thinking blocks** — internal reasoning (when present)
- **Token usage** — detailed breakdown including cache hits
- **Raw JSONL logs** — complete request/response pairs
- **Interactive viewer** — conversation, raw HTTP, and JSON debug tabs
- **API format label** — each conversation shows its request format (e.g. `8 messages · OpenAI Chat`) in the session header

### Conversation index

```bash
claude-trace --index
# or
opencode-trace --index
# or
codex-trace --index
```

Scans log files, summarizes meaningful conversations via Claude CLI, and generates a searchable `index.html`. **Note:** indexing uses additional API tokens.

### Trace validation

```bash
export CLAUDE_TRACE_LOG_DIR=/absolute/path/to/trace-directory
claude-trace --validate complete --claude-path /path/to/claude
claude-trace --validate incomplete --claude-path /path/to/claude
```

Checks `trace.jsonl` for valid request/response structure, successful Messages API exchanges and header redaction; writes `metadata.json` and JSON metadata to stdout. Validation may remove secret material from the trace. `complete` declares normal capture completion: failed checks mark it incomplete and exit 1. `incomplete` declares interrupted capture: checks still run, status remains incomplete, and findings alone do not cause a nonzero exit. Invalid validation arguments or a missing/non-absolute log directory exit 2. This does not assess task correctness.

### OpenAI SFT export

```bash
claude-trace --export-openai --input /path/to/run-a --input /path/to/run-b/trace.jsonl --output sft.jsonl
# Optional: --diagnostics diagnostics.json --filter-system-messages --merge-system-messages
```

Directory inputs are searched recursively for `trace.jsonl`. The command refuses to overwrite existing output and creates only the JSONL file by default. Use `--diagnostics FILE` to save request-level diagnostics; skipped and duplicate requests are also reported in the command output. Each JSONL row contains `messages`, `tools`, and `metadata`. Historical messages have `trainable: false`; each captured assistant response has `trainable: true` and a corresponding entry in `metadata.response_sources`.

By default, top-level request `system` becomes a leading system message, while inline system messages retain their relative positions and separate boundaries. Add `--merge-system-messages` to concatenate all system text into the leading message, restoring the previous behavior. `--filter-system-messages` independently keeps only the first inline system message before optional merging; it does not filter the top-level system. Billing-header text is omitted in both modes, and system messages have `trainable: false`. Without merging, later inline system messages can extend a continuous trajectory; merging retains segmentation on changed combined system text. To render the final request prompt, apply the chat template to `messages.slice(0, -1)` with `tools` and `add_generation_prompt=true`; the final assistant response remains in the SFT trajectory.

Only successful `POST /v1/messages` exchanges become training targets. History changes, including compaction, create separate rows; output from a segment ending at a history break may contain tool calls without subsequent tool results. The exporter uses only HTTP traces, does not read Claude session files, and does not generate token-level loss masks.

Validation and export do not start Claude and cannot be combined with other utility modes or `--run-with`. Export-specific options require `--export-openai`. In tracing mode, arguments after `--run-with` remain client arguments. Standalone `claude-trace-validate` and `claude-trace-export-openai` commands and offline launchers are removed without aliases; migrate callers before adopting a new package.

## Requirements

- Node.js 16+ (Node.js 22+ recommended for full Codex OAuth request-body display in logs)
- **Claude Code** CLI (V1 Node.js or V2+ native binary) for `claude-trace`
- **OpenCode** CLI for `opencode-trace`
- **Codex CLI** for `codex-trace`

## Development

```bash
npm run setup    # first time
npm run dev      # watch mode; preview at http://localhost:8080/test
npm run build
npm run typecheck
npm run test:unit
```

### Architecture

**Backend** (`src/`):

- **CLI** (`cli/cli.ts`, `cli/opencode-cli.ts`, `cli/codex-cli.ts`, `cli/cli-common.ts`) — thin entry points and shared arg parsing
- **Trace Runner** (`cli/trace-runner.ts`) — shared launch + proxy/interceptor dispatch
- **Tool Profiles** (`tools/claude.ts`, `tools/opencode.ts`, `tools/codex.ts`, `tools/binary-utils.ts`) — per-tool config, binary detection, upstream resolution
- **Config Overlays** (`config/claude-config-overlay.ts`, `config/codex-config-overlay.ts`) — persistent proxy overlays without modifying user config
- **Reverse Proxy** (`intercept/reverse-proxy.ts`) — native-binary interception, real-time HTML generation
- **Interceptor** (`intercept/interceptor.ts`) + **Loader** (`intercept/interceptor-loader.js`, `intercept/token-extractor.js`) — Claude Code V1
- **Routing** (`routing/proxy-routing.ts`, `routing/codex-routing.ts`) — OpenCode model routes and Codex path/auth upstream selection
- **API Format** (`adapt/api-format.ts`) — format detection and display labels
- **OpenAI Adapter** (`adapt/openai-adapter.ts`) — OpenAI request/response → Anthropic `Message` for the viewer
- **Report** (`report/html-generator.ts`, `report/index-generator.ts`, `report/shared-conversation-processor.ts`) — HTML generation and shared conversation parsing

**Frontend** (`frontend/src/`): Lit + Tailwind interactive viewer embedded into HTML reports.

## Documentation

Maintainer and contributor docs live under [`doc/`](doc/):

| Document | Description |
|----------|-------------|
| [doc/publishing/oidc.md](doc/publishing/oidc.md) | Recommended npm release via GitHub Actions OIDC |
| [doc/github-actions-workflow-guide.md](doc/github-actions-workflow-guide.md) | GitHub Actions workflow reference and examples |
| [doc/npm-v12-security-changelog.md](doc/npm-v12-security-changelog.md) | npm v12 install-time security and GAT deprecation notes |

## License

MIT — maintained at [FlyingFish-233/claude-trace](https://github.com/FlyingFish-233/claude-trace), forked from [hanqunfeng/claude-trace](https://github.com/hanqunfeng/claude-trace), which was forked from [badlogic/lemmy's claude-trace](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace).
