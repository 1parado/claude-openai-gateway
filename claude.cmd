@echo off
rem ============================================================
rem claude smart-router wrapper (cmd / PowerShell)
rem gateway (8787) UP   -> launch with isolated profile (claude-profile)
rem gateway (8787) DOWN -> launch plain, use default ~/.claude config
rem NOTE: settings.json "env" block overrides process env vars, so
rem       the UP branch must use CLAUDE_CONFIG_DIR to route reliably.
rem ============================================================
curl -s -m 2 --noproxy "*" http://127.0.0.1:8787/health >nul 2>&1
if errorlevel 1 goto :direct

set "CLAUDE_CONFIG_DIR=%~dp0claude-profile"
"%USERPROFILE%\.local\bin\claude.exe" %*
goto :eof

:direct
"%USERPROFILE%\.local\bin\claude.exe" %*
