-- ---------------------------------------------------------------------
-- 007 — Ouverture sept jours sur sept
--
-- Symptôme : aucun rendez-vous ne pouvait être pris le vendredi ni le
-- samedi. La table `availability_rule` ne portait de plages que du
-- dimanche au jeudi (codes ISO 7, 1, 2, 3, 4) : sans plage déclarée, le
-- moteur de créneaux ne propose rien et `fn_slot_is_available()` refuse.
-- Une clinique d'esthétique reçoit précisément le week-end, quand sa
-- clientèle est disponible.
--
-- 1. Pour chaque praticien, on duplique vers le vendredi (5) et le
--    samedi (6) les plages de son jour « de référence » : le dimanche
--    s'il y travaille, sinon son premier jour ouvré dans l'ordre de la
--    semaine algérienne (7, 1, 2, 3, 4). Le jeudi n'est jamais retenu
--    en premier : il est écourté (pas d'après-midi) dans le jeu de
--    données livré, et le copier donnerait un week-end à mi-temps.
--
-- 2. Les « fermetures » qui ne font que signaler un jour férié sont
--    retirées de `clinic_closure`. Elles bloquaient la réservation
--    (`fn_slot_is_available` et le moteur de créneaux) alors qu'un jour
--    férié reste ouvert dans une clinique privée. L'affichage visuel du
--    jour férié dans l'agenda est assuré côté interface
--    (FIXED_HOLIDAYS) et n'est pas affecté. Les fermetures réelles —
--    travaux, congés annuels — se saisissent dans Paramètres et
--    continuent de bloquer.
--
-- Idempotente : un NOT EXISTS sur (praticien, jour, heures, salle, type)
-- rend la duplication rejouable ; la suppression ne trouve plus rien au
-- second passage.
-- ---------------------------------------------------------------------

-- (Le runner de migrations enveloppe déjà chaque fichier dans une
--  transaction : pas de BEGIN/COMMIT ici.)

-- 1. Vendredi et samedi -------------------------------------------------
WITH reference_day AS (
  -- Premier jour présent dans l'ordre 7, 1, 2, 3, 4 pour chaque praticien.
  SELECT DISTINCT ON (practitioner_id)
         practitioner_id, weekday
    FROM availability_rule
   WHERE weekday IN (7, 1, 2, 3, 4)
     AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
   ORDER BY practitioner_id,
            CASE weekday WHEN 7 THEN 0 ELSE weekday END
),
source_rules AS (
  SELECT r.*
    FROM availability_rule r
    JOIN reference_day d
      ON d.practitioner_id = r.practitioner_id AND d.weekday = r.weekday
   WHERE (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)
)
INSERT INTO availability_rule
  (practitioner_id, room_id, weekday, start_time, end_time,
   valid_from, valid_to, slot_minutes, appointment_type_id, capacity)
SELECT s.practitioner_id, s.room_id, wd.weekday, s.start_time, s.end_time,
       s.valid_from, s.valid_to, s.slot_minutes, s.appointment_type_id, s.capacity
  FROM source_rules s
 CROSS JOIN (VALUES (5::smallint), (6::smallint)) AS wd(weekday)
 WHERE NOT EXISTS (
         SELECT 1 FROM availability_rule x
          WHERE x.practitioner_id = s.practitioner_id
            AND x.weekday        = wd.weekday
            AND x.start_time     = s.start_time
            AND x.end_time       = s.end_time
            AND x.room_id            IS NOT DISTINCT FROM s.room_id
            AND x.appointment_type_id IS NOT DISTINCT FROM s.appointment_type_id
       );

-- 2. Les jours fériés ne bloquent plus la réservation --------------------
DELETE FROM clinic_closure
 WHERE label ILIKE '%férié%'
    OR label ILIKE '%ferie%'
    OR label ILIKE '%fête%'
    OR label ILIKE '%fete%';
