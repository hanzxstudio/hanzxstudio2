@echo off
title Verbatim Studio - Setup
cd /d %~dp0
echo ============================================
echo  Verbatim Studio - Setup
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js nahi mila. Pehle https://nodejs.org se Node.js LTS install karo, phir dobara chalao.
  pause
  exit /b 1
)
node --version

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [WARNING] FFmpeg nahi mila. Video render ke liye zaroori hai.
  echo Install karne ke liye nayi PowerShell mein chalao:
  echo   winget install Gyan.FFmpeg
  echo Phir PowerShell band karke dobara kholo aur setup dobara chalao.
  pause
  exit /b 1
)
ffmpeg -version 2>&1 | findstr /C:"ffmpeg version" >nul
echo [OK] FFmpeg mil gaya.

if not exist .env.local (
  echo [WARNING] .env.local nahi mili - AI key missing hogi.
  echo App ke andar Media Tools ^> Auto Clips ^> Add API Key ^> Groq (Free) se free key daal sakte ho.
)

echo.
echo Installing dependencies (pehli dafa 1-2 minute lag sakte hain)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install fail hua. Internet check karo aur dobara chalao.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  Setup complete! Ab run.bat chalao.
echo  Browser mein kholo: http://localhost:3000
echo ============================================
pause
