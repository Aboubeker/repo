# CliniRDV — Logiciel de gestion des rendez-vous pour clinique (on-premise)

Spécification complète et plan de développement pour un logiciel de gestion des rendez-vous
déployé **exclusivement sur infrastructure locale** : aucune synchronisation cloud, aucune
fonctionnalité en ligne, aucune dépendance externe à l'exécution.

## Documentation

| Doc | Contenu |
|---|---|
| [01 — Architecture technique](docs/01-architecture-technique.md) | Stack, justifications, découpage en modules, ADR, dimensionnement matériel |
| [02 — Modèle de données](docs/02-modele-de-donnees.md) | Schéma PostgreSQL complet, contraintes anti-double-booking, index, chiffrement |
| [03 — Spécification fonctionnelle](docs/03-specification-fonctionnelle.md) | Rôles, permissions, workflows, 18 cas d'usage, règles de gestion, exigences non fonctionnelles |
| [04 — Plan de développement](docs/04-plan-de-developpement.md) | 9 phases, dépendances, jalons, MoSCoW, risques, charge (~700 j/h) |
| [05 — Points techniques critiques](docs/05-points-techniques-critiques.md) | Auth locale + MFA, gestion d'erreurs, sauvegarde/restauration, RGPD, exploitation |
| [06 — Interface utilisateur](docs/06-interface-utilisateur.md) | Wireframes ASCII des 12 écrans clés, raccourcis, ergonomie, impressions |

## Résumé exécutif

**Stack** : React + TypeScript (SPA) · NestJS + Node 20 LTS · PostgreSQL 16 · Nginx · Docker Compose,
livré sous forme de bundle hors ligne installable sur un serveur Debian isolé d'Internet.

**Différenciateur technique** : l'intégrité des plannings est garantie par le SGBD lui-même
(`EXCLUDE USING gist` sur les périodes de praticien, patient, salle et équipement) — aucun
double-booking possible, même en cas de bug applicatif ou d'écriture concurrente.

**Périmètre v1** : patients · praticiens et disponibilités · rendez-vous et agenda · ressources ·
facturation et caisse · rapports · authentification locale avec MFA et RBAC · sauvegarde/restauration.

**Trajectoire** : MVP agenda opérationnel à S26, mise en production à S46, avec un pilote sur un
service avant généralisation.

---

## Implémentation de référence livrée avec la spécification

Le dépôt ne contient pas que des documents : une **application complète et fonctionnelle**
accompagne la spécification, afin que l'équipe puisse démarrer sur du code exécutable.

### Démarrage (aucune connexion Internet requise après `npm install`)

```bash
npm install              # dépendances (pg, react, vite, postgres embarqué)
npm run setup            # crée le cluster PostgreSQL local (.pgdata, port 55432)
npm run migrate          # applique infra/db/001_schema.sql puis 002_credit_notes.sql
npm run seed             # référentiels + jeu de démonstration
npm run build:web        # compile l'interface dans apps/web/dist
npm start                # serveur applicatif sur http://127.0.0.1:3001
```

Développement de l'interface : `npm -w @clinirdv/web run dev` (port 5173, proxy `/api` → 3001).
Tests : `npm test` (**49 tests**, `node --test`).
Cycle de vie de la base : `node scripts/db.mjs start|stop|status|reset`.

### Comptes de démonstration

Mot de passe commun : **`Clinique2026!`**

| Identifiant | Rôle | Usage |
|---|---|---|
| `admin` | ADMIN | Toutes permissions, administration, sauvegardes |
| `s.martin`, `l.dubois` | RECEPTION | Accueil, agenda, file d'attente, encaissement |
| `a.bernard`, `m.leroy`, `n.aziz` | PRACTITIONER | Agenda personnel, dossier médical, consultation |
| `c.compta` | BILLING | Facturation, caisse, impayés |

Praticiens : DR-001 BERNARD (cardiologie), DR-002 LEROY (médecine générale),
DR-003 AZIZ (dermatologie), DR-004 MOREAU (kinésithérapie), DR-005 PETIT (pédiatrie).
Formats d'identifiants : patients `P-2026-000001`, rendez-vous `RDV-2026-000001`,
factures `F-2026-00001`, avoirs `AV-2026-00001`.

### Contenu de l'implémentation

- `infra/db/001_schema.sql` — schéma complet : 40+ tables, contraintes `EXCLUDE USING gist`
  anti-double-booking (praticien, patient, salle, équipement), 8 triggers, vues
  `v_appointment_full` et `v_patient_summary`, fonctions `immutable_unaccent()` et
  `fn_slot_is_available()`.
- `infra/db/002_credit_notes.sql` — migration : autorise les montants négatifs pour les avoirs
  (`invoice_amount_sign_check` remplace `invoice_total_amount_check`).
- `apps/api/` — API HTTP : authentification (JWT 15 min + refresh rotatif en cookie
  `HttpOnly`), RBAC à 22 permissions, patients, praticiens et disponibilités, moteur de
  créneaux, rendez-vous et file d'attente, ressources, facturation et caisse, rapports et
  export CSV, administration, sauvegarde/restauration, journal d'audit.
- `apps/web/` — interface React : connexion, tableau de bord, agenda jour/semaine, assistant
  de prise de rendez-vous, dossier patient, file d'attente temps réel, praticiens,
  ressources, facturation/caisse/impayés, rapports, administration.
- `apps/api/test/api.test.mjs` — suite de tests couvrant les règles critiques
  (double-booking, concurrence, immutabilité des factures, permissions, audit).

### Écarts assumés entre la spécification et l'implémentation de référence

La spécification décrit la cible de production ; l'implémentation privilégie l'exécution
immédiate dans un environnement sans Docker ni accès réseau. Les écarts sont volontaires
et documentés :

| Sujet | Spécification (cible) | Implémentation livrée | Raison |
|---|---|---|---|
| Base de données | PostgreSQL 16 en conteneur | PostgreSQL 18.4 embarqué via npm (`.pgdata`, port 55432) | Docker et les dépôts APT indisponibles sur le poste de développement |
| Cadre applicatif | NestJS + Prisma | Node.js natif ESM (`.mjs`), routeur maison, SQL explicite ; unique dépendance runtime : `pg` | Zéro dépendance superflue, lisibilité du SQL critique (contraintes temporelles) |
| Interface | React + TypeScript | React + JSX (Vite) | Rapidité de mise au point ; migration TS sans rupture |
| Sauvegarde | `pg_dump` / PITR WAL | Export SQL natif (`nativeDump()`) + empreinte SHA-256 | `pg_dump` n'est pas fourni par la distribution PostgreSQL embarquée |
| Verrouillage agenda | Contrainte GiST seule | `pg_advisory_xact_lock(hashtext('appt:<praticien>'))` **puis** contrainte GiST | Le verrouillage `FOR UPDATE` seul provoquait des interblocages sous forte concurrence |

En cas de divergence, **le schéma réel (`infra/db/001_schema.sql` + `002_credit_notes.sql`)
fait foi** sur le document 02.

### Passage en production

Pour un déploiement réel, remplacer le cluster embarqué par un PostgreSQL installé sur le
serveur (mêmes fichiers SQL), placer l'API derrière Nginx en TLS interne, activer les
sauvegardes planifiées (`cron` sur `/api/admin/backups`) et suivre le document 05 pour le
durcissement, la rotation des secrets et les procédures de restauration.

### Installation en une commande sur un poste local

Un script d'installation automatise l'ensemble des prérequis (Node.js, dépendances,
PostgreSQL embarqué, schéma, données de démonstration, compilation de l'interface, tests) :

```bash
git clone https://github.com/Aboubeker/repo.git clinirdv
cd clinirdv
git checkout arena/01a0629d-repo

./install.sh              # Linux / macOS — installe puis démarre l'application
```

```powershell
# Windows 10/11 (PowerShell)
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

Options : `--no-start` / `-NoStart` (installer sans démarrer) et `--reset` / `-Reset`
(réinitialiser la base avant réinstallation).

L'application est ensuite disponible sur **http://localhost:3001**. Le script génère un
secret JWT aléatoire dans `.env` — la valeur d'exemple `change-me` n'est jamais conservée.
Aucun privilège administrateur n'est requis : PostgreSQL est embarqué dans le projet
(`.pgdata`, port 55432, écoute limitée à `127.0.0.1`) et rien n'est installé au niveau système
hormis Node.js s'il est absent.
