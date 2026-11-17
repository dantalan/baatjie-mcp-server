@echo off
rem sigsche master MCP: dashboard + MCP endpoint on http://localhost:8641
cd /d "%~dp0"
set TRANSPORT=http
start "" http://localhost:8641/
"C:\Program Files\nodejs\node.exe" dist\index.js
pause
