-- ---------------------------------------------------------------------
-- 003 — Rôles personnalisables, superutilisateur, thème
--
-- Trois manques constatés :
--   1. `role` et `role_permission` existaient mais aucune route ne les
--      écrivait : les rôles étaient figés au peuplement initial.
--   2. Aucun niveau au-dessus d'ADMIN : rien n'empêchait un administrateur
--      de se retirer ses propres droits ou de supprimer le dernier compte
--      capable d'administrer le système.
--   3. Le thème (couleurs, logo) était compilé dans le bundle.
-- ---------------------------------------------------------------------

-- --------------------------- Rôles personnalisés ---------------------
-- `is_system` existait déjà et vaut true par défaut. Les rôles livrés sont
-- marqués système : ni renommables ni supprimables, pour qu'une clinique ne
-- puisse pas se verrouiller hors de sa propre application. Les rôles créés
-- ensuite sont libres.
UPDATE role SET is_system = true
 WHERE code IN ('ADMIN','RECEPTION','PRACTITIONER','BILLING','READONLY');

ALTER TABLE role ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE role ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Un rôle sans permission est légitime (rôle en cours de construction),
-- mais son code doit rester exploitable comme identifiant stable.
ALTER TABLE role DROP CONSTRAINT IF EXISTS role_code_format;
ALTER TABLE role ADD CONSTRAINT role_code_format
  CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$');

-- ------------------------------ Superutilisateur ---------------------
-- Distinct d'un rôle : c'est un attribut du compte, non délégable par
-- l'attribution d'un rôle. Un administrateur ne peut donc pas se promouvoir
-- lui-même en modifiant ses rôles.
ALTER TABLE user_account
  ADD COLUMN IF NOT EXISTS is_superuser boolean NOT NULL DEFAULT false;

-- Garantie de dernier recours : il doit toujours rester au moins un
-- superutilisateur actif. Vérifié par déclencheur, la contrainte portant sur
-- l'ensemble de la table et non sur une ligne.
CREATE OR REPLACE FUNCTION assert_superuser_remains() RETURNS trigger AS $$
DECLARE
  remaining int;
BEGIN
  SELECT count(*) INTO remaining
    FROM user_account
   WHERE is_superuser
     AND status = 'ACTIVE'
     AND deleted_at IS NULL
     AND id <> COALESCE(OLD.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF remaining = 0 THEN
    RAISE EXCEPTION 'LAST_SUPERUSER'
      USING HINT = 'Le dernier superutilisateur actif ne peut être ni supprimé, '
                   'ni désactivé, ni rétrogradé.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Deux déclencheurs distincts : `TG_OP` n'est pas accessible dans une clause
-- WHEN, et la condition de déclenchement diffère entre UPDATE et DELETE.
DROP TRIGGER IF EXISTS trg_last_superuser ON user_account;
DROP TRIGGER IF EXISTS trg_last_superuser_upd ON user_account;
DROP TRIGGER IF EXISTS trg_last_superuser_del ON user_account;

-- À la modification : seulement si la ligne cesse d'être un superutilisateur
-- actif. Évite un comptage à chaque écriture sur la table.
CREATE TRIGGER trg_last_superuser_upd
  BEFORE UPDATE ON user_account
  FOR EACH ROW
  WHEN (
    OLD.is_superuser
    AND (NOT NEW.is_superuser
         OR NEW.status <> 'ACTIVE'
         OR NEW.deleted_at IS NOT NULL)
  )
  EXECUTE FUNCTION assert_superuser_remains();

CREATE TRIGGER trg_last_superuser_del
  BEFORE DELETE ON user_account
  FOR EACH ROW
  WHEN (OLD.is_superuser)
  EXECUTE FUNCTION assert_superuser_remains();

-- Le compte `admin` livré devient superutilisateur.
UPDATE user_account SET is_superuser = true WHERE username = 'admin';

-- ------------------------------ Suppression douce --------------------
-- Un compte ayant produit des écritures (factures, consultations, audit) ne
-- peut pas être supprimé physiquement sans rompre la traçabilité, exigence
-- de conformité en santé. La suppression est donc logique.
ALTER TABLE user_account ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE user_account ADD COLUMN IF NOT EXISTS deleted_by uuid;

-- L'unicité du nom d'utilisateur ne doit porter que sur les comptes vivants,
-- sans quoi un identifiant supprimé resterait à jamais réservé.
-- La contrainte d'abord : elle s'appuie sur l'index, qui ne peut être
-- supprimé tant qu'elle existe.
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS user_account_username_key;
DROP INDEX IF EXISTS user_account_username_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_username_alive
  ON user_account (lower(username)) WHERE deleted_at IS NULL;

-- --------------------------------- Thème -----------------------------
-- Une seule ligne, contrainte par `singleton`. Stocker le thème en base
-- plutôt qu'en CSS compilé permet de le modifier depuis l'interface, sans
-- recompilation ni accès au serveur — le poste d'une clinique n'a pas
-- d'outillage de développement.
CREATE TABLE IF NOT EXISTS app_theme (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  preset        text NOT NULL DEFAULT 'teal',
  primary_color text NOT NULL DEFAULT '#0f766e',
  accent_color  text NOT NULL DEFAULT '#5eead4',
  sidebar_color text NOT NULL DEFAULT '#14201e',
  density       text NOT NULL DEFAULT 'comfortable'
                CHECK (density IN ('comfortable','compact')),
  radius        text NOT NULL DEFAULT 'medium'
                CHECK (radius IN ('square','medium','round')),
  font_scale    numeric(3,2) NOT NULL DEFAULT 1.00
                CHECK (font_scale BETWEEN 0.85 AND 1.30),
  -- Logo en data URI : le déploiement est hors ligne et mono-poste, un
  -- stockage de fichiers séparé n'apporterait ici que de la complexité.
  -- Plafonné à 256 Ko pour ne pas alourdir la charge utile.
  logo_data_uri text CHECK (logo_data_uri IS NULL OR length(logo_data_uri) <= 262144),
  login_message text CHECK (login_message IS NULL OR length(login_message) <= 300),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  -- Les couleurs alimentent des variables CSS : valider le format ici évite
  -- une injection de valeur arbitraire dans la feuille de style.
  CONSTRAINT theme_colors_hex CHECK (
    primary_color ~ '^#[0-9a-fA-F]{6}$' AND
    accent_color  ~ '^#[0-9a-fA-F]{6}$' AND
    sidebar_color ~ '^#[0-9a-fA-F]{6}$'
  )
);

INSERT INTO app_theme (singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- --------------------------- Permissions ajoutées --------------------
INSERT INTO permission (code, label, category) VALUES
  ('admin.roles',  'Créer et modifier les rôles',        'Administration'),
  ('admin.theme',  'Personnaliser l''apparence',          'Administration'),
  ('patient.delete', 'Archiver un dossier patient',       'Patients'),
  ('user.delete',  'Supprimer un compte utilisateur',     'Administration')
ON CONFLICT (code) DO NOTHING;

-- Attribuées au rôle ADMIN livré.
INSERT INTO role_permission (role_id, permission_code)
SELECT r.id, p.code
  FROM role r
 CROSS JOIN (VALUES ('admin.roles'),('admin.theme'),
                    ('patient.delete'),('user.delete')) AS p(code)
 WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;
