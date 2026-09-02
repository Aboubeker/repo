import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, Empty, Modal, Field, ErrorAlert, Bar,
         fmtDate, fmtTime, can, useToast } from '../lib.jsx';

const DAYS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const REASONS = { LEAVE: 'Congés', SICK: 'Maladie', TRAINING: 'Formation',
                  SURGERY: 'Bloc opératoire', OTHER: 'Autre' };

export default function Practitioners({ user }) {
  const [list, setList] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { api.practitioners().then((d) => setList(d.items)).catch(setError); }, []);

  if (error) return <ErrorAlert error={error} />;
  if (!list) return <Spinner />;
  if (selected) return <Detail id={selected} user={user} onBack={() => setSelected(null)} />;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Praticiens</h3>
        <div className="spacer" />
        <span className="muted small">{list.length} praticien(s) actif(s)</span>
      </div>
      <div className="card-body tight">
        <table>
          <thead><tr><th>Code</th><th>Nom</th><th>Spécialités</th>
            <th>Bureau</th><th>Créneau</th><th>Contact</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => setSelected(p.id)}>
                <td className="muted small">{p.code}</td>
                <td>
                  <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2,
                                 background: p.color, marginRight: 7 }} />
                  <strong>{p.title} {p.last_name} {p.first_name}</strong>
                </td>
                <td className="muted">{(p.specialties || []).join(', ') || '—'}</td>
                <td className="muted small">{p.office_room_code || '—'}</td>
                <td className="muted small">{p.default_slot_minutes} min</td>
                <td className="muted small">{p.phone || p.email || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Detail({ id, user, onBack }) {
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('availability');
  const [error, setError] = useState(null);
  const [addRule, setAddRule] = useState(false);
  const [addAbsence, setAddAbsence] = useState(false);
  const [preview, setPreview] = useState(null);
  const toast = useToast();

  const load = () => api.practitioner(id).then(setD).catch(setError);
  useEffect(() => { setD(null); load(); }, [id]);

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  const p = d.practitioner;
  const editable = can(user, 'practitioner.write');
  const weeklyMinutes = d.availabilityRules.reduce((s, r) => {
    const [h1, m1] = r.start_time.split(':').map(Number);
    const [h2, m2] = r.end_time.split(':').map(Number);
    return s + (h2 * 60 + m2 - h1 * 60 - m1);
  }, 0);

  const removeRule = async (rid) => {
    try { await api.deleteAvailability(id, rid); toast.success('Plage supprimée.'); load(); }
    catch (e) { toast.error(e.message); }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <button className="btn ghost sm" onClick={onBack}>◂ Praticiens</button>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 17 }}>{p.title} {p.last_name} {p.first_name}</h3>
            <div className="muted small">
              {(d.specialties || []).map((s) => s.label).join(', ')} · {p.code}
              {p.registration_number && ` · N° ${p.registration_number}`}
            </div>
          </div>
        </div>
        <div style={{ padding: '0 16px' }}>
          <div className="tabs" style={{ marginBottom: 0 }}>
            <button className={tab === 'availability' ? 'active' : ''}
                    onClick={() => setTab('availability')}>Disponibilités</button>
            <button className={tab === 'absences' ? 'active' : ''}
                    onClick={() => setTab('absences')}>Absences ({d.absences.length})</button>
            <button className={tab === 'stats' ? 'active' : ''}
                    onClick={() => setTab('stats')}>Activité</button>
          </div>
        </div>
      </div>

      {tab === 'availability' && (
        <div className="card">
          <div className="card-head">
            <h3>Règles hebdomadaires</h3>
            <div className="spacer" />
            <span className="muted small">
              Capacité théorique {Math.round(weeklyMinutes / 60)} h/semaine ·
              {' '}~{Math.floor(weeklyMinutes / p.default_slot_minutes)} RDV
            </span>
            <button className="btn sm" onClick={async () => {
              try {
                setPreview(await api.previewSlots(id, {
                  from: new Date().toISOString().slice(0, 10),
                  to: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
                }));
              } catch (e) { toast.error(e.message); }
            }}>Aperçu 14 jours</button>
            {editable && <button className="btn primary sm"
              onClick={() => setAddRule(true)}>+ Ajouter une plage</button>}
          </div>
          <div className="card-body tight">
            {d.availabilityRules.length === 0
              ? <Empty icon="📅" text="Aucune disponibilité déclarée : ce praticien n'est pas réservable." />
              : (
                <table>
                  <thead><tr><th>Jour</th><th>Horaires</th><th>Salle</th><th>Créneau</th>
                    <th>Type dédié</th><th>Validité</th>{editable && <th></th>}</tr></thead>
                  <tbody>
                    {d.availabilityRules.map((r) => (
                      <tr key={r.id}>
                        <td><strong>{DAYS[r.weekday]}</strong></td>
                        <td className="num">{r.start_time.slice(0, 5)} – {r.end_time.slice(0, 5)}</td>
                        <td className="muted">{r.room_code || '—'}</td>
                        <td className="muted small">
                          {r.slot_minutes || p.default_slot_minutes} min</td>
                        <td className="muted small">{r.type_label || 'Tous'}</td>
                        <td className="muted small">
                          {fmtDate(r.valid_from)} → {r.valid_to ? fmtDate(r.valid_to) : '∞'}</td>
                        {editable && <td>
                          <button className="btn ghost sm"
                                  onClick={() => removeRule(r.id)}>🗑</button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
          {preview && (
            <div style={{ padding: 16, borderTop: '1px solid var(--border)' }}>
              <strong>{preview.count}</strong> créneaux réservables sur les 14 prochains jours.
            </div>
          )}
        </div>
      )}

      {tab === 'absences' && (
        <div className="card">
          <div className="card-head">
            <h3>Absences à venir</h3>
            <div className="spacer" />
            {editable && <button className="btn primary sm"
              onClick={() => setAddAbsence(true)}>+ Déclarer une absence</button>}
          </div>
          <div className="card-body tight">
            {d.absences.length === 0 ? <Empty icon="✓" text="Aucune absence programmée." /> : (
              <table>
                <thead><tr><th>Du</th><th>Au</th><th>Motif</th><th>Commentaire</th></tr></thead>
                <tbody>
                  {d.absences.map((a) => (
                    <tr key={a.id}>
                      <td>{fmtDate(a.start_at)} {fmtTime(a.start_at)}</td>
                      <td>{fmtDate(a.end_at)} {fmtTime(a.end_at)}</td>
                      <td><span className="badge orange">{REASONS[a.reason] || a.reason}</span></td>
                      <td className="muted small">{a.comment || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'stats' && (
        <div className="grid c4">
          <div className="stat accent-green">
            <div className="label">Consultations (90 j)</div>
            <div className="value">{d.stats.completed}</div></div>
          <div className="stat accent-blue">
            <div className="label">À venir</div>
            <div className="value">{d.stats.upcoming}</div></div>
          <div className="stat accent-red">
            <div className="label">Absences patients</div>
            <div className="value">{d.stats.no_show}</div>
            <div className="hint">{d.stats.completed
              ? `${Math.round(d.stats.no_show / (d.stats.completed + d.stats.no_show) * 100)}%`
              : '—'}</div></div>
          <div className="stat accent-orange">
            <div className="label">Annulations</div>
            <div className="value">{d.stats.cancelled}</div></div>
        </div>
      )}

      {addRule && <AddRule practitionerId={id} onClose={() => setAddRule(false)}
        onDone={() => { setAddRule(false); load(); }} />}
      {addAbsence && <AddAbsence practitionerId={id} onClose={() => setAddAbsence(false)}
        onDone={() => { setAddAbsence(false); load(); }} />}
    </>
  );
}

function AddRule({ practitionerId, onClose, onDone }) {
  const [f, setF] = useState({ weekday: 1, startTime: '08:00', endTime: '12:00', slotMinutes: '' });
  const [rooms, setRooms] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { api.rooms().then((d) => setRooms(d.items)).catch(() => {}); }, []);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api.addAvailability(practitionerId, {
        ...f, weekday: Number(f.weekday),
        slotMinutes: f.slotMinutes ? Number(f.slotMinutes) : undefined,
      });
      toast.success('Plage ajoutée.');
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title="Nouvelle plage de disponibilité" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={busy} onClick={submit}>Ajouter</button>
      </>
    }>
      <ErrorAlert error={error} />
      <div className="row">
        <Field label="Jour de la semaine">
          <select value={f.weekday} onChange={set('weekday')}>
            {DAYS.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
          </select></Field>
        <Field label="Début"><input type="time" value={f.startTime} onChange={set('startTime')} /></Field>
        <Field label="Fin"><input type="time" value={f.endTime} onChange={set('endTime')} /></Field>
      </div>
      <div className="row">
        <Field label="Salle">
          <select value={f.roomId || ''} onChange={set('roomId')}>
            <option value="">Bureau par défaut</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.label}</option>)}
          </select></Field>
        <Field label="Durée de créneau" help="Vide = durée par défaut du praticien">
          <input type="number" min={5} max={240} step={5}
                 value={f.slotMinutes} onChange={set('slotMinutes')} placeholder="20" /></Field>
      </div>
    </Modal>
  );
}

function AddAbsence({ practitionerId, onClose, onDone }) {
  const [f, setF] = useState({ startAt: '', endAt: '', reason: 'LEAVE', comment: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [impacted, setImpacted] = useState(null);
  const toast = useToast();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.addAbsence(practitionerId, {
        startAt: new Date(f.startAt).toISOString(),
        endAt: new Date(f.endAt).toISOString(),
        reason: f.reason, comment: f.comment,
      });
      if (r.impactedAppointments.length) {
        setImpacted(r.impactedAppointments);
        toast.error(`${r.impactedAppointments.length} rendez-vous à replanifier.`);
      } else {
        toast.success('Absence enregistrée.');
        onDone();
      }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (impacted) return (
    <Modal title="Rendez-vous impactés" onClose={onDone} wide footer={
      <button className="btn primary" onClick={onDone}>J'ai pris connaissance</button>
    }>
      <div className="alert warning">
        <span>⚠</span>
        <div>L'absence est enregistrée. Ces {impacted.length} rendez-vous doivent être
          replanifiés ou annulés, et les patients prévenus.</div>
      </div>
      <table>
        <thead><tr><th>Référence</th><th>Date</th><th>Patient</th><th>Téléphone</th></tr></thead>
        <tbody>
          {impacted.map((a) => (
            <tr key={a.id}>
              <td className="small">{a.reference}</td>
              <td>{fmtDate(a.start_at)} {fmtTime(a.start_at)}</td>
              <td>{a.patient_last_name} {a.patient_first_name}</td>
              <td className="muted">{a.patient_phone || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn sm" style={{ marginTop: 12 }}
              onClick={() => window.print()}>🖨 Imprimer la liste d'appels</button>
    </Modal>
  );

  return (
    <Modal title="Déclarer une absence" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={!f.startAt || !f.endAt || busy}
                onClick={submit}>Enregistrer</button>
      </>
    }>
      <ErrorAlert error={error} />
      <div className="row">
        <Field label="Du"><input type="datetime-local" value={f.startAt}
                                 onChange={set('startAt')} /></Field>
        <Field label="Au"><input type="datetime-local" value={f.endAt}
                                 onChange={set('endAt')} /></Field>
      </div>
      <Field label="Motif">
        <select value={f.reason} onChange={set('reason')}>
          {Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></Field>
      <Field label="Commentaire"><input value={f.comment} onChange={set('comment')} /></Field>
      <div className="alert info">
        <span>ⓘ</span>
        <div>Les créneaux concernés cesseront immédiatement d'être proposés.
          Les rendez-vous déjà pris vous seront listés pour replanification.</div>
      </div>
    </Modal>
  );
}
