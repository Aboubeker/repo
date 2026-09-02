import React, { useState, useEffect } from 'react';
import { api, setToken } from '../api.js';
import { Field, ErrorAlert } from '../lib.jsx';

const DEMO = [
  ['admin', 'Administrateur — tous les droits'],
  ['s.amrani', 'Réceptionniste — accueil et agenda'],
  ['a.benali', 'Dr Benali — praticien (cardiologie)'],
  ['c.compta', 'Facturation — factures et caisse'],
];

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(null);
  const [brand, setBrand] = useState(null);
  const [theme, setTheme] = useState(null);

  useEffect(function loadPublicInfo() {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.branding().then(setBrand).catch(() => {});
    // Le thème est public : l'écran de connexion porte les couleurs et le
    // logo de la clinique avant même qu'un compte ne soit identifié.
    api.theme().then(setTheme).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const d = await api.login(username, password);
      setToken(d.accessToken);
      onLogin(d.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const fill = (u) => { setUsername(u); setPassword('Clinique2026!'); setError(null); };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        {theme?.logo_data_uri
          ? <img className="login-logo-img" src={theme.logo_data_uri}
                 alt={brand?.clinic_name || 'Logo de la clinique'} />
          : <div className="login-logo" aria-hidden="true">✚</div>}
        <h1>CliniRDV</h1>
        <p className="sub">{brand?.clinic_name || 'Clinique'} · Gestion des rendez-vous</p>

        {theme?.login_message && (
          <p className="login-message">{theme.login_message}</p>
        )}

        <ErrorAlert error={error} />

        <Field label="Identifiant">
          <input value={username} onChange={(e) => setUsername(e.target.value)}
                 autoFocus autoComplete="username" required />
        </Field>

        <Field label="Mot de passe">
          <div style={{ position: 'relative' }}>
            <input type={show ? 'text' : 'password'} value={password}
                   onChange={(e) => setPassword(e.target.value)}
                   autoComplete="current-password" required style={{ paddingRight: 40 }} />
            <button type="button" onClick={() => setShow(!show)}
                    aria-label={show ? 'Masquer' : 'Afficher'}
                    style={{ position: 'absolute', right: 6, top: 5, border: 0,
                             background: 'none', cursor: 'pointer', width: 'auto' }}>
              {show ? '🙈' : '👁'}
            </button>
          </div>
        </Field>

        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }}
                disabled={busy || !username || !password}>
          {busy ? <span className="spinner" /> : 'Se connecter'}
        </button>

        <div className="demo-accounts">
          <b>Comptes de démonstration</b>
          {DEMO.map(([u, d]) => (
            <button type="button" key={u} onClick={() => fill(u)}>
              <strong>{u}</strong> <span className="muted">— {d}</span>
            </button>
          ))}
          <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
            Mot de passe commun : Clinique2026!
          </div>
        </div>

        <div className="login-footer">
          Serveur local · Base de données {health?.database?.ok ? 'opérationnelle' : 'injoignable'}
          {health && ` (${health.database.latencyMs} ms)`}
          <br />
          Déploiement on-premise — aucune donnée ne quitte l'établissement.
          <br />
          Accès réservé au personnel autorisé. Toute activité est journalisée.
        </div>
      </form>
    </div>
  );
}
