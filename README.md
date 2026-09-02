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
