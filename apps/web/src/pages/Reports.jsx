import React, { useEffect, useState } from 'react';
import { api, getToken } from '../api.js';
import { Spinner, Empty, Stat, Bar, ErrorAlert, fmtMoney, fmtDate, useToast } from '../lib.jsx';

const PRESETS = [
  ['7 jours', 7], ['30 jours', 30], ['90 jours', 90], ['12 mois', 365],
];
const iso = (d) => d.toISOString().slice(0, 10);

export default function Reports() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 864e5)));
  const [to, setTo] = useState(iso(new Date()));
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const toast = useToast();

  const load = () => {
    setD(null); setError(null);
    const p = { from, to };
    Promise.all([
      api.overview(p), api.occupancy(p), api.hourly(p),
      api.bySpecialty(p), api.roomsReport(p), api.daily(p),
    ]).then(([overview, occupancy, hourly, specialty, rooms, daily]) =>
      setD({ overview, occupancy: occupancy.items, hourly: hourly.items,
             specialty: specialty.items, rooms: rooms.items, daily: daily.items }))
      .catch(setError);
  };
  useEffect(load, [from, to]);

  const exportCsv = async () => {
    try {
      const res = await fetch(api.exportUrl({ from, to }), {
        headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('Export impossible');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `rendez-vous_${from}_${to}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success('Export CSV enregistré sur ce poste (tracé dans le journal d\'audit).');
    } catch (e) { toast.error(e.message); }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <label className="muted small">Du</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 style={{ width: 150 }} />
          <label className="muted small">au</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                 style={{ width: 150 }} />
          {PRESETS.map(([label, days]) => (
            <button key={days} className="btn sm" onClick={() => {
              setFrom(iso(new Date(Date.now() - days * 864e5))); setTo(iso(new Date()));
            }}>{label}</button>
          ))}
          <div className="spacer" />
          <button className="btn sm" onClick={() => window.print()}>🖨 Imprimer</button>
          <button className="btn primary sm" onClick={exportCsv}>⬇ Export CSV</button>
        </div>
      </div>

      <ErrorAlert error={error} />
      {!d ? <Spinner /> : (
        <>
          <div className="grid c4" style={{ marginBottom: 14 }}>
            <Stat label="Rendez-vous" value={d.overview.appointments.total} accent="blue"
                  hint={`${d.overview.appointments.completed} honorés`} />
            <Stat label="Taux d'absence" value={`${d.overview.noShowRate} %`}
                  accent={d.overview.noShowRate > 10 ? 'red' : 'green'}
                  hint={`${d.overview.appointments.no_show} absences`} />
            <Stat label="Chiffre d'affaires" value={fmtMoney(d.overview.finance.revenue)}
                  accent="purple" hint={`${fmtMoney(d.overview.finance.collected)} encaissés`} />
            <Stat label="Encours" value={fmtMoney(d.overview.finance.outstanding)} accent="orange" />
          </div>

          <div className="grid c4" style={{ marginBottom: 14 }}>
            <Stat label="Délai moyen d'obtention"
                  value={d.overview.avgLeadDays != null ? `${d.overview.avgLeadDays} j` : '—'} />
            <Stat label="Durée moyenne de consultation"
                  value={d.overview.avgDurationMinutes != null
                    ? `${d.overview.avgDurationMinutes} min` : '—'} />
            <Stat label="Attente moyenne en salle"
                  value={d.overview.avgWaitMinutes != null
                    ? `${d.overview.avgWaitMinutes} min` : '—'} />
            <Stat label="Taux d'annulation" value={`${d.overview.cancelledRate} %`} />
          </div>

          <div className="grid c2">
            <div className="card">
              <div className="card-head"><h3>Occupation par praticien</h3></div>
              <div className="card-body">
                {d.occupancy.length === 0 ? <Empty text="Aucune donnée." /> : d.occupancy.map((o) => (
                  <div key={o.id} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                      <span>Dr {o.last_name} <span className="muted">
                        ({o.appointments} RDV)</span></span>
                      <strong>{o.occupancy_rate} %</strong>
                    </div>
                    <Bar value={Math.min(o.occupancy_rate, 100)}
                         color={o.occupancy_rate > 90 ? 'var(--danger)'
                              : o.occupancy_rate > 60 ? 'var(--success)' : 'var(--warning)'} />
                    <div className="muted small">
                      {Math.round(o.booked_minutes / 60)} h réservées sur
                      {' '}{Math.round(o.capacity_minutes / 60)} h ouvrables</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-head"><h3>Répartition horaire</h3></div>
              <div className="card-body">
                {(() => {
                  const max = Math.max(1, ...d.hourly.map((h) => h.appointments));
                  return (
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 190 }}>
                      {d.hourly.map((h) => (
                        <div key={h.hour} style={{ flex: 1, textAlign: 'center' }}
                             title={`${h.appointments} RDV`}>
                          <div style={{ height: `${(h.appointments / max) * 150}px`,
                                        background: 'var(--primary)', borderRadius: '3px 3px 0 0',
                                        minHeight: 2 }} />
                          <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>{h.hour}h</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <div className="muted small" style={{ marginTop: 8 }}>
                  Identifie les heures creuses pour ajuster les plages de disponibilité.
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-head"><h3>Activité par spécialité</h3></div>
              <div className="card-body tight">
                <table>
                  <thead><tr><th>Spécialité</th><th className="num">RDV</th>
                    <th className="num">Honorés</th><th className="num">Part</th></tr></thead>
                  <tbody>
                    {d.specialty.map((s) => {
                      const total = d.specialty.reduce((a, x) => a + x.appointments, 0) || 1;
                      return (
                        <tr key={s.specialty}>
                          <td>{s.specialty}</td>
                          <td className="num">{s.appointments}</td>
                          <td className="num muted">{s.completed}</td>
                          <td className="num">{Math.round(s.appointments / total * 100)} %</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="card-head"><h3>Occupation des salles</h3></div>
              <div className="card-body tight">
                <table>
                  <thead><tr><th>Salle</th><th className="num">Réservations</th>
                    <th className="num">Heures</th></tr></thead>
                  <tbody>
                    {d.rooms.map((r) => (
                      <tr key={r.code}>
                        <td><strong>{r.code}</strong> <span className="muted">{r.label}</span></td>
                        <td className="num">{r.bookings}</td>
                        <td className="num">{Math.round(r.booked_minutes / 60)} h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-head"><h3>Évolution quotidienne</h3></div>
            <div className="card-body">
              {(() => {
                const max = Math.max(1, ...d.daily.map((x) => x.total));
                return (
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 170 }}>
                    {d.daily.map((x) => (
                      <div key={x.day} style={{ flex: 1, minWidth: 3 }}
                           title={`${fmtDate(x.day)} — ${x.total} RDV, ${x.no_show} absences`}>
                        <div style={{ height: `${(x.total / max) * 140}px`,
                                      background: 'var(--primary)', minHeight: 2,
                                      borderRadius: '2px 2px 0 0' }} />
                        <div style={{ height: `${(x.no_show / max) * 140}px`,
                                      background: 'var(--danger)' }} />
                      </div>
                    ))}
                  </div>
                );
              })()}
              <div className="muted small" style={{ marginTop: 8 }}>
                Barre bleue : rendez-vous programmés · rouge : absences.
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
