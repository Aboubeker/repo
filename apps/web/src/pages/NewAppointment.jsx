import React, { useEffect, useState, useMemo } from 'react';
import { api } from '../api.js';
import {
  Modal, Field, ErrorAlert, Spinner, fmtName, fmtTime, age, toISODate, useToast, Empty,
} from '../lib.jsx';

/** Assistant de prise de rendez-vous en 3 étapes : patient → créneau → confirmation. */
export default function NewAppointment({ initial = {}, onClose, onCreated }) {
  const [step, setStep] = useState(initial.patientId ? 2 : 1);
  const [patient, setPatient] = useState(null);
  const [refs, setRefs] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.practitioners(), api.appointmentTypes()])
      .then(([p, t]) => setRefs({ practitioners: p.items, types: t.items }))
      .catch(setError);
  }, []);

  useEffect(() => {
    if (initial.patientId) api.patient(initial.patientId).then((d) => setPatient(d.patient));
  }, [initial.patientId]);

  return (
    <Modal title="Nouveau rendez-vous" onClose={onClose} wide>
      <Steps current={step} />
      <ErrorAlert error={error} />
      {!refs ? <Spinner /> : step === 1 ? (
        <StepPatient onPick={(p) => { setPatient(p); setStep(2); }} />
      ) : (
        <StepSlot patient={patient} refs={refs} initial={initial}
                  onBack={() => setStep(1)} onCreated={onCreated} />
      )}
    </Modal>
  );
}

const Steps = ({ current }) => (
  <div style={{ display: 'flex', gap: 8, marginBottom: 18, fontSize: 12.5 }}>
    {['Patient', 'Créneau et confirmation'].map((s, i) => (
      <div key={s} style={{
        flex: 1, padding: '7px 12px', borderRadius: 6, textAlign: 'center',
        background: current === i + 1 ? 'var(--primary)' : 'var(--surface-2)',
        color: current === i + 1 ? '#fff' : 'var(--text-muted)',
        border: '1px solid var(--border)', fontWeight: current === i + 1 ? 600 : 400,
      }}>{i + 1}. {s}</div>
    ))}
  </div>
);

/* ------------------------------- Étape 1 -------------------------------- */
function StepPatient({ onPick }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setItems([]); return; }
    setLoading(true);
    const t = setTimeout(() => {
      api.patients({ q, limit: 12 })
        .then((d) => setItems(d.items))
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  if (creating) return <QuickCreate onCreated={onPick} onCancel={() => setCreating(false)} />;

  return (
    <>
      <Field label="Rechercher un patient"
             help="Nom, prénom, identifiant, téléphone ou date de naissance (JJ/MM/AAAA)">
        <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
               placeholder="Ex. Dupont, P-2026-000001, 12/03/1979…" />
      </Field>

      {loading && <div className="muted small">Recherche…</div>}

      {items.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <table>
            <thead><tr><th>Patient</th><th>Naissance</th><th>Téléphone</th><th></th></tr></thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => onPick(p)}>
                  <td>
                    <strong>{fmtName(p.last_name, p.first_name)}</strong>
                    <div className="muted small">{p.mrn}</div>
                  </td>
                  <td>{new Date(p.birth_date).toLocaleDateString('fr-FR')}
                    <span className="muted small"> ({age(p.birth_date)} ans)</span></td>
                  <td className="muted">{p.phone_mobile || '—'}</td>
                  <td>{Number(p.no_show_count) >= 3 &&
                    <span className="badge red">{p.no_show_count} absences</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {q.trim().length >= 2 && !loading && items.length === 0 && (
        <Empty icon="🔍" text="Aucun patient trouvé."
               action={<button className="btn primary" onClick={() => setCreating(true)}>
                 Créer un nouveau patient</button>} />
      )}

      <button className="btn" onClick={() => setCreating(true)}>+ Nouveau patient</button>
    </>
  );
}

function QuickCreate({ onCreated, onCancel }) {
  const [f, setF] = useState({ lastName: '', firstName: '', birthDate: '', phoneMobile: '', sex: 'U' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { onCreated(await api.createPatient(f)); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit}>
      <div className="alert info">
        <span>ⓘ</span>
        <div>Saisie minimale : la fiche pourra être complétée plus tard.</div>
      </div>
      <ErrorAlert error={error} />
      <div className="row">
        <Field label="Nom" error={error?.details?.lastName}>
          <input value={f.lastName} onChange={set('lastName')} required autoFocus /></Field>
        <Field label="Prénom" error={error?.details?.firstName}>
          <input value={f.firstName} onChange={set('firstName')} required /></Field>
      </div>
      <div className="row">
        <Field label="Date de naissance" error={error?.details?.birthDate}>
          <input type="date" value={f.birthDate} onChange={set('birthDate')} required /></Field>
        <Field label="Sexe">
          <select value={f.sex} onChange={set('sex')}>
            <option value="U">Non précisé</option><option value="F">Féminin</option>
            <option value="M">Masculin</option>
          </select></Field>
        <Field label="Téléphone mobile" error={error?.details?.phoneMobile}>
          <input value={f.phoneMobile} onChange={set('phoneMobile')} placeholder="06 12 34 56 78" /></Field>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onCancel}>Retour</button>
        <button className="btn primary" disabled={busy}>Créer et continuer</button>
      </div>
    </form>
  );
}

/* ------------------------------- Étape 2 -------------------------------- */
function StepSlot({ patient, refs, initial, onBack, onCreated }) {
  const [typeId, setTypeId] = useState(refs.types[0]?.id || '');
  const [practId, setPractId] = useState('');
  const [from, setFrom] = useState(toISODate(new Date()));
  const [slots, setSlots] = useState(null);
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const type = refs.types.find((t) => t.id === typeId);

  // Praticiens compatibles avec la spécialité du type choisi
  const eligible = useMemo(() => {
    if (!type?.specialty_label) return refs.practitioners;
    const m = refs.practitioners.filter((p) =>
      (p.specialties || []).includes(type.specialty_label));
    return m.length ? m : refs.practitioners;
  }, [type, refs.practitioners]);

  useEffect(() => {
    if (!eligible.find((p) => p.id === practId)) setPractId(eligible[0]?.id || '');
  }, [eligible, practId]);

  useEffect(() => {
    if (!practId || !typeId) return;
    setSlots(null); setSelected(null);
    const to = toISODate(new Date(new Date(from).getTime() + 28 * 864e5));
    api.slots({ practitionerId: practId, appointmentTypeId: typeId, from, to })
      .then((d) => setSlots(d.slots))
      .catch((e) => { setError(e); setSlots([]); });
  }, [practId, typeId, from]);

  const byDay = useMemo(() => {
    const m = new Map();
    for (const s of slots || []) {
      const k = toISODate(new Date(s.start));
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return [...m.entries()].slice(0, 8);
  }, [slots]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const a = await api.createAppointment({
        patientId: patient.id, practitionerId: practId, appointmentTypeId: typeId,
        startAt: selected.start, reason,
      });
      onCreated(a);
    } catch (e) {
      setError(e);
      // En cas de collision, on recharge immédiatement les créneaux disponibles
      if (e.code?.startsWith('SLOT_')) {
        toast.error('Ce créneau vient d\'être pris. Liste actualisée.');
        const to = toISODate(new Date(new Date(from).getTime() + 28 * 864e5));
        api.slots({ practitionerId: practId, appointmentTypeId: typeId, from, to })
          .then((d) => { setSlots(d.slots); setSelected(null); });
      }
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 14, background: 'var(--surface-2)' }}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <strong>{fmtName(patient?.last_name, patient?.first_name)}</strong>
            <div className="muted small">
              {patient?.mrn} · {age(patient?.birth_date)} ans · ☎ {patient?.phone_mobile || '—'}
            </div>
          </div>
          <button className="btn sm" onClick={onBack}>Changer de patient</button>
        </div>
      </div>

      <ErrorAlert error={error} />

      <div className="row">
        <Field label="Type de rendez-vous">
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {refs.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} ({t.default_duration_minutes} min)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Praticien">
          <select value={practId} onChange={(e) => setPractId(e.target.value)}>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>Dr {p.last_name} {p.first_name}</option>
            ))}
          </select>
        </Field>
        <Field label="À partir du">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
      </div>

      <label style={{ marginTop: 6 }}>Créneaux disponibles</label>
      <div className="card" style={{ padding: 12, maxHeight: 280, overflowY: 'auto',
                                     marginBottom: 12 }}>
        {slots === null ? <Spinner label="Recherche des créneaux…" />
          : byDay.length === 0 ? (
            <Empty icon="📅" text="Aucun créneau disponible sur cette période." />
          ) : byDay.map(([day, list]) => (
            <div className="slot-day" key={day}>
              <div className="d">
                {new Date(day).toLocaleDateString('fr-FR',
                  { weekday: 'long', day: 'numeric', month: 'long' })}
                <span className="muted small" style={{ fontWeight: 400 }}> · {list.length} libres</span>
              </div>
              <div className="slot-list">
                {list.slice(0, 14).map((s) => (
                  <button key={s.start}
                    className={`slot-btn ${selected?.start === s.start ? 'selected' : ''}`}
                    onClick={() => setSelected(s)}>{fmtTime(s.start)}</button>
                ))}
                {list.length > 14 && <span className="muted small"
                  style={{ alignSelf: 'center' }}>+{list.length - 14}</span>}
              </div>
            </div>
          ))}
      </div>

      <Field label="Motif de consultation">
        <input value={reason} onChange={(e) => setReason(e.target.value)}
               placeholder="Ex. suivi post-opératoire" />
      </Field>

      {type?.preparation_instructions && (
        <div className="alert info"><span>ⓘ</span><div>{type.preparation_instructions}</div></div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" onClick={onBack}>Retour</button>
        <button className="btn primary" disabled={!selected || busy} onClick={submit}>
          {busy ? <span className="spinner" /> :
            selected ? `Valider — ${new Date(selected.start).toLocaleDateString('fr-FR')} à ${fmtTime(selected.start)}`
                     : 'Choisissez un créneau'}
        </button>
      </div>
    </>
  );
}
