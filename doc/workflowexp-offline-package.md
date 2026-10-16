# WorkflowExp offline package

This fork carries the runtime behavior needed by WorkflowExp/Pier directly in
the TypeScript sources. The WorkflowExp bundle builder must not patch installed
JavaScript files.

## Build the local npm tarball

The repository must be clean and committed before packaging:

```bash
cd /raid/zwx/claude-trace
bash scripts/pack-workflowexp.sh /raid/zwx/claude-trace/releases
```

The command runs locked installs, type checking, unit tests, the backend and
frontend builds, a CLI smoke test, and `npm pack --ignore-scripts`. It produces
the npm tarball plus `.sha256` and `.json` provenance sidecars.

The tarball uses the version from the repository's `package.json`. It is a
WorkflowExp staging artifact and is not published to npm. Production
dependencies are bundled so the next packaging stage can use npm's offline
mode.

## Build the Node-inclusive bundle

```bash
cd /raid/zwx/WorkflowExp
bash pier/build_claude_trace_offline.sh \
  /raid/zwx/claude-trace/releases/<generated-package-tarball>.tgz \
  /raid/zwx/claude-trace-linux-x64-<version>-node22.23.2.tgz
```

The final bundle contains Node 22.23.2, the self-contained npm package,
relative-path launchers, a manifest, and per-file checksums. Task containers do
not need npm, a system Node installation, or network access.

## Runtime interfaces

Set an absolute log directory for Pier:

```bash
export CLAUDE_TRACE_LOG_DIR=/logs/agent/claude-trace
```

Validate a completed trace:

```bash
claude-trace --validate complete --claude-path "$HOME/.local/bin/claude-real"
```

Without `CLAUDE_TRACE_LOG_DIR`, the normal `claude-trace` command continues to
write to `.claude-trace` in the current directory.

Use `--validate incomplete` for interrupted captures: checks and metadata are
still produced, but the status remains incomplete and validation findings alone
do not cause a nonzero exit. Complete mode exits 1 on validation failures;
invalid validation arguments or log directories exit 2. Validation can redact
secret material in `trace.jsonl` and writes `metadata.json`.

Export with the same launcher:

```bash
claude-trace --export-openai --input /logs/agent/claude-trace --output /logs/sft.jsonl
```

Inline system messages stay in their original positions by default. Add
`--merge-system-messages` to hoist them into the leading system message.

The standalone validation/export commands and offline launchers have been
removed, without compatibility aliases. Downstream WorkflowExp callers, tests
and bundle-builder checks must migrate to `bin/claude-trace --validate ...` and
`bin/claude-trace --export-openai ...` before adopting a new bundle. This repository
does not update deployed bundles or the WorkflowExp repository.
