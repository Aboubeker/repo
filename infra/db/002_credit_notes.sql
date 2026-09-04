-- Migration 002 : autorise les montants négatifs pour les avoirs.
-- Une facture ordinaire reste positive ; seul un avoir (rattaché à une facture
-- d'origine par credited_invoice_id) peut porter un montant négatif.
ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_total_amount_check;
ALTER TABLE invoice ADD CONSTRAINT invoice_amount_sign_check CHECK (
  (credited_invoice_id IS NULL     AND total_amount >= 0) OR
  (credited_invoice_id IS NOT NULL AND total_amount <= 0)
);
