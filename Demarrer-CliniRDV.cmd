@echo off
REM Raccourci Windows : double-cliquez sur ce fichier pour lancer CliniRDV.
REM Demarre la base, le serveur, puis ouvre la page de connexion.
cd /d "%~dp0"
title CliniRDV - Gestion des rendez-vous

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [x] Node.js est introuvable.
  echo       Installez Node.js 20 ou superieur : https://nodejs.org
  echo       Puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   Premiere utilisation : installation des dependances...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [x] L'installation des dependances a echoue.
    echo.
    pause
    exit /b 1
  )
)

node scripts/app.mjs

echo.
echo   Le serveur est arrete.
pause
