@echo off
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
rem --auto = automatic update mode, used by the updater. The server still
rem refuses to run silently unless this PC already has an install receipt.
set "AUTOFLAG="
if /I "%~1"=="--auto" set "AUTOFLAG=-Auto"
echo IRIS installer - checking the files, then your browser will open.
echo This black window closes by itself once the browser is open.
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\installer\bootstrap.ps1" -ZipRoot "%ROOT%" %AUTOFLAG%
if errorlevel 1 (
  echo.
  echo Setup could not start ^(code %errorlevel%^). Log: %LOCALAPPDATA%\IRIS-Installer\bootstrap.log
  pause
)
endlocal
