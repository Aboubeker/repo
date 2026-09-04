-- ---------------------------------------------------------------------
-- 005 — Corrections de facturation
--
-- Trois défauts constatés en exploitation :
--
--   C2  la ventilation part assurance / part patient n'était calculée
--       qu'à la création de la facture. Toute ligne ajoutée ensuite
--       laissait « insurance_part + patient_part » inférieur au total.
--   C4  le droit de timbre (art. 100 du code du timbre) n'était nulle
--       part enregistré, alors qu'il est dû sur les règlements espèces.
--   I1  factures et avoirs partageaient une séquence, ce qui perçait des
--       trous dans la numérotation — motif de rejet en contrôle fiscal.
-- ---------------------------------------------------------------------

/* --------------------------------------------------------------- C4 ---
 * Droit de timbre
 *
 * Stocké sur le paiement (le fait générateur est l'encaissement en
 * espèces, pas l'émission de la facture) ET cumulé sur la facture pour
 * l'impression. Une colonne générée est impossible ici : le montant
 * dépend des paiements, donc d'une autre table.
 */
ALTER TABLE payment ADD COLUMN IF NOT EXISTS stamp_duty numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS stamp_duty numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN payment.stamp_duty IS
  'Droit de timbre (art. 100) : 1 DA par tranche de 100 DA entamée, min 5, max 2500. Espèces uniquement.';

/* Calcul en base : l'API ne peut pas être la seule garante d'un montant fiscal. */
CREATE OR REPLACE FUNCTION fn_stamp_duty(p_amount numeric, p_method text)
RETURNS numeric AS $$
BEGIN
  IF p_method <> 'CASH' THEN RETURN 0; END IF;      -- art. 258 bis
  IF p_amount IS NULL OR p_amount <= 20 THEN RETURN 0; END IF;
  RETURN least(2500, greatest(5, ceil(p_amount / 100.0)));
END $$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION fn_payment_stamp_duty() RETURNS trigger AS $$
BEGIN
  -- Un remboursement ne génère pas de timbre.
  IF NEW.is_refund THEN NEW.stamp_duty := 0;
  ELSE NEW.stamp_duty := fn_stamp_duty(NEW.amount, NEW.method);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_stamp_duty ON payment;
CREATE TRIGGER trg_payment_stamp_duty
  BEFORE INSERT OR UPDATE OF amount, method ON payment
  FOR EACH ROW EXECUTE FUNCTION fn_payment_stamp_duty();

/* --------------------------------------------------------------- C2 ---
 * Ventilation assurance / patient, recalculée à chaque changement
 *
 * L'invariant à tenir est : insurance_part + patient_part = total_amount.
 * On le recalcule depuis la couverture principale en vigueur, à chaque
 * modification des lignes — et non plus une seule fois à la création.
 */
CREATE OR REPLACE FUNCTION fn_recalc_invoice_shares(p_invoice_id uuid)
RETURNS void AS $$
DECLARE rate numeric(5,2); tot numeric(12,2); ins numeric(12,2); st text;
BEGIN
  SELECT total_amount, status INTO tot, st FROM invoice WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Une facture émise est figée : sa ventilation ne doit plus bouger,
  -- même si la couverture du patient change par la suite.
  IF st <> 'DRAFT' THEN RETURN; END IF;

  SELECT pi.coverage_rate INTO rate
    FROM patient_insurance pi
    JOIN invoice i ON i.patient_id = pi.patient_id
   WHERE i.id = p_invoice_id AND pi.is_primary
     AND (pi.valid_to IS NULL OR pi.valid_to >= CURRENT_DATE)
   LIMIT 1;

  ins := CASE WHEN rate IS NULL THEN 0 ELSE round(tot * rate / 100.0, 2) END;

  -- Un avoir porte des montants négatifs : la ventilation suit le signe.
  UPDATE invoice
     SET insurance_part = ins,
         patient_part   = tot - ins
   WHERE id = p_invoice_id;
END $$ LANGUAGE plpgsql;

/* Le trigger des totaux doit aussi entretenir la ventilation : sans cela,
   total_amount et les parts divergent dès la deuxième ligne. */
CREATE OR REPLACE FUNCTION fn_recalc_invoice_totals() RETURNS trigger AS $$
DECLARE inv_id uuid; sub numeric(12,2); vat numeric(12,2);
BEGIN
  inv_id := coalesce(NEW.invoice_id, OLD.invoice_id);
  SELECT coalesce(sum(line_total), 0),
         coalesce(sum(line_total * vat_rate / 100), 0)
    INTO sub, vat FROM invoice_line WHERE invoice_id = inv_id;
  UPDATE invoice SET subtotal = sub, vat_amount = round(vat, 2),
                     total_amount = round(sub + vat - discount_amount, 2)
    WHERE id = inv_id AND status = 'DRAFT';
  PERFORM fn_recalc_invoice_shares(inv_id);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

/* Reprise des factures brouillon existantes. */
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT id FROM invoice WHERE status = 'DRAFT' LOOP
    PERFORM fn_recalc_invoice_shares(r.id);
    n := n + 1;
  END LOOP;
  IF n > 0 THEN RAISE NOTICE 'Ventilation recalculée sur % facture(s) brouillon.', n; END IF;
END $$;

/* Les factures DÉJÀ ÉMISES ne sont pas retouchées : leur montant est figé.
   On se contente de signaler celles dont la ventilation est incohérente,
   pour que la clinique les traite par avoir en connaissance de cause. */
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM invoice
   WHERE status <> 'DRAFT'
     AND round(insurance_part + patient_part, 2) <> round(total_amount, 2);
  IF bad > 0 THEN
    RAISE WARNING
      '% facture(s) émise(s) portent une ventilation assurance/patient incohérente (antérieures au correctif). Elles sont conservées en l''état : une facture émise est immuable. Corrigez-les par avoir si nécessaire.',
      bad;
  END IF;
END $$;

/* --------------------------------------------------------------- I1 ---
 * Numérotation : une séquence par document, remise à zéro chaque année
 *
 * Une suite de factures doit être continue. Partager la séquence avec les
 * avoirs y perçait des trous (F-00001, F-00002, AV-00003, F-00004…), ce
 * qui laisse présumer des factures supprimées.
 */
CREATE SEQUENCE IF NOT EXISTS credit_note_number_seq;

/* Année de référence de chaque séquence, pour la remise à zéro au 1er janvier. */
CREATE TABLE IF NOT EXISTS document_sequence_year (
  sequence_name text PRIMARY KEY,
  year          int  NOT NULL
);

/*
 * Attribution d'un numéro. `nextval` est volontairement appelé APRÈS la
 * remise à zéro éventuelle. Le verrou sur la ligne de l'année sérialise
 * les appels concurrents : deux caissières qui émettent au même instant
 * ne peuvent pas obtenir le même numéro.
 */
CREATE OR REPLACE FUNCTION fn_next_document_number(p_prefix text, p_seq text)
RETURNS text AS $$
DECLARE cur_year int := extract(year FROM now())::int; rec_year int; n bigint;
BEGIN
  INSERT INTO document_sequence_year (sequence_name, year)
       VALUES (p_seq, cur_year)
  ON CONFLICT (sequence_name) DO NOTHING;

  SELECT year INTO rec_year FROM document_sequence_year
   WHERE sequence_name = p_seq FOR UPDATE;

  IF rec_year <> cur_year THEN
    EXECUTE format('ALTER SEQUENCE %I RESTART WITH 1', p_seq);
    UPDATE document_sequence_year SET year = cur_year WHERE sequence_name = p_seq;
  END IF;

  EXECUTE format('SELECT nextval(%L)', p_seq) INTO n;
  RETURN p_prefix || '-' || cur_year::text || '-' || lpad(n::text, 5, '0');
END $$ LANGUAGE plpgsql;

/* Aligne les séquences sur les numéros déjà attribués, pour ne jamais
   réémettre un numéro existant. */
DO $$
DECLARE mx bigint; y int := extract(year FROM now())::int;
BEGIN
  SELECT coalesce(max(substring(number from '[0-9]+$')::bigint), 0) INTO mx
    FROM invoice WHERE number LIKE 'F-%';
  PERFORM setval('invoice_number_seq', greatest(mx, 1), mx > 0);

  SELECT coalesce(max(substring(number from '[0-9]+$')::bigint), 0) INTO mx
    FROM invoice WHERE number LIKE 'AV-%';
  PERFORM setval('credit_note_number_seq', greatest(mx, 1), mx > 0);

  INSERT INTO document_sequence_year (sequence_name, year)
       VALUES ('invoice_number_seq', y), ('credit_note_number_seq', y)
  ON CONFLICT (sequence_name) DO UPDATE SET year = excluded.year;
END $$;
