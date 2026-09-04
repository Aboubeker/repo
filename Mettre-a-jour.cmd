@echo off
REM Double-cliquez sur ce fichier pour recuperer la derniere version du projet.
REM Contourne le blocage de "git pull" quand npm a modifie package.json
REM ou package-lock.json.
cd /d "%~dp0"
title CliniRDV - Mise a jour

where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [x] Git est introuvable. Installez-le : https://git-scm.com/downloads
  echo.
  pause
  exit /b 1
)

REM Les fichiers reecrits par npm n'ont aucune valeur : on les restaure pour
REM que la mise a jour ne soit jamais bloquee.
git checkout -- package.json package-lock.json 2>nul

if exist "scripts\update.mjs" (
  node scripts/update.mjs
) else (
  echo.
  echo   Recuperation de la derniere version...
  echo.
  git stash push -m "sauvegarde-avant-mise-a-jour" >nul 2>&1
  for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
  git fetch origin %BRANCH%
  git merge --ff-only FETCH_HEAD
  if errorlevel 1 git reset --hard FETCH_HEAD
  echo.
  echo   Installation des dependances...
  call npm install --no-audit --no-fund
)

echo.
echo   Mise a jour terminee. Lancez Demarrer-CliniRDV.cmd
echo.
pause
