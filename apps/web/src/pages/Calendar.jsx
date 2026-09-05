import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { api } from '../api.js';
import {
  Spinner, Badge, STATUS, fmtTime, fmtDate, fmtName, age, can, Drawer, Modal,
  Field, ErrorAlert, toISODate, startOfWeekDZ, isWeekend, fixedHolidayFor,
  useToast,
} from '../lib.jsx';

const DAY_START = 8, DAY_END = 19, PX_PER_MIN = 1.1;

export default function Calendar({ user, go, onNewAppt }) {
  // Les callbacks de navigation sont fournis par App.jsx, mais ce composant
  // est aussi monté depuis d'autres écrans. Un appel sur une prop absente
  // produirait « X is not a function » et un écran d'erreur complet, là où
  // ne rien faire est inoffensif.
  onNewAppt = onNewAppt || (() => {});
  go = go || (() => {});
  // Sur téléphone, la vue semaine (7 colonnes) est illisible : on part de la
  // vue jour, l'utilisateur peut toujours basculer.
  const [view, setView] = useState(() => (
    typeof window !== 'undefined' && window.innerWidth < 760 ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(() => new Date());
  const [practitioners, setPractitioners] = useState([]);
  const [selectedPract, setSelectedPract] = useState([]);
  const [items, setItems] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  /*
   * Semaine complète de 7 jours, du dimanche au samedi.
   *
   * L'agenda n'affichait que 5 jours à partir du lundi : le week-end
   * algérien (vendredi-samedi, décret 09-234) était donc invisible, alors
   * que le samedi est un jour de forte activité en clinique. Le dimanche,
   * jour ouvré plein ici, manquait lui aussi. On part de startOfWeekDZ
   * (dimanche) et on parcourt les 7 jours.
   *
   * On ajoute un jour de calendrier plutôt que 864e5 ms : sur un changement
   * d'heure, une journée ne fait pas 24 h et les colonnes dériveraient.
   */
  const days = useMemo(() => {
    if (view === 'day') return [new Date(anchor)];
    const s = startOfWeekDZ(anchor);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(s);
      d.setDate(s.getDate() + i);
      return d;
    });
  }, [view, anchor]);

  /* Fermetures saisies par l'administrateur (fêtes religieuses, ponts). */
  const [closures, setClosures] = useState([]);
  useEffect(() => {
    let alive = true;
    api.closures()
      .then((r) => { if (alive) setClosures(r.items || []); })
      // Une fermeture non chargée ne doit pas priver l'utilisateur de son
      // agenda : on dégrade en silence vers les seuls fériés à date fixe.
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  /** Libellé du jour chômé, ou null si le jour est ouvré. */
  const closureFor = useCallback((d) => {
    const fixed = fixedHolidayFor(d);
    if (fixed) return fixed.label;
    const k = toISODate(d);
    const hit = closures.find((c) => toISODate(new Date(c.start_at)) <= k
                                  && k < toISODate(new Date(c.end_at)));
    return hit ? hit.label : null;
  }, [closures]);

  /*
   * Un praticien ne voit que son propre agenda.
   *
   * Le serveur restreint déjà les rendez-vous renvoyés ; sans ce filtre,
   * l'écran afficherait les colonnes de tous les confrères, vides et
   * incompréhensibles. On aligne donc l'affichage sur ce que la permission
   * autorise réellement.
   */
  const seesAll = can(user, 'appointment.read.all');
  const ownId = user?.practitionerId || null;

  useEffect(function loadPractitioners() {
    api.practitioners().then((d) => {
      const list = seesAll ? d.items : d.items.filter((p) => p.id === ownId);
      setPractitioners(list);
      setSelectedPract(list.slice(0, 4).map((p) => p.id));
    }).catch(setError);
  }, [seesAll, ownId]);

  const load = useCallback(async () => {
    if (!selectedPract.length) { setItems([]); return; }
    try {
      const d = await api.appointments({
        from: toISODate(days[0]), to: toISODate(days[days.length - 1]),
        practitionerIds: selectedPract.join(','),
      });
      setItems(d.items);
    } catch (e) { setError(e); }
  }, [days, selectedPract]);

  useEffect(() => { setItems(null); load(); }, [load, tick]);

  // Rafraîchissement périodique : plusieurs postes peuvent modifier le planning
  useEffect(() => {
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const shift = (n) => setAnchor((d) =>
    new Date(d.getTime() + n * (view === 'day' ? 1 : 7) * 864e5));

  const byDay = useMemo(() => {
    const m = {};
    for (const a of items || []) {
      const k = toISODate(new Date(a.start_at));
      (m[k] ||= []).push(a);
    }
    return m;
  }, [items]);

  const hours = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
  const gridH = (DAY_END - DAY_START) * 60 * PX_PER_MIN;
  const todayKey = toISODate(new Date());
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => shift(-1)}>◂</button>
          <button className="btn sm" onClick={() => setAnchor(new Date())}>Aujourd'hui</button>
          <button className="btn sm" onClick={() => shift(1)}>▸</button>
          <h3 style={{ marginLeft: 6, textTransform: 'capitalize' }}>
            {view === 'day'
              ? days[0].toLocaleDateString('fr-FR',
                  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
              : `${fmtDate(days[0])} – ${fmtDate(days[days.length - 1])}`}
          </h3>
          <div className="spacer" />
          <div style={{ display: 'flex', gap: 2 }}>
            <button className={`btn sm ${view === 'day' ? 'primary' : ''}`}
                    onClick={() => setView('day')}>Jour</button>
            <button className={`btn sm ${view === 'week' ? 'primary' : ''}`}
                    onClick={() => setView('week')}>Semaine</button>
          </div>
        </div>

        <div style={{ padding: '9px 16px', display: 'flex', gap: 8, flexWrap: 'wrap',
                      alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
          <span className="small muted">
            {seesAll ? 'Praticiens :' : 'Mon agenda :'}</span>
          {practitioners.map((p) => {
            const on = selectedPract.includes(p.id);
            return (
              <button key={p.id} className={`btn sm ${on ? '' : 'ghost'}`}
                onClick={() => setSelectedPract((s) =>
                  on ? s.filter((x) => x !== p.id) : [...s, p.id])}
                style={on ? { borderColor: p.color, background: `${p.color}14` } : { opacity: .6 }}>
                <i style={{ width: 8, height: 8, borderRadius: 2, background: p.color,
                            display: 'inline-block' }} />
                Dr {p.last_name}
              </button>
            );
          })}
        </div>
      </div>

      <ErrorAlert error={error} />

      <div className="card">
        <div className="calendar">
          {items === null ? <Spinner /> : (
            <div className="cal-grid"
                 style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(160px, 1fr))` }}>
              <div className="cal-head" />
              {days.map((d) => {
                const k = toISODate(d);
                const holiday = closureFor(d);
                return (
                  <div key={k} className={`cal-head ${k === todayKey ? 'today' : ''}`
                    + (holiday ? ' holiday' : isWeekend(d) ? ' weekend' : '')}>
                    <div className="dow">{d.toLocaleDateString('fr-FR', { weekday: 'short' })}</div>
                    <div className="dnum">{d.getDate()}</div>
                    {holiday
                      ? <div className="small muted" title={holiday}>{holiday}</div>
                      : <div className="small muted">{(byDay[k] || []).length} RDV</div>}
                  </div>
                );
              })}

              <div style={{ position: 'relative', height: gridH }}>
                {hours.map((h) => (
                  <div key={h} className="cal-time"
                       style={{ height: 60 * PX_PER_MIN, paddingTop: 2 }}>
                    {String(h).padStart(2, '0')}:00
                  </div>
                ))}
              </div>

              {days.map((d) => {
                const k = toISODate(d);
                return (
                  <div key={k}
                       className={`cal-col${isWeekend(d) || closureFor(d) ? ' weekend' : ''}`}
                       style={{ position: 'relative', height: gridH }}>
                    {hours.map((h) => (
                      <div key={h} className="cal-slot hour"
                           style={{ height: 60 * PX_PER_MIN }}
                           onClick={() => can(user, 'appointment.write') &&
                             onNewAppt({ startAt: new Date(d).setHours(h, 0, 0, 0) })} />
                    ))}
                    {k === todayKey && nowMin > DAY_START * 60 && nowMin < DAY_END * 60 && (
                      <div className="cal-now" style={{ top: (nowMin - DAY_START * 60) * PX_PER_MIN }} />
                    )}
                    {layout(byDay[k] || []).map(({ a, col, cols }) => {
                      const s = new Date(a.start_at), e = new Date(a.end_at);
                      const top = (s.getHours() * 60 + s.getMinutes() - DAY_START * 60) * PX_PER_MIN;
                      const h = Math.max(18, ((e - s) / 60000) * PX_PER_MIN - 1);
                      const st = STATUS[a.status] || {};
                      const dim = ['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(a.status);
                      return (
                        <div key={a.id} className="cal-event"
                             onClick={(ev) => { ev.stopPropagation(); setDetailId(a.id); }}
                             title={`${fmtTime(a.start_at)} ${fmtName(a.patient_last_name, a.patient_first_name)} — ${a.type_label}`}
                             style={{
                               top, height: h, borderLeftColor: st.color,
                               background: dim ? '#f8fafc' : `${a.practitioner_color}0f`,
                               opacity: dim ? .55 : 1,
                               textDecoration: a.status === 'CANCELLED' ? 'line-through' : 'none',
                               left: `calc(${(col / cols) * 100}% + 2px)`,
                               width: `calc(${100 / cols}% - 4px)`,
                             }}>
                          <div className="t">{fmtTime(a.start_at)}</div>
                          <div className="n">
                            {fmtName(a.patient_last_name, a.patient_first_name)}
                          </div>
                          {h > 40 && <div className="n muted" style={{ fontSize: 10 }}>
                            Dr {a.practitioner_last_name}{a.room_code ? ` · ${a.room_code}` : ''}
                          </div>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="legend">
          {Object.entries(STATUS).map(([k, v]) => (
            <span key={k}><i style={{ background: v.color }} />{v.label}</span>
          ))}
        </div>
      </div>

      {detailId && (
        <AppointmentDetail id={detailId} user={user} go={go}
          onClose={() => setDetailId(null)}
          onChanged={() => { setDetailId(null); setTick((t) => t + 1); }} />
      )}
    </>
  );
}

/** Répartit les rendez-vous qui se chevauchent en colonnes côte à côte. */
function layout(list) {
  const sorted = [...list].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const out = [];
  let group = [], groupEnd = null;
  const flush = () => {
    const cols = [];
    for (const a of group) {
      let ci = cols.findIndex((c) => new Date(c) <= new Date(a.start_at));
      if (ci === -1) { ci = cols.length; }
      cols[ci] = a.end_at;
      out.push({ a, col: ci, cols: 0, _g: group });
    }
    const n = cols.length;
    for (const o of out) if (o._g === group) o.cols = n;
    group = []; groupEnd = null;
  };
  for (const a of sorted) {
    if (groupEnd && new Date(a.start_at) >= new Date(groupEnd)) flush();
    group.push(a);
    groupEnd = !groupEnd || new Date(a.end_at) > new Date(groupEnd) ? a.end_at : groupEnd;
  }
  if (group.length) flush();
  return out.map(({ a, col, cols }) => ({ a, col, cols: cols || 1 }));
}

/* ------------------------- Panneau de détail --------------------------- */
export function AppointmentDetail({ id, user, go, onClose, onChanged }) {
  // Réutilisé par Queue.jsx : toutes les fonctions ne sont pas fournies.
  go = go || (() => {});
  onChanged = onChanged || (() => {});
  onClose = onClose || (() => {});
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => { api.appointment(id).then(setD).catch(setError); }, [id]);

  const change = async (status, r) => {
    setBusy(true); setError(null);
    try {
      await api.setStatus(id, { status, reason: r, version: d.appointment.version });
      toast.success('Rendez-vous mis à jour.');
      onChanged();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (error && !d) return <Drawer title="Erreur" onClose={onClose}><ErrorAlert error={error} /></Drawer>;
  if (!d) return <Drawer title="Rendez-vous" onClose={onClose}><Spinner /></Drawer>;

  const a = d.appointment;
  const critical = d.allergies.filter((x) => x.severity === 'CRITICAL');
  const NEXT = {
    SCHEDULED: [['CONFIRMED', 'Confirmer'], ['CHECKED_IN', 'Enregistrer l\'arrivée']],
    CONFIRMED: [['CHECKED_IN', 'Enregistrer l\'arrivée']],
    CHECKED_IN: [['IN_PROGRESS', 'Appeler le client']],
    IN_PROGRESS: [['COMPLETED', 'Terminer la consultation']],
  }[a.status] || [];

  return (
    <Drawer title={a.reference} onClose={onClose} footer={
      <>
        {can(user, 'appointment.write') && NEXT.map(([s, label]) => (
          <button key={s} className="btn primary" disabled={busy}
                  onClick={() => change(s)}>{label}</button>
        ))}
        {can(user, 'appointment.write') && !['CANCELLED', 'COMPLETED', 'NO_SHOW', 'RESCHEDULED']
          .includes(a.status) && (
          <button className="btn danger" disabled={busy}
                  onClick={() => setCancelling(true)}>Annuler</button>
        )}
        <button className="btn" onClick={() => go('patient', a.patient_id)}>Fiche client</button>
      </>
    }>
      <ErrorAlert error={error} />
      {critical.length > 0 && (
        <div className="critical-banner">
          ⚠ ALLERGIE CRITIQUE : {critical.map((x) => x.label).join(', ')}
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>
          {fmtName(a.patient_last_name, a.patient_first_name)}
        </div>
        <div className="muted small">
          {age(a.patient_birth_date)} ans · {a.mrn} · ☎ {a.patient_phone || 'non renseigné'}
        </div>
      </div>

      <dl className="dl" style={{ marginBottom: 16 }}>
        <dt>Date</dt><dd style={{ textTransform: 'capitalize' }}>
          {new Date(a.start_at).toLocaleDateString('fr-FR',
            { weekday: 'long', day: 'numeric', month: 'long' })}</dd>
        <dt>Horaire</dt><dd>{fmtTime(a.start_at)} → {fmtTime(a.end_at)}</dd>
        <dt>Praticien</dt><dd>Dr {a.practitioner_last_name} {a.practitioner_first_name}</dd>
        <dt>Spécialité</dt><dd>{a.specialty_label || '—'}</dd>
        <dt>Type</dt><dd>{a.type_label}</dd>
        <dt>Salle</dt><dd>{a.room_code || 'non attribuée'}</dd>
        <dt>Statut</dt><dd><Badge status={a.status} /></dd>
        <dt>Motif</dt><dd>{a.reason || '—'}</dd>
        {a.cancellation_reason && (<><dt>Motif d'annulation</dt><dd>{a.cancellation_reason}</dd></>)}
      </dl>

      {d.notifications.length > 0 && (
        <>
          <h4 style={{ fontSize: 13, marginBottom: 7 }}>Notifications</h4>
          <div style={{ fontSize: 12, marginBottom: 16 }}>
            {d.notifications.slice(0, 5).map((n) => (
              <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between',
                                       padding: '3px 0' }}>
                <span className="muted">{n.channel} · {fmtDate(n.scheduled_for)}</span>
                <span className={`badge ${n.status === 'SENT' ? 'green'
                  : n.status === 'FAILED' ? 'red' : 'gray'}`}>{n.status}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h4 style={{ fontSize: 13, marginBottom: 7 }}>Historique</h4>
      <div style={{ fontSize: 12 }}>
        {d.history.map((h) => (
          <div key={h.id} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
            <span className="muted">{fmtDate(h.changed_at)} {fmtTime(h.changed_at)}</span>
            {' — '}{h.from_status ? `${h.from_status} → ` : ''}<strong>{h.to_status}</strong>
            {h.comment && <span className="muted"> ({h.comment})</span>}
          </div>
        ))}
      </div>

      {cancelling && (
        <Modal title="Annuler le rendez-vous" onClose={() => setCancelling(false)} footer={
          <>
            <button className="btn" onClick={() => setCancelling(false)}>Retour</button>
            <button className="btn danger" disabled={!reason.trim() || busy}
                    onClick={() => change('CANCELLED', reason)}>Confirmer l'annulation</button>
          </>
        }>
          <div className="alert warning">
            <span>⚠</span>
            <div>Le créneau sera libéré et les rappels programmés seront annulés.</div>
          </div>
          <Field label="Motif de l'annulation (obligatoire)">
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">— Choisir —</option>
              <option>Annulé par le client</option>
              <option>Annulé par le praticien</option>
              <option>Client injoignable</option>
              <option>Report à la demande du client</option>
              <option>Erreur de saisie</option>
            </select>
          </Field>
        </Modal>
      )}
    </Drawer>
  );
}
