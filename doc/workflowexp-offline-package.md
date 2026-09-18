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

The package uses the local-only version `3.0.13-workflowexp.1`. It is not
published to npm. Production dependencies are bundled so the next packaging
stage can use npm's offline mode.

## Build the Node-inclusive bundle

```bash
cd /raid/zwx/WorkflowExp
bash pier/build_claude_trace_offline.sh \
  /raid/zwx/claude-trace/releases/hanqunfeng-claude-trace-3.0.13-workflowexp.1.tgz \
  /raid/zwx/claude-trace-linux-x64-3.0.13-workflowexp.1-node22.23.2.tgz
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
claude-trace-validate complete "$HOME/.local/bin/claude-real"
```

Without `CLAUDE_TRACE_LOG_DIR`, the normal `claude-trace` command continues to
write to `.claude-trace` in the current directory.
