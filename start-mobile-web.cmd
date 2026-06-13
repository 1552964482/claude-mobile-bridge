@echo off
setlocal
cd /d "%~dp0"

set "WORKSPACE=%~1"
if "%WORKSPACE%"=="" set "WORKSPACE=%CD%"

echo Starting Claude mobile console...
echo.
node server.js --workspace "%WORKSPACE%"

if errorlevel 1 (
  echo.
  echo Startup failed. Check that Node.js and Claude CLI are installed.
  pause
)
