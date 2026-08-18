@echo off
rem ============================================================
rem  DSH Boot Launcher - self-check, auto-repair, then start.
rem  Usage:  dsh-boot.cmd            (check + repair + start)
rem          dsh-boot.cmd --repair-only  (check + repair only)
rem  Exit code: 0 = engine ready, 1 = boot failed, 2 = repair incomplete
rem ============================================================
setlocal
cd /d "%~dp0"
node bin\dsh-boot.mjs %*
set EXITCODE=%ERRORLEVEL%
echo.
if "%EXITCODE%"=="0" (
  echo [dsh-boot] OK - engine is ready. Open http://127.0.0.1:3080/ in your browser.
) else (
  echo [dsh-boot] FAILED - use the rescue center at http://127.0.0.1:3081/ or run: dsh-boot.cmd --repair-only
)
endlocal & exit /b %EXITCODE%
