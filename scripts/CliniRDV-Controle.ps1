# =====================================================================
#  CliniRDV - Panneau de controle
#
#  Fenetre unique pour demarrer, arreter et mettre a jour l'application,
#  sans jamais ouvrir de terminal.
#
#  Choix technique : Windows Forms via PowerShell. C'est le seul moyen
#  d'obtenir une vraie fenetre native sans rien installer de plus - pas
#  d'Electron (200 Mo), pas de runtime tiers. Present sur tout Windows 10/11.
# =====================================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# --- Le port vient de .env : le coder en dur ferait mentir l'ecran si
#     l'exploitant l'a change pour un conflit de port.
$Port = 3001
$envFile = Join-Path $Root '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
}
$Url = "http://localhost:$Port"

# ---------------------------------------------------------------- Etat
function Test-ServerUp {
  # On teste le port, pas la presence d'un process node : plusieurs
  # processus node peuvent coexister, et seul le port dit la verite.
  try {
    $c = New-Object Net.Sockets.TcpClient
    $r = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    $okc = $r.AsyncWaitHandle.WaitOne(400, $false)
    if ($okc) { $c.EndConnect($r); $c.Close(); return $true }
    $c.Close(); return $false
  } catch { return $false }
}

function Get-ServerProcess {
  # Le PID qui ecoute reellement le port applicatif.
  try {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -First 1
    if ($conn) { return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue }
  } catch { }
  return $null
}

# ------------------------------------------------------------- Fenetre
$form                = New-Object Windows.Forms.Form
$form.Text           = 'CliniRDV - Panneau de controle'
$form.Size           = New-Object Drawing.Size(560, 430)
$form.StartPosition  = 'CenterScreen'
$form.FormBorderStyle= 'FixedSingle'
$form.MaximizeBox    = $false
$form.BackColor      = [Drawing.Color]::White
$form.Font           = New-Object Drawing.Font('Segoe UI', 9)

$title            = New-Object Windows.Forms.Label
$title.Text       = 'CliniRDV'
$title.Font       = New-Object Drawing.Font('Segoe UI', 17, [Drawing.FontStyle]::Bold)
$title.ForeColor  = [Drawing.Color]::FromArgb(37, 99, 235)
$title.Location   = New-Object Drawing.Point(24, 18)
$title.AutoSize   = $true
$form.Controls.Add($title)

$subtitle          = New-Object Windows.Forms.Label
$subtitle.Text     = 'Gestion de clinique - installation locale'
$subtitle.ForeColor= [Drawing.Color]::Gray
$subtitle.Location = New-Object Drawing.Point(26, 52)
$subtitle.AutoSize = $true
$form.Controls.Add($subtitle)

# Pastille d'etat : couleur + texte, jamais la couleur seule (un
# utilisateur daltonien doit pouvoir lire l'etat).
$dot          = New-Object Windows.Forms.Label
$dot.Size     = New-Object Drawing.Size(14, 14)
$dot.Location = New-Object Drawing.Point(26, 92)
$form.Controls.Add($dot)

$state          = New-Object Windows.Forms.Label
$state.Location = New-Object Drawing.Point(48, 89)
$state.AutoSize = $true
$state.Font     = New-Object Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Bold)
$form.Controls.Add($state)

$addr           = New-Object Windows.Forms.LinkLabel
$addr.Location  = New-Object Drawing.Point(26, 114)
$addr.AutoSize  = $true
$addr.Text      = $Url
$addr.add_LinkClicked({ Start-Process $Url })
$form.Controls.Add($addr)

function New-Button($text, $x, $y, $w) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object Drawing.Point($x, $y)
  $b.Size = New-Object Drawing.Size($w, 42)
  $b.FlatStyle = 'Flat'
  $b.BackColor = [Drawing.Color]::FromArgb(243, 244, 246)
  $b.Cursor = 'Hand'
  return $b
}

$btnStart  = New-Button 'Demarrer'          26  146 160
$btnStop   = New-Button 'Arreter'          196  146 160
$btnOpen   = New-Button 'Ouvrir'           366  146 160
$btnUpdate = New-Button 'Mettre a jour'     26  196 250
$btnDiag   = New-Button 'Diagnostic'       286  196 240
$form.Controls.AddRange(@($btnStart, $btnStop, $btnOpen, $btnUpdate, $btnDiag))

$log                = New-Object Windows.Forms.TextBox
$log.Multiline      = $true
$log.ScrollBars     = 'Vertical'
$log.ReadOnly       = $true
$log.Location       = New-Object Drawing.Point(26, 252)
$log.Size           = New-Object Drawing.Size(500, 120)
$log.BackColor      = [Drawing.Color]::FromArgb(250, 250, 250)
$log.Font           = New-Object Drawing.Font('Consolas', 8.5)
$form.Controls.Add($log)

# --- Lecture d'une commande externe ----------------------------------
# Les scripts Node emettent de l'UTF-8, alors que cmd.exe rend son texte dans
# la page de code de la console (850 en Europe francophone). Lire la sortie
# sans le preciser affichait des caracteres parasites a la place des accents.
function Invoke-Tool([string]$CommandLine) {
  $prev = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $out = & cmd.exe /c "chcp 65001 >nul & $CommandLine 2>&1"
  } finally {
    [Console]::OutputEncoding = $prev
  }
  return $out
}

# La zone de journal utilise une police a chasse fixe depourvue des symboles
# decoratifs employes par les scripts : sans conversion ils s'affichent en
# carres vides.
function Format-LogLine([string]$Line) {
  $map = @{
    [char]0x2713 = '[ok]'; [char]0x2714 = '[ok]'
    [char]0x2717 = '[X]';  [char]0x2718 = '[X]'
    [char]0x25B8 = '>';    [char]0x2022 = '-'
    [char]0x2192 = '->';   [char]0x2502 = '|'
    [char]0x2500 = '-';    [char]0x2014 = '-'
    [char]0x2013 = '-';    [char]0x2026 = '...'
    [char]0x00B7 = '-';    [char]0x26A0 = '[!]'
    [char]0x00AB = '"';    [char]0x00BB = '"'
  }
  $sb = New-Object Text.StringBuilder
  foreach ($ch in $Line.ToCharArray()) {
    if ($map.ContainsKey($ch)) { [void]$sb.Append($map[$ch]) }
    else { [void]$sb.Append($ch) }
  }
  return $sb.ToString()
}

function Write-Log($msg) {
  $clean = Format-LogLine "$msg"
  $log.AppendText(('[{0}] {1}{2}' -f (Get-Date -Format 'HH:mm:ss'), $clean, [Environment]::NewLine))
}

# ------------------------------------------------------- Rafraichissement
function Update-State {
  if (Test-ServerUp) {
    $dot.BackColor    = [Drawing.Color]::FromArgb(22, 163, 74)
    $state.Text       = 'Serveur en marche'
    $state.ForeColor  = [Drawing.Color]::FromArgb(22, 163, 74)
    $btnStart.Enabled = $false
    $btnStop.Enabled  = $true
    $btnOpen.Enabled  = $true
    $addr.Visible     = $true
  } else {
    $dot.BackColor    = [Drawing.Color]::FromArgb(220, 38, 38)
    $state.Text       = 'Serveur arrete'
    $state.ForeColor  = [Drawing.Color]::FromArgb(220, 38, 38)
    $btnStart.Enabled = $true
    $btnStop.Enabled  = $false
    $btnOpen.Enabled  = $false
    $addr.Visible     = $false
  }
}

# Sonde periodique : l'etat reste juste meme si le serveur est demarre ou
# tue depuis l'exterieur du panneau.
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ Update-State })
$timer.Start()

# ------------------------------------------------------------- Actions

# Arret complet : le serveur applicatif, puis PostgreSQL. Partage par le
# bouton Arreter et par la mise a jour, qui exige les deux a l'arret - le
# serveur garderait sinon des connexions ouvertes pendant la migration.
function Stop-Application {
  $p = Get-ServerProcess
  if ($p) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Write-Log "Processus $($p.Id) arrete."
  } else {
    Write-Log 'Aucun processus trouve sur le port.'
  }
  # PostgreSQL est arrete proprement par son propre outil : tuer le process
  # laisserait un verrou et la base refuserait de redemarrer.
  & node (Join-Path $Root 'scripts\db.mjs') stop 2>&1 | Out-Null
  Write-Log 'Base de donnees arretee.'
}

$btnStart.add_Click({
  Write-Log 'Demarrage en cours...'
  $btnStart.Enabled = $false
  # -WindowStyle Hidden : le serveur tourne en tache de fond, l'utilisateur
  # n'a pas de fenetre noire a garder ouverte (ni a fermer par erreur).
  # 'npm run app', pas 'npm start' : start lance le seul serveur web et
  # laisse PostgreSQL a l'arret, si bien que la connexion echouait avec une
  # erreur 500. app demarre la base, verifie les prerequis, puis le serveur.
  Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', 'npm', 'run', 'app' `
    -WorkingDirectory $Root -WindowStyle Hidden

  # Le demarrage inclut PostgreSQL : on laisse jusqu'a 40 s avant d'alerter.
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 1000
    [Windows.Forms.Application]::DoEvents()
    if (Test-ServerUp) {
      Write-Log "Serveur pret sur $Url"
      Update-State
      Start-Process $Url
      return
    }
  }
  Write-Log 'Le serveur ne repond toujours pas. Lancez le diagnostic.'
  Update-State
})

$btnStop.add_Click({
  Write-Log 'Arret du serveur...'
  Stop-Application
  Start-Sleep -Milliseconds 600
  Update-State
})

$btnOpen.add_Click({ Start-Process $Url })

$btnUpdate.add_Click({
  $r = [Windows.Forms.MessageBox]::Show(
    "Mettre a jour CliniRDV ?`n`nLe serveur sera arrete pendant l'operation.",
    'Mise a jour', 'YesNo', 'Question')
  if ($r -ne 'Yes') { return }

  # Le serveur ET la base sont arretes avant l'operation : migrer sous des
  # connexions ouvertes est un risque inutile. La mise a jour redemarre la
  # base le temps d'appliquer les migrations, puis la rend a cet etat arrete.
  Write-Log 'Arret du serveur et de la base...'
  Stop-Application

  Write-Log 'Mise a jour en cours (cela peut prendre une minute)...'
  $form.Cursor = 'WaitCursor'
  $btnUpdate.Enabled = $false
  $out = Invoke-Tool "npm run update"
  $form.Cursor = 'Default'
  $btnUpdate.Enabled = $true

  foreach ($line in $out) { if ("$line".Trim()) { Write-Log "$line" } }
  Write-Log 'Mise a jour terminee. Cliquez sur Demarrer pour relancer.'
  Update-State
})

$btnDiag.add_Click({
  Write-Log 'Diagnostic en cours...'
  $out = Invoke-Tool "npm run doctor"
  foreach ($line in $out) { if ("$line".Trim()) { Write-Log "$line" } }
})

# Le panneau ne tue pas le serveur en se fermant : la clinique doit pouvoir
# fermer cette fenetre tout en continuant a travailler dans le navigateur.
$form.add_FormClosing({
  $timer.Stop()
  if (Test-ServerUp) {
    Write-Log 'Le serveur continue de tourner en arriere-plan.'
  }
})

Update-State
Write-Log 'Panneau de controle pret.'
[void]$form.ShowDialog()
