#!/usr/bin/env bash
# Build FormLogic's backend sandbox runtime and vendor the result.
#
#   scripts/build-runtime.sh guest        # zipp → wasm32-wasip1, copied into runtime/host/
#   scripts/build-runtime.sh windows      # launcher for this machine → backend/bin/runtime/
#   scripts/build-runtime.sh linux        # launcher for x86_64 musl, built in Docker
#   scripts/build-runtime.sh all          # the three in order
#
# The guest is the zipp JavaScript engine compiled for WASI (formlogic/runtime/guest).
# The launcher (formlogic/runtime/host) embeds a wasmtime-precompiled copy of it,
# so the guest must be built FIRST and its .wasm copied beside the launcher's
# build.rs — that copy is tracked in git, which is what lets the launcher build
# from a clean checkout without a wasm toolchain.
#
# The Linux launcher is built inside Docker rather than cross-compiled: wasmtime's
# runtime carries a small C helper, and cross-compiling C for musl from Windows
# needs a toolchain this machine does not have. A container has it for free.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/formlogic/runtime"
OUT="$ROOT/formlogic/backend/bin/runtime"
mkdir -p "$OUT"

build_guest() {
  echo "== guest (wasm32-wasip1)"
  (cd "$RUNTIME/guest" && cargo build --release)
  cp "$RUNTIME/guest/target/wasm32-wasip1/release/formlogic-runtime-guest.wasm" \
     "$RUNTIME/host/formlogic-runtime-guest.wasm"
  sha256sum "$RUNTIME/host/formlogic-runtime-guest.wasm"
}

build_windows() {
  echo "== launcher (windows-x86_64)"
  (cd "$RUNTIME/host" && cargo build --release)
  cp "$RUNTIME/host/target/release/formlogic-runtime.exe" "$OUT/formlogic-runtime-windows-x86_64.exe"
  ls -la "$OUT/formlogic-runtime-windows-x86_64.exe"
}

build_linux() {
  echo "== launcher (linux-x86_64, static musl, via Docker)"
  # rust:1.92 is Debian; musl-tools supplies musl-gcc for wasmtime's C helper.
  # The host crate's target/ is mounted to a separate volume so Windows build
  # artefacts and Linux ones never share a directory.
  # Git Bash on Windows rewrites arguments that look like POSIX paths (`-w /work`
  # became `C:/Program Files/Git/work`). MSYS_NO_PATHCONV stops that; the host
  # directory is then handed over in the C:/... form Docker Desktop expects.
  local hostdir; hostdir="$(cygpath -m "$RUNTIME/host" 2>/dev/null || echo "$RUNTIME/host")"
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v "$hostdir:/work" \
    -v formlogic-runtime-linux-target:/work/target \
    -v formlogic-runtime-cargo-registry:/usr/local/cargo/registry \
    -w /work \
    rust:1.92-bookworm \
    bash -euc '
      apt-get update -qq >/dev/null && apt-get install -y -qq musl-tools >/dev/null
      rustup target add x86_64-unknown-linux-musl >/dev/null
      export CC_x86_64_unknown_linux_musl=musl-gcc
      cargo build --release --target x86_64-unknown-linux-musl
      cp target/x86_64-unknown-linux-musl/release/formlogic-runtime /work/formlogic-runtime-linux-x86_64
    '
  mv "$RUNTIME/host/formlogic-runtime-linux-x86_64" "$OUT/formlogic-runtime-linux-x86_64"
  chmod +x "$OUT/formlogic-runtime-linux-x86_64"
  ls -la "$OUT/formlogic-runtime-linux-x86_64"
  file "$OUT/formlogic-runtime-linux-x86_64" 2>/dev/null || true
}

case "${1:-all}" in
  guest)   build_guest ;;
  windows) build_windows ;;
  linux)   build_linux ;;
  all)     build_guest; build_windows; build_linux ;;
  *) echo "usage: $0 {guest|windows|linux|all}" >&2; exit 2 ;;
esac
