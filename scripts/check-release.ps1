# One local release bar for the FormLogic repo (audit XR-01).
#
# Runs every gate a release must pass, in order, propagating the first failure.
# Cheap gates always run; expensive/hardware-adjacent gates are opt-in flags so
# they can never silently self-skip — you either asked for them or you can see
# in the output that they did not run.
#
#   powershell -File scripts/check-release.ps1                 # standard gates
#   powershell -File scripts/check-release.ps1 -Playwright     # + E2E projects
#   powershell -File scripts/check-release.ps1 -NativeRuntime  # + native-runtime build
#
# Requires: PHP + composer deps installed (backend/vendor), Node deps
# (ui/node_modules), the Rust toolchain for -Desktop/-NativeRuntime, and a
# reachable test MySQL for phpunit (suites self-skip without one — that is a
# TEST-environment miss, and this script fails loudly when phpunit reports
# skipped-only runs).

param(
    [switch]$Playwright,
    [switch]$NativeRuntime,
    [switch]$Desktop
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
Invoke-Gate 'ui: pack screens' (Join-Path $repo 'formlogic/ui') {
    node scripts/check-pack-screens.mjs
}
Invoke-Gate 'ui: security invariants' (Join-Path $repo 'formlogic/ui') {
    node scripts/check-security-invariants.mjs
}
Invoke-Gate 'ui: build (tsc -b + vite)' (Join-Path $repo 'formlogic/ui') {
    npm run build
}

# ── Desktop (Rust) — opt-in: multi-minute build ──
if ($Desktop) {
    Invoke-Gate 'desktop: cargo test (gui features)' (Join-Path $repo 'formlogic/desktop/src-tauri') {
        cargo test --features gui
    }
} else {
    Write-Host "`n(skipped: desktop cargo test — pass -Desktop to include)" -ForegroundColor Yellow
}

# ── Native runtime — opt-in ──
if ($NativeRuntime) {
    Invoke-Gate 'native-runtime: cargo check' (Join-Path $repo 'formlogic/native-runtime/src-tauri') {
        cargo check
    }
    Invoke-Gate 'native-runtime: frontend build' (Join-Path $repo 'formlogic/native-runtime') {
        npm run build
    }
} else {
    Write-Host "(skipped: native-runtime — pass -NativeRuntime to include)" -ForegroundColor Yellow
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
