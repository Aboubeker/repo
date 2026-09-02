# 04 — Plan de développement

Hypothèse d'équipe : **1 tech lead, 2 devs full-stack, 1 dev front/UX, 1 QA (mi-temps), 1 PO métier côté clinique (mi-temps)**.
Durée cible : **~9 mois** jusqu'à la mise en production, sprints de 2 semaines.
Une équipe plus réduite (2 devs) allongerait à ~14 mois avec le même ordonnancement.

---

## 1. Phases

### Phase 0 — Cadrage & socle technique (Sprints 1–2, 4 semaines)

| Lot | Contenu | Sortie |
|---|---|---|
| P0.1 | Ateliers métier : observation de l'accueil, recueil des règles réelles, formulaires papier existants | Backlog affiné, règles RG validées |
| P0.2 | Monorepo (pnpm workspaces), NestJS + React + Prisma, ESLint/Prettier, conventions | `main` qui build |
| P0.3 | Docker Compose (api, web, postgres, nginx), scripts `make up/seed/test` | Environnement en 1 commande |
| P0.4 | CI locale (Gitea Actions/Jenkins) : lint, tests, build d'images, artefact `.tar` | Pipeline vert |
| P0.5 | Schéma de base v1 + migrations + seed de démonstration (10 praticiens, 2 000 patients, 20 000 RDV) | Base jouable |
| P0.6 | Design system, maquettes haute-fidélité des 6 écrans clés, validation utilisateurs | Maquettes signées |

**Critère de sortie** : environnement de dev reproductible, schéma validé, maquettes approuvées par 2 réceptionnistes et 2 praticiens.

### Phase 1 — Socle sécurité & référentiels (Sprints 3–4, 4 semaines)

- Auth locale : login, Argon2id, JWT + refresh rotatif, MFA TOTP, verrouillage, politique de mots de passe.
- RBAC : rôles, permissions, guards, tests d'autorisation exhaustifs.
- Journal d'audit (triggers + interceptor) et écran de consultation.
- CRUD utilisateurs, paramètres applicatifs, spécialités, salles, équipements.
- Coquille UI : layout, navigation, gestion d'erreurs globale, notifications toast, états de chargement.

**Critère de sortie** : un ADMIN crée un utilisateur, chaque rôle voit exactement son périmètre, tout est tracé.

### Phase 2 — Patients & praticiens (Sprints 5–7, 6 semaines)

- Fiche patient complète (identité, contacts, assurances, consentements, documents).
- Recherche floue performante, détection et fusion de doublons.
- Historique médical (antécédents, allergies, bandeau d'alerte).
- Profils praticiens, spécialités, règles de disponibilité avec prévisualisation, absences.
- Import initial CSV/Excel de l'existant (assistant de mapping, rapport d'erreurs, mode simulation).

**Critère de sortie** : reprise de données réelle testée sur un extrait anonymisé du logiciel actuel.

### Phase 3 — Cœur agenda (Sprints 8–11, 8 semaines) — *phase la plus risquée*

- Moteur de calcul de créneaux disponibles (règles − absences − fermetures − RDV − ressources).
- Contraintes d'exclusion en base, gestion des collisions et des verrous optimistes.
- CRUD RDV, machine à états, historique de statuts.
- Vues agenda : jour, semaine, mois, multi-praticiens, par ressource ; drag & drop ; copier/coller ; impression.
- Récurrences, surbooking contrôlé, urgences, liste d'attente.
- Temps réel WebSocket multi-postes.
- Check-in / file d'attente du jour.
- Replanification en masse lors d'une absence.

**Critère de sortie** : test de charge 50 postes simultanés sans double-booking (test de concurrence automatisé : 200 réservations parallèles sur le même créneau → 1 succès, 199 refus propres).

### Phase 4 — Notifications & consultation (Sprints 12–13, 4 semaines)

- Worker pg-boss, modèles de notification, moteur de gabarits, planification et journal d'envoi.
- Connecteurs : SMTP interne, passerelle SMS GSM locale, impression, notifications internes.
- Écran praticien : saisie de consultation, verrouillage/signature, RDV de suivi.
- Impressions : convocation, planning du jour, liste d'appels.

### Phase 5 — Facturation & caisse (Sprints 14–16, 6 semaines)

- Tarifs versionnés, génération de facture depuis un RDV, calcul part assurance/patient.
- Émission immuable, PDF, avoirs, remises contrôlées.
- Paiements multi-modes, remboursements, sessions de caisse et clôture.
- Impayés, relances, exports comptables (CSV/FEC).

### Phase 6 — Rapports & statistiques (Sprints 17–18, 4 semaines)

- Vues matérialisées, rafraîchissement nocturne.
- Tableaux de bord : occupation des créneaux, activité par praticien/spécialité, taux de no-show et d'annulation, délai moyen d'obtention d'un RDV, durée moyenne de consultation, chiffre d'affaires, encours, occupation des salles.
- Générateur de rapport personnalisé (filtres, regroupements), export CSV/PDF, rapports planifiés imprimés.

### Phase 7 — Exploitation, durcissement, recette (Sprints 19–21, 6 semaines)

- Sauvegarde/restauration : pgBackRest, écran d'administration, test de restauration automatisé mensuel.
- Supervision : healthchecks, métriques Prometheus, Grafana local, alertes e-mail interne.
- Mode maintenance, mise à jour applicative avec migration et rollback.
- Durcissement sécurité + **test d'intrusion interne** ; revue RGPD/DPIA.
- Tests E2E Playwright de tous les workflows, tests de charge, tests de reprise après coupure électrique.
- Documentation : manuel réceptionniste, manuel praticien, manuel administrateur, guide d'exploitation, plan de reprise.
- Recette utilisateur (UAT) sur site avec données réelles anonymisées.

### Phase 8 — Déploiement & accompagnement (Sprints 22–23, 4 semaines)

- Installation du serveur de production, PKI interne, postes clients, imprimantes.
- Reprise de données définitive (répétition à blanc puis bascule le week-end).
- Formation : 2 sessions réceptionnistes (3 h), 1 session praticiens (1 h 30), 1 session admin (4 h).
- **Fonctionnement en double** 2 semaines (ancien + nouveau) puis bascule.
- Support renforcé 1 mois, garantie 3 mois, contrat de maintenance ensuite.

---

## 2. Dépendances entre lots

```
P0 socle
 └─► P1 auth/RBAC/audit ──┬─► P2 patients ─┬─► P3 agenda ─┬─► P4 notifications
                          └─► P2 praticiens┘              ├─► P5 facturation
                                     P1 référentiels ─────┘              │
                                     (salles, équipements)               │
                          P3 + P5 ────────────────────────► P6 rapports ─┘
                          tout ──────────────────────────► P7 exploitation ─► P8 déploiement
```

Chemin critique : **P0 → P1 → P2 → P3 → P5 → P7 → P8**. Les notifications (P4) et les rapports (P6) peuvent glisser sans bloquer la mise en production d'un MVP.

---

## 3. Priorisation MoSCoW

**Must (MVP exploitable, fin P3+P4)** : auth/RBAC, patients, praticiens et disponibilités, RDV complet, agenda, check-in, impression de convocation, sauvegarde/restauration, audit.
**Should** : facturation et encaissement, notifications SMS/e-mail, liste d'attente, rapports standards.
**Could** : générateur de rapports personnalisés, borne d'accueil (kiosque) pour l'auto-enregistrement, écran d'affichage en salle d'attente, application tablette praticien, tiers payant avancé.
**Won't (v1)** : téléconsultation, portail patient en ligne, prise de RDV via Internet, échange avec plateformes nationales, interfaçage HL7/DICOM (prévu v2 via une passerelle locale).

---

## 4. Jalons et livrables

| Jalon | Échéance | Livrable | Critère d'acceptation |
|---|---|---|---|
| J1 | S4 | Socle + maquettes | Build CI vert, maquettes validées |
| J2 | S8 | Sécurité & référentiels | Audit d'accès conforme sur les 5 rôles |
| J3 | S14 | Patients & praticiens | Import d'un extrait réel sans perte |
| J4 | S22 | **Agenda opérationnel** | 0 double-booking sous test de concurrence |
| J5 | S26 | MVP pilote | 1 service pilote en usage réel 2 semaines |
| J6 | S32 | Facturation | Clôture de caisse conforme sur 5 jours de test |
| J7 | S36 | Rapports | 10 indicateurs validés par la direction |
| J8 | S42 | Recette + pentest | 0 vulnérabilité critique/haute, UAT signée |
| J9 | S46 | Mise en production | Bascule réussie, plan de retour arrière non utilisé |

---

## 5. Risques et mitigations

| Risque | P | I | Mitigation |
|---|:--:|:--:|---|
| Règles de planification réelles plus complexes que prévu | H | H | Ateliers dès P0, moteur de disponibilité paramétrable, marge de 2 sprints en P3 |
| Qualité des données existantes (doublons, champs libres) | H | M | Audit de données en P0, outil de fusion, import en mode simulation |
| Résistance au changement de l'équipe d'accueil | M | H | Réceptionniste référente dans l'équipe projet, maquettes testées tôt, pilote progressif |
| Panne serveur unique | M | H | RAID1 + UPS + sauvegardes hors machine + serveur froid documenté (option : réplication streaming) |
| Perte de la clé de chiffrement | F | Critique | Escrow en coffre physique, procédure de rotation testée |
| Passerelle SMS indisponible / interdite | M | F | Fallback impression + liste d'appels, dégradation propre |
| Dérive du périmètre (dossier médical complet, DPI) | H | H | Périmètre « gestion de RDV » gelé en v1, backlog v2 explicite |
| Départ d'un développeur | M | M | Revues de code croisées, documentation dans le repo, pas de zone détenue par un seul |

---

## 6. Qualité & définition de « terminé »

Une user story est terminée quand : code revu par un pair, tests unitaires (≥ 80 % sur la logique métier) et test d'intégration API, test E2E pour les parcours critiques, permissions vérifiées, erreurs gérées et journalisées, i18n en place, accessibilité clavier, documentation utilisateur mise à jour, migration réversible, démonstration acceptée par le PO.

Pipeline CI : lint → typecheck → tests unitaires → tests d'intégration (Testcontainers PostgreSQL) → build → E2E Playwright → analyse de dépendances hors ligne (audit du lockfile) → génération des images et du bundle d'installation hors ligne.

---

## 7. Charge indicative

| Phase | Semaines | Charge (j/h) |
|---|:--:|:--:|
| P0 socle | 4 | 60 |
| P1 sécurité | 4 | 60 |
| P2 patients/praticiens | 6 | 90 |
| P3 agenda | 8 | 140 |
| P4 notifications/consultation | 4 | 60 |
| P5 facturation | 6 | 90 |
| P6 rapports | 4 | 55 |
| P7 exploitation/recette | 6 | 90 |
| P8 déploiement | 4 | 55 |
| **Total** | **46 sem.** | **~700 j/h** |
