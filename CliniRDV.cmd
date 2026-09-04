@echo off
REM ====================================================================
REM  CliniRDV - ouverture du panneau de controle
REM
REM  Cible du raccourci depose sur le Bureau. Ouvre la fenetre graphique
REM  qui permet de demarrer, arreter et mettre a jour l'application.
REM
REM  -WindowStyle Hidden : aucune fenetre noire ne doit apparaitre, seule
REM  la fenetre graphique compte pour l'utilisateur.
REM ====================================================================
cd /d "%~dp0"

if not exist "scripts\CliniRDV-Controle.ps1" (
  echo   [x] Fichier "scripts\CliniRDV-Controle.ps1" introuvable.
  echo       Gardez ce programme dans le dossier de l'application.
  echo.
  pause
  exit /b 1
)

start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "scripts\CliniRDV-Controle.ps1"
exit /b 0
