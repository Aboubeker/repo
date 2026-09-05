# =====================================================================
#  CliniRDV - Assistant d'installation
#
#  Fenetre graphique : nom de la clinique, dossier d'installation,
#  mot de passe administrateur (saisi deux fois), port.
#
#  Ce script ne contient AUCUNE logique d'installation : il lance
#  l'executable en mode --silent et lit sa progression ligne a ligne.
#  Contrat lu ici :
#     stdout : "PROGRESS <pct> <message>" (barre de progression)
#     stderr : les erreurs
#  Le code de sortie de l'executable decide du succes.
#
#  Fichier ASCII strict, sans BOM (page de code 850 de la console).
# =====================================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Exe = $env:CLINIRDV_INSTALLER_SELF
if (-not $Exe -or -not (Test-Path $Exe)) {
  [Windows.Forms.MessageBox]::Show("Executable d'installation introuvable :`n$Exe", 'Erreur', 'OK', 'Error') | Out-Null
  exit 1
}

$script:Pending = New-Object System.Collections.ArrayList
$script:Errors  = New-Object System.Collections.ArrayList
# Code de sortie MEMORISE par le bouton Installer : un "exit" direct dans
# un gestionnaire de clic leve une ExitException que Windows Forms affiche
# comme une erreur systeme. Le script se termine APRES ShowDialog (bas du
# fichier) avec ce code.
$script:ExitCode = 0

# ------------------------------------------------------------------ Fenetre
$form = New-Object Windows.Forms.Form
$form.Text = 'CliniRDV - Installation'
$form.Size = New-Object Drawing.Size(470, 660)
$form.StartPosition = 'CenterScreen'
# Passe devant la console au lancement, puis redevient une fenetre normale.
$form.Topmost = $true
$form.add_Shown({ $form.Topmost = $false; [void]$form.Activate() })
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = [Drawing.Color]::White
$form.Font = New-Object Drawing.Font('Segoe UI', 9)

function New-Label([string]$text, [int]$x, [int]$y, [bool]$bold = $false) {
  $l = New-Object Windows.Forms.Label
  $l.Text = $text
  $l.Location = New-Object Drawing.Point($x, $y)
  $l.AutoSize = $true
  if ($bold) { $l.Font = New-Object Drawing.Font('Segoe UI', 9, [Drawing.FontStyle]::Bold) }
  return $l
}

$title = New-Label 'CliniRDV' 24 16 $true
$title.Font = New-Object Drawing.Font('Segoe UI', 17, [Drawing.FontStyle]::Bold)
$title.ForeColor = [Drawing.Color]::FromArgb(37, 99, 235)
$form.Controls.Add($title)

$subtitle = New-Label 'Gestion de clinique - installation locale, sans aucun autre logiciel' 26 52
$subtitle.ForeColor = [Drawing.Color]::Gray
$form.Controls.Add($subtitle)

$form.Controls.Add((New-Label 'Nom de la clinique' 26 92))
$txtName = New-Object Windows.Forms.TextBox
$txtName.Location = New-Object Drawing.Point(26, 112)
$txtName.Size = New-Object Drawing.Size(400, 24)
$form.Controls.Add($txtName)

$form.Controls.Add((New-Label 'Dossier d''installation' 26 150))
$txtFolder = New-Object Windows.Forms.TextBox
$txtFolder.Location = New-Object Drawing.Point(26, 170)
$txtFolder.Size = New-Object Drawing.Size(330, 24)
# Chemin par defaut : a cote de l'installateur (ou dans le dossier ouvert).
$txtFolder.Text = Join-Path (Get-Item -Path . -Force).FullName 'CliniRDV'
$form.Controls.Add($txtFolder)

$btnBrowse = New-Object Windows.Forms.Button
$btnBrowse.Text = 'Parcourir'
$btnBrowse.Location = New-Object Drawing.Point(364, 168)
$btnBrowse.Size = New-Object Drawing.Size(62, 28)
$btnBrowse.add_Click({
  $dlg = New-Object Windows.Forms.FolderBrowserDialog
  $dlg.Description = 'Choisissez le dossier d''installation'
  if ($txtFolder.Text -and (Test-Path $txtFolder.Text)) { $dlg.SelectedPath = $txtFolder.Text }
  if ($dlg.ShowDialog() -eq 'OK') { $txtFolder.Text = $dlg.SelectedPath }
})
$form.Controls.Add($btnBrowse)

$form.Controls.Add((New-Label 'Mot de passe administrateur (12 caracteres minimum)' 26 210))
$txtPw = New-Object Windows.Forms.TextBox
$txtPw.Location = New-Object Drawing.Point(26, 230)
$txtPw.Size = New-Object Drawing.Size(400, 24)
$txtPw.UseSystemPasswordChar = $true
$form.Controls.Add($txtPw)

$form.Controls.Add((New-Label 'Confirmer le mot de passe' 26 268))
$txtPw2 = New-Object Windows.Forms.TextBox
$txtPw2.Location = New-Object Drawing.Point(26, 288)
$txtPw2.Size = New-Object Drawing.Size(400, 24)
$txtPw2.UseSystemPasswordChar = $true
$form.Controls.Add($txtPw2)

$form.Controls.Add((New-Label 'Port' 26 326))
$txtPort = New-Object Windows.Forms.TextBox
$txtPort.Location = New-Object Drawing.Point(26, 346)
$txtPort.Size = New-Object Drawing.Size(80, 24)
$txtPort.Text = '3001'
$form.Controls.Add($txtPort)

$btnInstall = New-Object Windows.Forms.Button
$btnInstall.Text = 'Installer'
$btnInstall.Location = New-Object Drawing.Point(26, 386)
$btnInstall.Size = New-Object Drawing.Size(400, 44)
$btnInstall.BackColor = [Drawing.Color]::FromArgb(37, 99, 235)
$btnInstall.ForeColor = [Drawing.Color]::White
$btnInstall.FlatStyle = 'Flat'
$btnInstall.Font = New-Object Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Bold)
$form.Controls.Add($btnInstall)

$progress = New-Object Windows.Forms.ProgressBar
$progress.Location = New-Object Drawing.Point(26, 446)
$progress.Size = New-Object Drawing.Size(400, 18)
$progress.Minimum = 0
$progress.Maximum = 100
$form.Controls.Add($progress)

$lblStatus = New-Object Windows.Forms.Label
$lblStatus.Location = New-Object Drawing.Point(26, 472)
$lblStatus.Size = New-Object Drawing.Size(400, 20)
$lblStatus.AutoSize = $true
$lblStatus.Font = New-Object Drawing.Font('Segoe UI', 9, [Drawing.FontStyle]::Bold)
$form.Controls.Add($lblStatus)

$log = New-Object Windows.Forms.TextBox
$log.Multiline = $true
$log.ScrollBars = 'Vertical'
$log.ReadOnly = $true
$log.Location = New-Object Drawing.Point(26, 498)
$log.Size = New-Object Drawing.Size(408, 130)
$log.BackColor = [Drawing.Color]::FromArgb(250, 250, 250)
$log.Font = New-Object Drawing.Font('Consolas', 8.5)
$form.Controls.Add($log)

# ------------------------------------------------- Lecture de la progression
# Les lignes arrives du processus fils sont mises en file ; un minutier
# (thread UI) les consomme : aucune mise a jour du panneau depuis un autre
# thread, ce que Windows Forms interdit.
function Write-LogLine([string]$line) {
  $log.AppendText(('[{0}] {1}{2}' -f (Get-Date -Format 'HH:mm:ss'), $line, [Environment]::NewLine))
}

function Drain-Pending {
  while ($script:Pending.Count -gt 0) {
    $line = $script:Pending[0]
    [void]$script:Pending.RemoveAt(0)
    $m = [regex]::Match($line, '^PROGRESS (\d+) (.*)$')
    if ($m.Success) {
      $progress.Value = [Math]::Min([int]$m.Groups[1].Value, $progress.Maximum)
      $lblStatus.Text = $m.Groups[2].Value
    } else {
      Write-LogLine $line
    }
  }
}

# File des sorties du processus fils : les evenements .NET sont mis en file
# par le moteur (Register-ObjectEvent, voir le bouton Installer) et relus
# ici avec Wait-Event, SUR LE THREAD DU PANNEAU : une seule voie, aucun
# appel entre threads, ce que Windows Forms interdit.
function Drain-ProcessEvents {
  $ev = Wait-Event -Timeout 0
  while ($null -ne $ev) {
    $data = $ev.SourceEventArgs.Data
    if ($null -ne $data) {
      [void]$script:Pending.Add($data)
      if ($ev.SourceIdentifier -eq 'CliniRDV-Err') { [void]$script:Errors.Add($data) }
    }
    Remove-Event -EventIdentifier $ev.EventIdentifier -ErrorAction SilentlyContinue
    $ev = Wait-Event -Timeout 0
  }
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 100
$timer.add_Tick({ Drain-Pending })
$timer.Start()

# ----------------------------------------------------------------- Actions
$btnInstall.add_Click({
  $name   = $txtName.Text.Trim()
  $folder = $txtFolder.Text.Trim()
  $pw     = $txtPw.Text
  $pw2    = $txtPw2.Text
  $port   = $txtPort.Text.Trim()

  # --- Validation (miree de la politique de l'application, cote interface)
  $errs = @()
  if (-not $name) { $errs += 'Le nom de la clinique est obligatoire.' }
  if (-not $folder) { $errs += 'Le dossier d''installation est obligatoire.' }
  elseif (-not [System.IO.Path]::IsPathRooted($folder)) { $errs += 'Le dossier doit etre un chemin absolu.' }
  if ($pw.Length -lt 12) {
    $errs += 'Mot de passe : 12 caracteres minimum.'
  } else {
    $classes = 0
    if ($pw -match '[a-z]') { $classes++ }
    if ($pw -match '[A-Z]') { $classes++ }
    if ($pw -match '[0-9]') { $classes++ }
    if ($pw -match '[^a-zA-Z0-9]') { $classes++ }
    if ($classes -lt 3) { $errs += 'Mot de passe : 3 types de caracteres minimum (minuscule, majuscule, chiffre, symbole).' }
  }
  if ($pw -ne $pw2) { $errs += 'Les deux mots de passe ne correspondent pas.' }
  if ($port -notmatch '^\d{1,5}$' -or [int]$port -lt 1024 -or [int]$port -gt 65535) {
    $errs += 'Port : entier entre 1024 et 65535.'
  }
  if ($errs.Count -gt 0) {
    [Windows.Forms.MessageBox]::Show(($errs -join "`n"), 'Champs a corriger', 'OK', 'Warning') | Out-Null
    return
  }

  # --- Mot de passe : fichier temporaire 0600, jamais en argument
  $pwfile = Join-Path $env:TEMP "clinirdv-install-pw-$PID.tmp"
  [System.IO.File]::WriteAllText($pwfile, $pw, (New-Object Text.UTF8Encoding($false)))

  # --- Installation existante : mise a jour (confirmation a l'utilisateur)
  $isUpdate = Test-Path (Join-Path $folder '.pgdata')
  if ($isUpdate) {
    $r = [Windows.Forms.MessageBox]::Show(
      "Une installation est deja presente dans ce dossier.`n`nLa base de donnees et le fichier .env seront conserves.`nContinuer la mise a jour ?",
      'Mise a jour', 'YesNo', 'Question')
    if ($r -ne 'Yes') { return }
  }

  $btnInstall.Enabled = $false
  $form.Cursor = 'WaitCursor'
  $lblStatus.Text = 'Demarrage...'

  $argList = @('--silent', '--target', "`"$folder`"", '--name', "`"$name`"", '--port', $port, '--admin-password-file', "`"$pwfile`"")
  if ($isUpdate) { $argList += '--update' }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = $argList -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = (Split-Path -Parent $Exe)

  # Abonnements residuels eventuels (clic precedent interrompu).
  Unregister-Event -SourceIdentifier 'CliniRDV-Out' -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier 'CliniRDV-Err' -ErrorAction SilentlyContinue

  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
    # SANS "+=" : Windows PowerShell 5.1 ne connait pas cette syntaxe C#
    # pour les evenements ("The property 'OutputDataReceived' cannot be
    # found..."). Les lignes sont mises en file par le moteur et relues
    # avec Wait-Event (Drain-ProcessEvents), sur le thread du panneau.
    Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -SourceIdentifier 'CliniRDV-Out' | Out-Null
    Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -SourceIdentifier 'CliniRDV-Err' | Out-Null
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()
    # Lecture au fil de l'eau : on attend sans bloquer le panneau.
    while (-not $proc.WaitForExit(100)) {
      Drain-ProcessEvents
      Drain-Pending
      [Windows.Forms.Application]::DoEvents()
    }
    $proc.WaitForExit()
    Start-Sleep -Milliseconds 200
    Drain-ProcessEvents
    Drain-Pending
    $code = $proc.ExitCode
  } catch {
    $code = 1
    [void]$script:Errors.Add($_.Exception.Message)
  } finally {
    Unregister-Event -SourceIdentifier 'CliniRDV-Out' -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier 'CliniRDV-Err' -ErrorAction SilentlyContinue
    Remove-Item $pwfile -ErrorAction SilentlyContinue
    $form.Cursor = 'Default'
  }

  if ($code -ne 0) {
    $msg = "L'installation a echoue (code $code)."
    if ($script:Errors.Count -gt 0) { $msg += "`n`n" + ($script:Errors -join "`n") }
    [Windows.Forms.MessageBox]::Show($msg, 'Erreur', 'OK', 'Error') | Out-Null
    $script:ExitCode = 1
    $form.Close()
    return
  }

  [Windows.Forms.MessageBox]::Show(
    "Installation terminee.`n`nVous pouvez lancer CliniRDV depuis le raccourci depose sur le Bureau.",
    'Succes', 'OK', 'Information') | Out-Null
  $script:ExitCode = 0
  $form.Close()
  return
})

# Fermer la fenetre n'arrete rien d'autre : si l'installation tourne, c'est
# le processus fils qui est la reference, pas ce panneau.
$form.add_FormClosing({
  $timer.Stop()
})

Write-LogLine 'Pret. Renseignez les champs puis cliquez sur Installer.'
[void]$form.ShowDialog()
exit $script:ExitCode
