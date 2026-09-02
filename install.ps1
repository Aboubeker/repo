<#
  CliniRDV — installation locale complète (Windows 10/11, PowerShell 5.1+)

    .\install.ps1              installation puis démarrage du serveur
    .\install.ps1 -NoStart     installation seule
    .\install.ps1 -Reset       réinitialise la base avant de réinstaller

  Le script installe Node.js si nécessaire (via winget), les dépendances, le
  serveur PostgreSQL embarqué, applique le schéma, charge le jeu de
  démonstration, compile l'interface et lance l'application.

  Si l'exécution est bloquée par la stratégie de sécurité, lancez :
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>

param(
  [switch]$NoStart,
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$NodeMin = 20

function Step($m) { Write-Host "`n> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`n[x] $m`n" -ForegroundColor Red; exit 1 }

Write-Host @'
  ================================================================
    CliniRDV - Gestion des rendez-vous de clinique
    Installation locale - deploiement on-premise
  ================================================================
'@ -ForegroundColor White

# ------------------------------------------------------------- 1. plateforme
Step "Verification du systeme"
if ([Environment]::Is64BitOperatingSystem -ne $true) {
  Die "Windows 64 bits requis."
}
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
Ok "Windows $arch (paquet PostgreSQL : windows-$arch)"

# --------------------------------------------------------------- 2. Node.js
Step "Node.js $NodeMin ou superieur"
$needNode = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = (node -v) -replace '^v','' -split '\.' | Select-Object -First 1
  if ([int]$v -ge $NodeMin) { Ok "Node.js $(node -v) deja present"; $needNode = $false }
  else { Warn "Node.js $(node -v) trop ancien (minimum v$NodeMin)" }
} else { Warn "Node.js absent" }

if ($needNode) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die "Node.js $NodeMin+ est requis. Installez-le depuis https://nodejs.org puis relancez ce script."
  }
  Step "Installation de Node.js LTS via winget"
  winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  # Rafraichit le PATH de la session courante
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path','User')
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "Node.js a ete installe mais n'est pas dans le PATH. Fermez et rouvrez PowerShell, puis relancez."
  }
  Ok "Node.js $(node -v) installe"
}

# --------------------------------------------------------- 3. fichier .env
Step "Configuration locale (.env)"
if (Test-Path .env) {
  Ok ".env existant conserve"
} else {
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $content = (Get-Content .env.example) -replace '^JWT_SECRET=.*', "JWT_SECRET=$secret"
  # IMPORTANT : ecriture sans BOM. « Set-Content -Encoding UTF8 » ajoute un BOM
  # sous PowerShell 5.1, ce qui corrompt le nom de la premiere variable et rend
  # NODE_ENV illisible pour « node --env-file ».
  [IO.File]::WriteAllLines((Join-Path $PWD '.env'), $content, (New-Object Text.UTF8Encoding($false)))
  Ok ".env cree avec un secret JWT aleatoire"
}

# Detecte un .env corrompu par un BOM (installation faite avec une version
# anterieure du script) et le repare.
$envBytes = [IO.File]::ReadAllBytes((Join-Path $PWD '.env'))
if ($envBytes.Length -ge 3 -and $envBytes[0] -eq 0xEF -and $envBytes[1] -eq 0xBB -and $envBytes[2] -eq 0xBF) {
  $lines = [IO.File]::ReadAllLines((Join-Path $PWD '.env'))
  [IO.File]::WriteAllLines((Join-Path $PWD '.env'), $lines, (New-Object Text.UTF8Encoding($false)))
  Warn ".env contenait un BOM UTF-8 : corrige"
}

$portApp = (Select-String -Path .env -Pattern '^PORT=' | ForEach-Object { $_.Line.Split('=')[1] })
if (-not $portApp) { $portApp = '3001' }
$portDb = (Select-String -Path .env -Pattern '^PGPORT=' | ForEach-Object { $_.Line.Split('=')[1] })
if (-not $portDb) { $portDb = '55432' }

# ------------------------------------------------------------ 4. dependances
Step "Installation des dependances npm"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die "Echec de 'npm install'. Verifiez l'acces au registre npm." }
Ok "Dependances installees"

$pgDir = "node_modules\@embedded-postgres\windows-$arch"
if (-not (Test-Path $pgDir)) { Die "PostgreSQL embarque absent ($pgDir). Relancez 'npm install'." }
Ok "PostgreSQL embarque disponible"

# ------------------------------------------------------------- 5. base locale
# PostgreSQL refuse de demarrer si le dossier de donnees est protege par
# l'antivirus ou synchronise (OneDrive). On previent plutot que d'echouer.
if ($PSScriptRoot -match 'OneDrive') {
  Warn "Le projet est dans un dossier OneDrive : la synchronisation peut corrompre"
  Warn "le cluster PostgreSQL. Deplacez-le vers C:\dev\clinirdv si le demarrage echoue."
}

if ($Reset) {
  Step "Reinitialisation de la base"
  node scripts/db.mjs reset
} else {
  Step "Demarrage du serveur PostgreSQL local"
  node scripts/db.mjs start
}
if ($LASTEXITCODE -ne 0) { Die "Echec du demarrage de PostgreSQL. Consultez .pgdata.log." }
Ok "PostgreSQL en ecoute sur 127.0.0.1:$portDb"

Step "Application du schema (migrations)"
npm run migrate
if ($LASTEXITCODE -ne 0) { Die "Echec des migrations." }
Ok "Schema applique"

Step "Chargement du jeu de demonstration"
npm run seed
if ($LASTEXITCODE -ne 0) { Warn "Le seed a echoue ou les donnees existent deja - poursuite." }
else { Ok "Donnees de demonstration chargees" }

# ------------------------------------------------------------- 6. interface
Step "Compilation de l'interface web"
npm run build:web
if ($LASTEXITCODE -ne 0) { Die "Echec de la compilation de l'interface." }
Ok "Interface compilee dans apps\web\dist"

# ----------------------------------------------------------------- 7. tests
Step "Verification par la suite de tests"
npm test *> "$env:TEMP\clinirdv-test.log"
if ($LASTEXITCODE -eq 0) { Ok "Suite de tests reussie" }
else { Warn "Des tests ont echoue - detail dans $env:TEMP\clinirdv-test.log" }

# ------------------------------------------------------------------ 8. bilan
Write-Host "`n  Installation terminee." -ForegroundColor Green
Write-Host @"

  Comptes de demonstration - mot de passe : Clinique2026!
    admin      Administrateur (acces complet)
    s.amrani   Receptionniste (agenda, file d'attente, encaissement)
    a.benali   Praticien (dossiers medicaux, consultation)
    c.compta   Facturation (factures, caisse, impayes)

  Commandes utiles
    npm start                  demarre l'application -> http://localhost:$portApp
    npm test                   relance la suite de tests
    npm run dev:api            API en rechargement automatique
    npm run dev:web            interface en mode developpement (port 5173)
    node scripts/db.mjs stop   arrete PostgreSQL
    node scripts/db.mjs reset  remet la base a zero
    .\install.ps1 -Reset       reinstallation complete
"@

# Diagnostic final : valide chaque maillon avant de rendre la main.
Step "Diagnostic de l'installation"
node scripts/doctor.mjs
if ($LASTEXITCODE -ne 0) {
  Die "L'installation est incomplete. Corrigez les points marques [x] ci-dessus, puis relancez : node scripts/doctor.mjs"
}

if (-not $NoStart) {
  Step "Demarrage de l'application"
  Write-Host "  La page de connexion va s'ouvrir dans votre navigateur.`n"
  npm run app
} else {
  Write-Host "  Lancez 'npm run app' pour demarrer et ouvrir la page de connexion.`n"
}
