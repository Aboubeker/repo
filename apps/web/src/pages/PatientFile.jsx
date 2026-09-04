import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Spinner, Badge, INVOICE_STATUS, Modal, Field, ErrorAlert, Empty,
  fmtDate, fmtTime, fmtMoney, fmtName, age, can, useToast,
} from '../lib.jsx';

/*
 * Onglet « Consentements » et bloc « Couverture » retires de la fiche a la
 * demande de la clinique d'esthetique : la prise en charge par un organisme
 * (CNAS/CASNOS) ne s'applique pas a des actes esthetiques, non remboursables.
 *
 * Seul l'AFFICHAGE disparait. Les donnees restent en base et continuent de
 * servir : patient_insurance alimente la ventilation assurance/client des
 * factures (fn_recalc_invoice_shares) et consent conditionne l'envoi des
 * rappels automatiques (notifications.service). Les supprimer casserait ces
 * deux mecanismes.
 */
const TABS = [
  ['identity', 'Identité'], ['medical', 'Médical'], ['appointments', 'Rendez-vous'],
  ['billing', 'Facturation'],
];

export default function PatientFile({ id, user, go, onNewAppt }) {
  onNewAppt = onNewAppt || (() => {});
  go = go || (() => {});
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('identity');
  const [error, setError] = useState(null);
  const [addHistory, setAddHistory] = useState(false);

  /*
   * Garde sur l'identifiant. Un appelant qui transmet un id absent
   * produisait /api/patients/undefined : Postgres rejetait l'UUID (22P02) et
   * l'ecran affichait « Format de donnee invalide », message technique qui
   * ne disait ni ou ni pourquoi. On n'appelle plus l'API sans identifiant.
   */
  const load = () => { if (id) api.client(id).then(setD).catch(setError); };
  useEffect(() => { setD(null); load(); }, [id]);

  if (!id) return <ErrorAlert error={{ message:
    'Aucun client selectionne : cette fiche a ete ouverte sans identifiant.' }} />;
  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  const p = d.patient;
  const critical = d.history.filter((h) => h.severity === 'CRITICAL' && h.is_active);
  const chronic = d.history.filter((h) => h.category === 'CHRONIC_CONDITION' && h.is_active);
  const canMedical = can(user, 'patient.write.medical');

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <button className="btn ghost sm" onClick={() => go('patients')}>◂ Clients</button>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 17 }}>{fmtName(p.last_name, p.first_name)}</h3>
            <div className="muted small">
              {age(p.birth_date)} ans · {p.sex === 'F' ? 'Féminin' : p.sex === 'M' ? 'Masculin' : '—'}
              {' · '}{p.mrn}
            </div>
          </div>
          {can(user, 'appointment.write') && (
            <button className="btn primary" onClick={() => onNewAppt({ patientId: p.id })}>
              + Rendez-vous</button>
          )}
          <button className="btn" onClick={() => window.print()}>🖨</button>
        </div>

        {(critical.length > 0 || chronic.length > 0) && (
          <div style={{ padding: '10px 16px 0' }}>
            {critical.length > 0 && (
              <div className="critical-banner">
                ⚠ ALLERGIE CRITIQUE : {critical.map((h) => h.label).join(' · ')}
              </div>
            )}
            {chronic.length > 0 && (
              <div className="alert warning">
                <span>ⓘ</span>
                <div>Antécédents actifs : {chronic.map((h) => h.label).join(' · ')}</div>
              </div>
            )}
          </div>
        )}

        <div style={{ padding: '0 16px' }}>
          <div className="tabs" style={{ marginBottom: 0 }}>
            {TABS.map(([k, label]) => (
              <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                {label}
                {k === 'appointments' && ` (${d.appointments.length})`}
                {k === 'medical' && d.history.length > 0 && ` (${d.history.length})`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'identity' && (
        <div className="grid c2">
          <div className="card">
            <div className="card-head"><h3>Identité</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>Identifiant</dt><dd>{p.mrn}</dd>
                <dt>Nom</dt><dd>{p.last_name}</dd>
                <dt>Prénom</dt><dd>{p.first_name}</dd>
                <dt>Naissance</dt><dd>{fmtDate(p.birth_date)} ({age(p.birth_date)} ans)</dd>
                <dt>Lieu</dt><dd>{p.birth_place || '—'}</dd>
                <dt>Groupe sanguin</dt><dd>{p.blood_type || '—'}</dd>
                <dt>Médecin traitant</dt><dd>{p.gp_name || '—'}</dd>
              </dl>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Coordonnées</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>Mobile</dt><dd>{p.phone_mobile || '—'}</dd>
                <dt>Fixe</dt><dd>{p.phone_home || '—'}</dd>
                <dt>E-mail</dt><dd>{p.email || '—'}</dd>
                <dt>Adresse</dt><dd>{p.address_line1 || '—'}</dd>
                <dt>Ville</dt><dd>{[p.postal_code, p.city].filter(Boolean).join(' ') || '—'}</dd>
              </dl>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Synthèse</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>Client depuis</dt><dd>{fmtDate(p.created_at)}</dd>
                <dt>Consultations</dt><dd>{d.appointments.filter((a) => a.status === 'COMPLETED').length}</dd>
                <dt>Dernière visite</dt><dd>{p.last_visit_at ? fmtDate(p.last_visit_at) : '—'}</dd>
                <dt>Prochain RDV</dt><dd>{p.next_visit_at
                  ? `${fmtDate(p.next_visit_at)} à ${fmtTime(p.next_visit_at)}` : '—'}</dd>
                <dt>Absences (12 mois)</dt><dd>
                  {Number(p.no_show_count) >= 3
                    ? <span className="badge red">{p.no_show_count}</span>
                    : p.no_show_count}</dd>
                <dt>Solde dû</dt><dd style={{ color: Number(p.outstanding_balance) > 0
                  ? 'var(--danger)' : undefined }}>{fmtMoney(p.outstanding_balance)}</dd>
              </dl>
            </div>
          </div>
        </div>
      )}

      {tab === 'medical' && (
        <div className="card">
          <div className="card-head">
            <h3>Historique médical</h3>
            <div className="spacer" />
            {canMedical && <button className="btn primary sm"
              onClick={() => setAddHistory(true)}>+ Ajouter</button>}
          </div>
          <div className="card-body tight">
            {!canMedical ? (
              <div className="alert warning" style={{ margin: 16 }}>
                <span>🔒</span>
                <div>Les données médicales sont réservées aux praticiens.
                  Votre rôle ne permet pas cet accès.</div>
              </div>
            ) : d.history.length === 0 ? (
              <Empty icon="⚕" text="Aucun antécédent enregistré." />
            ) : (
              <table>
                <thead><tr><th>Catégorie</th><th>Libellé</th><th>Gravité</th>
                  <th>Début</th><th>Statut</th></tr></thead>
                <tbody>
                  {d.history.map((h) => (
                    <tr key={h.id}>
                      <td className="muted small">{CATEGORY[h.category] || h.category}</td>
                      <td><strong>{h.label}</strong>
                        {h.detail && <div className="muted small">{h.detail}</div>}</td>
                      <td>{h.severity && <span className={`badge ${
                        h.severity === 'CRITICAL' ? 'red' : h.severity === 'HIGH' ? 'orange' : 'gray'
                      }`}>{SEVERITY[h.severity]}</span>}</td>
                      <td className="muted small">{h.onset_date ? fmtDate(h.onset_date) : '—'}</td>
                      <td>{h.is_active ? <span className="badge green">Actif</span>
                                        : <span className="badge gray">Résolu</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'appointments' && (
        <div className="card">
          <div className="card-head"><h3>Historique des rendez-vous</h3></div>
          <div className="card-body tight">
            {d.appointments.length === 0 ? <Empty icon="📅" text="Aucun rendez-vous." /> : (
              <table>
                <thead><tr><th>Date</th><th>Heure</th><th>Praticien</th>
                  <th>Type</th><th>Motif</th><th>Statut</th></tr></thead>
                <tbody>
                  {d.appointments.map((a) => (
                    <tr key={a.id}>
                      <td>{fmtDate(a.start_at)}</td>
                      <td className="num">{fmtTime(a.start_at)}</td>
                      <td className="muted">Dr {a.practitioner_last_name}</td>
                      <td className="muted small">{a.type_label}</td>
                      <td className="muted small">{a.reason || '—'}</td>
                      <td><Badge status={a.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'billing' && (
        <div className="card">
          <div className="card-head"><h3>Factures</h3></div>
          <div className="card-body tight">
            {d.invoices.length === 0 ? <Empty icon="▤" text="Aucune facture." /> : (
              <table>
                <thead><tr><th>Numéro</th><th>Date</th><th className="num">Total</th>
                  <th className="num">Payé</th><th className="num">Solde</th><th>Statut</th></tr></thead>
                <tbody>
                  {d.invoices.map((i) => (
                    <tr key={i.id}>
                      <td>{i.number || <span className="muted">brouillon</span>}</td>
                      <td className="muted">{i.issued_at ? fmtDate(i.issued_at) : '—'}</td>
                      <td className="num">{fmtMoney(i.total_amount)}</td>
                      <td className="num">{fmtMoney(i.paid_amount)}</td>
                      <td className="num" style={{ color: Number(i.balance) > 0
                        ? 'var(--danger)' : undefined }}>{fmtMoney(i.balance)}</td>
                      <td><Badge status={i.status} map={INVOICE_STATUS} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {addHistory && <AddHistory patientId={p.id} onClose={() => setAddHistory(false)}
        onDone={() => { setAddHistory(false); load(); }} />}
    </>
  );
}

const CATEGORY = {
  ALLERGY: 'Allergie', CHRONIC_CONDITION: 'Pathologie chronique', SURGERY: 'Chirurgie',
  TREATMENT: 'Traitement', VACCINATION: 'Vaccination', FAMILY: 'Antécédent familial',
  LIFESTYLE: 'Mode de vie', NOTE: 'Note',
};
const SEVERITY = { LOW: 'Faible', MODERATE: 'Modérée', HIGH: 'Élevée', CRITICAL: 'Critique' };

function AddHistory({ patientId, onClose, onDone }) {
  const [f, setF] = useState({ category: 'ALLERGY', label: '', severity: '', detail: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async () => {
    setBusy(true); setError(null);
    try { await api.addHistory(patientId, f); toast.success('Antécédent enregistré.'); onDone(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title="Ajouter un antécédent" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={!f.label || busy} onClick={submit}>Enregistrer</button>
      </>
    }>
      <ErrorAlert error={error} />
      <Field label="Catégorie">
        <select value={f.category} onChange={set('category')}>
          {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Libellé">
        <input value={f.label} onChange={set('label')} autoFocus
               placeholder="Ex. Pénicilline, Hypertension artérielle…" /></Field>
      <Field label="Gravité" help="« Critique » déclenche un bandeau d'alerte sur la fiche.">
        <select value={f.severity} onChange={set('severity')}>
          <option value="">Non précisée</option>
          {Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Détail">
        <textarea rows={3} value={f.detail} onChange={set('detail')} /></Field>
    </Modal>
  );
}
