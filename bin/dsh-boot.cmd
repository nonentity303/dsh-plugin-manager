@echo off
rem ============================================================
rem  DSH Boot Launcher - self-check, auto-repair, then start.
rem  Usage:  dsh-boot.cmd [--repair-only] [--help] [--profile <dir>] [--dsh <cmd>] ...
rem          dsh-boot.cmd --repair-only   check + repair only
rem          dsh-boot.cmd --help          show usage
rem  Exit code: 0 = engine ready / profile healthy, 1 = boot failed, 2 = repair incomplete
rem ============================================================
rem  Fix (audit L1): the old version did "cd /d bin" and then ran "node bin\dsh-boot.mjs",
rem  which resolved to bin\bin\dsh-boot.mjs (MODULE_NOT_FOUND) - the rescue entry never
rem  worked. This version calls the script by absolute path and keeps the caller's
rem  working directory, so relative --profile paths resolve as the caller expects and
rem  quoted arguments (paths with spaces) pass through unchanged.
rem  ASCII ONLY on purpose: cmd.exe reads this file as ANSI/CP936, so non-ASCII
rem  comments can corrupt the line and be executed as a stray command.
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo [dsh-boot] node not found in PATH - install Node.js or add it to PATH.
  endlocal
  exit /b 1
)

node "%~dp0dsh-boot.mjs" %*
set EXITCODE=%ERRORLEVEL%
echo.
if "%EXITCODE%"=="0" (
  echo [dsh-boot] OK - finished successfully.
  echo            engine ready, or profile healthy for --repair-only.
) else if "%EXITCODE%"=="1" (
  echo [dsh-boot] FAILED - boot did not finish.
  echo            Rescue center: http://127.0.0.1:3081/   Details: dsh-boot.cmd --repair-only
) else if "%EXITCODE%"=="2" (
  echo [dsh-boot] REPAIR INCOMPLETE - run: dsh-boot.cmd --repair-only
  echo            and fix the listed issues manually.
) else (
  echo [dsh-boot] UNKNOWN - exit code %EXITCODE%
)
endlocal & exit /b %EXITCODE%
