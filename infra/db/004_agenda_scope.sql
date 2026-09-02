-- ---------------------------------------------------------------------
-- 004 — Cloisonnement de l'agenda par praticien
--
-- Jusqu'ici, « appointment.read » ouvrait l'agenda de TOUS les praticiens.
-- Le filtre par praticien n'existait que dans l'interface : un médecin
-- pouvait consulter le planning de ses confrères, et il suffisait d'appeler
-- l'API sans le paramètre `practitionerIds` pour tout obtenir.
--
-- Le secret médical impose l'inverse : un praticien voit son agenda, pas
-- celui des autres. On sépare donc les deux notions.
--
--   appointment.read      → consulter l'agenda (le sien au minimum)
--   appointment.read.all  → consulter l'agenda de TOUS les praticiens
--
-- L'accueil et la facturation gardent la vue complète : ils ne peuvent pas
-- placer un rendez-vous ni encaisser sans voir l'ensemble du planning.
-- ---------------------------------------------------------------------

INSERT INTO permission (code, label, category) VALUES
  ('appointment.read.all',
   'Consulter l''agenda de tous les praticiens',
   'Rendez-vous')
ON CONFLICT (code) DO NOTHING;

-- Rôles disposant de la vue globale. Le rôle PRACTITIONER en est
-- volontairement absent : c'est tout l'objet de cette migration.
INSERT INTO role_permission (role_id, permission_code)
SELECT r.id, 'appointment.read.all'
  FROM role r
 WHERE r.code IN ('ADMIN', 'RECEPTION', 'BILLING')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Filet de sécurité : un praticien sans fiche rattachée
--
-- Le cloisonnement s'appuie sur user_account.practitioner_id. Si un compte
-- porte le rôle PRACTITIONER sans être relié à une fiche praticien, il ne
-- verrait plus aucun rendez-vous — panne silencieuse et déroutante.
-- On les recense ici pour que la migration le signale à l'installation.
-- ---------------------------------------------------------------------
DO $$
DECLARE orphans int;
BEGIN
  SELECT count(*) INTO orphans
    FROM user_account u
    JOIN user_role ur ON ur.user_id = u.id
    JOIN role r ON r.id = ur.role_id
   WHERE r.code = 'PRACTITIONER'
     AND u.practitioner_id IS NULL
     AND u.deleted_at IS NULL;

  IF orphans > 0 THEN
    RAISE WARNING
      '% compte(s) « praticien » ne sont rattachés à aucune fiche praticien : leur agenda sera vide. Renseignez le champ « Praticien » de ces comptes, ou accordez-leur appointment.read.all.',
      orphans;
  END IF;
END $$;
