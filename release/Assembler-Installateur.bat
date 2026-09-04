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
  echo   [x] Part 1 not found : CliniRDV-Installateur.part1
  pause
  exit /b 1
)
if not exist "CliniRDV-Installateur.part2" (
  echo   [x] Part 2 not found : CliniRDV-Installateur.part2
  pause
  exit /b 1
)

echo   Assembling CliniRDV-Installateur.exe ...
copy /b "CliniRDV-Installateur.part1" + "CliniRDV-Installateur.part2" "CliniRDV-Installateur.exe"

if not exist "CliniRDV-Installateur.exe" (
  echo   [x] Assembly failed.
  pause
  exit /b 1
)

echo.
echo   [OK] CliniRDV-Installateur.exe is ready (%~z2 bytes).
echo        Double-click it to start the installation.
echo.
pause
