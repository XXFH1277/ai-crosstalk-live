@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-breeze.ps1" %*
if errorlevel 1 pause
