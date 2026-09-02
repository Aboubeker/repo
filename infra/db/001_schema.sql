-- =====================================================================
-- CliniRDV — Schéma de base de données (PostgreSQL)
-- Migration 001 : structure complète
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- unaccent n'est pas IMMUTABLE : wrapper indexable
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
$$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ---------------------------------------------------------------------
-- 1. Sécurité, utilisateurs, audit
-- ---------------------------------------------------------------------
CREATE TABLE role (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code      text UNIQUE NOT NULL,
  label     text NOT NULL,
  is_system boolean NOT NULL DEFAULT true
);

CREATE TABLE permission (
  code     text PRIMARY KEY,
  label    text NOT NULL,
  category text NOT NULL
);

CREATE TABLE role_permission (
  role_id         uuid REFERENCES role(id) ON DELETE CASCADE,
  permission_code text REFERENCES permission(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE practitioner (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text UNIQUE NOT NULL,
  last_name            text NOT NULL,
  first_name           text NOT NULL,
  title                text,
  registration_number  text UNIQUE,
  phone                text,
  email                citext,
  office_room_id       uuid,
  default_slot_minutes int NOT NULL DEFAULT 20 CHECK (default_slot_minutes BETWEEN 5 AND 240),
  color                text DEFAULT '#2563eb',
  employment_type      text CHECK (employment_type IN ('SALARIED','LIBERAL','LOCUM')),
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

CREATE TABLE user_account (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             citext UNIQUE NOT NULL,
  full_name            text NOT NULL,
  email                citext,
  password_hash        text NOT NULL,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  must_change_password boolean NOT NULL DEFAULT false,
  mfa_secret           text,
  mfa_enabled          boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  failed_attempts      int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  practitioner_id      uuid REFERENCES practitioner(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

CREATE TABLE user_role (
  user_id uuid REFERENCES user_account(id) ON DELETE CASCADE,
  role_id uuid REFERENCES role(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE session_token (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  ip         text,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_user ON session_token(user_id) WHERE revoked_at IS NULL;

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  user_id       uuid,
  username      text,
  ip            text,
  action        text NOT NULL,
  entity        text NOT NULL,
  entity_id     text,
  summary       text,
  diff          jsonb,
  justification text
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id, occurred_at DESC);
CREATE INDEX idx_audit_time   ON audit_log(occurred_at DESC);

-- ---------------------------------------------------------------------
-- 2. Référentiels
-- ---------------------------------------------------------------------
CREATE TABLE specialty (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code      text UNIQUE NOT NULL,
  label     text NOT NULL,
  color     text DEFAULT '#64748b',
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE practitioner_specialty (
  practitioner_id uuid REFERENCES practitioner(id) ON DELETE CASCADE,
  specialty_id    uuid REFERENCES specialty(id) ON DELETE RESTRICT,
  is_primary      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (practitioner_id, specialty_id)
);

CREATE TABLE room (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code      text UNIQUE NOT NULL,
  label     text NOT NULL,
  building  text,
  floor     text,
  capacity  int NOT NULL DEFAULT 1,
  kind      text CHECK (kind IN ('CONSULTATION','PROCEDURE','IMAGING','LAB','SURGERY','WAITING')),
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE practitioner ADD CONSTRAINT fk_practitioner_room
  FOREIGN KEY (office_room_id) REFERENCES room(id);

CREATE TABLE equipment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text UNIQUE NOT NULL,
  label               text NOT NULL,
  kind                text,
  serial_number       text,
  room_id             uuid REFERENCES room(id),
  is_mobile           boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'AVAILABLE'
                      CHECK (status IN ('AVAILABLE','IN_MAINTENANCE','OUT_OF_ORDER','RETIRED')),
  next_maintenance_on date,
  is_active           boolean NOT NULL DEFAULT true
);

CREATE TABLE tariff (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text UNIQUE NOT NULL,
  label        text NOT NULL,
  amount       numeric(12,2) NOT NULL CHECK (amount >= 0),
  vat_rate     numeric(5,2) NOT NULL DEFAULT 0,
  valid_from   date NOT NULL DEFAULT CURRENT_DATE,
  valid_to     date,
  specialty_id uuid REFERENCES specialty(id),
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE appointment_type (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text UNIQUE NOT NULL,
  label                    text NOT NULL,
  specialty_id             uuid REFERENCES specialty(id),
  default_duration_minutes int NOT NULL CHECK (default_duration_minutes > 0),
  buffer_before_minutes    int NOT NULL DEFAULT 0,
  buffer_after_minutes     int NOT NULL DEFAULT 0,
  requires_room            boolean NOT NULL DEFAULT true,
  required_equipment_kind  text,
  color                    text DEFAULT '#3b82f6',
  default_tariff_id        uuid REFERENCES tariff(id),
  preparation_instructions text,
  is_active                boolean NOT NULL DEFAULT true
);

CREATE TABLE app_setting (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  category    text,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

-- ---------------------------------------------------------------------
-- 3. Patients
-- ---------------------------------------------------------------------
CREATE SEQUENCE patient_mrn_seq;

CREATE TABLE patient (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn                text UNIQUE NOT NULL,
  last_name          text NOT NULL,
  first_name         text NOT NULL,
  birth_name         text,
  sex                text CHECK (sex IN ('M','F','U')),
  birth_date         date NOT NULL,
  birth_place        text,
  national_id        text,
  phone_mobile       text,
  phone_home         text,
  email              citext,
  address_line1      text,
  address_line2      text,
  postal_code        text,
  city               text,
  country            text DEFAULT 'FR',
  preferred_language text DEFAULT 'fr',
  blood_type         text,
  gp_name            text,
  notes              text,
  is_deceased        boolean NOT NULL DEFAULT false,
  deceased_on        date,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED','MERGED')),
  merged_into_id     uuid REFERENCES patient(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  deleted_at         timestamptz
);
CREATE INDEX idx_patient_search ON patient
  USING gin ((immutable_unaccent(lower(last_name || ' ' || first_name || ' ' || mrn || ' ' || coalesce(phone_mobile,'')))) gin_trgm_ops);
CREATE INDEX idx_patient_birthdate ON patient(birth_date);
CREATE UNIQUE INDEX uq_patient_identity ON patient
  (lower(immutable_unaccent(last_name)), lower(immutable_unaccent(first_name)), birth_date)
  WHERE deleted_at IS NULL AND status = 'ACTIVE';

CREATE TABLE patient_contact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('EMERGENCY','TRUSTED','LEGAL_GUARDIAN','OTHER')),
  full_name    text NOT NULL,
  relationship text,
  phone        text,
  email        citext
);

CREATE TABLE patient_insurance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  scheme        text NOT NULL,
  insurer_name  text,
  policy_number text,
  coverage_rate numeric(5,2) CHECK (coverage_rate BETWEEN 0 AND 100),
  valid_from    date,
  valid_to      date,
  is_primary    boolean NOT NULL DEFAULT true
);

CREATE TABLE medical_history_entry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN
              ('ALLERGY','CHRONIC_CONDITION','SURGERY','TREATMENT','VACCINATION','FAMILY','LIFESTYLE','NOTE')),
  code_system text,
  code        text,
  label       text NOT NULL,
  severity    text CHECK (severity IN ('LOW','MODERATE','HIGH','CRITICAL')),
  onset_date  date,
  end_date    date,
  detail      text,
  is_active   boolean NOT NULL DEFAULT true,
  recorded_by uuid REFERENCES user_account(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_history_patient ON medical_history_entry(patient_id, category);

CREATE TABLE consent (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('DATA_PROCESSING','SMS_REMINDER','EMAIL_REMINDER','DATA_SHARING')),
  granted    boolean NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (patient_id, kind)
);

-- ---------------------------------------------------------------------
-- 4. Disponibilités
-- ---------------------------------------------------------------------
CREATE TABLE availability_rule (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id     uuid NOT NULL REFERENCES practitioner(id) ON DELETE CASCADE,
  room_id             uuid REFERENCES room(id),
  weekday             smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time          time NOT NULL,
  end_time            time NOT NULL,
  valid_from          date NOT NULL DEFAULT CURRENT_DATE,
  valid_to            date,
  slot_minutes        int,
  appointment_type_id uuid REFERENCES appointment_type(id),
  capacity            int NOT NULL DEFAULT 1,
  CHECK (end_time > start_time),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX idx_avail_pract ON availability_rule(practitioner_id, weekday);

CREATE TABLE absence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioner(id) ON DELETE CASCADE,
  period          tstzrange NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('LEAVE','SICK','TRAINING','SURGERY','OTHER')),
  comment         text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (practitioner_id WITH =, period WITH &&)
);

CREATE TABLE clinic_closure (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period tstzrange NOT NULL,
  label  text NOT NULL,
  EXCLUDE USING gist (period WITH &&)
);

CREATE TABLE resource_unavailability (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      uuid REFERENCES room(id),
  equipment_id uuid REFERENCES equipment(id),
  period       tstzrange NOT NULL,
  reason       text,
  CHECK (num_nonnulls(room_id, equipment_id) = 1)
);

-- ---------------------------------------------------------------------
-- 5. Rendez-vous  (cœur du système)
-- ---------------------------------------------------------------------
CREATE SEQUENCE appointment_ref_seq;

CREATE TABLE appointment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text UNIQUE NOT NULL,
  patient_id          uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  practitioner_id     uuid NOT NULL REFERENCES practitioner(id) ON DELETE RESTRICT,
  appointment_type_id uuid NOT NULL REFERENCES appointment_type(id),
  period              tstzrange NOT NULL,
  blocked_period      tstzrange NOT NULL,
  status              text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN
                      ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW','RESCHEDULED')),
  cancellation_reason text,
  cancelled_by        uuid,
  cancelled_at        timestamptz,
  rescheduled_from_id uuid REFERENCES appointment(id),
  recurrence_group_id uuid,
  priority            text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','URGENT','EMERGENCY')),
  origin              text NOT NULL DEFAULT 'DESK' CHECK (origin IN ('DESK','PHONE','KIOSK','WAITLIST','IMPORT')),
  reason              text,
  notes               text,
  checked_in_at       timestamptz,
  started_at          timestamptz,
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  version             int NOT NULL DEFAULT 1,
  CHECK (upper(period) > lower(period)),
  CHECK (blocked_period @> period)
);

-- ===== GARANTIE ANTI-DOUBLE-BOOKING AU NIVEAU DU SGBD =====
ALTER TABLE appointment ADD CONSTRAINT no_overlap_practitioner
  EXCLUDE USING gist (practitioner_id WITH =, blocked_period WITH &&)
  WHERE (status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS'));
ALTER TABLE appointment ADD CONSTRAINT no_overlap_patient
  EXCLUDE USING gist (patient_id WITH =, period WITH &&)
  WHERE (status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS'));

CREATE INDEX idx_appt_period       ON appointment USING gist (period);
CREATE INDEX idx_appt_pract_start  ON appointment (practitioner_id, lower(period));
CREATE INDEX idx_appt_patient      ON appointment (patient_id, lower(period) DESC);
CREATE INDEX idx_appt_status_start ON appointment (status, lower(period));

CREATE TABLE appointment_resource (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointment(id) ON DELETE CASCADE,
  room_id        uuid REFERENCES room(id),
  equipment_id   uuid REFERENCES equipment(id),
  period         tstzrange NOT NULL,
  CHECK (num_nonnulls(room_id, equipment_id) = 1),
  EXCLUDE USING gist (room_id WITH =, period WITH &&) WHERE (room_id IS NOT NULL),
  EXCLUDE USING gist (equipment_id WITH =, period WITH &&) WHERE (equipment_id IS NOT NULL)
);

CREATE TABLE appointment_status_history (
  id             bigserial PRIMARY KEY,
  appointment_id uuid NOT NULL REFERENCES appointment(id) ON DELETE CASCADE,
  from_status    text,
  to_status      text NOT NULL,
  changed_by     uuid,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  comment        text
);

CREATE TABLE waiting_list_entry (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id           uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  practitioner_id      uuid REFERENCES practitioner(id),
  specialty_id         uuid REFERENCES specialty(id),
  appointment_type_id  uuid REFERENCES appointment_type(id),
  earliest_date        date,
  latest_date          date,
  priority             text NOT NULL DEFAULT 'NORMAL',
  status               text NOT NULL DEFAULT 'WAITING'
                       CHECK (status IN ('WAITING','OFFERED','BOOKED','EXPIRED','CANCELLED')),
  linked_appointment_id uuid REFERENCES appointment(id),
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE encounter (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid UNIQUE REFERENCES appointment(id),
  patient_id      uuid NOT NULL REFERENCES patient(id),
  practitioner_id uuid NOT NULL REFERENCES practitioner(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  chief_complaint text,
  diagnosis_code  text,
  diagnosis_label text,
  observations    text,
  plan            text,
  is_locked       boolean NOT NULL DEFAULT false,
  locked_at       timestamptz,
  locked_by       uuid
);

-- ---------------------------------------------------------------------
-- 6. Facturation
-- ---------------------------------------------------------------------
CREATE SEQUENCE invoice_number_seq;

CREATE TABLE cash_session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_by      uuid NOT NULL,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  opening_float  numeric(12,2) NOT NULL DEFAULT 0,
  closed_by      uuid,
  closed_at      timestamptz,
  counted_cash   numeric(12,2),
  expected_cash  numeric(12,2),
  discrepancy    numeric(12,2),
  workstation    text,
  comment        text,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
);

CREATE TABLE invoice (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              text UNIQUE,
  patient_id          uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  practitioner_id     uuid REFERENCES practitioner(id),
  issued_at           timestamptz,
  due_date            date,
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                      ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED','CREDITED')),
  subtotal            numeric(12,2) NOT NULL DEFAULT 0,
  discount_amount     numeric(12,2) NOT NULL DEFAULT 0,
  vat_amount          numeric(12,2) NOT NULL DEFAULT 0,
  total_amount        numeric(12,2) NOT NULL DEFAULT 0,
  insurance_part      numeric(12,2) NOT NULL DEFAULT 0,
  patient_part        numeric(12,2) NOT NULL DEFAULT 0,
  paid_amount         numeric(12,2) NOT NULL DEFAULT 0,
  balance             numeric(12,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
  credited_invoice_id uuid REFERENCES invoice(id),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  CHECK (total_amount >= 0)
);
CREATE INDEX idx_invoice_patient ON invoice(patient_id, issued_at DESC);
CREATE INDEX idx_invoice_status  ON invoice(status);

CREATE TABLE invoice_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointment(id),
  tariff_id      uuid REFERENCES tariff(id),
  label          text NOT NULL,
  quantity       numeric(8,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price     numeric(12,2) NOT NULL,
  discount_rate  numeric(5,2) NOT NULL DEFAULT 0,
  vat_rate       numeric(5,2) NOT NULL DEFAULT 0,
  line_total     numeric(12,2) NOT NULL
);

CREATE TABLE payment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES invoice(id) ON DELETE RESTRICT,
  cash_session_id uuid REFERENCES cash_session(id),
  method          text NOT NULL CHECK (method IN ('CASH','CARD','CHECK','TRANSFER','INSURANCE','VOUCHER')),
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  received_at     timestamptz NOT NULL DEFAULT now(),
  reference       text,
  received_by     uuid NOT NULL,
  is_refund       boolean NOT NULL DEFAULT false,
  refund_of_id    uuid REFERENCES payment(id),
  notes           text
);
CREATE INDEX idx_payment_invoice ON payment(invoice_id);
CREATE INDEX idx_payment_date    ON payment(received_at DESC);

-- ---------------------------------------------------------------------
-- 7. Notifications
-- ---------------------------------------------------------------------
CREATE TABLE notification_template (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code      text UNIQUE NOT NULL,
  channel   text NOT NULL CHECK (channel IN ('EMAIL','SMS','PRINT','INTERNAL')),
  subject   text,
  body      text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE notification (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_code  text REFERENCES notification_template(code),
  channel        text NOT NULL,
  appointment_id uuid REFERENCES appointment(id) ON DELETE CASCADE,
  patient_id     uuid REFERENCES patient(id) ON DELETE CASCADE,
  recipient      text NOT NULL,
  subject        text,
  body           text,
  scheduled_for  timestamptz NOT NULL,
  sent_at        timestamptz,
  status         text NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','SENT','FAILED','CANCELLED','SKIPPED_NO_CONSENT')),
  attempts       int NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX idx_notification_due ON notification(scheduled_for) WHERE status = 'PENDING';

CREATE TABLE backup_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text CHECK (kind IN ('FULL','INCREMENTAL','MANUAL','PRE_UPGRADE')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text CHECK (status IN ('RUNNING','SUCCESS','FAILED')),
  size_bytes       bigint,
  target_path      text,
  checksum         text,
  error            text,
  restore_tested_at timestamptz
);

-- ---------------------------------------------------------------------
-- 8. Déclencheurs métier
-- ---------------------------------------------------------------------

-- Référence lisible du RDV : RDV-2026-000123
CREATE OR REPLACE FUNCTION fn_appointment_defaults() RETURNS trigger AS $$
DECLARE t appointment_type%ROWTYPE;
BEGIN
  IF NEW.reference IS NULL OR NEW.reference = '' THEN
    NEW.reference := 'RDV-' || to_char(now(), 'YYYY') || '-' ||
                     lpad(nextval('appointment_ref_seq')::text, 6, '0');
  END IF;
  SELECT * INTO t FROM appointment_type WHERE id = NEW.appointment_type_id;
  -- blocked_period = period élargie des temps tampons du type de RDV
  NEW.blocked_period := tstzrange(
    lower(NEW.period) - make_interval(mins => coalesce(t.buffer_before_minutes, 0)),
    upper(NEW.period) + make_interval(mins => coalesce(t.buffer_after_minutes, 0)),
    '[)');
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointment_defaults
  BEFORE INSERT OR UPDATE OF period, appointment_type_id ON appointment
  FOR EACH ROW EXECUTE FUNCTION fn_appointment_defaults();

-- Machine à états : seules les transitions autorisées passent
CREATE OR REPLACE FUNCTION fn_appointment_status_guard() RETURNS trigger AS $$
DECLARE allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := CASE OLD.status
    WHEN 'SCHEDULED'   THEN ARRAY['CONFIRMED','CHECKED_IN','CANCELLED','NO_SHOW','RESCHEDULED']
    WHEN 'CONFIRMED'   THEN ARRAY['CHECKED_IN','CANCELLED','NO_SHOW','RESCHEDULED']
    WHEN 'CHECKED_IN'  THEN ARRAY['IN_PROGRESS','CANCELLED','NO_SHOW']
    WHEN 'IN_PROGRESS' THEN ARRAY['COMPLETED','CANCELLED']
    WHEN 'COMPLETED'   THEN ARRAY[]::text[]
    WHEN 'CANCELLED'   THEN ARRAY[]::text[]
    WHEN 'NO_SHOW'     THEN ARRAY['CHECKED_IN']
    WHEN 'RESCHEDULED' THEN ARRAY[]::text[]
    ELSE ARRAY[]::text[] END;
  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'Transition de statut interdite : % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointment_status_guard
  BEFORE UPDATE OF status ON appointment
  FOR EACH ROW EXECUTE FUNCTION fn_appointment_status_guard();

-- Historisation automatique des changements de statut
CREATE OR REPLACE FUNCTION fn_appointment_status_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO appointment_status_history(appointment_id, from_status, to_status, changed_by)
    VALUES (NEW.id, NULL, NEW.status, NEW.created_by);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO appointment_status_history(appointment_id, from_status, to_status, changed_by, comment)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.updated_by, NEW.cancellation_reason);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointment_status_history
  AFTER INSERT OR UPDATE ON appointment
  FOR EACH ROW EXECUTE FUNCTION fn_appointment_status_history();

-- Facture émise = immuable (correction uniquement par avoir)
CREATE OR REPLACE FUNCTION fn_invoice_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF NEW.subtotal <> OLD.subtotal OR NEW.total_amount <> OLD.total_amount
       OR NEW.patient_id <> OLD.patient_id OR NEW.number IS DISTINCT FROM OLD.number THEN
      RAISE EXCEPTION 'Une facture émise est immuable : créez un avoir'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_immutable BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_immutable();

-- Lignes de facture verrouillées après émission
CREATE OR REPLACE FUNCTION fn_invoice_line_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM invoice WHERE id = coalesce(NEW.invoice_id, OLD.invoice_id);
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'Facture non modifiable (statut %)', st USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_line_guard();

-- Recalcul automatique du montant payé et du statut de la facture
CREATE OR REPLACE FUNCTION fn_recalc_invoice_payment() RETURNS trigger AS $$
DECLARE inv_id uuid; paid numeric(12,2); tot numeric(12,2); st text;
BEGIN
  inv_id := coalesce(NEW.invoice_id, OLD.invoice_id);
  SELECT coalesce(sum(CASE WHEN is_refund THEN -amount ELSE amount END), 0)
    INTO paid FROM payment WHERE invoice_id = inv_id;
  SELECT total_amount, status INTO tot, st FROM invoice WHERE id = inv_id;
  IF st IN ('DRAFT','CANCELLED','CREDITED') THEN
    UPDATE invoice SET paid_amount = paid WHERE id = inv_id;
  ELSE
    UPDATE invoice SET paid_amount = paid,
      status = CASE WHEN paid >= tot AND tot > 0 THEN 'PAID'
                    WHEN paid > 0 THEN 'PARTIALLY_PAID'
                    ELSE 'ISSUED' END
    WHERE id = inv_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recalc_invoice_payment
  AFTER INSERT OR UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION fn_recalc_invoice_payment();

-- Recalcul des totaux d'une facture brouillon
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
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recalc_invoice_totals
  AFTER INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION fn_recalc_invoice_totals();

-- ---------------------------------------------------------------------
-- 9. Fonction de disponibilité : un créneau est-il réservable ?
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_slot_is_available(
  p_practitioner uuid, p_start timestamptz, p_end timestamptz
) RETURNS boolean AS $$
DECLARE p tstzrange := tstzrange(p_start, p_end, '[)');
BEGIN
  -- fermeture de la clinique
  IF EXISTS (SELECT 1 FROM clinic_closure WHERE period && p) THEN RETURN false; END IF;
  -- absence du praticien
  IF EXISTS (SELECT 1 FROM absence WHERE practitioner_id = p_practitioner AND period && p)
    THEN RETURN false; END IF;
  -- doit tomber dans une plage de disponibilité déclarée
  IF NOT EXISTS (
    SELECT 1 FROM availability_rule r
    WHERE r.practitioner_id = p_practitioner
      AND r.weekday = EXTRACT(ISODOW FROM p_start)::smallint
      AND r.valid_from <= p_start::date
      AND (r.valid_to IS NULL OR r.valid_to >= p_start::date)
      AND p_start::time >= r.start_time AND p_end::time <= r.end_time
  ) THEN RETURN false; END IF;
  -- pas de RDV actif en collision
  IF EXISTS (
    SELECT 1 FROM appointment a
    WHERE a.practitioner_id = p_practitioner AND a.blocked_period && p
      AND a.status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS')
  ) THEN RETURN false; END IF;
  RETURN true;
END $$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------
-- 10. Vues de reporting
-- ---------------------------------------------------------------------
CREATE VIEW v_appointment_full AS
SELECT a.*,
       p.mrn, p.last_name AS patient_last_name, p.first_name AS patient_first_name,
       p.birth_date AS patient_birth_date, p.phone_mobile AS patient_phone,
       pr.last_name AS practitioner_last_name, pr.first_name AS practitioner_first_name,
       pr.color AS practitioner_color,
       at.label AS type_label, at.color AS type_color,
       at.default_duration_minutes,
       s.label AS specialty_label,
       (SELECT r.code FROM appointment_resource ar JOIN room r ON r.id = ar.room_id
         WHERE ar.appointment_id = a.id LIMIT 1) AS room_code,
       lower(a.period) AS start_at, upper(a.period) AS end_at
FROM appointment a
JOIN patient p ON p.id = a.patient_id
JOIN practitioner pr ON pr.id = a.practitioner_id
JOIN appointment_type at ON at.id = a.appointment_type_id
LEFT JOIN specialty s ON s.id = at.specialty_id;

CREATE VIEW v_patient_summary AS
SELECT p.*,
       (SELECT count(*) FROM appointment a WHERE a.patient_id = p.id
          AND a.status = 'NO_SHOW' AND lower(a.period) > now() - interval '12 months') AS no_show_count,
       (SELECT max(lower(a.period)) FROM appointment a WHERE a.patient_id = p.id
          AND a.status = 'COMPLETED') AS last_visit_at,
       (SELECT min(lower(a.period)) FROM appointment a WHERE a.patient_id = p.id
          AND a.status IN ('SCHEDULED','CONFIRMED') AND lower(a.period) > now()) AS next_visit_at,
       (SELECT coalesce(sum(i.balance), 0) FROM invoice i WHERE i.patient_id = p.id
          AND i.status IN ('ISSUED','PARTIALLY_PAID','OVERDUE')) AS outstanding_balance,
       (SELECT count(*) FROM medical_history_entry m WHERE m.patient_id = p.id
          AND m.category = 'ALLERGY' AND m.severity = 'CRITICAL' AND m.is_active) AS critical_allergy_count
FROM patient p;
