#!/usr/bin/env bash
#
# CliniRDV — installation locale complète (Linux / macOS)
#
#   ./install.sh              installation puis démarrage du serveur
#   ./install.sh --no-start   installation seule
#   ./install.sh --reset      réinitialise la base avant de réinstaller
#
# Le script installe Node.js si nécessaire, les dépendances, le serveur
# PostgreSQL embarqué, applique le schéma, charge le jeu de démonstration,
# compile l'interface et lance l'application. Aucun service cloud n'est
# contacté en dehors du téléchargement des paquets npm.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

NODE_MIN=20
DO_START=1
DO_RESET=0

for arg in "$@"; do
  case "$arg" in
    --no-start) DO_START=0 ;;
    --reset)    DO_RESET=1 ;;
    -h|--help)  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $arg (utilisez --help)"; exit 1 ;;
  esac
done

# ----------------------------------------------------------------- affichage
if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=''; G=''; Y=''; R=''; C=''; N=''
fi
step() { printf '\n%s▸ %s%s\n' "$B$C" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%s✗ %s%s\n\n' "$R" "$1" "$N" >&2; exit 1; }

printf '%s\n' "$B"
cat <<'BANNER'
  ╔══════════════════════════════════════════════════════════════╗
  ║   CliniRDV — Gestion des rendez-vous de clinique             ║
  ║   Installation locale · déploiement on-premise               ║
  ╚══════════════════════════════════════════════════════════════╝
BANNER
printf '%s' "$N"

# ------------------------------------------------------- 1. système supporté
step "Vérification du système"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux)  PLATFORM=linux  ;;
  Darwin) PLATFORM=darwin ;;
  *) die "Système non pris en charge : $OS. Sous Windows, utilisez WSL2 ou install.ps1." ;;
esac
case "$ARCH" in
  x86_64|amd64) PGARCH=x64   ;;
  arm64|aarch64) PGARCH=arm64 ;;
  *) die "Architecture non prise en charge : $ARCH." ;;
esac
ok "$OS $ARCH (paquet PostgreSQL : $PLATFORM-$PGARCH)"

if [ "$(id -u)" = "0" ]; then
  warn "Exécution en root : déconseillé. PostgreSQL refuse de démarrer en root."
  die  "Relancez ce script avec un utilisateur non privilégié."
fi

# --------------------------------------------------------------- 2. Node.js
step "Node.js $NODE_MIN ou supérieur"

need_node=1
if command -v node >/dev/null 2>&1; then
  current="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$current" -ge "$NODE_MIN" ]; then
    ok "Node.js $(node -v) déjà présent"
    need_node=0
  else
    warn "Node.js $(node -v) trop ancien (minimum v$NODE_MIN)"
  fi
else
  warn "Node.js absent"
fi

if [ "$need_node" = "1" ]; then
  # nvm est privilégié : pas de droits administrateur requis, pas de conflit
  # avec le Node.js éventuellement fourni par la distribution.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    step "Installation de nvm (gestionnaire de versions Node.js)"
    command -v curl >/dev/null 2>&1 || die "curl est requis pour installer Node.js. Installez-le puis relancez."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash \
      || die "Échec du téléchargement de nvm. Installez Node.js $NODE_MIN+ manuellement (https://nodejs.org)."
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MIN" || die "Échec de l'installation de Node.js."
  nvm use "$NODE_MIN" >/dev/null
  ok "Node.js $(node -v) installé"
  warn "Pour les prochains terminaux : source \"$NVM_DIR/nvm.sh\""
fi

command -v npm >/dev/null 2>&1 || die "npm introuvable alors que Node.js est présent."

# ------------------------------------------------------ 3. fichier .env local
step "Configuration locale (.env)"

if [ -f .env ]; then
  ok ".env existant conservé"
else
  cp .env.example .env
  # Un secret JWT aléatoire est généré par installation : la valeur d'exemple
  # « change-me » ne doit jamais servir sur une machine réelle.
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  if [ "$PLATFORM" = "darwin" ]; then
    sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=$SECRET|" .env
  else
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$SECRET|" .env
  fi
  ok ".env créé avec un secret JWT aléatoire"
fi

# Le serveur applicatif n'écoute qu'en local par défaut sur un poste isolé.
grep -q '^HOST=' .env || echo 'HOST=127.0.0.1' >> .env

PORT_APP="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
PORT_DB="$(grep -E '^PGPORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
PORT_APP="${PORT_APP:-3001}"
PORT_DB="${PORT_DB:-55432}"

for p in "$PORT_APP" "$PORT_DB"; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "Le port $p est déjà utilisé — modifiez PORT/PGPORT dans .env si l'étape suivante échoue."
  fi
done

# ---------------------------------------------------------- 4. dépendances
step "Installation des dépendances npm"
npm install --no-audit --no-fund || die "Échec de « npm install ». Vérifiez votre accès réseau au registre npm."
ok "Dépendances installées"

PGDIR="node_modules/@embedded-postgres/${PLATFORM}-${PGARCH}"
[ -d "$PGDIR" ] || die "PostgreSQL embarqué absent ($PGDIR). Relancez « npm install »."
ok "PostgreSQL embarqué disponible ($PGDIR)"

# ------------------------------------------------------------- 5. base locale
if [ "$DO_RESET" = "1" ]; then
  step "Réinitialisation de la base"
  node scripts/db.mjs reset || die "Échec de la réinitialisation."
else
  step "Démarrage du serveur PostgreSQL local"
  node scripts/db.mjs start || die "Échec du démarrage de PostgreSQL. Consultez .pgdata.log."
fi
ok "PostgreSQL en écoute sur 127.0.0.1:$PORT_DB"

step "Application du schéma (migrations)"
npm run migrate || die "Échec des migrations."
ok "Schéma appliqué"

step "Chargement du jeu de démonstration"
if npm run seed; then
  ok "Données de démonstration chargées"
else
  warn "Le seed a échoué ou les données existent déjà — poursuite."
fi

# ------------------------------------------------------------- 6. interface
step "Compilation de l'interface web"
npm run build:web || die "Échec de la compilation de l'interface."
ok "Interface compilée dans apps/web/dist"

# ----------------------------------------------------------------- 7. tests
step "Vérification par la suite de tests"
if npm test >/tmp/clinirdv-test.log 2>&1; then
  ok "$(grep -E '^# pass' /tmp/clinirdv-test.log | tr -d '#' | xargs) tests réussis"
else
  warn "Des tests ont échoué — détail dans /tmp/clinirdv-test.log"
fi

# ------------------------------------------------------------------ 8. bilan
cat <<EOF

$B$G  Installation terminée.$N

  ${B}Comptes de démonstration${N} — mot de passe : ${B}Clinique2026!${N}
    admin      Administrateur (accès complet)
    s.martin   Réceptionniste (agenda, file d'attente, encaissement)
    a.bernard  Praticien (dossiers médicaux, consultation)
    c.compta   Facturation (factures, caisse, impayés)

  ${B}Commandes utiles${N}
    npm start                  démarre l'application      → http://localhost:$PORT_APP
    npm test                   relance la suite de tests
    npm run dev:api            API en rechargement automatique
    npm run dev:web            interface en mode développement (port 5173)
    node scripts/db.mjs stop   arrête PostgreSQL
    node scripts/db.mjs reset  remet la base à zéro
    ./install.sh --reset       réinstallation complète

EOF

if [ "$DO_START" = "1" ]; then
  step "Démarrage de l'application"
  printf '  Interface : %shttp://localhost:%s%s   (Ctrl+C pour arrêter)\n\n' "$B" "$PORT_APP" "$N"
  exec npm start
else
  printf '  Lancez %snpm start%s pour démarrer l'"'"'application.\n\n' "$B" "$N"
fi
