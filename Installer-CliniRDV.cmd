@echo off
REM ======================================================================
REM  CliniRDV - Programme d'installation (Windows 10/11, 64 bits)
REM
REM  Double-cliquez sur ce fichier pour installer l'application.
REM
REM  Il fait le meme travail qu'un setup.exe classique :
REM    - verifie Windows et Node.js (installation via winget si absent),
REM    - installe les dependances et le serveur PostgreSQL embarque,
REM    - cree la base, applique le schema, charge le jeu de demonstration,
REM    - compile l'interface,
REM    - depose un raccourci "CliniRDV" sur le Bureau,
REM    - lance l'application.
REM
REM  Ce fichier .cmd est un lanceur : tout le travail est fait par
REM  install.ps1, place a cote de lui. Il contourne la strategie
REM  d'execution PowerShell, qui bloque par defaut les scripts telecharges
REM  et deroute les utilisateurs peu familiers de la ligne de commande.
REM ======================================================================

setlocal
cd /d "%~dp0"
title Installation de CliniRDV

echo.
echo   ================================================================
echo     CliniRDV - Installation
echo     Deploiement local, sans connexion externe
echo   ================================================================
echo.

REM --- PowerShell est-il disponible ? -----------------------------------
where powershell >nul 2>&1
if errorlevel 1 (
  echo   [x] Windows PowerShell est introuvable.
  echo       Ce programme necessite Windows 10 ou 11.
  echo.
  pause
  exit /b 1
)

REM --- Le script d'installation est-il bien present ? --------------------
if not exist "install.ps1" (
  echo   [x] Fichier "install.ps1" introuvable.
  echo       Gardez ce programme dans le dossier de l'application :
  echo       il ne fonctionne pas seul, sorti de son dossier.
  echo.
  pause
  exit /b 1
)

REM --- Droits administrateur --------------------------------------------
REM  Non obligatoires : l'installation se fait dans le dossier courant et
REM  n'ecrit pas dans Program Files. Ils ne servent qu'a winget, si
REM  Node.js doit etre installe. On avertit sans bloquer.
net session >nul 2>&1
if errorlevel 1 (
  echo   [i] Execution sans droits administrateur.
  echo       Si Node.js doit etre installe, Windows demandera confirmation.
  echo.
)

echo   Installation en cours. Comptez quelques minutes a la premiere
echo   execution : le serveur de base de donnees est telecharge.
echo.

REM  -ExecutionPolicy Bypass : sans cette option, Windows refuse d'executer
REM  un script telecharge et affiche une erreur incomprehensible.
powershell -NoProfile -ExecutionPolicy Bypass -File "install.ps1" %*
set "RESULT=%ERRORLEVEL%"

echo.
if "%RESULT%"=="0" (
  echo   ================================================================
  echo     Installation terminee.
  echo.
  echo     Pour demarrer l'application plus tard, utilisez le raccourci
  echo     "CliniRDV" sur le Bureau, ou le fichier
  echo     "Demarrer-CliniRDV.cmd" de ce dossier.
  echo   ================================================================
) else (
  echo   ================================================================
  echo     L'installation a echoue (code %RESULT%).
  echo     Le message d'erreur ci-dessus en indique la cause.
  echo   ================================================================
)
echo.
pause
exit /b %RESULT%
