@echo off
rem ============================================================
rem Start the protocol gateway + WebUI (foreground window).
rem While it runs, the `claude` smart-router wrapper routes to it;
rem when closed, `claude` automatically falls back to default config.
rem ============================================================
cd /d "%~dp0"
set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE%" set "NODE=node"
echo [gateway] starting on http://127.0.0.1:8787 (WebUI: /ui) ...
start "" http://127.0.0.1:8787/ui
"%NODE%" gateway.mjs
pause
