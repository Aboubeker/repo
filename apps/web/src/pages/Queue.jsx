import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorAlert, fmtTime, fmtName, can, useToast, toISODate } from '../lib.jsx';
import { AppointmentDetail } from './Calendar.jsx';

const COLUMNS = [
  { key: 'expected',   title: 'Attendus',        next: ['CHECKED_IN', 'Enregistrer l\'arrivée'] },
  { key: 'waiting',    title: 'En salle d\'attente', next: ['IN_PROGRESS', 'Appeler'] },
  { key: 'inProgress', title: 'En consultation', next: ['COMPLETED', 'Terminer'] },
  { key: 'done',       title: 'Terminés',        next: null },
];

export default function Queue({ user, go }) {
  const [date, setDate] = useState(toISODate(new Date()));
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const toast = useToast();

  const load = useCallback(() => {
    api.queue(date).then(setD).catch(setError);
  }, [date]);

  useEffect(() => { setD(null); load(); }, [load]);
  // Le tableau reflète l'activité en direct de plusieurs postes
  useEffect(() => {
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const advance = async (a, status) => {
    setBusyId(a.id);
    try {
      await api.setStatus(a.id, { status, version: a.version });
      toast.success('Statut mis à jour.');
      load();
    } catch (e) { toast.error(e.message); } finally { setBusyId(null); }
  };

  const noShow = async (a) => {
    setBusyId(a.id);
    try {
      await api.setStatus(a.id, { status: 'NO_SHOW', version: a.version });
      toast.info('Patient marqué absent.');
      load();
    } catch (e) { toast.error(e.message); } finally { setBusyId(null); }
  };

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  const now = new Date();

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                 style={{ width: 160 }} />
          <button className="btn sm" onClick={() => setDate(toISODate(new Date()))}>Aujourd'hui</button>
          <div className="spacer" />
          <span className="badge green">● temps réel</span>
          <span className="muted small">
            {d.absent.length} absent(s) · {d.cancelled.length} annulé(s)
          </span>
          <button className="btn sm" onClick={() => window.print()}>🖨 Liste</button>
        </div>
      </div>

      <div className="queue">
        {COLUMNS.map((col) => {
          const items = d[col.key] || [];
          return (
            <div className="queue-col" key={col.key}>
              <h4>
                <span>{col.title}</span>
                <span className="badge gray">{items.length}</span>
              </h4>
              <div className="items">
                {items.length === 0 && (
                  <div className="muted small" style={{ padding: 12, textAlign: 'center' }}>—</div>
                )}
                {items.map((a) => {
                  const start = new Date(a.start_at);
                  const lateMin = Math.round((now - start) / 60000);
                  const late = col.key === 'expected' && lateMin > 10;
                  const waitMin = a.checked_in_at
                    ? Math.round((now - new Date(a.checked_in_at)) / 60000) : null;
                  return (
                    <div key={a.id} className={`queue-card ${late ? 'late' : ''}`}>
                      <div className="h">
                        <span className="nm">{fmtName(a.patient_last_name, a.patient_first_name)}</span>
                        <span className="tm">{fmtTime(a.start_at)}</span>
                      </div>
                      <div className="meta">
                        Dr {a.practitioner_last_name}
                        {a.room_code && ` · ${a.room_code}`}
                        {a.type_label && ` · ${a.type_label}`}
                      </div>
                      {Number(a.critical_allergy_count) > 0 && (
                        <div className="badge red" style={{ marginTop: 4 }}>⚠ allergie critique</div>
                      )}
                      {late && <div className="badge red" style={{ marginTop: 4 }}>
                        retard {lateMin} min</div>}
                      {col.key === 'waiting' && waitMin > 0 && (
                        <div className={`badge ${waitMin > 20 ? 'orange' : 'gray'}`}
                             style={{ marginTop: 4 }}>attend {waitMin} min</div>
                      )}
                      {col.key === 'done' && Number(a.outstanding_balance) > 0 && (
                        <div className="badge orange" style={{ marginTop: 4 }}>à encaisser</div>
                      )}

                      <div className="acts">
                        {can(user, 'appointment.write') && col.next && (
                          <button className="btn primary sm" disabled={busyId === a.id}
                                  onClick={() => advance(a, col.next[0])}>{col.next[1]}</button>
                        )}
                        {can(user, 'appointment.write') && col.key === 'expected' && late && (
                          <button className="btn sm" disabled={busyId === a.id}
                                  onClick={() => noShow(a)}>Absent</button>
                        )}
                        <button className="btn ghost sm" onClick={() => setDetailId(a.id)}>Détail</button>
                        <button className="btn ghost sm"
                                onClick={() => go('patient', a.patient_id)}>Dossier</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {(d.absent.length > 0 || d.cancelled.length > 0) && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-head"><h3>Absences et annulations</h3></div>
          <div className="card-body tight">
            <table>
              <thead><tr><th>Heure</th><th>Patient</th><th>Téléphone</th>
                <th>Praticien</th><th>Statut</th><th>Motif</th></tr></thead>
              <tbody>
                {[...d.absent, ...d.cancelled].map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => go('patient', a.patient_id)}>
                    <td className="num">{fmtTime(a.start_at)}</td>
                    <td>{fmtName(a.patient_last_name, a.patient_first_name)}</td>
                    <td className="muted">{a.patient_phone || '—'}</td>
                    <td className="muted">Dr {a.practitioner_last_name}</td>
                    <td><span className={`badge ${a.status === 'NO_SHOW' ? 'red' : 'gray'}`}>
                      {a.status === 'NO_SHOW' ? 'Absent' : 'Annulé'}</span></td>
                    <td className="muted small">{a.cancellation_reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {detailId && <AppointmentDetail id={detailId} user={user} go={go}
        onClose={() => setDetailId(null)}
        onChanged={() => { setDetailId(null); load(); }} />}
    </>
  );
}
