@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-breeze.ps1" %*
if errorlevel 1 pause
