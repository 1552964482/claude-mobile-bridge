@echo off
setlocal
cd /d "%~dp0"

set "WORKSPACE=%~1"
if "%WORKSPACE%"=="" set "WORKSPACE=%CD%"

node remote.js "%WORKSPACE%"

echo.
echo Remote access has stopped.
pause
