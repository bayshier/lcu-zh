@echo off
rem Run the ChatGPT app's own Node on lcu\runtime.mjs. Contract: docs/REMOVE-PYTHON.md, "Launcher contract".
setlocal
set "LCU_RUN_NODE="
if exist "%~dp0..\node-path" (
  set /p LCU_RUN_NODE=<"%~dp0..\node-path"
) else (
  set "LCU_RUN_NODE=%LCU_NODE%"
)
if not defined LCU_RUN_NODE goto missing
if not exist "%LCU_RUN_NODE%" goto missing
if exist "%LCU_RUN_NODE%\*" goto missing
endlocal & "%LCU_RUN_NODE%" "%~dp0..\lcu\runtime.mjs" %*
exit /b %ERRORLEVEL%
:missing
rem Only plain `lcu --help` / `lcu -h` works without Node, as on Linux and macOS.
if not "%~2"=="" goto fail
if "%~1"=="--help" goto help
if "%~1"=="-h" goto help
:fail
>&2 echo LCU: the ChatGPT app's Node is not recorded, missing or not a file. Repair the ChatGPT app, then reinstall LCU.
exit /b 1
:help
type "%~dp0..\lcu\usage.txt"
exit /b 0
