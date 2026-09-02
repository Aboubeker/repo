import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, Empty, Modal, Field, ErrorAlert, Stat,
         fmtDate, fmtDateTime, can, useToast } from '../lib.jsx';

const TABS = [
  ['users', 'Utilisateurs', 'admin.users'],
  ['settings', 'Paramètres', 'admin.settings'],
  ['backups', 'Sauvegardes', 'admin.backup'],
  ['audit', 'Journal d\'audit', 'audit.read'],
  ['system', 'Système', 'admin.settings'],
];

export default function Admin({ user }) {
  const tabs = TABS.filter(([, , perm]) => can(user, perm));
  const [tab, setTab] = useState(tabs[0]?.[0]);
  if (tabs.length === 0) return <Empty icon="🔒" text="Accès réservé aux administrateurs." />;
  return (
    <>
      <div className="tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''}
                  onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'users'    && <Users />}
      {tab === 'settings' && <Settings />}
      {tab === 'backups'  && <Backups />}
      {tab === 'audit'    && <Audit />}
      {tab === 'system'   && <System />}
    </>
  );
}

/* ----------------------------- Utilisateurs ------------------------------ */
function Users() {
  const [items, setItems] = useState(null);
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const load = () => api.users().then((d) => setItems(d.items)).catch(setError);
  useEffect(() => { load(); api.roles().then((d) => setRoles(d.items)).catch(() => {}); }, []);

  const setStatus = async (u, status, msg) => {
    try { await api.updateUser(u.id, { status }); toast.success(msg); load(); }
    catch (e) { toast.error(e.message); }
  };
  const resetPassword = async (u) => {
    const pwd = prompt(`Nouveau mot de passe provisoire pour ${u.username} :`);
    if (!pwd) return;
    try {
      await api.updateUser(u.id, { password: pwd });
      toast.success('Mot de passe réinitialisé ; sessions révoquées.');
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (error) return <ErrorAlert error={error} />;
  if (!items) return <Spinner />;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Comptes utilisateurs</h3>
          <div className="spacer" />
          <button className="btn primary sm" onClick={() => setCreating(true)}>
            + Créer un compte</button>
        </div>
        <div className="card-body tight">
          <table>
            <thead><tr><th>Identifiant</th><th>Nom</th><th>Rôles</th><th>Courriel</th>
              <th>Dernière connexion</th><th>État</th><th></th></tr></thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.username}</strong></td>
                  <td>{u.full_name}</td>
                  <td>{(u.roles || []).map((r) => (
                    <span key={r} className="badge blue" style={{ marginRight: 4 }}>{r}</span>))}</td>
                  <td className="muted small">{u.email || '—'}</td>
                  <td className="muted small">
                    {u.last_login_at ? fmtDateTime(u.last_login_at) : 'jamais'}</td>
                  <td>
                    {u.status === 'ACTIVE' ? <span className="badge green">Actif</span>
                      : u.status === 'LOCKED' ? <span className="badge red">Verrouillé</span>
                      : <span className="badge gray">Désactivé</span>}
                    {u.must_change_password &&
                      <span className="badge orange" style={{ marginLeft: 4 }}>MDP à changer</span>}
                  </td>
                  <td>
                    {u.status !== 'ACTIVE'
                      ? <button className="btn sm"
                          onClick={() => setStatus(u, 'ACTIVE', 'Compte réactivé.')}>Réactiver</button>
                      : <button className="btn ghost sm"
                          onClick={() => setStatus(u, 'DISABLED', 'Compte désactivé.')}>Désactiver</button>}
                    <button className="btn ghost sm"
                            onClick={() => resetPassword(u)}>Réinitialiser</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head"><h3>Rôles et permissions</h3></div>
        <div className="card-body tight">
          <table>
            <thead><tr><th>Rôle</th><th>Description</th><th>Permissions</th></tr></thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.code}>
                  <td><strong>{r.code}</strong></td>
                  <td className="muted small">{r.label}</td>
                  <td className="muted small">{(r.permissions || []).length} permission(s)
                    <div style={{ marginTop: 4 }}>{(r.permissions || []).map((p) => (
                      <span key={p} className="badge gray"
                            style={{ marginRight: 3 }}>{p}</span>))}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {creating && <CreateUser roles={roles} onClose={() => setCreating(false)}
        onDone={() => { setCreating(false); load(); }} />}
    </>
  );
}

function CreateUser({ roles, onClose, onDone }) {
  const [f, setF] = useState({ username: '', fullName: '', email: '', password: '', roles: [] });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async () => {
    setBusy(true); setError(null);
    try { await api.createUser(f); toast.success('Compte créé.'); onDone(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title="Créer un compte" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={busy} onClick={submit}>Créer</button>
      </>
    }>
      <ErrorAlert error={error} />
      <Field label="Identifiant" error={error?.details?.username}>
        <input value={f.username} onChange={set('username')} autoFocus placeholder="p.nom" /></Field>
      <Field label="Nom affiché" error={error?.details?.fullName}>
        <input value={f.fullName} onChange={set('fullName')} /></Field>
      <Field label="Courriel interne"><input value={f.email} onChange={set('email')} /></Field>
      <Field label="Mot de passe provisoire"
             help="12 caractères minimum. L'utilisateur devra le changer à la première connexion.">
        <input type="text" value={f.password} onChange={set('password')} /></Field>
      <Field label="Rôles">
        <div style={{ display: 'grid', gap: 5 }}>
          {roles.map((r) => (
            <label key={r.code} style={{ display: 'flex', gap: 7, alignItems: 'center',
                                         fontSize: 13 }}>
              <input type="checkbox" checked={f.roles.includes(r.code)}
                     onChange={(e) => setF({ ...f, roles: e.target.checked
                       ? [...f.roles, r.code] : f.roles.filter((x) => x !== r.code) })} />
              <strong>{r.code}</strong> <span className="muted">{r.label}</span>
            </label>
          ))}
        </div>
      </Field>
    </Modal>
  );
}

/* ------------------------------ Paramètres ------------------------------- */
function Settings() {
  const [items, setItems] = useState(null);
  const [closures, setClosures] = useState([]);
  const [error, setError] = useState(null);
  const [edit, setEdit] = useState(null);
  const toast = useToast();

  const load = () => {
    api.settings().then((d) => setItems(d.items)).catch(setError);
    api.closures().then((d) => setClosures(d.items)).catch(() => {});
  };
  useEffect(load, []);

  const save = async () => {
    try {
      let value;
      try { value = JSON.parse(edit.raw); } catch { value = edit.raw; }
      await api.updateSetting(edit.key, value);
      toast.success('Paramètre enregistré.');
      setEdit(null); load();
    } catch (e) { toast.error(e.message); }
  };

  if (error) return <ErrorAlert error={error} />;
  if (!items) return <Spinner />;

  const groups = items.reduce((acc, s) => {
    (acc[s.category || 'Divers'] ||= []).push(s); return acc;
  }, {});

  return (
    <>
      {Object.entries(groups).map(([cat, list]) => (
        <div className="card" key={cat} style={{ marginBottom: 14 }}>
          <div className="card-head"><h3>{cat}</h3></div>
          <div className="card-body tight">
            <table>
              <thead><tr><th>Clé</th><th>Valeur</th><th>Description</th><th></th></tr></thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.key}>
                    <td><strong>{s.key}</strong></td>
                    <td><code style={{ fontSize: 12 }}>{JSON.stringify(s.value)}</code></td>
                    <td className="muted small">{s.description || '—'}</td>
                    <td><button className="btn ghost sm"
                      onClick={() => setEdit({ key: s.key,
                        raw: JSON.stringify(s.value) })}>Modifier</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="card">
        <div className="card-head"><h3>Fermetures de la clinique</h3></div>
        <div className="card-body tight">
          {closures.length === 0 ? <Empty text="Aucune fermeture programmée." /> : (
            <table>
              <thead><tr><th>Du</th><th>Au</th><th>Motif</th></tr></thead>
              <tbody>
                {closures.map((c) => (
                  <tr key={c.id}>
                    <td>{fmtDate(c.start_at)}</td>
                    <td>{fmtDate(c.end_at)}</td>
                    <td>{c.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {edit && (
        <Modal title={`Paramètre — ${edit.key}`} onClose={() => setEdit(null)} footer={
          <>
            <button className="btn" onClick={() => setEdit(null)}>Annuler</button>
            <button className="btn primary" onClick={save}>Enregistrer</button>
          </>
        }>
          <Field label="Valeur (JSON)" help="Chaînes entre guillemets, ex. « 30 » ou « true ».">
            <textarea rows={4} value={edit.raw}
                      onChange={(e) => setEdit({ ...edit, raw: e.target.value })} /></Field>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------ Sauvegardes ------------------------------ */
function Backups() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [integrity, setIntegrity] = useState(null);
  const toast = useToast();

  const load = () => api.backups().then(setD).catch(setError);
  useEffect(load, []);

  const run = async () => {
    setBusy(true);
    try { const r = await api.runBackup(); toast.success(`Sauvegarde ${r.status}.`); load(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const check = async () => {
    setIntegrity(null);
    try { setIntegrity(await api.integrity()); } catch (e) { toast.error(e.message); }
  };

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  return (
    <>
      <div className="grid c3" style={{ marginBottom: 14 }}>
        <Stat label="Taille de la base" value={d.diskInfo?.database_size || '—'} accent="blue" />
        <Stat label="Sauvegardes conservées" value={d.items.length} accent="purple" />
        <Stat label="Dernière réussie" accent="green"
              value={d.items.find((b) => b.status === 'SUCCESS')
                ? fmtDate(d.items.find((b) => b.status === 'SUCCESS').started_at) : 'aucune'} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Sauvegardes locales</h3>
          <div className="spacer" />
          <button className="btn sm" onClick={check}>Contrôle d'intégrité</button>
          <button className="btn primary sm" disabled={busy} onClick={run}>
            {busy ? 'Sauvegarde en cours…' : 'Lancer une sauvegarde'}</button>
        </div>
        <div className="card-body tight">
          <div className="alert info" style={{ margin: 12 }}>
            <span>ⓘ</span>
            <div>Les sauvegardes sont écrites sur le disque local du serveur
              (<code>storage/backups</code>) : aucun envoi vers l'extérieur.
              Copiez-les régulièrement sur un support amovible chiffré.</div>
          </div>
          {d.items.length === 0 ? <Empty text="Aucune sauvegarde." /> : (
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Fichier</th><th className="num">Taille</th>
                <th>Empreinte</th><th>État</th></tr></thead>
              <tbody>
                {d.items.map((b) => (
                  <tr key={b.id}>
                    <td>{fmtDateTime(b.started_at)}</td>
                    <td className="muted small">{b.kind}</td>
                    <td className="muted small">{(b.target_path || '').split('/').pop()}</td>
                    <td className="num muted">
                      {b.size_bytes ? `${(b.size_bytes / 1048576).toFixed(1)} Mo` : '—'}</td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {(b.checksum || '').slice(0, 12)}…</td>
                    <td><span className={`badge ${b.status === 'SUCCESS' ? 'green'
                      : b.status === 'RUNNING' ? 'blue' : 'red'}`}>{b.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {integrity && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h3>Contrôle d'intégrité</h3>
            <span className={`badge ${integrity.ok ? 'green' : 'red'}`}>
              {integrity.ok ? 'Base cohérente' : 'Anomalies détectées'}</span>
          </div>
          <div className="card-body tight">
            <table>
              <tbody>
                {integrity.checks.map((c) => (
                  <tr key={c.name}>
                    <td>{c.ok ? '✅' : '❌'} {c.name}</td>
                    <td className="muted small">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/* --------------------------------- Audit --------------------------------- */
function Audit() {
  const [items, setItems] = useState(null);
  const [f, setF] = useState({ entity: '', action: '', username: '' });
  const [error, setError] = useState(null);

  const load = () => {
    setItems(null);
    api.audit({ ...f, limit: 200 }).then((d) => setItems(d.items)).catch(setError);
  };
  useEffect(load, []);

  if (error) return <ErrorAlert error={error} />;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Journal d'audit</h3>
        <input placeholder="Entité" value={f.entity} style={{ width: 130 }}
               onChange={(e) => setF({ ...f, entity: e.target.value })} />
        <select value={f.action} style={{ width: 140 }}
                onChange={(e) => setF({ ...f, action: e.target.value })}>
          <option value="">Toutes actions</option>
          {['CREATE', 'UPDATE', 'DELETE', 'READ', 'LOGIN', 'LOGOUT', 'EXPORT', 'BACKUP', 'RESTORE']
            .map((a) => <option key={a}>{a}</option>)}
        </select>
        <input placeholder="Utilisateur" value={f.username} style={{ width: 130 }}
               onChange={(e) => setF({ ...f, username: e.target.value })} />
        <button className="btn sm" onClick={load}>Filtrer</button>
        <div className="spacer" />
        <span className="muted small">Conservation : 3 ans · journal non modifiable</span>
      </div>
      <div className="card-body tight">
        {!items ? <Spinner /> : items.length === 0 ? <Empty text="Aucune entrée." /> : (
          <table>
            <thead><tr><th>Horodatage</th><th>Utilisateur</th><th>Action</th>
              <th>Entité</th><th>Résumé</th><th>Poste</th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="muted small">{fmtDateTime(a.occurred_at)}</td>
                  <td>{a.username || <span className="muted">système</span>}</td>
                  <td><span className="badge gray">{a.action}</span></td>
                  <td className="muted small">{a.entity}</td>
                  <td className="small">{a.summary}
                    {a.justification && <div className="muted small">
                      Motif : {a.justification}</div>}</td>
                  <td className="muted small">{a.ip || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- Système -------------------------------- */
function System() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.system().then(setD).catch(setError); }, []);

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  const up = d.uptimeSeconds;
  return (
    <div className="grid c2">
      <div className="card">
        <div className="card-head"><h3>Déploiement</h3></div>
        <div className="card-body">
          <dl className="dl">
            <dt>Mode</dt><dd><span className="badge green">{d.deployment.mode}</span></dd>
            <dt>Synchro cloud</dt><dd><span className="badge gray">désactivée</span></dd>
            <dt>Appels externes</dt><dd><span className="badge gray">aucun</span></dd>
            <dt>Node.js</dt><dd>{d.nodeVersion}</dd>
            <dt>Disponibilité</dt><dd>
              {Math.floor(up / 3600)} h {Math.floor((up % 3600) / 60)} min</dd>
          </dl>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Base de données</h3></div>
        <div className="card-body">
          <dl className="dl">
            <dt>Version</dt><dd className="small">{(d.database.version || '').split(',')[0]}</dd>
            <dt>Taille</dt><dd>{d.database.size}</dd>
            <dt>Patients</dt><dd>{d.counts.patients}</dd>
            <dt>Praticiens</dt><dd>{d.counts.practitioners}</dd>
            <dt>Rendez-vous</dt><dd>{d.counts.appointments}</dd>
            <dt>Factures</dt><dd>{d.counts.invoices}</dd>
            <dt>Entrées d'audit</dt><dd>{d.counts.audit_entries}</dd>
          </dl>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Dernière sauvegarde</h3></div>
        <div className="card-body">
          {d.lastBackup ? (
            <dl className="dl">
              <dt>Date</dt><dd>{fmtDateTime(d.lastBackup.started_at)}</dd>
              <dt>Fichier</dt><dd className="small">
                {(d.lastBackup.target_path || '').split('/').pop()}</dd>
              <dt>Taille</dt><dd>
                {(d.lastBackup.size_bytes / 1048576).toFixed(1)} Mo</dd>
            </dl>
          ) : (
            <div className="alert warning"><span>⚠</span>
              <div>Aucune sauvegarde réussie : lancez-en une immédiatement.</div></div>
          )}
        </div>
      </div>
    </div>
  );
}
