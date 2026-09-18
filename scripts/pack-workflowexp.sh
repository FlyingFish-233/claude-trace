#!/usr/bin/env bash
set -euo pipefail

if (($# != 1)); then
  echo "Usage: $0 OUTPUT_DIRECTORY" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to package a dirty git worktree" >&2
  exit 1
fi

output_dir="$(realpath -m "$1")"
mkdir -p "$output_dir"
pack_result="$(mktemp)"
trap 'rm -f -- "$pack_result"' EXIT

npm ci --ignore-scripts
npm --prefix frontend ci --ignore-scripts
npm run typecheck
npm run test:unit
npm run build
node dist/cli/cli.js --help >/dev/null
npm pack --ignore-scripts --json --pack-destination "$output_dir" >"$pack_result"

filename="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))[0].filename" "$pack_result")"
package_tgz="$output_dir/$filename"
sha256sum "$package_tgz" >"$package_tgz.sha256"

PACK_RESULT="$pack_result" PACKAGE_TGZ="$package_tgz" GIT_COMMIT="$(git rev-parse HEAD)" \
  node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const pack = JSON.parse(fs.readFileSync(process.env.PACK_RESULT, "utf8"))[0];
    const bytes = fs.readFileSync(process.env.PACKAGE_TGZ);
    const metadata = {
      schema_version: 1,
      package_name: pack.name,
      package_version: pack.version,
      filename: pack.filename,
      git_commit: process.env.GIT_COMMIT,
      npm_integrity: pack.integrity,
      npm_shasum: pack.shasum,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
    fs.writeFileSync(`${process.env.PACKAGE_TGZ}.json`, `${JSON.stringify(metadata, null, 2)}\n`);
  '

echo "Created $package_tgz"
cat "$package_tgz.sha256"
