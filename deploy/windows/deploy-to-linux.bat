@echo off
title ADSI Dashboard - Windows to Linux Deployment Assistant
cd /d "%~dp0"
echo ==============================================================================
echo   ADSI Dashboard -- Windows to Linux Automated Deployment
echo ==============================================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-to-linux.ps1" %*
echo.
pause
