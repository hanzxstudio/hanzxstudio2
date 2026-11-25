@echo off
title Verbatim Studio
cd /d %~dp0
echo Verbatim Studio chal raha hai...
echo Browser mein kholo: http://localhost:3000
echo Band karne ke liye Ctrl + C dabao.
call npm run dev
pause
