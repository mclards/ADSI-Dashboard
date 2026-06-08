#!/usr/bin/env pwsh
Write-Host "Building v2.10.0-beta.2 in isolated PowerShell context..."
cd 'D:\ADSI-Dashboard'
npm run build:installer
