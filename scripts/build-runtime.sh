#!/usr/bin/env bash
# Build FormLogic's server sandbox from the ZIPP release the installed Softn
# release names, and record where every byte came from.
#
#   scripts/build-runtime.sh zipp-source  # that release's source -> .runtime-source/zipp/src (verified)
#   scripts/build-runtime.sh guest        # zipp -> wasm32-wasip1, copied into runtime/host/
#   scripts/build-runtime.sh windows      # launcher for this Windows machine -> backend/bin/runtime/
#   scripts/build-runtime.sh linux        # launcher for x86_64 musl: musl-gcc on Linux, else Docker
#   scripts/build-runtime.sh smoke        # the 42 job through every launcher this machine can run
#   scripts/build-runtime.sh provenance   # backend/bin/runtime/SOURCE.json from the build records
#   scripts/build-runtime.sh check        # launchers, guest, SOURCE.json and the installed release agree
#   scripts/build-runtime.sh all          # zipp-source guest <this OS's launchers> smoke provenance
#
# `all` on Windows builds both launchers, the Linux one in Docker; without
# Docker it builds the Windows one, says the Linux one was skipped, and still
# smoke-tests and records what it built (packaging needs both, so it refuses
# until the Linux launcher is built or installed from CI). A Linux launcher
# left from an earlier build stays only if it embeds the guest just built.
#
# Several steps run in the order given: scripts/build-runtime.sh guest linux smoke provenance
#
# Needs an installed Softn release (node scripts/fetch-softn-release.mjs): its
# current.json names the ZIPP release, and nothing in this tree does. The ZIPP
# source is cloned at that release's tag, or taken read-only from a local
# checkout with ZIPP_SOURCE_DIR=../zipp.org. The Rust toolchain is the one
# ZIPP's release was built with (its BUILD-INFO rustc, in the same record).
#
# The guest is the zipp JavaScript engine compiled for WASI (formlogic/runtime/guest).
# The launcher (formlogic/runtime/host) embeds a wasmtime-precompiled copy of it,
# so the guest is built FIRST and its .wasm copied beside the launcher's build.rs.
# Nothing built here is committed; CI builds the same way every run.
#
# On Windows the Linux launcher is built inside Docker rather than cross-compiled:
# wasmtime's runtime carries a small C helper, and cross-compiling C for musl
# from Windows needs a toolchain this machine does not have. A container has it for free.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/formlogic/runtime"
OUT="$ROOT/formlogic/backend/bin/runtime"
mkdir -p "$OUT"

on_windows() { case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }

# The toolchain ZIPP's release was built with, for every cargo call below.
use_toolchain() {
  if [ -z "${SANDBOX_TOOLCHAIN:-}" ]; then
    SANDBOX_TOOLCHAIN="$(node "$ROOT/scripts/runtime-provenance.mjs" toolchain)"
    export RUSTUP_TOOLCHAIN="$SANDBOX_TOOLCHAIN"
    echo "   rust toolchain $SANDBOX_TOOLCHAIN (ZIPP's release toolchain)"
  fi
}

# A pinned toolchain is a separate rustup install from `stable`, targets included.
# --no-self-update: on Windows rustup replaces its own proxies (cargo.exe among
# them) in the background, and the cargo call that follows then fails.
ensure_target() {
  command -v rustup >/dev/null 2>&1 || return 0
  rustup +"$RUSTUP_TOOLCHAIN" target list --installed 2>/dev/null | tr -d '\r' | grep -qx "$1" \
    || rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal --no-self-update --target "$1"
}

build_zipp_source() {
  echo "== ZIPP source (the release the installed Softn release names)"
  node "$ROOT/scripts/zipp-source.mjs"
}

build_guest() {
  echo "== guest (wasm32-wasip1)"
  use_toolchain
  ensure_target wasm32-wasip1
  node "$ROOT/scripts/zipp-source.mjs" --seed-lock
  (cd "$RUNTIME/guest" && cargo build --release --locked)
  cp "$RUNTIME/guest/target/wasm32-wasip1/release/formlogic-runtime-guest.wasm" \
     "$RUNTIME/host/formlogic-runtime-guest.wasm"
  node "$ROOT/scripts/runtime-provenance.mjs" fragment guest
}

build_windows() {
  echo "== launcher (windows-x86_64)"
  on_windows || { echo "the Windows launcher is built on Windows (CI: package.yml's sandbox-windows job on windows-2022)" >&2; exit 2; }
  use_toolchain
  ensure_target x86_64-pc-windows-msvc
  (cd "$RUNTIME/host" && cargo build --release --locked)
  cp "$RUNTIME/host/target/release/formlogic-runtime.exe" "$OUT/formlogic-runtime-windows-x86_64.exe"
  node "$ROOT/scripts/runtime-provenance.mjs" fragment windows
}

build_linux() {
  local rustc_vv
  use_toolchain
  if [ "$(uname -s)" = Linux ] && command -v musl-gcc >/dev/null 2>&1; then
    echo "== launcher (linux-x86_64, static musl)"
    ensure_target x86_64-unknown-linux-musl
    (cd "$RUNTIME/host" && CC_x86_64_unknown_linux_musl=musl-gcc cargo build --release --locked --target x86_64-unknown-linux-musl)
    cp "$RUNTIME/host/target/x86_64-unknown-linux-musl/release/formlogic-runtime" "$OUT/formlogic-runtime-linux-x86_64"
    rustc_vv="$(rustc -Vv)"
  else
    command -v docker >/dev/null 2>&1 || { echo "the Linux launcher needs musl-gcc on Linux (apt-get install musl-tools) or Docker" >&2; exit 2; }
    echo "== launcher (linux-x86_64, static musl, via Docker)"
    # rust:<toolchain> is Debian; musl-tools supplies musl-gcc for wasmtime's C helper.
    # The host crate's target/ is mounted to a separate volume so Windows build
    # artefacts and Linux ones never share a directory.
    # Git Bash on Windows rewrites arguments that look like POSIX paths (`-w /work`
    # became `C:/Program Files/Git/work`). MSYS_NO_PATHCONV stops that; the host
    # directory is then handed over in the C:/... form Docker Desktop expects.
    # The container runs as root (rustup's toolchain there is root's); the copy
    # is handed to whoever owns the mounted crate, so on a Linux host with
    # rootful Docker the chmod below is the user's own, not a root file's.
    local image="rust:${RUSTUP_TOOLCHAIN}-bookworm"
    local hostdir; hostdir="$(cygpath -m "$RUNTIME/host" 2>/dev/null || echo "$RUNTIME/host")"
    MSYS_NO_PATHCONV=1 docker run --rm \
      -v "$hostdir:/work" \
      -v formlogic-runtime-linux-target:/work/target \
      -v formlogic-runtime-cargo-registry:/usr/local/cargo/registry \
      -w /work \
      "$image" \
      bash -euc '
        apt-get update -qq >/dev/null && apt-get install -y -qq musl-tools >/dev/null
        rustup target add x86_64-unknown-linux-musl >/dev/null
        export CC_x86_64_unknown_linux_musl=musl-gcc
        cargo build --release --locked --target x86_64-unknown-linux-musl
        cp target/x86_64-unknown-linux-musl/release/formlogic-runtime /work/formlogic-runtime-linux-x86_64
        chown --reference=/work/Cargo.toml /work/formlogic-runtime-linux-x86_64
      '
    mv "$RUNTIME/host/formlogic-runtime-linux-x86_64" "$OUT/formlogic-runtime-linux-x86_64"
    rustc_vv="$(MSYS_NO_PATHCONV=1 docker run --rm "$image" rustc -Vv)"
  fi
  chmod +x "$OUT/formlogic-runtime-linux-x86_64"
  # The record reads the ELF headers itself: a dynamically linked launcher is refused there.
  node "$ROOT/scripts/runtime-provenance.mjs" fragment linux --rustc "$rustc_vv"
}

smoke() {
  echo "== smoke (validators.email through the prelude, 40 + 2)"
  local ran=0
  if on_windows; then
    if [ -f "$OUT/formlogic-runtime-windows-x86_64.exe" ]; then
      node "$ROOT/scripts/runtime-smoke.mjs" "$OUT/formlogic-runtime-windows-x86_64.exe"; ran=1
    fi
    if [ -f "$OUT/formlogic-runtime-linux-x86_64" ]; then
      if command -v docker >/dev/null 2>&1; then
        node "$ROOT/scripts/runtime-smoke.mjs" "$OUT/formlogic-runtime-linux-x86_64" --docker debian:bookworm-slim; ran=1
      else
        echo "   formlogic-runtime-linux-x86_64 not smoke-tested: no Docker to run it in"
      fi
    fi
  elif [ -f "$OUT/formlogic-runtime-linux-x86_64" ]; then
    node "$ROOT/scripts/runtime-smoke.mjs" "$OUT/formlogic-runtime-linux-x86_64"; ran=1
  fi
  [ "$ran" = 1 ] || { echo "no launcher this machine can run is in formlogic/backend/bin/runtime" >&2; exit 1; }
}

provenance() { echo "== provenance"; node "$ROOT/scripts/runtime-provenance.mjs" provenance; }
check() { echo "== check"; node "$ROOT/scripts/runtime-provenance.mjs" check; }

[ $# -gt 0 ] || set -- all
for step in "$@"; do
  case "$step" in
    zipp-source) build_zipp_source ;;
    guest)       build_guest ;;
    windows)     build_windows ;;
    linux)       build_linux ;;
    smoke)       smoke ;;
    provenance)  provenance ;;
    check)       check ;;
    all)
      build_zipp_source; build_guest
      if on_windows; then build_windows; fi
      if on_windows && ! command -v docker >/dev/null 2>&1; then
        echo "== launcher (linux-x86_64) SKIPPED: building it on Windows needs Docker. The Windows launcher is enough to run and test here;"
        echo "   packaging needs both (install Docker and run scripts/build-runtime.sh linux smoke provenance, or install CI's sandbox-linux)."
        # One left from an earlier build is recorded only if it embeds this guest.
        node "$ROOT/scripts/runtime-provenance.mjs" prune linux
      else
        build_linux
      fi
      smoke; provenance ;;
    *) echo "usage: $0 {zipp-source|guest|windows|linux|smoke|provenance|check|all}..." >&2; exit 2 ;;
  esac
done
