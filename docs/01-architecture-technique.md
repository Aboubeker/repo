# 01 — Architecture technique

Projet : **CliniRDV** — logiciel de gestion des rendez-vous pour clinique, 100 % on-premise.

---

## 1. Principes directeurs

| Principe | Conséquence technique |
|---|---|
| Zéro cloud, zéro appel sortant | Aucune dépendance à un SaaS (pas d'Auth0, Stripe, Twilio, Sentry SaaS, CDN externe). Toutes les polices, icônes et libs sont vendorisées. |
| Fonctionne sans Internet | Installation depuis un dépôt de paquets local / images Docker exportées en `.tar`. Pas de `npm install` au déploiement. |
| Faible coût d'exploitation | Un seul serveur (VM ou machine physique) suffit ; pas d'orchestrateur, pas de Kubernetes. |
| Fiabilité > nouveauté | Stack mature, LTS, monolithe modulaire plutôt que microservices. |
| Confidentialité (RGPD / hébergement de données de santé) | Chiffrement disque, chiffrement colonnes sensibles, journal d'audit immuable, sauvegardes chiffrées. |
| Reprise rapide par une autre équipe | Un seul langage côté serveur, ORM standard, tests automatisés, docs versionnées. |

---

## 2. Stack retenue

### Vue d'ensemble

```
┌──────────────────────────────────────────────────────────────┐
│  Poste client (LAN clinique) — navigateur Chromium/Firefox   │
│  SPA React + TypeScript (servie par Nginx, PWA offline-shell)│
└───────────────┬──────────────────────────────────────────────┘
                │ HTTPS (certificat interne, TLS 1.3) — LAN uniquement
┌───────────────▼──────────────────────────────────────────────┐
│  Serveur on-premise (Debian 12 LTS)                          │
│  ┌─────────────┐  ┌───────────────────────────────────────┐  │
│  │ Nginx       │→ │ API monolithe modulaire               │  │
│  │ reverse-px  │  │ NestJS (Node 20 LTS) + Prisma         │  │
│  │ + static    │  │ modules: auth, patients, praticiens,  │  │
│  └─────────────┘  │ agenda, ressources, facturation,      │  │
│                   │ rapports, audit, notifications        │  │
│                   └───────┬───────────────────┬───────────┘  │
│                           │                   │              │
│                  ┌────────▼────────┐  ┌───────▼───────────┐  │
│                  │ PostgreSQL 16   │  │ Worker jobs       │  │
│                  │ (données)       │  │ (pg-boss)         │  │
│                  └────────┬────────┘  │ rappels, exports, │  │
│                           │           │ purge, backup     │  │
│                  ┌────────▼────────┐  └───────────────────┘  │
│                  │ Sauvegardes     │                         │
│                  │ pgBackRest → NAS│  ┌───────────────────┐  │
│                  └─────────────────┘  │ Serveur SMTP local│  │
│                                       │ + passerelle SMS  │  │
│                                       │ GSM (optionnel)   │  │
│                                       └───────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Détail et justification

| Couche | Choix | Justification on-premise |
|---|---|---|
| **Base de données** | **PostgreSQL 16** | Gratuit, sans licence, installable hors ligne (paquets Debian miroités). Contraintes d'exclusion `EXCLUDE USING gist` → **anti-double-booking garanti au niveau SGBD**, indispensable pour un agenda. `pgcrypto` pour le chiffrement colonne. Réplication physique simple pour un serveur de secours. Alternative écartée : SQLite (pas de concurrence d'écriture suffisante, pas d'EXCLUDE), SQL Server/Oracle (coût de licence). |
| **Backend** | **NestJS 10 / Node.js 20 LTS / TypeScript** | Framework opinionné (modules, DI, guards, interceptors) → structure imposée, facile à reprendre. Même langage que le front → une seule compétence à recruter, types partagés. Écarté : Java/Spring (plus lourd à exploiter, JVM à tuner), Python/Django (moins bon pour le temps réel WebSocket, typage plus faible). |
| **ORM / migrations** | **Prisma 5** + migrations SQL versionnées | Migrations déterministes rejouables hors ligne (`prisma migrate deploy`), schéma unique source de vérité, typage bout en bout. Les contraintes non supportées (EXCLUDE, triggers d'audit) sont ajoutées via migrations SQL manuelles. |
| **Frontend** | **React 18 + TypeScript + Vite** | Écosystème mature, build statique servi par Nginx (aucun runtime Node côté client). |
| **UI kit** | **Mantine** (ou MUI) + design tokens maison | Composants accessibles (WCAG AA), DataTable, DatePicker, formulaires. Tout est bundlé localement. |
| **Agenda** | **FullCalendar** (licence standard, self-host) ou implémentation maison sur `@dnd-kit` | Vues jour/semaine/mois/ressources, drag & drop de RDV. |
| **État / données** | TanStack Query + Zustand | Cache, retry, invalidation ; état UI local séparé de l'état serveur. |
| **Formulaires** | React Hook Form + **Zod** | Schémas Zod **partagés front/back** (paquet `packages/contracts`) → validation identique des deux côtés. |
| **Temps réel** | WebSocket (Socket.IO) | Mise à jour instantanée du planning multi-postes (réceptionnistes concurrentes), verrous optimistes visibles. |
| **Jobs asynchrones** | **pg-boss** (files dans PostgreSQL) | Pas de Redis/RabbitMQ à exploiter en plus. Rappels de RDV, génération de PDF, exports, purge RGPD, sauvegardes. |
| **PDF** | Puppeteer headless local ou PDFKit | Factures, ordonnances de convocation, reçus. Aucun service externe. |
| **Auth** | JWT courts (15 min) + refresh token httpOnly rotatif en base + Argon2id + TOTP (RFC 6238) | Voir doc 05. Aucun IdP externe requis ; connecteur LDAP/AD **optionnel** si la clinique en dispose (reste sur le LAN). |
| **Reverse proxy** | Nginx | TLS, compression, cache statique, rate-limiting, en-têtes de sécurité (CSP stricte, HSTS). |
| **Packaging** | **Docker Compose** (images exportées `docker save`) ; alternative sans Docker : paquets `.deb` + systemd | Déploiement reproductible sur une machine hors ligne. |
| **Observabilité** | Logs JSON (Pino) → fichiers + Loki local *(optionnel)* ; métriques Prometheus + Grafana **auto-hébergés** ; healthchecks `/health`, `/ready` | Aucune télémétrie sortante. |
| **Sauvegarde** | pgBackRest (full hebdo + incrémental quotidien + WAL archiving) vers NAS/disque externe chiffré | RPO ≤ 5 min, RTO ≤ 1 h. Voir doc 05. |
| **Tests** | Vitest (unit), Supertest (API), Playwright (E2E), Testcontainers (DB) | CI locale (Gitea Actions ou Jenkins auto-hébergé). |

### Configuration matérielle recommandée

| Profil clinique | Serveur | Notes |
|---|---|---|
| ≤ 10 praticiens, ≤ 15 postes | 4 vCPU, 16 Go RAM, 2×512 Go SSD RAID1 | Mono-serveur, sauvegarde sur NAS |
| 10–40 praticiens | 8 vCPU, 32 Go RAM, 2×1 To NVMe RAID1 | + serveur secondaire en réplication streaming (bascule manuelle) |
| Onduleur (UPS) obligatoire, arrêt propre piloté par NUT | | |

---

## 3. Découpage en modules (monolithe modulaire)

```
apps/
  api/                    NestJS
    src/modules/
      auth/               login, MFA, sessions, RBAC, politique mots de passe
      users/              comptes, rôles, rattachement praticien
      patients/           fiches, identité, doublons, historique
      practitioners/      profils, spécialités, règles de disponibilité, absences
      scheduling/         créneaux, RDV, file d'attente, récurrences, no-show
      resources/          salles, équipements, réservations liées
      billing/            actes, tarifs, factures, paiements, caisse
      reporting/          agrégats, indicateurs, exports CSV/PDF
      notifications/      modèles, envoi SMTP/SMS local, journal d'envoi
      audit/              journal immuable, consultation, export
      admin/              paramètres, jours fériés, sauvegardes, licences
    src/shared/           erreurs, pagination, transaction, crypto, clock
  web/                    React SPA
packages/
  contracts/              schémas Zod + types partagés + codes d'erreur
  ui/                     design system interne
infra/
  docker/ nginx/ backup/ systemd/ ansible/
docs/
```

Règles : dépendances inter-modules **uniquement via interfaces de service exportées** (pas d'accès direct aux tables d'un autre module). Cela autorise une extraction ultérieure en service séparé si besoin, sans l'imposer aujourd'hui.

---

## 4. Décisions d'architecture (ADR résumés)

| # | Décision | Alternatives | Raison |
|---|---|---|---|
| ADR-01 | Monolithe modulaire | Microservices | Un seul serveur, une petite équipe, exploitation par un informaticien de clinique. |
| ADR-02 | PostgreSQL | SQLite, MySQL | `EXCLUDE` + `tstzrange` = intégrité des plannings, JSONB, extensions `pgcrypto`/`unaccent`/`pg_trgm` (recherche patient tolérante aux fautes). |
| ADR-03 | Web SPA plutôt que client lourd | Electron, WPF | Zéro installation sur les postes, mises à jour centralisées, fonctionne sur Windows/Linux/tablette. |
| ADR-04 | Docker Compose | Kubernetes, install bare-metal | Reproductibilité sans complexité opérationnelle ; fallback `.deb`+systemd documenté. |
| ADR-05 | Verrouillage anti-collision en base | Verrou applicatif | Garantie forte même en cas de bug applicatif ou d'écriture concurrente. |
| ADR-06 | Notifications SMTP interne + SMS via modem GSM/passerelle LAN | API SMS cloud | Contrainte « aucune fonctionnalité en ligne ». Si aucune passerelle : impression de convocation + rappel téléphonique assisté (liste de tâches). |
| ADR-07 | Chiffrement au repos LUKS + colonnes sensibles via `pgcrypto` avec clé dans un fichier root-only (ou HSM/TPM) | Chiffrement applicatif intégral | Compromis performance/recherche : identifiants et données médicales libres chiffrés, index conservés sur pseudonymes. |

---

## 5. Sécurité applicative (synthèse)

- TLS interne obligatoire (PKI de la clinique ou CA auto-signée déployée par GPO).
- CSP stricte, `SameSite=Strict`, protection CSRF sur cookies de refresh, anti-brute-force (verrouillage progressif + captcha local).
- RBAC + ABAC : un médecin ne voit que ses patients sauf « bris de glace » (accès justifié, tracé, notifié à l'admin).
- Journal d'audit append-only (trigger PostgreSQL, table sans DELETE/UPDATE pour le rôle applicatif) : qui a lu/modifié quelle fiche, quand, depuis quelle IP.
- Anonymisation/pseudonymisation pour l'environnement de test (script de masquage fourni).
- Politique de rétention configurable (dossier patient 20 ans par défaut, logs 3 ans).
