@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\ModelBridge.exe" "%~dp0..\resources\app.asar\out\main\cli.js" %*
exit /b %errorlevel%
