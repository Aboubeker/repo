# 02 — Modèle de données

SGBD : PostgreSQL 16. Extensions : `pgcrypto`, `citext`, `unaccent`, `pg_trgm`, `btree_gist`.

Conventions : clés primaires `uuid` (v7 pour l'ordre temporel), `snake_case`, colonnes d'audit `created_at, updated_at, created_by, updated_by`, suppression **logique** (`deleted_at`) pour les entités métier, montants en `numeric(12,2)`, dates/heures en `timestamptz` (fuseau clinique stocké en paramètre).

---

## 1. Diagramme entité-relation (vue logique)

```
                 ┌───────────┐        ┌──────────────┐
                 │  role     │───<    │ user_account │>─── practitioner (0..1)
                 └───────────┘        └──────┬───────┘
                                             │ 1..n
                                     ┌───────▼────────┐
                                     │  audit_log     │
                                     └────────────────┘

 patient 1───n patient_contact          practitioner 1───n practitioner_specialty n───1 specialty
 patient 1───n patient_insurance        practitioner 1───n availability_rule
 patient 1───n medical_history_entry    practitioner 1───n absence
 patient 1───n document                 practitioner 1───n appointment
 patient 1───n appointment              
 patient 1───n invoice                  room        1───n appointment_resource
 patient 1───n consent                  equipment   1───n appointment_resource

 appointment 1───n appointment_resource
 appointment 1───n appointment_status_history
 appointment 1───1 encounter (consultation réalisée)
 appointment 1───n notification
 appointment 0..1─n invoice_line

 invoice 1───n invoice_line   invoice 1───n payment   payment n───1 cash_session
 appointment_type n───1 specialty
 waiting_list_entry n───1 patient / practitioner
```

---

## 2. Tables — définitions SQL de référence

### 2.1 Sécurité & utilisateurs

```sql
CREATE TABLE role (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text UNIQUE NOT NULL,          -- ADMIN, RECEPTION, PRACTITIONER, BILLING, READONLY
  label         text NOT NULL,
  is_system     boolean NOT NULL DEFAULT false
);

CREATE TABLE permission (
  code          text PRIMARY KEY,              -- patient.read, appointment.write, invoice.void, ...
  label         text NOT NULL,
  category      text NOT NULL
);

CREATE TABLE role_permission (
  role_id       uuid REFERENCES role(id) ON DELETE CASCADE,
  permission_code text REFERENCES permission(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        citext UNIQUE NOT NULL,
  email           citext,
  password_hash   text NOT NULL,               -- Argon2id
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  must_change_password boolean NOT NULL DEFAULT true,
  mfa_secret_enc  bytea,                       -- TOTP, chiffré pgcrypto
  mfa_enabled     boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  practitioner_id uuid REFERENCES practitioner(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE user_role (
  user_id uuid REFERENCES user_account(id) ON DELETE CASCADE,
  role_id uuid REFERENCES role(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE session_token (          -- refresh tokens rotatifs
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,           -- SHA-256 du refresh token
  parent_id    uuid REFERENCES session_token(id),
  ip           inet, user_agent text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,
  username    text,
  ip          inet,
  action      text NOT NULL,        -- READ, CREATE, UPDATE, DELETE, LOGIN, EXPORT, BREAK_GLASS
  entity      text NOT NULL,        -- patient, appointment, invoice...
  entity_id   text,
  summary     text,
  diff        jsonb,                -- {champ: {old, new}} hors données ultra-sensibles
  justification text,               -- obligatoire pour BREAK_GLASS / EXPORT
  hash_prev   text,                 -- chaînage d'intégrité
  hash_self   text
);
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
```

### 2.2 Patients

```sql
CREATE TABLE patient (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn               text UNIQUE NOT NULL,      -- Medical Record Number : P-2026-000123 (séquence)
  last_name         text NOT NULL,
  first_name        text NOT NULL,
  birth_name        text,
  sex               text CHECK (sex IN ('M','F','U')),
  birth_date        date NOT NULL,
  birth_place       text,
  national_id_enc   bytea,                     -- NIR/INS chiffré
  national_id_hash  text UNIQUE,               -- hash déterministe -> détection de doublon sans déchiffrer
  phone_mobile      text, phone_home text, email citext,
  address_line1 text, address_line2 text, postal_code text, city text, country text DEFAULT 'FR',
  preferred_language text DEFAULT 'fr',
  blood_type        text,
  gp_name           text,                      -- médecin traitant externe
  notes             text,
  is_deceased       boolean NOT NULL DEFAULT false, deceased_on date,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED','MERGED')),
  merged_into_id    uuid REFERENCES patient(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid, updated_by uuid, deleted_at timestamptz
);
CREATE INDEX idx_patient_name_trgm ON patient
  USING gin ((unaccent(last_name||' '||first_name)) gin_trgm_ops);
CREATE INDEX idx_patient_birthdate ON patient(birth_date);
-- Détection de doublons
CREATE UNIQUE INDEX uq_patient_identity ON patient
  (lower(unaccent(last_name)), lower(unaccent(first_name)), birth_date)
  WHERE deleted_at IS NULL AND status = 'ACTIVE';

CREATE TABLE patient_contact (         -- personne de confiance / urgence / tuteur
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('EMERGENCY','TRUSTED','LEGAL_GUARDIAN','OTHER')),
  full_name text NOT NULL, relationship text, phone text, email citext
);

CREATE TABLE patient_insurance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  scheme text NOT NULL,                 -- régime obligatoire / mutuelle / privé / auto-payeur
  insurer_name text, policy_number_enc bytea,
  coverage_rate numeric(5,2) CHECK (coverage_rate BETWEEN 0 AND 100),
  valid_from date, valid_to date,
  is_primary boolean NOT NULL DEFAULT true
);

CREATE TABLE medical_history_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN
    ('ALLERGY','CHRONIC_CONDITION','SURGERY','TREATMENT','VACCINATION','FAMILY','LIFESTYLE','NOTE')),
  code_system text, code text,          -- CIM-10 / CCAM si utilisé
  label text NOT NULL,
  severity text CHECK (severity IN ('LOW','MODERATE','HIGH','CRITICAL')),
  onset_date date, end_date date,
  detail_enc bytea,                     -- texte libre chiffré
  is_active boolean NOT NULL DEFAULT true,
  recorded_by uuid REFERENCES user_account(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
-- Les allergies CRITICAL remontent en bandeau rouge sur la fiche patient.

CREATE TABLE document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid REFERENCES patient(id) ON DELETE CASCADE,
  encounter_id uuid REFERENCES encounter(id),
  kind text NOT NULL,                   -- ID_CARD, INSURANCE_CARD, LAB_RESULT, IMAGING, CONSENT, INVOICE_PDF
  filename text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL,
  storage_path text NOT NULL,           -- volume local chiffré, hors base
  sha256 text NOT NULL,
  uploaded_by uuid, uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  kind text NOT NULL,                   -- DATA_PROCESSING, SMS_REMINDER, EMAIL_REMINDER, DATA_SHARING
  granted boolean NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  proof_document_id uuid REFERENCES document(id)
);
```

### 2.3 Praticiens & disponibilités

```sql
CREATE TABLE specialty (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL, label text NOT NULL, color text, is_active boolean DEFAULT true
);

CREATE TABLE practitioner (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,            -- DR-014
  last_name text NOT NULL, first_name text NOT NULL, title text,
  registration_number text UNIQUE,      -- n° RPPS / ordre
  phone text, email citext, office_room_id uuid REFERENCES room(id),
  default_slot_minutes int NOT NULL DEFAULT 20 CHECK (default_slot_minutes BETWEEN 5 AND 240),
  color text,
  employment_type text CHECK (employment_type IN ('SALARIED','LIBERAL','LOCUM')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz
);

CREATE TABLE practitioner_specialty (
  practitioner_id uuid REFERENCES practitioner(id) ON DELETE CASCADE,
  specialty_id    uuid REFERENCES specialty(id) ON DELETE RESTRICT,
  is_primary boolean NOT NULL DEFAULT false,
  PRIMARY KEY (practitioner_id, specialty_id)
);

-- Règle de disponibilité récurrente (RRULE iCalendar simplifiée)
CREATE TABLE availability_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioner(id) ON DELETE CASCADE,
  room_id uuid REFERENCES room(id),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO
  start_time time NOT NULL, end_time time NOT NULL,
  valid_from date NOT NULL, valid_to date,
  slot_minutes int,                      -- surcharge du défaut praticien
  appointment_type_id uuid REFERENCES appointment_type(id),    -- plage dédiée (ex: urgences)
  capacity int NOT NULL DEFAULT 1,       -- >1 = consultation de groupe / surbooking autorisé
  is_bookable_online boolean NOT NULL DEFAULT false,           -- borne d'accueil interne
  CHECK (end_time > start_time),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE TABLE absence (                   -- congés, formation, bloc opératoire, maladie
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioner(id) ON DELETE CASCADE,
  period tstzrange NOT NULL,
  reason text NOT NULL CHECK (reason IN ('LEAVE','SICK','TRAINING','SURGERY','OTHER')),
  comment text,
  created_by uuid, created_at timestamptz DEFAULT now(),
  EXCLUDE USING gist (practitioner_id WITH =, period WITH &&)
);

CREATE TABLE clinic_closure (            -- jours fériés, fermeture annuelle
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period tstzrange NOT NULL, label text NOT NULL
);
```

### 2.4 Ressources

```sql
CREATE TABLE room (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL, label text NOT NULL,
  building text, floor text, capacity int DEFAULT 1,
  kind text CHECK (kind IN ('CONSULTATION','PROCEDURE','IMAGING','LAB','SURGERY','WAITING')),
  is_active boolean DEFAULT true
);

CREATE TABLE equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL, label text NOT NULL,
  kind text, serial_number text, room_id uuid REFERENCES room(id),
  is_mobile boolean DEFAULT false,
  status text NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','IN_MAINTENANCE','OUT_OF_ORDER','RETIRED')),
  next_maintenance_on date, is_active boolean DEFAULT true
);

CREATE TABLE resource_unavailability (   -- maintenance, nettoyage, travaux
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid REFERENCES room(id), equipment_id uuid REFERENCES equipment(id),
  period tstzrange NOT NULL, reason text,
  CHECK (num_nonnulls(room_id, equipment_id) = 1)
);
```

### 2.5 Rendez-vous (cœur du système)

```sql
CREATE TABLE appointment_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL, label text NOT NULL,
  specialty_id uuid REFERENCES specialty(id),
  default_duration_minutes int NOT NULL CHECK (default_duration_minutes > 0),
  buffer_before_minutes int NOT NULL DEFAULT 0,
  buffer_after_minutes  int NOT NULL DEFAULT 0,
  requires_room boolean NOT NULL DEFAULT true,
  required_equipment_kind text,
  color text, default_tariff_id uuid REFERENCES tariff(id),
  preparation_instructions text,          -- ex: "à jeun 8 h"
  is_active boolean DEFAULT true
);

CREATE TABLE appointment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text UNIQUE NOT NULL,          -- RDV-2026-004512
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  practitioner_id uuid NOT NULL REFERENCES practitioner(id) ON DELETE RESTRICT,
  appointment_type_id uuid NOT NULL REFERENCES appointment_type(id),
  period tstzrange NOT NULL,               -- [start, end)
  blocked_period tstzrange NOT NULL,       -- period élargie des buffers (utilisée pour l'exclusion)
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN
    ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW','RESCHEDULED')),
  cancellation_reason text,
  cancelled_by uuid, cancelled_at timestamptz,
  rescheduled_from_id uuid REFERENCES appointment(id),
  recurrence_group_id uuid,                -- série de séances (kiné, etc.)
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','URGENT','EMERGENCY')),
  origin text NOT NULL DEFAULT 'DESK' CHECK (origin IN ('DESK','PHONE','KIOSK','WAITLIST','IMPORT')),
  reason text,                             -- motif de consultation (court)
  notes_enc bytea,
  checked_in_at timestamptz, started_at timestamptz, ended_at timestamptz,
  created_at timestamptz DEFAULT now(), created_by uuid,
  updated_at timestamptz DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,          -- verrou optimiste
  CHECK (upper(period) > lower(period)),
  CHECK (blocked_period @> period)
);

-- ANTI-DOUBLE-BOOKING au niveau SGBD (statuts actifs uniquement)
CREATE INDEX idx_appt_period ON appointment USING gist (period);
ALTER TABLE appointment ADD CONSTRAINT no_overlap_practitioner
  EXCLUDE USING gist (practitioner_id WITH =, blocked_period WITH &&)
  WHERE (status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS'));
ALTER TABLE appointment ADD CONSTRAINT no_overlap_patient
  EXCLUDE USING gist (patient_id WITH =, period WITH &&)
  WHERE (status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS'));

CREATE TABLE appointment_resource (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointment(id) ON DELETE CASCADE,
  room_id uuid REFERENCES room(id), equipment_id uuid REFERENCES equipment(id),
  period tstzrange NOT NULL,
  CHECK (num_nonnulls(room_id, equipment_id) = 1),
  EXCLUDE USING gist (room_id WITH =, period WITH &&) WHERE (room_id IS NOT NULL),
  EXCLUDE USING gist (equipment_id WITH =, period WITH &&) WHERE (equipment_id IS NOT NULL)
);

CREATE TABLE appointment_status_history (
  id bigserial PRIMARY KEY,
  appointment_id uuid NOT NULL REFERENCES appointment(id) ON DELETE CASCADE,
  from_status text, to_status text NOT NULL,
  changed_by uuid, changed_at timestamptz NOT NULL DEFAULT now(), comment text
);

CREATE TABLE waiting_list_entry (         -- patients en attente d'un créneau plus tôt
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  practitioner_id uuid REFERENCES practitioner(id),
  specialty_id uuid REFERENCES specialty(id),
  appointment_type_id uuid REFERENCES appointment_type(id),
  earliest_date date, latest_date date,
  preferred_slots jsonb,                  -- ex: {"weekdays":[1,2],"period":"AM"}
  priority text DEFAULT 'NORMAL',
  status text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','OFFERED','BOOKED','EXPIRED','CANCELLED')),
  linked_appointment_id uuid REFERENCES appointment(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE encounter (                  -- consultation réellement effectuée
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid UNIQUE REFERENCES appointment(id),
  patient_id uuid NOT NULL REFERENCES patient(id),
  practitioner_id uuid NOT NULL REFERENCES practitioner(id),
  started_at timestamptz NOT NULL, ended_at timestamptz,
  chief_complaint text, diagnosis_code text, diagnosis_label text,
  observations_enc bytea, plan_enc bytea,
  is_locked boolean NOT NULL DEFAULT false,   -- signature du praticien -> lecture seule
  locked_at timestamptz, locked_by uuid
);
```

### 2.6 Facturation & paiements

```sql
CREATE TABLE tariff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,             -- CS, APC, CCAM...
  label text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  vat_rate numeric(5,2) NOT NULL DEFAULT 0,
  valid_from date NOT NULL, valid_to date,
  specialty_id uuid REFERENCES specialty(id), is_active boolean DEFAULT true
);

CREATE TABLE invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text UNIQUE,                    -- séquence légale continue, attribuée à l'émission
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  practitioner_id uuid REFERENCES practitioner(id),
  issued_at timestamptz, due_date date,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
    ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED','CREDITED')),
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  vat_amount numeric(12,2) NOT NULL DEFAULT 0,
  total_amount numeric(12,2) NOT NULL DEFAULT 0,
  insurance_part numeric(12,2) NOT NULL DEFAULT 0,
  patient_part numeric(12,2) NOT NULL DEFAULT 0,
  paid_amount numeric(12,2) NOT NULL DEFAULT 0,
  balance numeric(12,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED,
  credited_invoice_id uuid REFERENCES invoice(id),   -- avoir
  pdf_document_id uuid REFERENCES document(id),
  notes text,
  created_at timestamptz DEFAULT now(), created_by uuid,
  CHECK (total_amount >= 0)
);
-- Immuabilité : une facture ISSUED ne peut plus être modifiée (trigger) ; correction = avoir.

CREATE TABLE invoice_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointment(id),
  tariff_id uuid REFERENCES tariff(id),
  label text NOT NULL,
  quantity numeric(8,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL,
  discount_rate numeric(5,2) NOT NULL DEFAULT 0,
  vat_rate numeric(5,2) NOT NULL DEFAULT 0,
  line_total numeric(12,2) NOT NULL
);

CREATE TABLE cash_session (              -- caisse : ouverture/clôture par jour et par poste
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_by uuid NOT NULL, opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float numeric(12,2) NOT NULL DEFAULT 0,
  closed_by uuid, closed_at timestamptz,
  counted_cash numeric(12,2), expected_cash numeric(12,2),
  discrepancy numeric(12,2), workstation text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
);

CREATE TABLE payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoice(id) ON DELETE RESTRICT,
  cash_session_id uuid REFERENCES cash_session(id),
  method text NOT NULL CHECK (method IN ('CASH','CARD','CHECK','TRANSFER','INSURANCE','VOUCHER')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  reference text,                        -- n° chèque, ticket TPE (saisi manuellement)
  received_by uuid NOT NULL,
  is_refund boolean NOT NULL DEFAULT false,
  refund_of_id uuid REFERENCES payment(id),
  notes text
);
```

### 2.7 Notifications & paramétrage

```sql
CREATE TABLE notification_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,      -- APPT_CONFIRMATION, APPT_REMINDER_48H, APPT_CANCELLED, INVOICE_DUE
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS','PRINT','INTERNAL')),
  subject text, body text NOT NULL,   -- moteur de gabarit {{patient.firstName}}, {{appointment.date}}
  is_active boolean DEFAULT true
);

CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_code text REFERENCES notification_template(code),
  channel text NOT NULL,
  appointment_id uuid REFERENCES appointment(id) ON DELETE CASCADE,
  patient_id uuid REFERENCES patient(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENT','FAILED','CANCELLED','SKIPPED_NO_CONSENT')),
  attempts int NOT NULL DEFAULT 0, last_error text,
  payload_preview text
);

CREATE TABLE app_setting (
  key text PRIMARY KEY, value jsonb NOT NULL,
  category text, description text, updated_at timestamptz DEFAULT now(), updated_by uuid
);
-- clinic.name, clinic.timezone, scheduling.min_notice_hours, scheduling.max_horizon_days,
-- scheduling.allow_overbooking, billing.invoice_prefix, security.password_policy,
-- notifications.reminder_offsets = [48h, 2h], retention.patient_years = 20 ...

CREATE TABLE backup_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text CHECK (kind IN ('FULL','INCREMENTAL','MANUAL','PRE_UPGRADE')),
  started_at timestamptz NOT NULL, finished_at timestamptz,
  status text CHECK (status IN ('RUNNING','SUCCESS','FAILED')),
  size_bytes bigint, target_path text, checksum text, error text,
  restore_tested_at timestamptz
);
```

---

## 3. Règles d'intégrité métier (triggers / contraintes applicatives)

| Règle | Mise en œuvre |
|---|---|
| Pas de chevauchement praticien / patient / salle / équipement | `EXCLUDE USING gist` (ci-dessus) |
| RDV uniquement dans une plage `availability_rule` valide et hors `absence` / `clinic_closure` | Vérifié en service + fonction SQL `fn_slot_is_available()` appelée dans la même transaction |
| `blocked_period` = period ± buffers du type de RDV | Trigger `BEFORE INSERT/UPDATE` |
| Transitions de statut RDV autorisées | Machine à états applicative + trigger de garde (voir doc 03 §3) |
| Facture `ISSUED` immuable | Trigger `BEFORE UPDATE` : seuls `status`, `paid_amount`, `pdf_document_id` modifiables |
| Numérotation de facture continue sans trou | Séquence dédiée + attribution dans la transaction d'émission uniquement |
| `paid_amount` = somme des paiements (hors remboursements) | Trigger `AFTER INSERT/UPDATE/DELETE ON payment` recalcule et met à jour le statut |
| Journalisation automatique | Trigger générique `audit_trigger()` sur les tables sensibles + interceptor NestJS pour les lectures |
| Suppression patient | Interdite si RDV ou facture existants → archivage (`status='ARCHIVED'`) ; suppression RGPD = anonymisation (`fn_anonymize_patient`) |
| Fusion de doublons | `fn_merge_patients(source, target)` : réaffecte RDV/factures/documents, marque `MERGED`, trace dans l'audit |

---

## 4. Index et performances

```sql
CREATE INDEX idx_appt_practitioner_day ON appointment (practitioner_id, lower(period));
CREATE INDEX idx_appt_patient        ON appointment (patient_id, lower(period) DESC);
CREATE INDEX idx_appt_status_day     ON appointment (status, lower(period));
CREATE INDEX idx_invoice_patient     ON invoice (patient_id, issued_at DESC);
CREATE INDEX idx_invoice_status      ON invoice (status) WHERE status IN ('ISSUED','PARTIALLY_PAID','OVERDUE');
CREATE INDEX idx_notification_due    ON notification (scheduled_for) WHERE status = 'PENDING';
CREATE INDEX idx_audit_entity        ON audit_log (entity, entity_id, occurred_at DESC);
```

Vues matérialisées pour le reporting, rafraîchies la nuit :
`mv_daily_occupancy`, `mv_practitioner_activity_monthly`, `mv_revenue_monthly`, `mv_noshow_rate`.

Volumétrie estimée (40 praticiens, 5 ans) : ~1,5 M RDV, ~300 k patients, ~2 M lignes d'audit → < 50 Go avec documents. Partitionnement par année sur `appointment` et `audit_log` prévu au-delà de 5 M lignes.

---

## 5. Chiffrement des colonnes

Colonnes `*_enc` : `pgp_sym_encrypt(valeur, clé)` avec clé lue depuis `/etc/clinirdv/db.key` (root:postgres, 0400), montée par systemd, sauvegardée séparément dans le coffre physique de la clinique. Perte de clé = perte des champs chiffrés → procédure d'escrow documentée (doc 05 §6).
