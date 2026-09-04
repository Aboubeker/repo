-- ---------------------------------------------------------------------
-- 006 — Catalogue de consultations d'une clinique d'esthétique
--
-- Remplace le catalogue médical généraliste (cardiologie, pédiatrie,
-- kinésithérapie…) par les 14 consultations d'esthétique demandées.
--
-- Choix : ARCHIVER l'ancien catalogue, ne pas le supprimer.
--   Les 7 types existants portent 1 501 rendez-vous, dont 587 à venir, et
--   sont référencés par `appointment`, `waiting_list` et `encounter` en
--   RESTRICT. Un DELETE échouerait ; un DELETE en cascade détruirait
--   l'historique et les factures qui s'y rattachent. `is_active = false`
--   les retire des listes de saisie tout en préservant le passé — c'est
--   exactement le mécanisme déjà employé par la route d'archivage.
--
-- Idempotente : rejouable sans effet de bord.
-- ---------------------------------------------------------------------

-- (Le runner de migrations enveloppe déjà chaque fichier dans une
--  transaction : pas de BEGIN/COMMIT ici.)

-- 1. Spécialités esthétiques -------------------------------------------
INSERT INTO specialty (code, label, color) VALUES
  ('ESTH-GEN',  'Médecine esthétique',        '#be185d'),
  ('ESTH-LASER','Laser et photorajeunissement','#7c3aed'),
  ('ESTH-CHIR', 'Chirurgie esthétique',       '#0f766e')
ON CONFLICT (code) DO NOTHING;

-- 2. Tarifs -------------------------------------------------------------
-- Un tarif par prestation : le prix est porté par `tariff`, c'est lui que
-- les lignes de facture référencent. TVA 0 comme le reste du catalogue.
INSERT INTO tariff (code, label, amount, specialty_id)
SELECT v.code, v.label, v.amount, s.id
  FROM (VALUES
    ('EST-INIT',    'Consultation esthétique initiale',            4000::numeric, 'ESTH-GEN'),
    ('EST-SUIVI',   'Consultation de suivi esthétique',            3000::numeric, 'ESTH-GEN'),
    ('EST-BILAN',   'Bilan de peau assisté (Visia)',               6000::numeric, 'ESTH-GEN'),
    ('EST-INJECT',  'Consultation injections',                     5000::numeric, 'ESTH-GEN'),
    ('EST-LASER',   'Consultation laser et photorajeunissement',   2500::numeric, 'ESTH-LASER'),
    ('EST-EPIL',    'Consultation épilation laser',                2500::numeric, 'ESTH-LASER'),
    ('EST-PIGMENT', 'Consultation taches pigmentaires / melasma',  4500::numeric, 'ESTH-LASER'),
    ('EST-CICAT',   'Consultation cicatrices d''acné / vergetures',4500::numeric, 'ESTH-GEN'),
    ('EST-ALOP',    'Consultation alopécie (PRP / mésothérapie)',  4000::numeric, 'ESTH-GEN'),
    ('EST-SILH',    'Consultation remodelage silhouette',          4000::numeric, 'ESTH-GEN'),
    ('EST-GYNE',    'Consultation gynéco-esthétique',              5000::numeric, 'ESTH-GEN'),
    ('EST-VARICO',  'Consultation varicosités / sclérothérapie',   4500::numeric, 'ESTH-GEN'),
    ('EST-RAJEUN',  'Consultation rajeunissement non chirurgical', 5000::numeric, 'ESTH-GEN'),
    ('EST-CHIR',    'Consultation chirurgie esthétique',           6000::numeric, 'ESTH-CHIR')
  ) AS v(code, label, amount, spec)
  JOIN specialty s ON s.code = v.spec
ON CONFLICT (code) DO NOTHING;

-- 3. Types de rendez-vous ----------------------------------------------
-- Les durées sont celles demandées. `buffer_after` couvre la remise en
-- état de la cabine ; il est plus long pour les actes appareillés.
INSERT INTO appointment_type (code, label, specialty_id, default_duration_minutes,
                              buffer_before_minutes, buffer_after_minutes,
                              default_tariff_id, color)
SELECT v.code, v.label, s.id, v.dur, v.buf_b, v.buf_a, t.id, v.color
  FROM (VALUES
    ('EST-INIT',    'Consultation esthétique initiale (bilan peau et objectifs)',      'ESTH-GEN',   30, 0,  5, '#be185d'),
    ('EST-SUIVI',   'Consultation de suivi esthétique',                                'ESTH-GEN',   20, 0,  5, '#db2777'),
    ('EST-BILAN',   'Bilan de peau assisté (analyse/Visia)',                           'ESTH-GEN',   40, 5, 10, '#9d174d'),
    ('EST-INJECT',  'Consultation injections (toxine botulique / acide hyaluronique)', 'ESTH-GEN',   30, 0, 10, '#a21caf'),
    ('EST-LASER',   'Consultation laser & photorajeunissement (évaluation)',           'ESTH-LASER', 20, 0, 10, '#7c3aed'),
    ('EST-EPIL',    'Consultation épilation laser (évaluation des zones)',             'ESTH-LASER', 20, 0, 10, '#6d28d9'),
    ('EST-PIGMENT', 'Consultation taches pigmentaires / melasma',                      'ESTH-LASER', 30, 0, 10, '#5b21b6'),
    ('EST-CICAT',   'Consultation cicatrices d''acné / vergetures',                    'ESTH-GEN',   30, 0,  5, '#c026d3'),
    ('EST-ALOP',    'Consultation alopécie / chute de cheveux (PRP/mésothérapie)',     'ESTH-GEN',   30, 0, 10, '#b45309'),
    ('EST-SILH',    'Consultation remodelage silhouette (cryolipolyse/HIFU/RF)',       'ESTH-GEN',   30, 0, 10, '#0891b2'),
    ('EST-GYNE',    'Consultation gynéco-esthétique',                                  'ESTH-GEN',   35, 0, 10, '#e11d48'),
    ('EST-VARICO',  'Consultation varicosités / sclérothérapie',                       'ESTH-GEN',   30, 0, 10, '#0e7490'),
    ('EST-RAJEUN',  'Consultation rajeunissement non chirurgical',                     'ESTH-GEN',   35, 0, 10, '#f43f5e'),
    ('EST-CHIR',    'Consultation chirurgie esthétique (visage/seins/silhouette)',     'ESTH-CHIR',  45, 5, 15, '#0f766e')
  ) AS v(code, label, spec, dur, buf_b, buf_a, color)
  JOIN specialty s ON s.code = v.spec
  JOIN tariff    t ON t.code = v.code
ON CONFLICT (code) DO NOTHING;

-- 4. Rattachement des praticiens ---------------------------------------
-- Sans cela, l'écran de prise de rendez-vous ne proposerait aucun
-- praticien pour une spécialité esthétique (il filtre par spécialité).
-- Les praticiens en place sont rattachés à la médecine esthétique ; les
-- spécialités laser et chirurgie vont au praticien le plus ancien, à
-- ajuster depuis Administration une fois l'équipe réelle saisie.
INSERT INTO practitioner_specialty (practitioner_id, specialty_id, is_primary)
SELECT p.id, s.id, false
  FROM practitioner p
  CROSS JOIN specialty s
 WHERE p.is_active AND s.code = 'ESTH-GEN'
ON CONFLICT DO NOTHING;

INSERT INTO practitioner_specialty (practitioner_id, specialty_id, is_primary)
SELECT p.id, s.id, false
  FROM (SELECT id FROM practitioner WHERE is_active ORDER BY code LIMIT 1) p
  CROSS JOIN specialty s
 WHERE s.code IN ('ESTH-LASER', 'ESTH-CHIR')
ON CONFLICT DO NOTHING;

-- 5. Retrait de l'ancien catalogue -------------------------------------
-- Archivage seulement : l'historique et les factures restent intacts et
-- consultables. Les rendez-vous à venir déjà pris sur ces types ne sont
-- pas touchés — ils resteront honorés.
UPDATE appointment_type SET is_active = false
 WHERE code IN ('CS-GEN','CS-CARDIO','ECG','CS-DERMA','KINE','CS-PEDIA','URGENCE');

UPDATE tariff SET is_active = false
 WHERE code IN ('C','CS-CARDIO','ECG','CS-DERMA','AMM','CS-PEDIA');

-- Les rattachements praticien ↔ ancienne spécialité ne sont pas supprimés :
-- l'affichage des spécialités d'un praticien ne filtre pas sur is_active,
-- et les rendez-vous à venir déjà pris restent lisibles.
UPDATE specialty SET is_active = false
 WHERE code IN ('CARDIO','GENE','DERMA','KINE','PEDIA');

