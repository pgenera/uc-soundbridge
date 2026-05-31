#!/usr/bin/env bash
# Build an on-remote-installable .tgz for the Unfolded Circle Remote Two/3.
#
# Layout (observed empirically): the remote validates the presence of a
# `bin/` directory and then extracts its contents to `/app/`. Anything
# outside `bin/` (other than driver.json) appears to be discarded, so
# node_modules MUST live inside `bin/`.
#
#   driver.json          metadata (root, kept)
#   bin/driver.js        entry point (lands at /app/driver.js)
#   bin/*.js, *.js.map   compiled sources (land at /app/)
#   bin/node_modules/    production deps (land at /app/node_modules/)
#
# Constraints enforced by this script:
#   - .tgz max 100 MB
#   - port in driver.json must be outside 8000-9200 and != 13333
#   - icon files (if any) ≤ 32 KB
#
# Usage:
#   docker run --rm -v "$PWD":/app -w /app -u "$(id -u):$(id -g)" node:22 \
#       bash scripts/package-remote.sh
#
# Output:
#   uc-soundbridge-remote-<version>.tgz at the repo root.

set -euo pipefail

# Ports the remote uses for its own services — custom integrations cannot
# bind anything in this range.
readonly RESERVED_PORT_LOW=8000
readonly RESERVED_PORT_HIGH=9200
readonly RESERVED_EXTRA=13333

# Port the driver will bind on the remote. The env var
# UC_INTEGRATION_HTTP_PORT on the remote can still override this — the
# value here is just the default listed in driver.json.
readonly REMOTE_PORT="${REMOTE_PORT:-9990}"

if [[ "$REMOTE_PORT" -ge "$RESERVED_PORT_LOW" && "$REMOTE_PORT" -le "$RESERVED_PORT_HIGH" ]] ||
   [[ "$REMOTE_PORT" -eq "$RESERVED_EXTRA" ]]; then
  echo "ERROR: port $REMOTE_PORT is reserved by the remote firmware" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "==> Compiling TypeScript"
npm run build > /dev/null

echo "==> Staging into $STAGE"
# Remote runtime invokes /app/driver.js after extracting bin/* into /app.
mkdir -p "$STAGE/bin"
cp -r dist/. "$STAGE/bin/"
# dist/ also contains a stale driver.json copy from tsc's resourceful
# inclusion; we rewrite the canonical one below.
rm -f "$STAGE/bin/driver.json"

# Custom icon referenced from driver.json (must be ≤ 32 KB per UC docs).
if [[ -f soundbridge.png ]]; then
  ICON_SIZE=$(stat -c%s soundbridge.png)
  if (( ICON_SIZE > 32 * 1024 )); then
    echo "ERROR: soundbridge.png is $ICON_SIZE bytes, exceeds 32 KB icon limit" >&2
    exit 1
  fi
  cp soundbridge.png "$STAGE/soundbridge.png"
fi

# driver.json with the on-remote port baked in
node -e "
  const fs = require('fs');
  const j = JSON.parse(fs.readFileSync('driver.json', 'utf8'));
  j.port = $REMOTE_PORT;
  fs.writeFileSync('$STAGE/driver.json', JSON.stringify(j, null, 2));
"

echo "==> Installing production-only node_modules"
# Stage a minimal package.json containing only the runtime deps. npm v10's
# `--omit=dev` is unreliable when devDependencies are present in the
# manifest — it can leak transitive dev packages (esbuild, rollup, vitest)
# even with --no-package-lock. Hand-crafting the manifest avoids that.
node -e "
  const fs = require('fs');
  const src = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const out = {
    name: src.name,
    version: src.version,
    type: src.type,
    main: 'driver.js',
    private: true,
    dependencies: src.dependencies,
    engines: src.engines,
  };
  fs.writeFileSync('$STAGE/bin/package.json', JSON.stringify(out, null, 2));
"
# Install runtime deps inside bin/ so the resulting node_modules ends up
# at /app/node_modules/ after the remote extracts bin/ into /app/.
( cd "$STAGE/bin" && npm install --no-audit --no-fund --no-package-lock --silent )

echo "==> Packing"
OUT="uc-soundbridge-remote-${VERSION}.tgz"
PACK_FILES=(driver.json bin)
[[ -f "$STAGE/soundbridge.png" ]] && PACK_FILES+=(soundbridge.png)
( cd "$STAGE" && tar --owner=0 --group=0 -czf "$OLDPWD/$OUT" "${PACK_FILES[@]}" )

SIZE=$(stat -c%s "$OUT")
HUMAN=$(numfmt --to=iec-i --suffix=B "$SIZE")
LIMIT=$((100 * 1024 * 1024))

if (( SIZE > LIMIT )); then
  echo "ERROR: $OUT is $HUMAN, exceeds 100 MB on-remote limit" >&2
  exit 1
fi

echo "==> Built $OUT ($HUMAN)"
echo "==> Install on the remote with:"
echo "    curl -u 'web-configurator:<pin>' \\"
echo "         -F 'file=@$OUT' \\"
echo "         http://<remote-ip>/api/intg/install"
