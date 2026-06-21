#!/usr/bin/env bash
#
# Smoke-test a clean *global* install of minercon inside a throwaway container.
#
# Default (tarball mode): compiles and `npm pack`s the current working tree —
# i.e. the exact artifact `npm publish` would ship — then installs THAT tarball
# in a fresh node image. Run this before cutting a release to catch a broken
# `files` whitelist, a missing bin, or a bad shebang before it reaches the
# registry.
#
# Registry mode (--registry [version]): instead installs the published package
# with `npm i -g minercon[@version]`, to verify a real release end-to-end (this
# is the "cold npm install on a clean machine" check from PUBLISHING.md §2).
#
# Usage:
#   scripts/smoke-test-install.sh                 # pack the working tree, test it
#   scripts/smoke-test-install.sh --registry      # test the latest published version
#   scripts/smoke-test-install.sh --registry 3.0.4
#   scripts/smoke-test-install.sh --node 20-slim  # pin a different node image
#
# Requires: docker (a running daemon) and, for tarball mode, the repo's dev
# dependencies installed (`npm ci`) so the compile step can run.
set -euo pipefail

NODE_TAG="${NODE_TAG:-22-slim}"
MODE="tarball"
PKG_SPEC="minercon"

while [ $# -gt 0 ]; do
  case "$1" in
    --registry)
      MODE="registry"; shift
      # Optional bare version arg (not another flag) -> pin minercon@<version>.
      if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then PKG_SPEC="minercon@$1"; shift; fi
      ;;
    --node) NODE_TAG="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! docker info >/dev/null 2>&1; then
  echo "error: docker daemon is not reachable — start Docker and retry." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXPECTED_VERSION="$(node -p "require('./package.json').version")"

run_args=(--rm -e "EXPECTED_VERSION=$EXPECTED_VERSION")

if [ "$MODE" = "tarball" ]; then
  echo "==> Compiling and packing the working tree (expect v$EXPECTED_VERSION)…"
  npm run compile >/dev/null
  TARBALL="$(npm pack --silent)"
  trap 'rm -f "$ROOT/$TARBALL"' EXIT
  echo "==> Packed $TARBALL"
  run_args+=(-v "$ROOT/$TARBALL:/work/$TARBALL:ro")
  INSTALL_CMD="npm install -g /work/$TARBALL"
else
  echo "==> Registry mode: will install '$PKG_SPEC' from npm"
  INSTALL_CMD="npm install -g $PKG_SPEC"
fi

echo "==> Smoke-testing a clean install on node:$NODE_TAG"
docker run "${run_args[@]}" "node:$NODE_TAG" bash -euo pipefail -c "
  echo '--- runtime ---'; node -v; npm -v
  echo '--- install ---'; $INSTALL_CMD
  echo '--- resolves on PATH ---'; command -v minercon
  echo '--- --version matches package.json ---'
  got=\$(minercon --version)
  echo \"reported: \$got (expected to contain: \$EXPECTED_VERSION)\"
  echo \"\$got\" | grep -qF \"\$EXPECTED_VERSION\"
  echo '--- --help exits 0 ---'; minercon --help >/dev/null
  echo '--- rejects non-TTY (piped) input ---'
  out=\$(printf '' | minercon 2>&1 || true)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'does not support piped input'
  echo 'SMOKE OK'
"

echo "==> Smoke test passed."
echo "    To drive the interactive client against a real server, run it with a TTY:"
echo "    docker run --rm -it node:$NODE_TAG bash -c '$INSTALL_CMD && minercon <host> <port>'"
