# One local release bar for the FormLogic repo (audit XR-01).
#
# Runs every gate a release must pass, in order, propagating the first failure.
# Cheap gates always run; expensive/hardware-adjacent gates are opt-in flags so
# they can never silently self-skip — you either asked for them or you can see
# in the output that they did not run.
#
#   powershell -File scripts/check-release.ps1                 # standard gates
#   powershell -File scripts/check-release.ps1 -Playwright     # + E2E projects
#   powershell -File scripts/check-release.ps1 -Desktop        # + desktop clippy + test
#   powershell -File scripts/check-release.ps1 -NativeRuntime  # + native-runtime clippy/check/build
#   powershell -File scripts/check-release.ps1 -DistSmoke      # + package + boot the zip (FL-30)
#   powershell -File scripts/check-release.ps1 -Fmt            # + cargo fmt --check, both Rust roots (FL-31)
#   powershell -File scripts/check-release.ps1 -RustAudit      # + cargo audit, both Rust roots (FL-31)
#   powershell -File scripts/check-release.ps1 -Msrv           # + compile with the pinned 1.88 MSRV (FL-31)
#   powershell -File scripts/check-release.ps1 -Android        # + native-runtime Android target check (FL-31)
#
# Requires: PHP + composer deps installed (backend/vendor), Node deps
# (ui/node_modules), the Rust toolchain for -Desktop/-NativeRuntime, and a
# reachable test MySQL for phpunit (suites self-skip without one — that is a
# TEST-environment miss, and this script fails loudly when phpunit reports
# skipped-only runs).

param(
    [switch]$Playwright,
    [switch]$NativeRuntime,
    [switch]$Desktop,
    [switch]$DistSmoke,
    [switch]$Fmt,
    [switch]$RustAudit,
    [switch]$Msrv,
    [switch]$Android
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$failed = $false

function Invoke-Gate {
    param([string]$Name, [string]$WorkDir, [scriptblock]$Body)
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    Push-Location $WorkDir
    try {
        & $Body
        if ($LASTEXITCODE -ne 0) { throw "$Name exited $LASTEXITCODE" }
        Write-Host "=== $Name OK ===" -ForegroundColor Green
    } catch {
        Write-Host "=== $Name FAILED: $_ ===" -ForegroundColor Red
        $script:failed = $true
    } finally {
        Pop-Location
    }
}

# ── Backend ──
Invoke-Gate 'backend: phpunit' (Join-Path $repo 'formlogic/backend') {
    & vendor/bin/phpunit
}
Invoke-Gate 'backend: phpstan' (Join-Path $repo 'formlogic/backend') {
    & vendor/bin/phpstan analyse --memory-limit=1G
}

# ── UI ──
Invoke-Gate 'ui: vitest' (Join-Path $repo 'formlogic/ui') {
    npx vitest run
}
Invoke-Gate 'ui: eslint' (Join-Path $repo 'formlogic/ui') {
    npx eslint .
}
Invoke-Gate 'ui: typecheck tests (audit FL-28)' (Join-Path $repo 'formlogic/ui') {
    npm run typecheck:test
}
Invoke-Gate 'ui: pack screens' (Join-Path $repo 'formlogic/ui') {
    node scripts/check-pack-screens.mjs
}
Invoke-Gate 'ui: security invariants' (Join-Path $repo 'formlogic/ui') {
    node scripts/check-security-invariants.mjs
}
Invoke-Gate 'ui: build (tsc -b + vite)' (Join-Path $repo 'formlogic/ui') {
    npm run build
}

# ── Cross-repo contract digest (audit FL-34) — cheap, always on; fails loudly
# when the aokie checkout is missing (set AOKIE_REPO to point at it) ──
Invoke-Gate 'contracts: cross-repo digest (FL-34)' $repo {
    node scripts/check-contracts.mjs
}

# ── Desktop (Rust) — opt-in: multi-minute build ──
if ($Desktop) {
    Invoke-Gate 'desktop: cargo clippy (gui features, audit FL-31)' (Join-Path $repo 'formlogic/desktop/src-tauri') {
        cargo clippy --features gui
    }
    Invoke-Gate 'desktop: cargo test (gui features)' (Join-Path $repo 'formlogic/desktop/src-tauri') {
        cargo test --features gui
    }
} else {
    Write-Host "`n(skipped: desktop cargo clippy + test — pass -Desktop to include)" -ForegroundColor Yellow
}

# ── Native runtime — opt-in ──
if ($NativeRuntime) {
    Invoke-Gate 'native-runtime: cargo clippy (audit FL-31)' (Join-Path $repo 'formlogic/native-runtime/src-tauri') {
        cargo clippy
    }
    Invoke-Gate 'native-runtime: cargo check' (Join-Path $repo 'formlogic/native-runtime/src-tauri') {
        cargo check
    }
    Invoke-Gate 'native-runtime: frontend build' (Join-Path $repo 'formlogic/native-runtime') {
        npm run build
    }
} else {
    Write-Host "(skipped: native-runtime — pass -NativeRuntime to include)" -ForegroundColor Yellow
}

# ── Rust hygiene gates (audit FL-31) — opt-in, each fails loudly when its
# tool/toolchain is missing rather than self-skipping ──
if ($Fmt) {
    Invoke-Gate 'desktop: cargo fmt --check' (Join-Path $repo 'formlogic/desktop/src-tauri') {
        cargo fmt --check
    }
    Invoke-Gate 'native-runtime: cargo fmt --check' (Join-Path $repo 'formlogic/native-runtime/src-tauri') {
        cargo fmt --check
    }
} else {
    Write-Host "(skipped: cargo fmt --check — pass -Fmt to include; NOTE both trees carry pre-audit fmt drift)" -ForegroundColor Yellow
}
if ($RustAudit) {
    Invoke-Gate 'desktop: cargo audit (RustSec)' (Join-Path $repo 'formlogic/desktop/src-tauri') {
        cargo audit
    }
    Invoke-Gate 'native-runtime: cargo audit (RustSec)' (Join-Path $repo 'formlogic/native-runtime/src-tauri') {
        cargo audit
    }
} else {
    Write-Host "(skipped: cargo audit — pass -RustAudit to include; requires cargo-audit installed)" -ForegroundColor Yellow
}
if ($Msrv) {
    # rust-version = "1.88" is pinned in both Cargo.tomls; compiling WITH that
    # toolchain is what actually detects an accidental MSRV increase.
    Invoke-Gate 'desktop: MSRV check (cargo +1.88.0)' (Join-Path $repo 'formlogic/desktop/src-tauri') {
        cargo +1.88.0 check --features gui
    }
    Invoke-Gate 'native-runtime: MSRV check (cargo +1.88.0)' (Join-Path $repo 'formlogic/native-runtime/src-tauri') {
        cargo +1.88.0 check
    }
} else {
    Write-Host "(skipped: MSRV compile — pass -Msrv to include; requires 'rustup toolchain install 1.88.0')" -ForegroundColor Yellow
}
if ($Android) {
    Invoke-Gate 'native-runtime: Android target check' (Join-Path $repo 'formlogic/native-runtime/src-tauri') {
        cargo check --target aarch64-linux-android
    }
} else {
    Write-Host "(skipped: Android target compile — pass -Android to include; requires the NDK + 'rustup target add aarch64-linux-android')" -ForegroundColor Yellow
}

# ── Distributable smoke (audit FL-30) — opt-in: packages the zip, then boots
# and exercises the EXTRACTED artifact against a clean throwaway database ──
if ($DistSmoke) {
    Invoke-Gate 'dist: package zip' $repo {
        node scripts/package-dist.mjs --skip-ui-build
    }
    Invoke-Gate 'dist: smoke the artifact (FL-30)' $repo {
        node scripts/smoke-dist.mjs
    }
} else {
    Write-Host "(skipped: dist packaging + artifact smoke — pass -DistSmoke to include)" -ForegroundColor Yellow
}

# ── Playwright — opt-in: needs the served app ──
if ($Playwright) {
    Invoke-Gate 'ui: playwright' (Join-Path $repo 'formlogic/ui') {
        npm run test:e2e
    }
} else {
    Write-Host "(skipped: Playwright E2E — pass -Playwright to include)" -ForegroundColor Yellow
}

if ($failed) {
    Write-Host "`ncheck-release: FAILED (see gates above)" -ForegroundColor Red
    exit 1
}
Write-Host "`ncheck-release: all requested gates passed" -ForegroundColor Green
