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

## Paquet distribuable et protection du code

`node scripts/build-package.mjs` fabrique dans `release/` un dossier autonome :

| Fichier | Contenu |
|---|---|
| `CliniRDV.exe` | Serveur applicatif compile en un binaire unique (SEA Node 22) |
| `apps/web/dist` | Interface compilee et minifiee, **sans sourcemaps** |
| `infra/db` | Migrations SQL, lues a l'execution |
| `Installer.cmd` | Prepare la base via `CliniRDV.exe --migrate` |
| `CliniRDV.cmd` | Ouvre le panneau de controle |

Le dossier ne contient **aucun fichier `.mjs` ni `.jsx`**.

### Ce que cette protection vaut reellement

Il faut etre precis sur ce point, car le mot « protection » promet souvent
plus qu'il ne tient :

- **Ce qui est obtenu.** Le JavaScript est regroupe et minifie : noms de
  variables detruits, commentaires de conception supprimes, structure des
  modules effacee. Le code n'est ni lisible ni maintenable par un tiers, et
  les sourcemaps - qui reconstitueraient l'original a l'identique - sont
  exclues du paquet.
- **Ce qui n'est pas obtenu.** Ce n'est pas du chiffrement. Le binaire
  contient du JavaScript que l'on peut extraire et desobfusquer avec de la
  determination. Aucune technique cote client ne protege absolument un code
  qui doit s'executer sur une machine que l'on ne controle pas.

L'objectif realiste est d'empecher la reprise, la modification et la revente
du code par un concurrent ou un client, pas de resister a une analyse
outillee. Pour une clinique, c'est la protection utile ; la protection
juridique - licence, contrat - reste le vrai recours.

### Fabrication et telechargement

Un `.exe` Windows ne peut pas etre produit depuis Linux sans chaine croisee :
le workflow `.github/workflows/release.yml` compile donc sur un runner
`windows-latest`. Il **execute la suite de tests avant de publier** - un
paquet casse chez une clinique n'est pas diagnosticable a distance.

Pour publier une version :

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub attache alors `CliniRDV-Windows.zip` et son empreinte `SHA256.txt` a la
page *Releases*. Sans creer de version, l'onglet *Actions* permet de lancer le
workflow a la demande et de recuperer l'archive dans les artefacts.

Le client telecharge le zip, l'extrait, double-clique `Installer.cmd`, puis
`CliniRDV.cmd`. L'empreinte SHA-256 lui permet de verifier que l'archive n'a
pas ete alteree.

### Points techniques resolus

Cinq pieges, chacun rendant l'executable inutilisable ou sa fabrication impossible, ont ete corriges :

1. **`import.meta.url` est vide en CommonJS.** Chaque module calculait sa
   racine en remontant un nombre de niveaux different ; migrations, seed et
   sauvegardes cherchaient leurs fichiers a cote de la plaque. La racine est
   desormais resolue par `apps/api/src/core/root.mjs`, seul endroit a
   connaitre cette question.
2. **`process.versions.sea` n'est pas renseigne** par toutes les versions de
   Node. Le serveur ne se reconnaissait pas comme point d'entree et se
   terminait **sans le moindre message**. La detection passe par `node:sea`.
3. **Le `top-level await` est interdit en CommonJS.** Les appels concernes
   sont encapsules dans des fonctions asynchrones.
4. **`'C:\Program' is not recognized as an internal or external command.`**
   La fonction `run()` de `scripts/build-package.mjs` passait `shell: isWin`
   a tous les outils. `cmd.exe` recevait alors le chemin de Node sans
   guillemets et le coupait au premier espace — or Node s'installe par
   defaut dans `C:\Program Files\nodejs`. La fabrication echouait donc sur
   toute installation Windows standard, alors qu'elle passait sous Linux.
   Le shell n'est desormais utilise que pour les lanceurs `.cmd` et `.bat`,
   que Windows ne sait pas executer directement, et les arguments qui lui
   sont passes sont cites. Un test de `platform.test.mjs` verrouille ce
   comportement.
5. **Trois avertissements esbuild « import.meta is not available with the
   cjs output format »** s'affichaient a chaque fabrication. Ils sont
   attendus et deja traites par `core/root.mjs` ; ils sont reduits au
   silence (`--log-override:empty-import-meta=silent`) pour ne pas faire
   douter d'un paquet pourtant sain.

### Ce que le paquet livre a partir de la migration 007

Les migrations `infra/db/*.sql` sont embarquees et appliquees au premier
demarrage (`CliniRDV.exe --migrate`). Deux regles metier introduites par la
migration `007_ouverture_7j7.sql` s'appliquent donc a toute installation :

- **Ouverture sept jours sur sept.** Chaque praticien recoit, pour le
  vendredi et le samedi, les plages de son jour de reference (le dimanche
  s'il y travaille, sinon son premier jour ouvre). Les « fermetures »
  libellees comme un jour ferie sont retirees : les feries restent signales
  dans l'agenda mais ne bloquent plus la reservation. Les fermetures reelles
  (travaux, conges) se saisissent dans Parametres et continuent de bloquer.
- **Une seule facture par journee.** Un client qui enchaine deux actes le
  meme jour, ou une consultation suivie d'examens prescrits, repart avec un
  seul document a regler : le second acte rejoint le brouillon du jour. Une
  facture deja emise n'est jamais completee — un acte posterieur ouvre un
  nouveau document.

## Le panneau de controle

Le raccourci **CliniRDV** depose sur le Bureau n'ouvre pas un demarrage
direct : il ouvre `CliniRDV.cmd`, qui lance la fenetre graphique
`scripts/CliniRDV-Controle.ps1`. Depuis cette fenetre unique, sans terminal :

| Bouton | Effet |
|---|---|
| Demarrer | Lance le serveur en tache de fond, attend qu'il reponde, ouvre le navigateur |
| Arreter | Termine le serveur, puis arrete PostgreSQL proprement |
| Ouvrir | Reouvre la page de connexion |
| Mettre a jour | Arrete le serveur, lance `npm run update`, affiche le journal |
| Diagnostic | Execute `npm run doctor` et affiche le resultat |

Une pastille verte ou rouge indique l'etat, **doublee d'un texte** : la
couleur seule serait illisible pour un utilisateur daltonien. Une sonde
interroge le port toutes les 2 secondes, si bien que l'affichage reste juste
meme si le serveur est demarre ou arrete en dehors du panneau.

Decisions qui meritent explication :

- **Windows Forms plutot qu'Electron.** Une interface Electron demanderait
  ~200 Mo de runtime et une chaine de build. WinForms est present sur tout
  Windows 10/11 : la fenetre est native et l'installation ne grossit pas.
- **L'etat se lit sur le port, pas sur la presence d'un processus `node`.**
  Plusieurs processus Node peuvent coexister sur le poste ; seul le port
  applicatif dit la verite.
- **Le port est lu dans `.env`**, jamais code en dur : un exploitant qui
  change `PORT` pour resoudre un conflit ne doit pas se retrouver devant un
  panneau qui affiche une adresse fausse.
- **L'arret appelle `node scripts/db.mjs stop`** au lieu de tuer PostgreSQL.
  Un `Stop-Process` laisserait un verrou et la base refuserait de redemarrer.
- **Fermer le panneau n'arrete pas le serveur.** La clinique doit pouvoir
  fermer cette fenetre et continuer a travailler dans le navigateur.
- **La mise a jour demande confirmation** et arrete le serveur au prealable :
  recompiler pendant que la base sert des requetes est un risque inutile.

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
