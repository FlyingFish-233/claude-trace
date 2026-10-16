# Version 5 breaking changes / 迁移说明

Only this repository is updated. External WorkflowExp must migrate its own call sites before upgrading; it is not edited or deployed here. Historical captures remain untouched.

| Old interface | Version 5 |
| --- | --- |
| `claude-trace/codex-trace/opencode-trace --export-openai ...` | `llm-trace export --input PATH --output FILE` |
| client `--validate-trace ...` | `llm-trace validate --input PATH --output FILE [--outcome incomplete]` |
| client `--replay ...` | `llm-trace replay --input FILE --line-number N --base-url URL` |
| client `--generate-html` / index modes | `llm-trace report --input PATH --output FILE` |
| `--merge-system-prompt` and old system aliases | `llm-trace export --merge-system-messages` |
| `--run-with ARGS` | `-- ARGS` |
| `--claude-path` / per-client binary flags | `--binary PATH` |
| `--log NAME`, `--no-open`, `--jsonl-only` | `--log-dir UNIQUE_RUN_DIR`; raw-only is now the default |
| automatic JSON/HTML during capture | offline export/report |
| `exportOpenAI`, `exportCodexOpenAI`, old option types | `exportTraces`, `ExportOptions` |
| `codex: boolean` / client-based protocol switches | `ProtocolAdapter` registry keyed by wire format |
| `--preserve-stream` | `--stream preserve` (default), `on`, or `off` |
| old unversioned trace / arbitrary directory JSONL scan | schema-v2 records and manifest discovery |
| Node fetch hook / token extraction | reverse proxy for all supported client executables |

WorkflowExp callers should create a unique capture directory per run, read `manifest.json` / `trace.jsonl`, then invoke the generic offline commands. Inspect `capture_complete`, `protocol_valid`, `http_success`, and `model_complete` separately. `--outcome incomplete` remains incomplete. Export system transformations all default off; enable only the desired policies explicitly. Replay now requires an explicit line or seed and explicit target prefix. Target credentials must come from a named environment variable.

The offline Claude wrapper now uses `--binary ... -- "$@"`; bundle producers must copy all `offline/bin` launchers, including `llm-trace`, and use Node 20+. Package version is 5.0.0; there is no compatibility shim or data migration.
