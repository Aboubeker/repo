import React, { useState, useEffect, useCallback } from 'react';
import { api, setToken, setUnauthorizedHandler } from './api.js';
import { can, useToast, Spinner } from './lib.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Calendar from './pages/Calendar.jsx';
import Patients from './pages/Patients.jsx';
import PatientFile from './pages/PatientFile.jsx';
import Queue from './pages/Queue.jsx';
import Practitioners from './pages/Practitioners.jsx';
import Resources from './pages/Resources.jsx';
import Billing from './pages/Billing.jsx';
import Reports from './pages/Reports.jsx';
import Admin from './pages/Admin.jsx';
import NewAppointment from './pages/NewAppointment.jsx';

const NAV = [
  { group: 'Activité' },
  { id: 'dashboard',     label: 'Tableau de bord', icon: '◧' },
  { id: 'calendar',      label: 'Agenda',          icon: '▤', perm: 'appointment.read' },
  { id: 'queue',         label: 'File du jour',    icon: '⏱', perm: 'appointment.read' },
  { group: 'Dossiers' },
  { id: 'patients',      label: 'Patients',        icon: '⚕', perm: 'patient.read' },
  { id: 'practitioners', label: 'Praticiens',      icon: '👤', perm: 'practitioner.read' },
  { id: 'resources',     label: 'Ressources',      icon: '🏥', perm: 'resource.read' },
  { group: 'Gestion' },
  { id: 'billing',       label: 'Facturation',     icon: '€',  perm: 'billing.read' },
  { id: 'reports',       label: 'Rapports',        icon: '📊', perm: 'report.read' },
  { id: 'admin',         label: 'Administration',  icon: '⚙',  perm: 'admin.settings' },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [page, setPage] = useState('dashboard');
  const [patientId, setPatientId] = useState(null);
  const [newAppt, setNewAppt] = useState(null);   // null | {} | { patientId }
  const toast = useToast();

  // Reprise de session au chargement (jeton de rafraîchissement en cookie)
  useEffect(() => {
    setUnauthorizedHandler(() => { setUser(null); setToken(null); });
    (async () => {
      if (await api.refresh()) {
        try { setUser((await api.me()).user); } catch { /* session invalide */ }
      }
      setBooting(false);
    })();
  }, []);

  const go = useCallback((id, arg) => {
    if (id === 'patient') { setPatientId(arg); setPage('patient'); }
    else { setPage(id); setPatientId(null); }
  }, []);

  // Raccourcis clavier : conçus pour un usage intensif au comptoir
  useEffect(() => {
    if (!user) return;
    const onKey = (e) => {
      const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
      const map = { n: () => setNewAppt({}), a: () => go('calendar'),
                    p: () => go('patients'), f: () => go('queue') };
      if (map[e.key.toLowerCase()]) { e.preventDefault(); map[e.key.toLowerCase()](); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user, go]);

  const logout = async () => {
    try { await api.logout(); } catch { /* déconnexion locale quoi qu'il arrive */ }
    setToken(null); setUser(null); setPage('dashboard');
  };

  if (booting) return <div style={{ paddingTop: 120 }}><Spinner label="Connexion au serveur local…" /></div>;
  if (!user) return <Login onLogin={setUser} />;

  const visible = NAV.filter((n) => n.group || !n.perm || can(user, n.perm));
  const current = NAV.find((n) => n.id === page);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <div className="mark">C</div>
          <div>
            <strong>CliniRDV</strong>
            <span>Clinique Saint-Michel</span>
          </div>
        </div>
        <div className="sidebar-nav">
          {visible.map((n, i) => n.group
            ? <div className="group" key={`g${i}`}>{n.group}</div>
            : (
              <button key={n.id} className={page === n.id ? 'active' : ''}
                      onClick={() => go(n.id)}>
                <span className="ico">{n.icon}</span>{n.label}
              </button>
            ))}
        </div>
        <div className="sidebar-foot">
          <span className="dot" />Serveur local · v1.0.0
          <div style={{ marginTop: 3 }}>Aucune connexion externe</div>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <h2>{page === 'patient' ? 'Dossier patient' : current?.label || 'Tableau de bord'}</h2>
          <div className="spacer" />
          {can(user, 'appointment.write') && (
            <button className="btn primary" onClick={() => setNewAppt({})}>
              + Nouveau rendez-vous <kbd style={{ opacity: .7, fontSize: 11 }}>N</kbd>
            </button>
          )}
          <div className="user-chip">
            <div className="avatar">
              {user.fullName.split(' ').map((w) => w[0]).slice(0, 2).join('')}
            </div>
            <div>
              <div style={{ fontWeight: 500 }}>{user.fullName}</div>
              <div className="small muted">{user.roles.join(', ')}</div>
            </div>
            <button className="btn ghost sm" onClick={logout} title="Se déconnecter">⏻</button>
          </div>
        </header>

        <main className="content">
          {page === 'dashboard'     && <Dashboard user={user} go={go} onNewAppt={setNewAppt} />}
          {page === 'calendar'      && <Calendar user={user} go={go} onNewAppt={setNewAppt} />}
          {page === 'queue'         && <Queue user={user} go={go} />}
          {page === 'patients'      && <Patients user={user} go={go} />}
          {page === 'patient'       && <PatientFile id={patientId} user={user} go={go}
                                          onNewAppt={setNewAppt} />}
          {page === 'practitioners' && <Practitioners user={user} />}
          {page === 'resources'     && <Resources user={user} />}
          {page === 'billing'       && <Billing user={user} go={go} />}
          {page === 'reports'       && <Reports user={user} />}
          {page === 'admin'         && <Admin user={user} />}
        </main>
      </div>

      {newAppt && (
        <NewAppointment
          initial={newAppt}
          onClose={() => setNewAppt(null)}
          onCreated={(a) => {
            setNewAppt(null);
            toast.success(`Rendez-vous ${a.reference} créé.`);
            if (page === 'calendar' || page === 'queue') location.hash = `#r${Date.now()}`;
          }}
        />
      )}
    </div>
  );
}
