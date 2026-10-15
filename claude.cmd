@echo off
rem ============================================================
rem claude smart-router wrapper (cmd / PowerShell), portable.
rem gateway (8787) UP   -> launch with isolated profile (claude-profile)
rem gateway (8787) DOWN -> launch plain, use default ~/.claude config
rem NOTE: settings.json "env" block overrides process env vars, so
rem       the UP branch must use CLAUDE_CONFIG_DIR to route reliably.
rem ============================================================
curl -s -m 2 --noproxy "*" http://127.0.0.1:8787/health >nul 2>&1
if errorlevel 1 goto :direct

rem Gateway is up: route through the isolated profile.
set "CLAUDE_CONFIG_DIR=%~dp0claude-profile"
goto :launch

:direct
rem Gateway is down: fall back to the default claude config.

:launch
rem Prefer the native-installer binary; fall back to `claude` on PATH
rem (works for npm installs: `npm i -g @anthropic-ai/claude-code`).
set "CLAUDE_EXE=%USERPROFILE%\.local\bin\claude.exe"
if exist "%CLAUDE_EXE%" (
  "%CLAUDE_EXE%" %*
  goto :eof
)
where claude >nul 2>&1
if errorlevel 1 (
  echo [claude-wrapper] ERROR: claude CLI not found. Install it via
  echo   npm install -g @anthropic-ai/claude-code
  echo or the native installer, then retry.
  goto :eof
)
claude %*
