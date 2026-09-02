# 05 — Points techniques critiques

---

## 1. Authentification locale

### 1.1 Mécanisme

- **Mots de passe** : Argon2id (`m=64 Mio, t=3, p=4`), sel unique. Jamais de MD5/SHA seul.
- **Politique** (paramétrable) : 12 caractères min, 3 classes, blocage des mots de passe de la liste locale des 10 000 plus courants, historique de 5, expiration 180 jours, changement obligatoire au premier login.
- **Anti-brute-force** : compteur `failed_attempts` ; temporisation progressive (1 s, 2 s, 4 s…), verrouillage 15 min après 5 échecs, alerte à l'admin après 10 échecs sur un compte. Limitation par IP au niveau Nginx.
- **MFA TOTP** (RFC 6238) : obligatoire pour ADMIN et BILLING, optionnel sinon. Secret chiffré en base, QR code généré **localement**, 10 codes de secours à usage unique imprimables.
- **Jetons** : access JWT **15 min** (signature EdDSA, clé dans `/etc/clinirdv/jwt.key`), refresh token **8 h** en cookie `httpOnly; Secure; SameSite=Strict`, rotatif avec détection de réutilisation (si un refresh déjà consommé est rejoué → révocation de toute la famille de sessions + alerte).
- **Session** : verrouillage d'écran après 15 min d'inactivité (re-saisie du mot de passe, l'agenda reste affiché flouté), déconnexion à 12 h. Un utilisateur peut voir et révoquer ses sessions actives ; l'admin peut révoquer n'importe quelle session.
- **Badge / carte** *(option)* : lecteur RFID USB émulant un clavier → login rapide au comptoir (badge + code PIN) sur postes partagés.
- **LDAP/AD local** *(option)* : si la clinique dispose d'un annuaire, délégation de l'authentification, rôles toujours gérés dans l'application. Aucune dépendance Internet.
- **Compte de secours** : un compte `break-glass-admin` scellé, mot de passe en enveloppe cachetée dans le coffre, usage tracé et alerté.

### 1.2 Autorisation

Guard NestJS `@RequirePermission('appointment.write')` + filtre ABAC en couche service (un praticien ne lit que ses patients, sauf bris de glace justifié et tracé, limité à 1 h, notifié à l'admin). **Aucune** vérification de droits côté front uniquement : le front masque, le back interdit. Tests d'autorisation automatisés : pour chaque route, un test par rôle attend 200 ou 403.

---

## 2. Gestion des erreurs

### 2.1 Taxonomie et contrat d'erreur

```json
{
  "error": {
    "code": "APPOINTMENT_SLOT_CONFLICT",
    "message": "Ce créneau vient d'être réservé.",
    "details": { "conflictingAppointmentId": "…", "bookedBy": "s.martin", "at": "2026-09-02T10:12:03Z" },
    "traceId": "01J9…",
    "timestamp": "2026-09-02T10:12:04Z"
  }
}
```

| Classe | HTTP | Exemples | Traitement UI |
|---|:--:|---|---|
| Validation | 400 | champ manquant, date invalide | Erreurs affichées sous les champs |
| Authentification | 401 | jeton expiré | Refresh silencieux, sinon retour au login sans perdre le formulaire |
| Autorisation | 403 | permission absente | Message explicite + bouton « demander l'accès » |
| Introuvable | 404 | patient supprimé | Écran vide explicite |
| Conflit métier | 409 | double-booking, verrou optimiste, doublon patient | Dialogue dédié avec action de résolution |
| Règle métier | 422 | hors disponibilité, facture immuable | Explication de la règle + dérogation si permission |
| Trop de requêtes | 429 | brute-force | Compte à rebours |
| Erreur serveur | 500 | bug | « Une erreur est survenue — code XYZ » + bouton copier le traceId |
| Indisponibilité | 503 | base injoignable, mode maintenance | Bandeau global + passage en lecture seule si possible |

### 2.2 Principes d'implémentation

- **Filtre d'exception global** : mappage des erreurs Prisma/PostgreSQL vers des codes métier (`23P01` exclusion → `SLOT_CONFLICT`, `23505` unicité → `DUPLICATE`, `40001` sérialisation → retry automatique ×3).
- **Transactions** : toute opération multi-tables en `SERIALIZABLE` ou `REPEATABLE READ` avec retry ; jamais d'écriture partielle. Idempotency-Key sur les POST de création de RDV et de paiement (double-clic, réseau instable).
- **Verrou optimiste** : champ `version` renvoyé au client et exigé en écriture ; en cas de désynchronisation → 409 avec diff des modifications concurrentes (« Dr. Durand a modifié ce RDV il y a 12 s »).
- **Frontend** : Error Boundary React par zone (l'agenda qui plante ne casse pas la navigation), retry automatique des GET (3× exponentiel), file d'actions en attente si l'API est momentanément injoignable, indicateur de connexion serveur permanent.
- **Journalisation** : Pino JSON, `traceId` propagé (AsyncLocalStorage) du front à la requête SQL, rotation logrotate 30 jours, niveaux ERROR agrégés dans un écran d'administration + alerte e-mail interne au-delà d'un seuil. **Aucune donnée patient dans les logs** (masquage automatique des champs sensibles).
- **Dégradations prévues** : impression indisponible → PDF téléchargeable ; SMS indisponible → liste d'appels ; base en lecture seule → mode consultation avec bandeau rouge.

---

## 3. Sauvegarde et restauration

### 3.1 Stratégie 3-2-1 adaptée à l'on-premise

| Niveau | Outil | Fréquence | Rétention | Cible |
|---|---|---|---|---|
| WAL archiving continu | pgBackRest | temps réel | 7 j | disque local dédié |
| Sauvegarde incrémentale | pgBackRest | quotidienne 01:00 | 30 j | NAS LAN (chiffré) |
| Sauvegarde complète | pgBackRest | hebdomadaire dimanche 02:00 | 12 sem. | NAS + **disque externe rotatif** sorti du site |
| Documents (volume fichiers) | restic (dépôt local chiffré) | quotidienne | 30 j | NAS |
| Configuration & clés | archive chiffrée manuelle | à chaque changement | permanente | coffre physique |
| Pré-mise à jour | dump complet automatique | avant migration | 3 versions | disque local |

**RPO ≤ 5 min** (WAL), **RTO ≤ 1 h** (restauration complète testée).

### 3.2 Restauration

Script `clinirdv-restore --target-time "2026-09-02 09:30"` : mode maintenance → arrêt de l'API → vérification du checksum → `pgbackrest restore` (PITR) → restauration des documents → `prisma migrate status` → vérifications d'intégrité (comptages, contraintes, cohérence factures/paiements) → redémarrage → rapport imprimable.

**Test de restauration automatisé mensuel** : job qui restaure la dernière sauvegarde dans une base temporaire, exécute une batterie de contrôles, écrit le résultat dans `backup_run.restore_tested_at` et alerte en cas d'échec. *Une sauvegarde jamais restaurée n'est pas une sauvegarde.*

### 3.3 Écran d'administration « Sauvegardes »

Historique des exécutions (date, type, taille, durée, statut, checksum, dernier test de restauration), bouton « Sauvegarde manuelle maintenant », indicateur d'espace disque, alerte si aucune sauvegarde réussie depuis 26 h, export d'une sauvegarde vers un support amovible avec journalisation.

### 3.4 Continuité

- UPS + arrêt propre automatique (NUT) à 20 % de batterie.
- RAID1 (perte disque sans interruption) — **ne remplace pas** les sauvegardes.
- Serveur de secours *(recommandé)* : réplication streaming asynchrone, bascule manuelle documentée (< 30 min).
- **Plan de continuité papier** : impression automatique du planning du lendemain à 18 h, formulaires papier de secours, procédure de ressaisie après incident.

---

## 4. Confidentialité et conformité

- Chiffrement disque **LUKS** sur les volumes données et sauvegardes ; colonnes ultra-sensibles chiffrées via `pgcrypto`.
- Réseau : serveur en VLAN dédié, pare-feu **deny-all en sortie** (règle vérifiée par un test automatisé qui échoue si un appel sortant est possible), accès uniquement depuis les VLAN postes de travail.
- Journal d'audit chaîné par hash, non modifiable par le rôle applicatif, export signé.
- Registre des traitements, **DPIA** (analyse d'impact) fournie en Phase 7, politique de rétention configurable, procédures RGPD outillées (droit d'accès, rectification, effacement par anonymisation, portabilité).
- Comptes nominatifs obligatoires (pas de compte « accueil » partagé) ; revue trimestrielle des comptes et des droits.
- Postes clients : session Windows/Linux verrouillée, navigateur en mode kiosque, pas d'export USB non tracé.

---

## 5. Déploiement et exploitation

```bash
# Bundle hors ligne livré sur clé USB
clinirdv-2.0.0-offline.tar.gz
├── images/{api,web,postgres,nginx}.tar   # docker load
├── compose.yml  .env.example
├── install.sh  upgrade.sh  rollback.sh
├── backup/{pgbackrest.conf,cron.d}
├── certs/                                # génération CA interne
└── docs/                                 # manuels PDF
```

Mise à jour : sauvegarde pré-migration → mode maintenance → `docker compose pull` (local) → `prisma migrate deploy` → healthcheck → sortie de maintenance ; `rollback.sh` restaure l'image et la base précédentes. Migrations toujours **rétrocompatibles en deux étapes** (ajout de colonne → double écriture → suppression à la version suivante) pour permettre un retour arrière sans perte.

Supervision : `/health` (liveness), `/ready` (base + disque + jobs), métriques Prometheus (latence, erreurs, RDV créés, file de notifications, retard des jobs, âge de la dernière sauvegarde), Grafana local avec 4 tableaux de bord, alertes par e-mail interne.

---

## 6. Gestion des clés (escrow)

Clés concernées : LUKS, `db.key` (pgcrypto), `jwt.key`, clé de dépôt restic, clé de chiffrement des sauvegardes.
Procédure : génération sur le serveur → sauvegarde sur deux supports chiffrés → enveloppes scellées signées par le responsable et la direction → coffre + coffre externalisé → registre des accès → rotation annuelle testée en environnement de recette avant application en production.

---

## 7. Tests de robustesse spécifiques exigés

| Test | Attendu |
|---|---|
| 200 réservations parallèles sur le même créneau | 1 succès, 199 × 409 propres, aucune donnée corrompue |
| Coupure électrique brutale en pleine transaction | Redémarrage < 60 s, aucune écriture partielle, WAL rejoué |
| Perte du NAS de sauvegarde | Alerte < 26 h, application non impactée |
| Disque plein à 95 % | Alerte, refus des uploads, application toujours opérationnelle |
| 50 postes en agenda semaine simultanément | P95 < 500 ms |
| Tentative d'appel réseau sortant | Bloquée par le pare-feu, test CI en échec si une dépendance en introduit un |
| Restauration PITR à T-30 min | Données cohérentes, RTO < 1 h |
| Compte praticien tentant de lire un patient hors patientèle | 403 + entrée d'audit |
