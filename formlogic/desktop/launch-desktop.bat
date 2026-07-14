@echo off
setlocal
title FormLogic Desktop Launcher

set "EXE=%~dp0src-tauri\target\release\formlogic-desktop.exe"

if not exist "%EXE%" (
    echo FormLogic Desktop has not been built yet.
    echo Expected: %EXE%
    echo.
    echo Build it first:
    echo   cd /d "%~dp0src-tauri"
    echo   npx tauri build --features gui --no-bundle
    echo.
    pause
    exit /b 1
)

tasklist /FI "IMAGENAME eq formlogic-desktop.exe" | find /I "formlogic-desktop.exe" >nul
if not errorlevel 1 (
    echo FormLogic Desktop is already running.
    ping -n 4 127.0.0.1 >nul
    exit /b 0
)

start "" /D "%~dp0src-tauri\target\release" "%EXE%"
endlocal
