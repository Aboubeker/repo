import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Stat, Spinner, Badge, fmtTime, fmtMoney, fmtName, can, Empty, Bar } from '../lib.jsx';

export default function Dashboard({ user, go, onNewAppt }) {
  // Repli sur les rappels de navigation : cette page peut être montée
  // hors de App.jsx. Un appel sur une prop absente ferait tomber tout
  // l'écran en « is not a function ».
  go = go || (() => {});
  onNewAppt = onNewAppt || (() => {});
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const [queue, occ, outstanding, waiting] = await Promise.all([
          api.queue(today),
          can(user, 'report.read') ? api.occupancy({ from: today, to: today }) : { items: [] },
          can(user, 'billing.read') ? api.outstanding() : { items: [] },
          can(user, 'appointment.read') ? api.waitingList() : { items: [] },
        ]);
        if (alive) setData({ queue, occ, outstanding, waiting });
      } catch (e) { if (alive) setError(e); }
    })();
    return () => { alive = false; };
  }, [user]);

  if (error) return <div className="alert error">⚠ {error.message}</div>;
  if (!data) return <Spinner />;

  const { queue, occ, outstanding, waiting } = data;
  const next = [...queue.expected]
    .filter((a) => new Date(a.start_at) >= new Date())
    .slice(0, 8);
  const total = queue.expected.length + queue.waiting.length +
                queue.inProgress.length + queue.done.length + queue.absent.length;
  const unpaidToday = queue.done.filter((a) => Number(a.outstanding_balance) > 0);

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, textTransform: 'capitalize' }}>
          {new Date().toLocaleDateString('fr-FR',
            { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </div>
        <div className="muted small">Bonjour {user.fullName.split(' ')[0]}, voici votre journée.</div>
      </div>

      <div className="grid c5" style={{ marginBottom: 16 }}>
        <Stat label="Rendez-vous du jour" value={total} accent="teal"
              onClick={() => go('calendar')} title="Ouvrir l'agenda" />
        <Stat label="En salle d'attente" value={queue.waiting.length} accent="green"
              hint={queue.waiting.length ? 'à appeler' : 'personne en attente'}
              onClick={() => go('queue')} title="Ouvrir la file d'attente" />
        <Stat label="En consultation" value={queue.inProgress.length} accent="orange"
              onClick={() => go('queue')} title="Ouvrir la file d'attente" />
        <Stat label="Terminés" value={queue.done.length} accent="green"
              onClick={() => go('queue')} title="Ouvrir la file d'attente" />
        <Stat label="Absents" value={queue.absent.length} accent="red"
              hint={queue.absent.length ? 'à recontacter' : '—'}
              onClick={() => go('queue')} title="Ouvrir la file d'attente" />
      </div>

      <div className="grid sidebar-right">
        <div className="card">
          <div className="card-head">
            <h3>Prochains rendez-vous</h3>
            <div className="spacer" />
            <button className="btn sm" onClick={() => go('queue')}>File du jour</button>
            <button className="btn sm" onClick={() => go('calendar')}>Agenda</button>
          </div>
          <div className="card-body tight">
            {next.length === 0 ? (
              <Empty icon="✓" text="Plus aucun rendez-vous à venir aujourd'hui."
                     action={can(user, 'appointment.write') &&
                       <button className="btn primary" onClick={() => onNewAppt({})}>
                         Planifier un rendez-vous</button>} />
            ) : (
              <table>
                <thead>
                  <tr><th style={{ width: 60 }}>Heure</th><th>Patient</th>
                      <th>Praticien</th><th>Motif</th><th>Statut</th></tr>
                </thead>
                <tbody>
                  {next.map((a) => (
                    <tr key={a.id} className="clickable" onClick={() => go('patient', a.patient_id)}>
                      <td className="num" style={{ fontWeight: 600 }}>{fmtTime(a.start_at)}</td>
                      <td>
                        {fmtName(a.patient_last_name, a.patient_first_name)}
                        {a.critical_allergy_count > 0 &&
                          <span className="badge red" style={{ marginLeft: 6 }}>⚠ allergie</span>}
                      </td>
                      <td className="muted">Dr {a.practitioner_last_name}</td>
                      <td className="muted small">{a.reason || a.type_label}</td>
                      <td><Badge status={a.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card">
            <div className="card-head"><h3>À traiter</h3></div>
            <div className="card-body" style={{ display: 'grid', gap: 9, fontSize: 13 }}>
              <TaskRow icon="⏱" ok={waiting.items.length === 0}
                       text={`${waiting.items.length} patient(s) en liste d'attente`}
                       onClick={() => go('calendar')} />
              <TaskRow icon="▤" ok={unpaidToday.length === 0}
                       text={`${unpaidToday.length} encaissement(s) en attente`}
                       onClick={() => go('billing')} />
              <TaskRow icon="⚠" ok={outstanding.items.length === 0}
                       text={`${outstanding.items.length} facture(s) impayée(s)`}
                       onClick={() => go('billing')} />
              <TaskRow icon="✗" ok={queue.absent.length === 0}
                       text={`${queue.absent.length} absence(s) à recontacter`}
                       onClick={() => go('queue')} />
            </div>
          </div>

          {can(user, 'report.read') && occ.items.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Occupation du jour</h3></div>
              <div className="card-body" style={{ display: 'grid', gap: 11 }}>
                {occ.items.slice(0, 6).map((p) => (
                  <div key={p.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between',
                                  fontSize: 12.5, marginBottom: 4 }}>
                      <span>Dr {p.last_name}</span>
                      <span className="muted">{p.occupancy_rate}% · {p.appointments} RDV</span>
                    </div>
                    <Bar value={p.occupancy_rate} color={p.color} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {can(user, 'billing.read') && (
            <div className="card">
              <div className="card-head"><h3>Encours financier</h3></div>
              <div className="card-body">
                <div style={{ fontSize: 24, fontWeight: 650 }}>
                  {fmtMoney(outstanding.items.reduce((s, i) => s + Number(i.balance), 0))}
                </div>
                <div className="muted small">
                  réparti sur {outstanding.items.length} facture(s) non soldée(s)
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const TaskRow = ({ icon, text, ok, onClick }) => (
  <button className="btn ghost" onClick={onClick}
          style={{ justifyContent: 'flex-start', width: '100%', padding: '6px 8px',
                   opacity: ok ? .55 : 1 }}>
    <span style={{ width: 18 }}>{ok ? '✓' : icon}</span>
    <span style={{ textAlign: 'left' }}>{text}</span>
  </button>
);
