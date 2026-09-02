import React, { useState, useEffect, useCallback } from 'react';
import { api, setToken, setUnauthorizedHandler } from './api.js';
import { can, useToast, Spinner, useDensity, applyStoredDensity } from './lib.jsx';
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

/*
 * Navigation en deux blocs seulement.
 *
 * La version précédente exposait dix entrées sur trois groupes, toutes au même
 * niveau visuel : une réceptionniste devait choisir entre « Praticiens »,
 * « Ressources » et « Administration » alors qu'elle n'ouvre en pratique que
 * trois écrans dans sa journée. Le quotidien est désormais isolé en haut ;
 * la configuration, consultée quelques fois par mois, est reléguée en bas et
 * repliée par défaut.
 */
const NAV_DAILY = [
  { id: 'dashboard', label: 'Aujourd\'hui',  icon: '◧' },
  { id: 'queue',     label: 'File d\'attente', icon: '⏱', perm: 'appointment.read',
    badge: 'waiting' },
  { id: 'calendar',  label: 'Agenda',        icon: '▤', perm: 'appointment.read' },
  { id: 'patients',  label: 'Patients',      icon: '⚕', perm: 'patient.read' },
  { id: 'billing',   label: 'Facturation',   icon: '₪', perm: 'billing.read' },
];

const NAV_CONFIG = [
  { id: 'practitioners', label: 'Praticiens',     icon: '👤', perm: 'practitioner.read' },
  { id: 'resources',     label: 'Salles & équip.', icon: '🏥', perm: 'resource.read' },
  { id: 'reports',       label: 'Rapports',       icon: '📊', perm: 'report.read' },
  { id: 'admin',         label: 'Administration', icon: '⚙',  perm: 'admin.settings' },
];

const ALL_NAV = [...NAV_DAILY, ...NAV_CONFIG];

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [page, setPage] = useState('dashboard');
  const [patientId, setPatientId] = useState(null);
  const [newAppt, setNewAppt] = useState(null);   // null | {} | { patientId }
  // Ouvert d'emblée pour les profils qui n'ont accès qu'à la configuration
  // (un administrateur pur ne verrait sinon qu'un menu vide au démarrage).
  const [showConfig, setShowConfig] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [brand, setBrand] = useState(null);
  const [density, toggleDensity] = useDensity();
  const toast = useToast();

  // Reprise de session au chargement (jeton de rafraîchissement en cookie)
  useEffect(() => {
    applyStoredDensity();
    // Le nom de l'établissement vient de la base : une clinique qui installe
    // le logiciel ne doit pas avoir à recompiler pour voir son propre nom.
    api.branding().then(setBrand).catch(() => {});
    setUnauthorizedHandler(() => { setUser(null); setToken(null); });
    (async () => {
      if (await api.refresh()) {
        try { setUser((await api.me()).user); } catch { /* session invalide */ }
      }
      setBooting(false);
    })();
  }, []);

  // Compteur de la file d'attente, rafraîchi toutes les 45 s. Permet à la
  // réception de voir arriver les patients depuis n'importe quel écran, sans
  // charger le serveur : une seule requête légère, et seulement si l'onglet
  // est visible.
  useEffect(() => {
    if (!user || !can(user, 'appointment.read')) return;
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const today = new Date().toISOString().slice(0, 10);
        const q = await api.queue(today);
        if (alive) setWaiting(q.waiting.length);
      } catch { /* le badge est accessoire : pas d'erreur affichée */ }
    };
    tick();
    const h = setInterval(tick, 45_000);
    return () => { alive = false; clearInterval(h); };
  }, [user, page]);

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

  const allowed = (n) => !n.perm || can(user, n.perm);
  const daily = NAV_DAILY.filter(allowed);
  const config = NAV_CONFIG.filter(allowed);
  const current = ALL_NAV.find((n) => n.id === page);

  const navButton = (n) => (
    <button key={n.id} className={page === n.id ? 'active' : ''}
            onClick={() => go(n.id)}
            aria-current={page === n.id ? 'page' : undefined}>
      <span className="ico" aria-hidden="true">{n.icon}</span>{n.label}
      {n.badge === 'waiting' && waiting > 0 && (
        <span className="nav-count" title={`${waiting} patient(s) en attente`}>
          {waiting}
        </span>
      )}
    </button>
  );

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <div className="mark" aria-hidden="true">✚</div>
          <div>
            <strong>CliniRDV</strong>
            <span title={brand?.clinic_name}>{brand?.clinic_name || '—'}</span>
          </div>
        </div>
        <div className="sidebar-nav">
          {daily.map(navButton)}
          {config.length > 0 && (
            <>
              <button className="group-toggle" onClick={() => setShowConfig((v) => !v)}
                      aria-expanded={showConfig}>
                <span className="ico" aria-hidden="true">{showConfig ? '▾' : '▸'}</span>
                Configuration
              </button>
              {showConfig && config.map(navButton)}
            </>
          )}
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
          <button className="btn ghost sm" onClick={toggleDensity}
                  title={density === 'compact'
                    ? 'Affichage confortable'
                    : 'Affichage compact — plus de lignes visibles'}>
            {density === 'compact' ? '▤' : '▥'}
            <span className="sr-only">Changer la densité d'affichage</span>
          </button>
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
