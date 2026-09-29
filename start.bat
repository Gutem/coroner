@echo off
REM coroner — servidor MCP read-only para cases do Autopsy
REM Uso: start.bat [stdio|http] [porta]

setlocal
set TRANSPORT=%~1
if "%TRANSPORT%"=="" set TRANSPORT=stdio

if not defined AUTOPSY_CASES_DIR set AUTOPSY_CASES_DIR=%USERPROFILE%\AutopsyCases

where bun >nul 2>nul
if errorlevel 1 (
  echo [erro] Bun nao encontrado. Instale: powershell -c "irm bun.sh/install.ps1 | iex"
  exit /b 1
)

if "%TRANSPORT%"=="http" (
  bun run src/index.js --transport http --port %2
) else (
  bun run src/index.js
)
endlocal
