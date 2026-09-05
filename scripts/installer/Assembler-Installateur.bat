@echo off
REM ====================================================================
REM  CliniRDV - reassembly of the installer (2 parts)
REM
REM  Download CliniRDV-Installateur.part1 and .part2,
REM  place them in the same folder as this file, and then
REM  double-click this file.
REM ====================================================================
cd /d "%~dp0"

if not exist "CliniRDV-Installateur.part1" (
  echo   [x] Part 1 introuvable : CliniRDV-Installateur.part1
  pause
  exit /b 1
)
if not exist "CliniRDV-Installateur.part2" (
  echo   [x] Part 2 introuvable : CliniRDV-Installateur.part2
  pause
  exit /b 1
)

REM Integrite des telechargements : part1 est toujours coupee a 95 Mo
REM (99614720 octets) ; part2 doit contenir au moins 1 Mo.
for %%F in ("CliniRDV-Installateur.part1") do if %%~zF NEQ 99614720 (
  echo   [x] Part 1 incomplete : %%~zF octets au lieu de 99614720.
  echo       Telechargez-la a nouveau.
  pause
  exit /b 1
)
for %%F in ("CliniRDV-Installateur.part2") do if %%~zF LSS 1048576 (
  echo   [x] Part 2 anormalement petite : %%~zF octets.
  echo       Telechargez-la a nouveau.
  pause
  exit /b 1
)

echo   Assemblage de CliniRDV-Installateur.exe ...
copy /b "CliniRDV-Installateur.part1" + "CliniRDV-Installateur.part2" "CliniRDV-Installateur.exe"

if not exist "CliniRDV-Installateur.exe" (
  echo   [x] Assemblage a echoue.
  pause
  exit /b 1
)

echo.
echo   [OK] CliniRDV-Installateur.exe est pret.
echo        Double-cliquez dessus pour lancer l'installation.
echo.
pause
