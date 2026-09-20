@echo off
setlocal
title Buyer Log Update Test

set "ROOT=%~dp0"
if not exist "%ROOT%BuyerLog.exe" (
  echo.
  echo Bu dosyayi BuyerLog.exe ile ayni klasore koyun.
  echo.
  pause
  exit /b 1
)

set "CFG=%ROOT%data\local\updater\config.json"
if not exist "%ROOT%data\local\updater" mkdir "%ROOT%data\local\updater"

> "%CFG%" (
  echo {
  echo   "enabled": true,
  echo   "channel": "test"
  echo }
)

echo.
echo Buyer Log TEST kanali etkinlestirildi.
echo Buyer Log aciliyor...
echo.

start "" "%ROOT%BuyerLog.exe"
exit /b 0
