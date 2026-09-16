@echo off
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
rem --auto   = automatic update mode, used by the updater. The server still
rem            refuses to run silently unless this PC already has a v2 receipt;
rem            a 1.x receipt answers "reinstall required" and changes nothing.
rem --resume = continue an install that stopped before the online steps were
rem            done. Used by the IRIS window's "continue setup" button.
set "AUTOFLAG="
set "RESUMEFLAG="
:parseargs
if "%~1"=="" goto runit
if /I "%~1"=="--auto" set "AUTOFLAG=-Auto"
if /I "%~1"=="--resume" set "RESUMEFLAG=-Resume"
shift
goto parseargs
:runit
echo IRIS installer - checking the files, then your browser will open.
echo This black window closes by itself once the browser is open.
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\installer\bootstrap.ps1" -ZipRoot "%ROOT%" %AUTOFLAG% %RESUMEFLAG%
if errorlevel 1 (
  echo.
  echo Setup could not start ^(code %errorlevel%^). Log: %LOCALAPPDATA%\IRIS-Installer\bootstrap.log
  pause
)
endlocal
