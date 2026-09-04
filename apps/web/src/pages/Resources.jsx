import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, Empty, ErrorAlert, fmtTime, fmtName, toISODate } from '../lib.jsx';

const KIND = { CONSULTATION: 'Consultation', PROCEDURE: 'Acte technique', IMAGING: 'Imagerie',
               LAB: 'Laboratoire', SURGERY: 'Chirurgie', WAITING: 'Salle d\'attente' };
const EQ_STATUS = { AVAILABLE: ['Disponible', 'green'], IN_MAINTENANCE: ['En maintenance', 'orange'],
                    OUT_OF_ORDER: ['Hors service', 'red'], RETIRED: ['Retiré', 'gray'] };

export default function Resources() {
  const [tab, setTab] = useState('rooms');
  const [rooms, setRooms] = useState(null);
  const [equipment, setEquipment] = useState(null);
  const [error, setError] = useState(null);
  const [scheduleRoom, setScheduleRoom] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [date, setDate] = useState(toISODate(new Date()));

  useEffect(() => {
    api.rooms().then((d) => setRooms(d.items)).catch(setError);
    api.equipment().then((d) => setEquipment(d.items)).catch(setError);
  }, []);

  useEffect(() => {
    if (!scheduleRoom) return;
    setSchedule(null);
    api.roomSchedule(scheduleRoom.id, date).then((d) => setSchedule(d.items)).catch(setError);
  }, [scheduleRoom, date]);

  if (error) return <ErrorAlert error={error} />;

  return (
    <>
      <div className="tabs">
        <button className={tab === 'rooms' ? 'active' : ''} onClick={() => setTab('rooms')}>
          Salles {rooms && `(${rooms.length})`}</button>
        <button className={tab === 'equipment' ? 'active' : ''} onClick={() => setTab('equipment')}>
          Équipements {equipment && `(${equipment.length})`}</button>
      </div>

      {tab === 'rooms' && (
        <div className="grid sidebar-right">
          <div className="card">
            <div className="card-head"><h3>Salles</h3></div>
            <div className="card-body tight">
              {!rooms ? <Spinner /> : (
                <table>
                  <thead><tr><th>Code</th><th>Libellé</th><th>Type</th>
                    <th>Étage</th><th className="num">Capacité</th>
                    <th className="num">RDV (24 h)</th><th></th></tr></thead>
                  <tbody>
                    {rooms.map((r) => (
                      <tr key={r.id} className="clickable" onClick={() => setScheduleRoom(r)}>
                        <td><strong>{r.code}</strong></td>
                        <td>{r.label}</td>
                        <td className="muted small">{KIND[r.kind] || r.kind}</td>
                        <td className="muted small">{r.floor || '—'}</td>
                        <td className="num muted">{r.capacity}</td>
                        <td className="num">
                          {r.bookings_today > 0
                            ? <span className="badge blue">{r.bookings_today}</span>
                            : <span className="muted">0</span>}</td>
                        <td><button className="btn ghost sm">Planning</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>{scheduleRoom ? `Planning — ${scheduleRoom.code}` : 'Planning de salle'}</h3>
            </div>
            <div className="card-body">
              {!scheduleRoom ? (
                <div className="muted small">Sélectionnez une salle pour afficher son occupation.</div>
              ) : (
                <>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                         style={{ marginBottom: 12 }} />
                  {!schedule ? <Spinner /> : schedule.length === 0 ? (
                    <Empty icon="✓" text="Salle libre toute la journée." />
                  ) : (
                    <div style={{ display: 'grid', gap: 7 }}>
                      {schedule.map((s, i) => (
                        <div key={i} style={{ padding: 8, border: '1px solid var(--border)',
                                              borderRadius: 6, fontSize: 12.5 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <strong>{fmtTime(s.start_at)} – {fmtTime(s.end_at)}</strong>
                            <span className="muted">{s.reference}</span>
                          </div>
                          <div className="muted">
                            {fmtName(s.patient_last_name, '')} · Dr {s.practitioner_last_name}
                          </div>
                          <div className="muted small">{s.type_label}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'equipment' && (
        <div className="card">
          <div className="card-head"><h3>Équipements</h3></div>
          <div className="card-body tight">
            {!equipment ? <Spinner /> : equipment.length === 0
              ? <Empty icon="🔧" text="Aucun équipement enregistré." /> : (
              <table>
                <thead><tr><th>Code</th><th>Libellé</th><th>Type</th><th>Salle</th>
                  <th>État</th><th>Prochaine maintenance</th></tr></thead>
                <tbody>
                  {equipment.map((e) => {
                    const [label, cls] = EQ_STATUS[e.status] || [e.status, 'gray'];
                    return (
                      <tr key={e.id}>
                        <td><strong>{e.code}</strong></td>
                        <td>{e.label}</td>
                        <td className="muted small">{e.kind || '—'}</td>
                        <td className="muted small">{e.room_code || 'mobile'}</td>
                        <td><span className={`badge ${cls}`}>{label}</span></td>
                        <td className="muted small">
                          {e.next_maintenance_on
                            ? new Date(e.next_maintenance_on).toLocaleDateString('fr-FR') : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}
