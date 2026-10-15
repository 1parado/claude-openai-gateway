@echo off
rem ============================================================
rem Start the protocol gateway + WebUI (foreground window).
rem While it runs, the `claude` smart-router wrapper routes to it;
rem when closed, `claude` automatically falls back to default config.
rem Requires Node.js 18+ available on PATH (https://nodejs.org).
rem ============================================================
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [gateway] ERROR: "node" not found in PATH. Install Node.js 18+ from https://nodejs.org
  pause
  exit /b 1
)
echo [gateway] starting on http://127.0.0.1:8787 (WebUI: /ui) ...
start "" http://127.0.0.1:8787/ui
node gateway.mjs
pause
