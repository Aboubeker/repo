# 08 — Gouvernance : CRUD, rôles et personnalisation

Ce document décrit la couche de gouvernance ajoutée à CliniRDV : gestion
complète des utilisateurs et des patients, système de rôles et permissions
modifiable en cours d'exploitation, et personnalisation de l'apparence.

Il complète les documents 01 (architecture) et 02 (modèle de données), dont il
suit les conventions.

---

## 1. Principes retenus

### 1.1 Le superutilisateur est un attribut, pas un rôle

`user_account.is_superuser` est un booléen porté par le compte, et non un rôle
de plus dans la matrice RBAC.

La raison est un problème d'amorçage et de récupération. Si le pouvoir absolu
était un rôle ordinaire, il suffirait de décocher une permission dans l'éditeur
de rôles — opération légitime en apparence — pour que plus personne ne puisse
administrer l'application. Il faudrait alors un accès `psql` au serveur pour
s'en sortir, ce qui est hors de portée d'une clinique.

En conséquence :

- `loadPermissions()` renvoie **le catalogue complet** des permissions pour un
  superutilisateur, y compris celles introduites par de futures migrations.
  Aucune configuration modifiable ne peut lui retirer un accès.
- Le rang ne s'octroie pas soi-même : seul un superutilisateur peut en désigner
  un autre (`SELF_DEMOTION` bloque l'auto-rétrogradation).
- La base **refuse qu'il n'en reste aucun** (voir 2.2).

### 1.2 Rien n'est détruit

| Objet | Suppression demandée | Effet réel |
|---|---|---|
| Patient | « Archiver » | `status = 'ARCHIVED'` — réversible, historique intact |
| Compte utilisateur | « Supprimer » | `deleted_at` renseigné, sessions révoquées |
| Rôle métier | « Supprimer » | Suppression réelle, refusée s'il est attribué |

Les dossiers de soins et les pièces comptables ont des obligations de
conservation ; le journal d'audit doit rester exploitable. Une suppression
physique casserait les deux. Les écritures d'audit d'un compte supprimé
subsistent donc, tandis que le compte disparaît des listes.

L'unicité du nom d'utilisateur ne porte que sur les comptes vivants, via un
index partiel : un identifiant redevient disponible après suppression.

```sql
CREATE UNIQUE INDEX uq_user_username_alive
  ON user_account (lower(username)) WHERE deleted_at IS NULL;
```

---

## 2. Base de données — migration `003_rbac_theme.sql`

### 2.1 Extensions du schéma

| Table | Ajout | Rôle |
|---|---|---|
| `role` | `description`, `created_at` | Rôles créés par la clinique |
| `role` | contrainte `role_code_format` | Code en majuscules, `^[A-Z][A-Z0-9_]{1,29}$` |
| `user_account` | `is_superuser` | Accès total, indépendant des rôles |
| `user_account` | `deleted_at`, `deleted_by` | Suppression réversible et traçable |
| `app_theme` | table complète | Apparence, ligne unique (singleton) |

Quatre permissions sont ajoutées et attribuées au rôle `ADMIN` :
`admin.roles`, `admin.theme`, `patient.delete`, `user.delete`.

### 2.2 Garde-fou « dernier superutilisateur »

Le contrôle est posé **dans la base**, pas dans l'API : il doit tenir quel que
soit le chemin d'écriture, y compris une correction manuelle en SQL un soir
d'incident.

```sql
CREATE OR REPLACE FUNCTION assert_superuser_remains() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_account
     WHERE is_superuser AND status = 'ACTIVE' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'LAST_SUPERUSER'
      USING HINT = 'Au moins un superutilisateur actif est requis.';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
```

Trois manières de se verrouiller dehors sont couvertes et **vérifiées par les
tests** : rétrograder, désactiver et supprimer le dernier superutilisateur.

> Note d'implémentation : `TG_OP` est inutilisable dans la clause `WHEN` d'un
> `CREATE TRIGGER`. Deux déclencheurs distincts (`UPDATE`, `DELETE`) sont donc
> déclarés sur la même fonction.

### 2.3 Thème

`app_theme` est contrainte à une seule ligne (`singleton boolean PRIMARY KEY
DEFAULT true CHECK (singleton)`). Les couleurs sont validées à l'écriture par
une expression régulière hexadécimale : leur valeur est réinjectée telle quelle
dans une variable CSS, elle ne doit rien pouvoir transporter d'autre.

Le logo est stocké en data-URI (256 Ko maximum), et non comme fichier :
l'application n'expose ainsi aucun répertoire d'envoi, et une sauvegarde de la
base emporte l'identité visuelle avec elle. Les SVG sont refusés car ils
peuvent porter du script.

---

## 3. Endpoints

Tous sous `admin.users` sauf mention contraire. Réponses en `snake_case`.

### 3.1 Rôles

| Méthode | Chemin | Effet |
|---|---|---|
| `GET` | `/api/admin/roles/catalog` | Permissions + rôles avec `user_count` |
| `POST` | `/api/admin/roles` | Création d'un rôle métier |
| `PATCH` | `/api/admin/roles/:id` | Intitulé, description, permissions |
| `DELETE` | `/api/admin/roles/:id` | Suppression d'un rôle non système |

Les trois routes d'écriture renvoient la **même forme** que le catalogue
(permissions et décompte inclus), afin que l'interface rafraîchisse sa ligne
sans second aller-retour.

### 3.2 Comptes

| Méthode | Chemin | Effet |
|---|---|---|
| `PATCH` | `/api/admin/users/:id/superuser` | Réservé à un superutilisateur |
| `DELETE` | `/api/admin/users/:id` | Suppression réversible + révocation |

### 3.3 Patients

| Méthode | Chemin | Effet |
|---|---|---|
| `DELETE` | `/api/patients/:id` | Archivage, refusé si RDV à venir |
| `POST` | `/api/patients/:id/restore` | Réactivation |

La réactivation évite qu'un patient revenu après plusieurs années n'oblige à
recréer une fiche — ce qui produirait précisément le doublon que la détection
cherche à empêcher, en scindant son historique de soins.

### 3.4 Apparence

| Méthode | Chemin | Permission |
|---|---|---|
| `GET` | `/api/theme` | **publique** |
| `PUT` | `/api/theme` | `admin.settings` |
| `POST` | `/api/theme/reset` | `admin.settings` |

La lecture est publique : l'écran de connexion porte les couleurs et le logo de
la clinique avant toute authentification.

### 3.5 Codes d'erreur

| Code | HTTP | Signification |
|---|---|---|
| `LAST_SUPERUSER` | 422 | Dernier superutilisateur actif |
| `SELF_DEMOTION` | 422 | Auto-rétrogradation |
| `SELF_LOCKOUT` | 422 | Auto-suppression / auto-désactivation |
| `SYSTEM_ROLE` | 422 | Renommage ou suppression d'un rôle livré |
| `ROLE_EXISTS` | 422 | Code de rôle déjà pris |
| `ROLE_IN_USE` | 422 | Rôle encore attribué à des comptes |
| `LAST_ADMIN_PERMISSION` | 422 | Dernier porteur d'une permission critique |
| `PATIENT_HAS_APPOINTMENTS` | 422 | Archivage avec rendez-vous à venir |

---

## 4. Verrou anti-auto-exclusion sur les permissions

Retirer `admin.users` ou `admin.roles` du dernier rôle **actif** qui la porte
est refusé (`LAST_ADMIN_PERMISSION`). Le superutilisateur reste un recours,
mais mieux vaut refuser l'opération que compter sur lui.

Les rôles système (`ADMIN`, `RECEPTION`, `PRACTITIONER`, `BILLING`,
`READONLY`) ne sont ni renommables ni supprimables — ils sont cités dans les
procédures de la clinique — mais **leurs permissions restent ajustables**,
sans quoi le RBAC ne serait pas réellement configurable.

---

## 5. Frontend

### 5.1 Gestion des patients — `pages/Patients.jsx`

- Filtre « Fiches actives / archivées ».
- Colonne d'actions par ligne : **Modifier**, **Archiver** / **Réactiver**.
- `PatientForm` sert la création et la modification. Un composant unique plutôt
  que deux jumeaux : les champs et les règles de saisie sont identiques, et
  deux formulaires finiraient par diverger.
- En modification, la fiche complète est rechargée : la ligne de tableau ne
  porte qu'un extrait des colonnes, et enregistrer depuis cet extrait
  écraserait l'adresse avec du vide.
- Les boutons d'action arrêtent la propagation du clic, sans quoi ils
  déclencheraient aussi la navigation portée par la ligne.

### 5.2 Administration — `pages/Admin.jsx`

Deux onglets s'ajoutent aux six existants :

**Rôles et permissions.** Matrice groupée par famille (`patient.*`,
`billing.*`…), avec « tout cocher » par famille. Le regroupement suit le
nommage déjà porté par les codes : aucune table de correspondance à maintenir
quand une permission apparaît.

**Apparence.** Six palettes prédéfinies, trois sélecteurs de couleur, densité,
arrondi des angles, échelle typographique, logo et message de connexion. Un
aperçu statique permet de juger un réglage sans l'imposer à toute la clinique.

L'onglet Utilisateurs gagne recherche, **Modifier**, **Supprimer** et bascule
**Superuser** (visible des seuls superutilisateurs). Le mot de passe n'apparaît
qu'à la création : le changer ensuite passe par « Réinitialiser », qui révoque
les sessions — une nuance de sécurité qu'un champ discret ferait oublier.

### 5.3 Application du thème

`applyTheme()` (dans `lib.jsx`) projette le thème sur les variables CSS de
`<html>`. Le style reste décrit une seule fois dans `styles.css` : seules
quelques variables de tête sont surchargées, donc aucune règle n'a besoin
d'être dupliquée pour devenir personnalisable.

Les déclinaisons (survol, fonds clairs) sont **calculées** par `shade()` : on
demande une couleur à l'administrateur, pas six.

`bootTheme()` est appelé dans `main.jsx` sans être attendu — le style compilé
s'affiche immédiatement et les couleurs de la clinique se substituent dès la
réponse. Attendre le réseau ferait clignoter une page blanche à chaque
chargement, y compris serveur injoignable.

La densité choisie sur un poste (barre supérieure, `localStorage`) l'emporte
sur le réglage global : elle dépend de la taille de l'écran, pas de la charte.

---

## 6. Tests

12 tests d'intégration couvrent cette couche (`Gouvernance` dans
`apps/api/test/api.test.mjs`), portant l'ensemble à **130**.

Points vérifiés : cycle de vie d'un rôle ; normalisation et unicité du code ;
rôle système renommable non mais ajustable oui ; `LAST_ADMIN_PERMISSION` ;
`ROLE_IN_USE` ; suppression de compte, libération de l'identifiant et refus de
l'auto-suppression ; protections du dernier superutilisateur ; permissions
complètes du superutilisateur ; lecture publique et validation du thème ; refus
opposé à un compte non administrateur.

---

## 7. Mise à jour d'une installation existante

```bash
npm run update    # git pull + install + migrate + build:web
npm run app
```

La migration `003_rbac_theme.sql` promeut le compte `admin` existant au rang de
superutilisateur. Sur une installation neuve, le seed s'en charge : sans cela,
aucun compte ne pourrait attribuer un rang qui ne s'octroie pas soi-même.

Pensez à un **Ctrl+F5** sur les postes, le bundle ayant changé de nom.
