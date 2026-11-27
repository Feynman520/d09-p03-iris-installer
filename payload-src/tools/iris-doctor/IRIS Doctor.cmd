@echo off
setlocal DisableDelayedExpansion
rem ---------------------------------------------------------------------------
rem IRIS Doctor start file.  ASCII only, CRLF line endings.
rem Shortcuts open it as:  cmd.exe /d /c "<this file>"   (/d = skip cmd AutoRun)
rem
rem Ladder:  1. bundled node (..\node\node.exe)
rem          2. node.exe found on PATH (shim folders are skipped)
rem          3. fixed guide.  The window never closes by itself; the user closes it.
rem A node candidate is accepted only if it can start Doctor within a time limit
rem (lib\start-check.ps1 selftest).  If that helper cannot run, Doctor is started
rem without the check.  Once the Doctor screen has come up (ready flag), no other
rem candidate is tried.
rem
rem Rules for editing this file: paths only as quoted variables (never pasted into
rem a command string), no delayed expansion, no "call" with arguments, no
rem parenthesised blocks around lines that expand a path.
rem ---------------------------------------------------------------------------
title IRIS Doctor
set "NODE_OPTIONS="
set "NODE_PATH="
set "NODE_REPL_EXTERNAL_MODULE="
set "ELECTRON_RUN_AS_NODE="
rem Trust the Windows certificate store as well (school / company networks that
rem re-sign HTTPS).  Filled only when empty: a value the user has set is kept.
rem Never the --use-system-ca flag and never NODE_OPTIONS (see lib\trust.mjs).
set "IRIS_DOCTOR_CA_FILLED="
if not defined NODE_USE_SYSTEM_CA set "IRIS_DOCTOR_CA_FILLED=1"
if not defined NODE_USE_SYSTEM_CA set "NODE_USE_SYSTEM_CA=1"
set "IRIS_DOCTOR_DIR=%~dp0"
set "IRIS_DOCTOR_DONE="
set "IRIS_DOCTOR_TRIED="
set "IRIS_DOCTOR_RC="
set "IRIS_DOCTOR_HAVELIST="
set "IRIS_DOCTOR_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
rem Switch for PCs where PowerShell is blocked or hangs: set IRIS_DOCTOR_NOPS=1 before opening this file.
if defined IRIS_DOCTOR_NOPS set "IRIS_DOCTOR_PS=%SystemRoot%\System32\WindowsPowerShell\not-used\powershell.exe"
set "IRIS_DOCTOR_READY=%TEMP%\iris-doctor-ready-%RANDOM%%RANDOM%.flag"
set "IRIS_DOCTOR_LIST=%TEMP%\iris-doctor-nodes-%RANDOM%%RANDOM%.txt"
if exist "%IRIS_DOCTOR_READY%" del /f /q "%IRIS_DOCTOR_READY%" >nul 2>&1

rem --- 1. bundled node -------------------------------------------------------
set "IRIS_DOCTOR_NODE=%IRIS_DOCTOR_DIR%..\node\node.exe"
call :attempt
if defined IRIS_DOCTOR_DONE goto finished

rem --- 2. node.exe on PATH ---------------------------------------------------
if not exist "%IRIS_DOCTOR_PS%" goto plainsearch
"%IRIS_DOCTOR_PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%IRIS_DOCTOR_DIR%lib\start-check.ps1" find >"%IRIS_DOCTOR_LIST%" 2>nul
if not exist "%IRIS_DOCTOR_LIST%" goto plainsearch
for /f "usebackq delims=" %%N in ("%IRIS_DOCTOR_LIST%") do (
  set "IRIS_DOCTOR_HAVELIST=1"
  if not defined IRIS_DOCTOR_DONE (
    set "IRIS_DOCTOR_NODE=%%N"
    call :attempt
  )
)
del /f /q "%IRIS_DOCTOR_LIST%" >nul 2>&1
if defined IRIS_DOCTOR_DONE goto finished
if defined IRIS_DOCTOR_HAVELIST goto finished

:plainsearch
rem PowerShell was not usable (or listed nothing): plain cmd search for node.exe on PATH.
set "IRIS_DOCTOR_NODE="
for %%I in (node.exe) do set "IRIS_DOCTOR_NODE=%%~$PATH:I"
if not defined IRIS_DOCTOR_NODE goto finished
echo "%IRIS_DOCTOR_NODE%" | "%SystemRoot%\System32\findstr.exe" /i /l /c:"\\shims\\" >nul 2>&1
if not errorlevel 1 goto finished
call :attempt
goto finished

:attempt
rem Try the node in IRIS_DOCTOR_NODE.  Sets IRIS_DOCTOR_DONE when the Doctor screen came up.
if not exist "%IRIS_DOCTOR_NODE%" exit /b 0
if not exist "%IRIS_DOCTOR_PS%" goto run
"%IRIS_DOCTOR_PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%IRIS_DOCTOR_DIR%lib\start-check.ps1" selftest >nul 2>&1
rem 8 = the helper saw that this node cannot start Doctor / 9 = it hung -> next candidate.
rem Anything else (0, or 1 = PowerShell itself refused to run the helper, e.g. by policy) -> start Doctor.
if errorlevel 10 goto run
if errorlevel 8 exit /b 0
:run
set "IRIS_DOCTOR_TRIED=1"
"%IRIS_DOCTOR_NODE%" "%IRIS_DOCTOR_DIR%iris-doctor.mjs" start
set "IRIS_DOCTOR_RC=%ERRORLEVEL%"
if exist "%IRIS_DOCTOR_READY%" set "IRIS_DOCTOR_DONE=1"
exit /b 0

:finished
if exist "%IRIS_DOCTOR_READY%" del /f /q "%IRIS_DOCTOR_READY%" >nul 2>&1
if exist "%IRIS_DOCTOR_LIST%" del /f /q "%IRIS_DOCTOR_LIST%" >nul 2>&1
if not defined IRIS_DOCTOR_DONE goto cannotstart
rem The Doctor screen came up.  Closed by the user (0) = let the window close.
if "%IRIS_DOCTOR_RC%"=="0" exit /b 0
"%SystemRoot%\System32\chcp.com" 65001 >nul 2>&1
echo.
echo  IRIS Doctor stopped unexpectedly (code %IRIS_DOCTOR_RC%).
if exist "%IRIS_DOCTOR_DIR%guide\stopped.ko.txt" type "%IRIS_DOCTOR_DIR%guide\stopped.ko.txt"
echo.
pause
exit /b 1

:cannotstart
"%SystemRoot%\System32\chcp.com" 65001 >nul 2>&1
echo.
echo  ==========================================================
echo   IRIS Doctor could not start on this PC.
echo   Download the IRIS installer and run it.  A newer version
echo   updates IRIS and puts IRIS Doctor back in place.
echo   Download: https://iris-workspace.com  (Install)
echo  ==========================================================
echo.
if exist "%IRIS_DOCTOR_DIR%guide\cannot-start.ko.txt" type "%IRIS_DOCTOR_DIR%guide\cannot-start.ko.txt"
echo.
echo  [check]
if exist "%IRIS_DOCTOR_DIR%..\node\node.exe" echo    bundled node      : found
if not exist "%IRIS_DOCTOR_DIR%..\node\node.exe" echo    bundled node      : MISSING
if defined IRIS_DOCTOR_TRIED echo    node on this PC   : found, but Doctor did not start with it
if not defined IRIS_DOCTOR_TRIED echo    node on this PC   : none that can start Doctor
if exist "%IRIS_DOCTOR_DIR%iris-doctor.mjs" echo    Doctor program    : found
if not exist "%IRIS_DOCTOR_DIR%iris-doctor.mjs" echo    Doctor program    : MISSING
if exist "%IRIS_DOCTOR_DIR%lib\session.mjs" echo    Doctor files      : found
if not exist "%IRIS_DOCTOR_DIR%lib\session.mjs" echo    Doctor files      : MISSING
if exist "%IRIS_DOCTOR_PS%" echo    PowerShell        : found
if not exist "%IRIS_DOCTOR_PS%" echo    PowerShell        : MISSING
echo.
pause
exit /b 1
