# claude-trace development guide

Read README.md for commands and MIGRATION.md for breaking changes. Do not use superpowers skills.

## Invariants

- Edit source, then run `npm run typecheck`, `npm run test:unit`, `npm run build`.
- New/materially edited TypeScript must have an English `@file` header and JSDoc for public behavior.
- Node 20+. Build cleans dist before compiling so deleted exports cannot survive.
- Never normalize payloads during forwarding. Store native JSON or raw SSE and apply header redaction only according to capture policy.
- Do not add client-name branches to capture/export/validate/replay. Client profiles provide launch/config/routing only.
- Defaults write trace.jsonl and manifest.json, no live HTML. Offline commands never resolve or spawn clients.
- Use schema-v2 records only. No legacy CLI aliases, old export APIs, or history conversion.
- No cross-protocol replay, tool execution, agent reruns, or server-history restoration.
- Never publish packages or replace installations as part of local validation.

## Architecture

`cli/llm-trace.ts` dispatches generic capture/export/validate/report/replay.
`cli/client-launcher.ts` + `trace-runner.ts` launch existing ToolProfiles through a reverse proxy.
`intercept/transport.ts` shares raw HTTP lifecycle and cancellation handling across reverse and forward proxies.
`trace/store.ts` owns schema-v2 records, header redaction, timings, manifests and manifest-scoped discovery.
`protocols/types.ts` and `registry.ts` define the three format adapters, native JSON/SSE parsing, completion checks, conversions and replay request mapping.
`trace/offline.ts` owns shared export policy and trajectory association, and independent read-only validation reports.
`trace/replay.ts` owns selection, target auth, timeouts, workers and provenance.
`trace/report.ts` owns the generic offline HTML report. Raw data must never be replaced with display objects.

Existing Claude/Codex config overlays and OpenCode provider/model routing are kept. HTTPS forward proxy inspection remains allowlist scoped with explicit client CA trust. New clients may use the generic proxy; adding automatic launch support needs only a profile and thin bin.

## Options and tests

Export options apply in fixed order: convertDeveloperToSystem, filterSystemMessages, mergeSystemMessages. All false by default. Association uses histories before these transforms.
mergeSystemSeparator defaults to two newlines and requires merging; an explicit empty string supports vLLM Messages concatenation. Preserve template normalization regressions: billing attribution is excluded from derived systems, OpenAI text blocks use newlines, and Responses function fields have stable serialization order. These rules must never alter captured or forwarded payloads.
Validation separates capture completeness, protocol validity, HTTP outcome and model completion. Complete HTTP errors are not successful training samples. Do not mutate inputs.
Replay preserves stream and parameters by default, requires line selection or seed and an explicit full API prefix, and never reuses original authentication.
Add meaningful mock-upstream tests for protocol/transport changes, including raw payload equality, streaming interruption, cancellation and profile configuration overrides. Test compiled CLI and offline bundle entry points after building. `scripts/pack-workflowexp.sh` requires a clean Git checkout.

Built/offline acceptance: `npm run test:built` (after build; local temporary npm tarball only).
