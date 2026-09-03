# Installateur Windows

## Ce qui est livré aujourd'hui

**`Installer-CliniRDV.cmd`** — programme d'installation à double-cliquer.

Il enveloppe `install.ps1`, qui fait le travail réel : vérification du système,
installation de Node.js via winget si absent, dépendances, serveur PostgreSQL
embarqué, schéma, jeu de démonstration, compilation de l'interface, raccourci
sur le Bureau, puis démarrage.

Le `.cmd` n'est qu'un lanceur, mais il résout un problème concret : par défaut,
Windows **refuse d'exécuter un `.ps1` téléchargé** et affiche une erreur de
stratégie d'exécution incompréhensible pour un utilisateur non technique. Le
`.cmd` passe `-ExecutionPolicy Bypass` et supprime cet obstacle.

Détails d'implémentation qui comptent :

- **Fichier 100 % ASCII.** La console Windows utilise la page de code 850 ;
  des caractères accentués ou des guillemets « français » s'y affichent en
  charabia. Le texte à l'écran est donc sans accents, volontairement.
- **Pas de BOM.** Un `.cmd` commençant par un BOM UTF-8 fait échouer la
  première commande.
- **`cd /d "%~dp0"`** : l'installation fonctionne quel que soit le dossier
  courant, y compris lancée depuis une clé USB.
- **Droits administrateur non requis.** L'installation reste dans son dossier,
  n'écrit pas dans `Program Files`. Un avertissement signale que Windows
  demandera confirmation si Node.js doit être installé.
- **Le code de sortie est propagé** (`exit /b %RESULT%`), pour un déploiement
  scripté sur plusieurs postes.

## Pourquoi pas un vrai `setup.exe`

Un exécutable Windows se produit avec un compilateur d'installateurs — NSIS ou
Inno Setup. Ni l'un ni l'autre n'est disponible dans l'environnement de
construction de ce projet : pas de paquet système installable, et le CDN qui
héberge les binaires NSIS portables (`objects.githubusercontent.com`) est
inaccessible depuis le réseau de construction. Fabriquer un fichier nommé
`setup.exe` qui ne serait pas un véritable exécutable aurait été pire que de
s'en passer : Windows l'aurait rejeté, sans message clair.

Il faut par ailleurs peser ce qu'apporte réellement un `.exe` ici :

| | `.cmd` livré | `setup.exe` |
|---|---|---|
| Double-clic | oui | oui |
| Avertissement SmartScreen | non | **oui**, tant que le binaire n'est pas signé |
| Certificat de signature | inutile | ~300 €/an pour éviter l'alerte |
| Contenu inspectable | oui, texte lisible | non |
| Désinstallation Windows | non | oui |

Sur un déploiement on-premise en petit nombre de postes, le `.cmd` est
souvent préférable : le service informatique de la clinique peut **lire** ce
qu'il exécute, ce qu'un binaire opaque ne permet pas.

## Produire un `setup.exe`, si vous le souhaitez

Sur une machine Windows disposant de NSIS (`winget install NSIS.NSIS`),
enregistrer le script ci-dessous en `installer.nsi` à la racine du projet, puis
lancer `makensis installer.nsi`. Le fichier `CliniRDV-Setup.exe` est produit à
côté.

```nsis
!include "MUI2.nsh"

Name "CliniRDV"
OutFile "CliniRDV-Setup.exe"
InstallDir "$LOCALAPPDATA\CliniRDV"   ; pas Program Files : evite l'elevation
RequestExecutionLevel user
Unicode true

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

Section "Application"
  SetOutPath "$INSTDIR"
  ; Le code source, sans les dossiers reconstruits a l'installation.
  File /r /x node_modules /x .pgdata /x .git /x dist "*.*"

  ; Meme script que le .cmd : une seule logique d'installation a maintenir.
  DetailPrint "Installation des composants..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1" -NoStart'
  Pop $0
  ${If} $0 != 0
    Abort "L'installation a echoue (code $0)."
  ${EndIf}

  CreateShortcut "$DESKTOP\CliniRDV.lnk" "$INSTDIR\Demarrer-CliniRDV.cmd" "" "$INSTDIR\favicon.ico"
  CreateDirectory "$SMPROGRAMS\CliniRDV"
  CreateShortcut "$SMPROGRAMS\CliniRDV\CliniRDV.lnk" "$INSTDIR\Demarrer-CliniRDV.cmd"
  WriteUninstaller "$INSTDIR\Desinstaller.exe"

  ; Entree « Ajout/Suppression de programmes »
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CliniRDV" \
    "DisplayName" "CliniRDV - Gestion de clinique"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CliniRDV" \
    "UninstallString" "$INSTDIR\Desinstaller.exe"
SectionEnd

Section "Uninstall"
  ; Arreter PostgreSQL avant de supprimer : sinon les fichiers sont verrouilles.
  nsExec::ExecToLog 'node "$INSTDIR\scripts\db.mjs" stop'
  Delete "$DESKTOP\CliniRDV.lnk"
  RMDir /r "$SMPROGRAMS\CliniRDV"
  ; .pgdata contient les donnees medicales : on ne le supprime jamais en
  ; silence. L'exploitant decide de son sort.
  MessageBox MB_YESNO "Supprimer egalement la base de donnees et les sauvegardes ?" IDYES full IDNO keep
  full:
    RMDir /r "$INSTDIR"
    Goto done
  keep:
    RMDir /r "$INSTDIR\node_modules"
    Delete "$INSTDIR\Desinstaller.exe"
  done:
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CliniRDV"
SectionEnd
```

Deux points de vigilance :

1. **Signature.** Sans certificat de signature de code, SmartScreen affichera
   « Windows a protégé votre ordinateur » au premier lancement, ce qui inquiète
   davantage un utilisateur que le `.cmd` actuel. Signer avec
   `signtool sign /fd SHA256 /t http://timestamp.digicert.com CliniRDV-Setup.exe`.
2. **Les données ne se suppriment pas en silence.** Le bloc de désinstallation
   ci-dessus demande explicitement avant de toucher à `.pgdata` : il contient
   le dossier médical des clients et les sauvegardes. Une désinstallation qui
   effacerait cela sans prévenir serait une perte de données irréversible.
