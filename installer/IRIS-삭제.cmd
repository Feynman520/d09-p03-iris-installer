@echo off
rem IRIS uninstaller launcher (2.0.39). ASCII only; the Korean screens live in uninstall-ko.json.
rem Sits at the zip root next to the install .cmd, and inside installer\ (so the installed copy
rem under <root>\_agent\setup\installer\installer\ works too).
rem
rem It copies uninstall.ps1, its strings and lib\file-holders.ps1 to a fresh folder under %TEMP%
rem and runs them from there, with %TEMP% as the working folder, so the uninstaller never runs
rem from inside the folder it deletes. Arguments are passed through (-NoUi -Root <dir> ...).
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "SRC=%HERE%\installer"
if not exist "%SRC%\uninstall.ps1" set "SRC=%HERE%"
if not exist "%SRC%\uninstall.ps1" goto missing
if not exist "%SRC%\uninstall-ko.json" goto missing
set "T=%TEMP%\IRIS-uninstall-%RANDOM%%RANDOM%"
if exist "%T%" rd /s /q "%T%"
mkdir "%T%" || goto copyfail
copy /y "%SRC%\uninstall.ps1" "%T%\" >nul || goto copyfail
copy /y "%SRC%\uninstall-ko.json" "%T%\" >nul || goto copyfail
if exist "%SRC%\lib\file-holders.ps1" copy /y "%SRC%\lib\file-holders.ps1" "%T%\" >nul
cd /d "%TEMP%"
echo IRIS uninstaller - its window opens in a moment.
echo This black window closes by itself when it is done. Closing it early does not stop the uninstaller.
goto run

:missing
rem Usually: the .cmd was double-clicked inside the zip without extracting it first. The message
rem box text is Korean in UTF-8, base64 here to keep this file ASCII:
rem "The files the IRIS uninstaller needs (the installer folder) are not next to this file. ...
rem  extract the whole zip first (right-click, Extract All), then double-click IRIS-(delete).cmd"
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $d = [Text.Encoding]::UTF8; [void][Windows.Forms.MessageBox]::Show($d.GetString([Convert]::FromBase64String('SVJJUyDsgq3soJzsl5Ag7ZWE7JqU7ZWcIO2MjOydvChpbnN0YWxsZXIg7Y+0642UKeydtCDsnbQg7YyM7J28IOyYhuyXkCDsl4bsirXri4jri6QuCgp6aXAg7JWI7JeQ7IScIOuwlOuhnCDriITrpbTrqbQg7J2066CH6rKMIOuQqeuLiOuLpC4gemlw7J2EIOyYpOuluOyqvSDtgbTrpq0g4oaSIOOAjOuqqOuRkCDslZXstpUg7ZKA6riw44CN66GcIOuovOyggCDtkbwg65KkLCDtkoDrprAg7Y+0642U7J2YIOOAjElSSVMt7IKt7KCcLmNtZOOAjeulvCDrkZAg67KIIOuIhOultOyEuOyalC4=')), $d.GetString([Convert]::FromBase64String('SVJJUyDsgq3soJw=')), 'OK', 'Warning')"
if errorlevel 1 (
  echo IRIS uninstaller: installer\uninstall.ps1 is not next to this file.
  echo Extract the whole zip first ^(right-click, Extract All^), then run this file again.
  pause
)
exit /b 2

:copyfail
echo IRIS uninstaller: could not copy its files to %TEMP%. Nothing was changed.
pause
exit /b 4

:run
rem The uninstaller gets its own console (start /wait), which it hides at once: that way it never
rem hides a terminal the person opened themselves, and closing this black window cannot kill it
rem half-way. start /wait hands back its exit code.
rem The block below must stay the LAST thing in this file. cmd reads a whole ( ) block before
rem running it, so it still runs when the installed copy of this file was just deleted. Each
rem branch first leaves the batch with "(goto) 2>nul": otherwise cmd re-opens this (deleted)
rem file after the block, prints "path not found" and hands a "cmd /c" caller 1 even after a
rem clean uninstall (measured). The exit code leaves as "cmd /d /c exit N" at the very end:
rem "exit /b N" and any further line (even "goto :eof") can reset what the caller sees to 0.
(
  start "IRIS" /wait /min powershell -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%T%\uninstall.ps1" %*
  if errorlevel 4 ((goto) 2>nul & rd /s /q "%T%" 2>nul & cmd /d /c exit 4) else if errorlevel 3 ((goto) 2>nul & rd /s /q "%T%" 2>nul & cmd /d /c exit 3) else if errorlevel 2 ((goto) 2>nul & rd /s /q "%T%" 2>nul & cmd /d /c exit 2) else if errorlevel 1 ((goto) 2>nul & rd /s /q "%T%" 2>nul & cmd /d /c exit 1) else ((goto) 2>nul & rd /s /q "%T%" 2>nul & cmd /d /c exit 0)
)
