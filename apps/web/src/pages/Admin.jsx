import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, Empty, Modal, Field, ErrorAlert, Stat, PageHead,
         HealthItem, ActionStrip, ConfirmDialog,
         fmtDate, fmtDateTime, fmtMoney, can, useToast, applyTheme } from '../lib.jsx';

const TABS = [
  ['overview', 'Vue d\'ensemble', 'admin.settings'],
  ['users', 'Utilisateurs', 'admin.users'],
  ['roles', 'Rôles et permissions', 'admin.roles'],
  ['theme', 'Apparence', 'admin.theme'],
  ['catalogue', 'Actes et tarifs', 'admin.settings'],
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
      {tab === 'overview' && <Overview go={setTab} />}
      {tab === 'users'    && <Users />}
      {tab === 'roles'    && <Roles />}
      {tab === 'theme'    && <Appearance />}
      {tab === 'catalogue' && <Catalogue />}
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
  const [form, setForm] = useState(null);       // { user } en modification, {} en création
  const [deleting, setDeleting] = useState(null);
  const [q, setQ] = useState('');
  const toast = useToast();

  const load = () => api.users().then((d) => setItems(d.items)).catch(setError);
  useEffect(function loadUsersAndRoles() {
    load();
    api.roles().then((d) => setRoles(d.items)).catch(() => {});
  }, []);

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
  const remove = async () => {
    try {
      await api.deleteUser(deleting.id);
      toast.success(`Compte ${deleting.username} supprimé.`);
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (error) return <ErrorAlert error={error} />;
  if (!items) return <Spinner />;

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? items.filter((u) => `${u.username} ${u.full_name} ${u.email || ''}`
        .toLowerCase().includes(needle))
    : items;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Comptes utilisateurs</h3>
          <div className="search-global" style={{ width: 260, marginLeft: 14 }}>
            <span className="icon">🔍</span>
            <input value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="Identifiant, nom, courriel…" />
          </div>
          <div className="spacer" />
          <span className="muted small">{shown.length} compte(s)</span>
          <button className="btn primary sm" onClick={() => setForm({})}>
            + Créer un compte</button>
        </div>
        <div className="card-body tight">
          {shown.length === 0 ? <Empty icon="👤" text="Aucun compte ne correspond." /> : (
          <table>
            <thead><tr><th>Identifiant</th><th>Nom</th><th>Rôles</th><th>Courriel</th>
              <th>Dernière connexion</th><th>État</th><th className="num">Actions</th></tr></thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.username}</strong>
                    {u.is_superuser &&
                      <span className="badge purple" style={{ marginLeft: 5 }}
                            title="Détient toutes les permissions">Superuser</span>}</td>
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
                  <td className="num nowrap">
                    <button className="btn sm" onClick={() => setForm({ user: u })}
                            title="Nom, courriel et rôles">Modifier</button>
                    {u.status !== 'ACTIVE'
                      ? <button className="btn ghost sm"
                          onClick={() => setStatus(u, 'ACTIVE', 'Compte réactivé.')}>Réactiver</button>
                      : <button className="btn ghost sm"
                          onClick={() => setStatus(u, 'DISABLED', 'Compte désactivé.')}>Désactiver</button>}
                    <button className="btn ghost sm"
                            onClick={() => resetPassword(u)}>Réinitialiser</button>
                    <button className="btn ghost sm danger" onClick={() => setDeleting(u)}
                            title="Supprimer le compte">Supprimer</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
      </div>

      {form && <UserForm target={form.user} roles={roles} onClose={() => setForm(null)}
        onDone={() => { setForm(null); load(); }} />}

      {deleting && (
        <ConfirmDialog title="Supprimer ce compte ?" danger confirmLabel="Supprimer le compte"
          onConfirm={remove} onClose={() => setDeleting(null)}
          message={`Le compte « ${deleting.username} » (${deleting.full_name}) sera supprimé et ses sessions immédiatement fermées.`}>
          <p className="muted small">
            Les rendez-vous, factures et écritures du journal d'audit créés par
            cet utilisateur sont conservés : la traçabilité réglementaire reste
            intacte. L'identifiant redevient disponible pour un nouveau compte.
            Pour un départ temporaire, préférez « Désactiver ».
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * Formulaire de compte, en création comme en modification.
 *
 * Le mot de passe n'apparaît qu'à la création : le modifier ensuite passe par
 * « Réinitialiser », qui révoque les sessions ouvertes — une nuance de
 * sécurité qu'un champ discret au milieu d'un formulaire ferait oublier.
 */
function UserForm({ target, roles, onClose, onDone }) {
  const editing = Boolean(target);
  const [f, setF] = useState({
    username: target?.username || '',
    fullName: target?.full_name || '',
    email: target?.email || '',
    password: '',
    roles: target?.roles || [],
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (editing) {
        await api.updateUser(target.id,
          { fullName: f.fullName, email: f.email, roles: f.roles });
        toast.success('Compte mis à jour.');
      } else {
        await api.createUser(f);
        toast.success('Compte créé.');
      }
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title={editing ? `Modifier ${target.username}` : 'Créer un compte'}
           onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {editing ? 'Enregistrer' : 'Créer'}</button>
      </>
    }>
      <ErrorAlert error={error} />
      <Field label="Identifiant" error={error?.details?.username}
             help={editing ? "L'identifiant de connexion n'est pas modifiable." : undefined}>
        <input value={f.username} onChange={set('username')} disabled={editing}
               autoFocus={!editing} placeholder="p.nom" /></Field>
      <Field label="Nom affiché" error={error?.details?.fullName}>
        <input value={f.fullName} onChange={set('fullName')} autoFocus={editing} /></Field>
      <Field label="Courriel interne"><input value={f.email} onChange={set('email')} /></Field>
      {!editing && (
        <Field label="Mot de passe provisoire" error={error?.details?.password}
               help="12 caractères minimum. L'utilisateur devra le changer à la première connexion.">
          <input type="text" value={f.password} onChange={set('password')} /></Field>
      )}
      <Field label="Rôles" help="Les permissions accordées sont l'union de celles des rôles cochés.">
        <div style={{ display: 'grid', gap: 5 }}>
          {roles.map((r) => (
            <label key={r.code} className="check" style={{ fontSize: 13 }}>
              <input type="checkbox" checked={f.roles.includes(r.code)}
                     onChange={(e) => setF({ ...f, roles: e.target.checked
                       ? [...f.roles, r.code] : f.roles.filter((x) => x !== r.code) })} />
              <strong>{r.code}</strong> <span className="muted">{r.label}</span>
            </label>
          ))}
        </div>
      </Field>
      {editing && target.is_superuser && (
        <div className="alert warning" style={{ marginTop: 10 }}>
          <span>⚠</span>
          <div>Ce compte est superutilisateur : il conserve toutes les
            permissions quels que soient les rôles cochés ci-dessus.</div>
        </div>
      )}
    </Modal>
  );
}

/* -------------------------- Rôles et permissions ------------------------- */

/**
 * Regroupe les permissions par préfixe (« patient.read » → famille « patient »).
 *
 * La matrice compte plusieurs dizaines d'entrées ; présentée à plat, elle est
 * illisible et l'on coche de travers. Le regroupement suit le nommage déjà
 * porté par les codes, il n'y a donc aucune table de correspondance à tenir
 * à jour quand une permission apparaît.
 */
function groupPermissions(permissions) {
  const groups = new Map();
  for (const p of permissions) {
    const family = (p.code || p).split('.')[0];
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(p);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'fr'));
}

const FAMILY_LABELS = {
  patient: 'Patients', appointment: 'Rendez-vous', practitioner: 'Praticiens',
  encounter: 'Consultations', resource: 'Ressources', billing: 'Facturation',
  invoice: 'Factures', payment: 'Encaissements', report: 'Rapports',
  audit: 'Audit', admin: 'Administration', user: 'Comptes',
};

function Roles() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const toast = useToast();

  const load = () => api.roleCatalog().then(setData).catch(setError);
  useEffect(function loadCatalog() { load(); }, []);

  const remove = async () => {
    try {
      await api.deleteRole(deleting.id);
      toast.success(`Rôle ${deleting.code} supprimé.`);
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (error) return <ErrorAlert error={error} />;
  if (!data) return <Spinner />;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Rôles</h3>
          <div className="spacer" />
          <span className="muted small">
            {data.roles.length} rôle(s) · {data.permissions.length} permissions</span>
          <button className="btn primary sm" onClick={() => setForm({})}>+ Créer un rôle</button>
        </div>
        <div className="card-body tight">
          <table>
            <thead><tr><th>Code</th><th>Intitulé</th><th className="num">Comptes</th>
              <th>Permissions</th><th className="num">Actions</th></tr></thead>
            <tbody>
              {data.roles.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.code}</strong>
                    {r.is_system &&
                      <span className="badge gray" style={{ marginLeft: 5 }}
                            title="Rôle livré avec le logiciel">Système</span>}</td>
                  <td>{r.label}
                    {r.description && <div className="muted small">{r.description}</div>}</td>
                  <td className="num">{r.user_count}</td>
                  <td className="muted small">{(r.permissions || []).length} permission(s)</td>
                  <td className="num nowrap">
                    <button className="btn sm" onClick={() => setForm({ role: r })}>
                      {r.is_system ? 'Ajuster' : 'Modifier'}</button>
                    {!r.is_system && (
                      <button className="btn ghost sm danger" onClick={() => setDeleting(r)}>
                        Supprimer</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="alert info" style={{ marginTop: 14 }}>
        <span>ℹ</span>
        <div>Les rôles système ne peuvent être ni renommés ni supprimés, car ils
          sont cités dans les procédures de la clinique ; leurs permissions
          restent en revanche ajustables. Un rôle attribué à au moins un compte
          ne peut pas être supprimé : retirez-le d'abord des comptes concernés.
          Enfin, la dernière permission « admin.users » ou « admin.roles » du
          système ne peut pas être retirée — sans elle plus personne ne pourrait
          administrer l'application.</div>
      </div>

      {form && <RoleForm role={form.role} permissions={data.permissions}
        onClose={() => setForm(null)} onDone={() => { setForm(null); load(); }} />}

      {deleting && (
        <ConfirmDialog title="Supprimer ce rôle ?" danger confirmLabel="Supprimer"
          onConfirm={remove} onClose={() => setDeleting(null)}
          message={`Le rôle « ${deleting.label} » (${deleting.code}) sera définitivement supprimé.`} />
      )}
    </>
  );
}

function RoleForm({ role, permissions, onClose, onDone }) {
  const editing = Boolean(role);
  const [f, setF] = useState({
    code: role?.code || '', label: role?.label || '',
    description: role?.description || '',
    permissions: role?.permissions || [],
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const locked = editing && role.is_system;
  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  const toggle = (code) => setF((prev) => ({
    ...prev,
    permissions: prev.permissions.includes(code)
      ? prev.permissions.filter((x) => x !== code)
      : [...prev.permissions, code],
  }));

  const toggleFamily = (codes, all) => setF((prev) => ({
    ...prev,
    permissions: all
      ? prev.permissions.filter((x) => !codes.includes(x))
      : [...new Set([...prev.permissions, ...codes])],
  }));

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (editing) {
        // Un rôle système refuse toute retouche de son libellé : n'envoyer
        // que les permissions évite un rejet sur un champ inchangé.
        await api.updateRole(role.id, locked
          ? { permissions: f.permissions }
          : { label: f.label, description: f.description, permissions: f.permissions });
        toast.success('Rôle mis à jour.');
      } else {
        await api.createRole(f);
        toast.success('Rôle créé.');
      }
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title={editing ? `Rôle ${role.code}` : 'Créer un rôle'} onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {editing ? 'Enregistrer' : 'Créer le rôle'}</button>
      </>
    }>
      <ErrorAlert error={error} />
      {!editing && (
        <div className="row">
          <Field label="Code *" error={error?.details?.code}
                 help="Majuscules, chiffres et « _ ». Exemple : INFIRMIER.">
            <input value={f.code} autoFocus
                   onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Intitulé *" error={error?.details?.label}>
            <input value={f.label} onChange={set('label')} /></Field>
        </div>
      )}
      {editing && !locked && (
        <div className="row">
          <Field label="Intitulé *" error={error?.details?.label}>
            <input value={f.label} onChange={set('label')} autoFocus /></Field>
        </div>
      )}
      {!locked && (
        <Field label="Description">
          <input value={f.description} onChange={set('description')}
                 placeholder="À quoi sert ce rôle dans la clinique ?" /></Field>
      )}
      {locked && (
        <div className="alert info">
          <span>ℹ</span>
          <div>Rôle système : l'intitulé et la description sont figés,
            les permissions restent modifiables.</div>
        </div>
      )}

      <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>
        Permissions <span className="muted">({f.permissions.length} sélectionnée(s))</span>
      </h4>
      {groupPermissions(permissions).map(([family, perms]) => {
        const codes = perms.map((p) => p.code);
        const all = codes.every((c) => f.permissions.includes(c));
        return (
          <div key={family} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <strong style={{ fontSize: 12 }}>{FAMILY_LABELS[family] || family}</strong>
              <button type="button" className="btn ghost sm"
                      onClick={() => toggleFamily(codes, all)}>
                {all ? 'Tout décocher' : 'Tout cocher'}</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
              {perms.map((p) => (
                <label key={p.code} className="check" style={{ fontSize: 12.5 }}>
                  <input type="checkbox" checked={f.permissions.includes(p.code)}
                         onChange={() => toggle(p.code)} />
                  <span><code>{p.code}</code>
                    {p.label && <span className="muted"> — {p.label}</span>}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </Modal>
  );
}

/* ------------------------------- Apparence ------------------------------- */

const THEME_PRESETS = [
  { key: 'teal',   label: 'Sarcelle (par défaut)', primary: '#0f766e', accent: '#5eead4', sidebar: '#14201e' },
  { key: 'indigo', label: 'Indigo',                primary: '#4338ca', accent: '#a5b4fc', sidebar: '#1a1b2e' },
  { key: 'ocean',  label: 'Bleu océan',            primary: '#0369a1', accent: '#7dd3fc', sidebar: '#0f1e2b' },
  { key: 'amber',  label: 'Ambre',                 primary: '#b45309', accent: '#fcd34d', sidebar: '#241a0f' },
  { key: 'plum',   label: 'Prune',                 primary: '#86198f', accent: '#f0abfc', sidebar: '#231325' },
  { key: 'slate',  label: 'Ardoise',               primary: '#334155', accent: '#94a3b8', sidebar: '#161a20' },
];

function Appearance() {
  const [f, setF] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const toast = useToast();

  // Le nom de la clinique n'appartient pas au thème : il vit dans
  // « app_setting » et sert aussi aux documents imprimés. On le charge et on
  // l'enregistre à part, tout en le présentant au même endroit que le logo.
  const [brand, setBrand] = useState(null);

  const apply = (t, b) => setF((prev) => ({
    preset: t.preset || 'teal',
    primaryColor: t.primary_color, accentColor: t.accent_color,
    sidebarColor: t.sidebar_color, density: t.density, radius: t.radius,
    fontScale: Number(t.font_scale), logoDataUri: t.logo_data_uri || '',
    loginMessage: t.login_message || '',
    clinicName:  b ? (b.clinic_name || '') : (prev?.clinicName ?? ''),
    clinicCity:  b ? (b.city || '')        : (prev?.clinicCity ?? ''),
    clinicPhone: b ? (b.phone || '')       : (prev?.clinicPhone ?? ''),
  }));

  useEffect(function loadThemeAndBrand() {
    Promise.all([api.theme(), api.branding().catch(() => null)])
      .then(([t, b]) => { setBrand(b); apply(t, b); })
      .catch(setError);
  }, []);

  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await api.updateTheme(f);

      /*
       * Les coordonnées ne sont réécrites que si elles ont changé : chaque
       * paramètre est une requête distincte, doublée d'une écriture au
       * journal d'audit. Enregistrer une couleur ne doit pas y laisser trois
       * lignes de modification pour des valeurs identiques.
       */
      const changed = [
        ['clinic.name',  f.clinicName,  brand?.clinic_name],
        ['clinic.city',  f.clinicCity,  brand?.city],
        ['clinic.phone', f.clinicPhone, brand?.phone],
      ].filter(([, next, before]) => (next || '') !== (before || ''));

      for (const [key, value] of changed) await api.updateSetting(key, value);

      const b = changed.length ? await api.branding().catch(() => brand) : brand;
      setBrand(b);
      apply(saved, b);
      applyTheme(saved);
      toast.success(changed.length
        ? 'Apparence et identité enregistrées pour tous les postes.'
        : 'Apparence enregistrée pour tous les postes.');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const reset = async () => {
    try {
      const saved = await api.resetTheme();
      // Le nom de la clinique n'est pas remis à zéro : ce n'est pas une
      // préférence visuelle, et le retrouver vidé serait déroutant.
      apply(saved, brand); applyTheme(saved);
      toast.success('Apparence réinitialisée.');
    } catch (e) { toast.error(e.message); }
  };

  const pickLogo = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 256 Ko : au-delà, le serveur refuse. Le logo voyage en data-URI dans la
    // configuration, ce qui évite d'exposer un répertoire de fichiers envoyés.
    if (file.size > 256 * 1024) {
      toast.error('Logo trop volumineux : 256 Ko maximum.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set('logoDataUri', String(reader.result));
    reader.readAsDataURL(file);
  };

  if (error && !f) return <ErrorAlert error={error} />;
  if (!f) return <Spinner />;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Apparence de l'application</h3>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => setResetting(true)}>
            Réinitialiser</button>
          <button className="btn primary sm" disabled={busy} onClick={save}>
            Enregistrer</button>
        </div>
        <div className="card-body">
          <ErrorAlert error={error} />
          <p className="muted small" style={{ marginTop: 0 }}>
            Ces réglages sont enregistrés sur le serveur et s'appliquent à tous
            les postes de la clinique dès leur prochain chargement.
          </p>

          <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>Palette</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {THEME_PRESETS.map((p) => (
              <button key={p.key} type="button"
                      className={`btn ${f.preset === p.key ? 'primary' : ''} sm`}
                      onClick={() => setF({ ...f, preset: p.key, primaryColor: p.primary,
                                            accentColor: p.accent, sidebarColor: p.sidebar })}>
                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3,
                               background: p.primary, marginRight: 6,
                               border: '1px solid rgba(0,0,0,.2)' }} />
                {p.label}
              </button>
            ))}
          </div>

          <div className="row">
            <Field label="Couleur principale" error={error?.details?.primaryColor}
                   help="Boutons, liens et éléments actifs.">
              <ColorInput value={f.primaryColor}
                          onChange={(v) => setF({ ...f, primaryColor: v, preset: 'custom' })} /></Field>
            <Field label="Couleur d'accent" error={error?.details?.accentColor}
                   help="Surlignages et badges.">
              <ColorInput value={f.accentColor}
                          onChange={(v) => setF({ ...f, accentColor: v, preset: 'custom' })} /></Field>
            <Field label="Fond du menu latéral" error={error?.details?.sidebarColor}>
              <ColorInput value={f.sidebarColor}
                          onChange={(v) => setF({ ...f, sidebarColor: v, preset: 'custom' })} /></Field>
          </div>

          <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>Mise en page</h4>
          <div className="row">
            <Field label="Densité"
                   help="« Compacte » affiche davantage de lignes par écran.">
              <select value={f.density} onChange={(e) => set('density', e.target.value)}>
                <option value="comfortable">Confortable</option>
                <option value="compact">Compacte</option>
              </select></Field>
            <Field label="Arrondi des angles">
              <select value={f.radius} onChange={(e) => set('radius', e.target.value)}>
                <option value="square">Droits</option>
                <option value="medium">Moyens</option>
                <option value="round">Arrondis</option>
              </select></Field>
            <Field label={`Taille du texte — ${Math.round(f.fontScale * 100)} %`}
                   help="Utile sur les postes d'accueil équipés de grands écrans.">
              <input type="range" min="0.9" max="1.3" step="0.05" value={f.fontScale}
                     onChange={(e) => set('fontScale', Number(e.target.value))} /></Field>
          </div>

          <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>Identité de la clinique</h4>
          {/*
            * Le nom et les coordonnées vivent dans « app_setting », éditables
            * jusqu'ici depuis le seul onglet Paramètres — un tableau de clés
            * techniques et de valeurs JSON où personne ne pense à les
            * chercher. Ils sont repris ici, à côté du logo : changer le logo
            * sans pouvoir changer le nom qui l'accompagne n'a pas de sens.
            */}
          <div className="row">
            <Field label="Nom de la clinique"
                   help="Affiché dans le menu, sur l'écran de connexion et sur les documents imprimés.">
              <input value={f.clinicName} onChange={(e) => set('clinicName', e.target.value)}
                     placeholder="Clinique El Amel" /></Field>
            <Field label="Ville">
              <input value={f.clinicCity} onChange={(e) => set('clinicCity', e.target.value)}
                     placeholder="Alger" /></Field>
            <Field label="Téléphone">
              <input value={f.clinicPhone} onChange={(e) => set('clinicPhone', e.target.value)}
                     placeholder="021 00 00 00" /></Field>
          </div>
          <div className="row">
            <Field label="Logo" help="PNG ou JPEG, 256 Ko maximum. Affiché dans le menu et sur l'écran de connexion.">
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pickLogo} />
              {f.logoDataUri && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <img src={f.logoDataUri} alt="Logo de la clinique"
                       style={{ height: 40, borderRadius: 6, background: '#fff', padding: 3 }} />
                  <button type="button" className="btn ghost sm"
                          onClick={() => set('logoDataUri', '')}>Retirer</button>
                </div>
              )}
            </Field>
            <Field label="Message sur l'écran de connexion" error={error?.details?.loginMessage}
                   help="Par exemple les horaires d'ouverture ou un numéro d'astreinte.">
              <input value={f.loginMessage} onChange={(e) => set('loginMessage', e.target.value)}
                     placeholder="Accueil ouvert du dimanche au jeudi, 8 h – 17 h" /></Field>
          </div>

          <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>Aperçu</h4>
          <ThemePreview theme={f} />
        </div>
      </div>

      {resetting && (
        <ConfirmDialog title="Réinitialiser l'apparence ?" confirmLabel="Réinitialiser"
          onConfirm={reset} onClose={() => setResetting(false)}
          message="Couleurs, densité, logo et message de connexion reviendront aux valeurs livrées avec le logiciel." />
      )}
    </>
  );
}

/** Sélecteur de couleur doublé d'un champ texte, pour coller une valeur exacte. */
function ColorInput({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
             style={{ width: 42, height: 32, padding: 2, cursor: 'pointer' }} />
      <input value={value} onChange={(e) => onChange(e.target.value)}
             style={{ fontFamily: 'monospace' }} placeholder="#0f766e" />
    </div>
  );
}

/** Aperçu statique : juger des couleurs sans les imposer à toute la clinique. */
function ThemePreview({ theme }) {
  const radius = theme.radius === 'square' ? 0 : theme.radius === 'round' ? 14 : 8;
  return (
    <div style={{ display: 'flex', borderRadius: radius, overflow: 'hidden',
                  border: '1px solid var(--border)', maxWidth: 520,
                  fontSize: `${13 * theme.fontScale}px` }}>
      <div style={{ background: theme.sidebarColor, color: '#fff', padding: '14px 12px',
                    width: 130, display: 'grid', gap: 8, alignContent: 'start' }}>
        {theme.logoDataUri
          ? <img src={theme.logoDataUri} alt="" style={{ maxWidth: '100%', maxHeight: 28 }} />
          : <strong style={{ fontSize: '1em' }}>CliniRDV</strong>}
        <span style={{ opacity: .75 }}>Agenda</span>
        <span style={{ background: theme.primaryColor, borderRadius: radius / 2,
                       padding: '3px 7px' }}>Patients</span>
        <span style={{ opacity: .75 }}>Facturation</span>
      </div>
      <div style={{ padding: 14, flex: 1, background: '#fff', display: 'grid', gap: 9 }}>
        <strong style={{ fontSize: '1.1em' }}>Fiche patient</strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <span style={{ background: theme.primaryColor, color: '#fff', borderRadius: radius / 2,
                         padding: `${theme.density === 'compact' ? 4 : 7}px 12px` }}>
            Enregistrer</span>
          <span style={{ border: '1px solid var(--border)', borderRadius: radius / 2,
                         padding: `${theme.density === 'compact' ? 4 : 7}px 12px` }}>
            Annuler</span>
        </div>
        <span style={{ background: theme.accentColor, color: '#0b1a17', borderRadius: 20,
                       padding: '2px 10px', justifySelf: 'start' }}>Confirmé</span>
      </div>
    </div>
  );
}

/* --------------------------- Actes et tarifs ----------------------------- */

/**
 * Catalogue des actes : ce que dure un rendez-vous et ce qu'il coûte.
 *
 * Deux tableaux plutôt qu'un seul : un tarif sert souvent plusieurs formats
 * de rendez-vous, et l'on ajuste un prix bien plus souvent qu'une durée. Les
 * fusionner obligerait à ressaisir le même montant à chaque ligne, avec la
 * dérive que cela finit toujours par produire.
 */
function Catalogue() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [typeForm, setTypeForm] = useState(null);
  const [tariffForm, setTariffForm] = useState(null);
  const [archiving, setArchiving] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const toast = useToast();

  const load = () => { api.catalogue().then(setD).catch(setError); };
  useEffect(load, []);

  const archive = async () => {
    const { kind, row } = archiving;
    try {
      await (kind === 'tariff' ? api.archiveTariff(row.id) : api.archiveAppointmentType(row.id));
      toast.success('Retiré du catalogue.');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const restore = async (kind, row) => {
    try {
      await (kind === 'tariff' ? api.restoreTariff(row.id) : api.restoreAppointmentType(row.id));
      toast.success('Réactivé.');
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  const types = d.types.filter((t) => showArchived || t.is_active);
  const tariffs = d.tariffs.filter((t) => showArchived || t.is_active);

  return (
    <>
      <div className="alert info" style={{ marginBottom: 14 }}>
        <span>ⓘ</span>
        <div>
          Le <strong>type de rendez-vous</strong> fixe la durée réservée dans
          l'agenda ; le <strong>tarif</strong> fixe le montant porté sur la
          facture. Chaque type désigne le tarif appliqué par défaut, que l'on
          peut toujours corriger au moment de facturer.
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <label className="check">
          <input type="checkbox" checked={showArchived}
                 onChange={(e) => setShowArchived(e.target.checked)} />
          Afficher les éléments retirés
        </label>
      </div>

      {/* ------------------------ Types de rendez-vous ------------------- */}
      <div className="card">
        <div className="card-head">
          <h3>Types de rendez-vous</h3>
          <div className="spacer" />
          <button className="btn primary sm" onClick={() => setTypeForm({})}>
            + Nouveau type</button>
        </div>
        <div className="card-body tight">
          {types.length === 0 ? <Empty text="Aucun type de rendez-vous." /> : (
            <table>
              <thead><tr>
                <th>Acte</th><th className="num">Durée</th><th className="num">Battement</th>
                <th className="num">Créneau total</th><th>Tarif appliqué</th>
                <th className="num">RDV</th><th className="num">Actions</th>
              </tr></thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id} style={t.is_active ? undefined : { opacity: .55 }}>
                    <td>
                      <span style={{ display: 'inline-block', width: 9, height: 9,
                                     borderRadius: 2, background: t.color,
                                     marginRight: 7 }} />
                      <strong>{t.label}</strong>
                      <div className="muted small">{t.code}
                        {t.specialty_label && ` · ${t.specialty_label}`}
                        {t.requires_room && ' · salle requise'}</div>
                    </td>
                    <td className="num"><strong>{t.default_duration_minutes} min</strong></td>
                    <td className="num muted">
                      {t.buffer_before_minutes > 0 && `${t.buffer_before_minutes} av. `}
                      {t.buffer_after_minutes > 0 ? `${t.buffer_after_minutes} ap.` : ''}
                      {!t.buffer_before_minutes && !t.buffer_after_minutes && '—'}
                    </td>
                    {/* Ce que le créneau occupe réellement dans l'agenda :
                        c'est cette valeur qui détermine le nombre de patients
                        possibles dans une journée, pas la durée seule. */}
                    <td className="num muted">
                      {t.default_duration_minutes + t.buffer_before_minutes
                        + t.buffer_after_minutes} min</td>
                    <td>
                      {t.tariff_code
                        ? <><strong>{fmtMoney(t.tariff_amount)}</strong>
                            <div className="muted small">{t.tariff_code}</div></>
                        : <span className="badge orange">aucun tarif</span>}
                    </td>
                    <td className="num muted small">{t.appointment_count}</td>
                    <td className="num nowrap">
                      {t.is_active ? (
                        <>
                          <button className="btn sm" onClick={() => setTypeForm({ row: t })}>
                            Modifier</button>
                          <button className="btn ghost sm danger"
                                  onClick={() => setArchiving({ kind: 'type', row: t })}>
                            Retirer</button>
                        </>
                      ) : (
                        <button className="btn sm" onClick={() => restore('type', t)}>
                          Réactiver</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ------------------------------ Tarifs --------------------------- */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <h3>Tarifs</h3>
          <div className="spacer" />
          <button className="btn primary sm" onClick={() => setTariffForm({})}>
            + Nouveau tarif</button>
        </div>
        <div className="card-body tight">
          {tariffs.length === 0 ? <Empty text="Aucun tarif." /> : (
            <table>
              <thead><tr>
                <th>Code</th><th>Libellé</th><th className="num">Montant</th>
                <th className="num">TVA</th><th>Spécialité</th>
                <th className="num">Utilisé par</th><th className="num">Actions</th>
              </tr></thead>
              <tbody>
                {tariffs.map((t) => (
                  <tr key={t.id} style={t.is_active ? undefined : { opacity: .55 }}>
                    <td><strong>{t.code}</strong></td>
                    <td>{t.label}</td>
                    <td className="num"><strong>{fmtMoney(t.amount)}</strong></td>
                    <td className="num muted">{Number(t.vat_rate) > 0
                      ? `${Number(t.vat_rate)} %` : '—'}</td>
                    <td className="muted small">{t.specialty_label || '—'}</td>
                    <td className="num muted small">
                      {t.used_by_types} type(s)
                      {t.used_by_lines > 0 &&
                        <div>{t.used_by_lines} ligne(s) de facture</div>}
                    </td>
                    <td className="num nowrap">
                      {t.is_active ? (
                        <>
                          <button className="btn sm" onClick={() => setTariffForm({ row: t })}>
                            Modifier</button>
                          <button className="btn ghost sm danger"
                                  onClick={() => setArchiving({ kind: 'tariff', row: t })}>
                            Retirer</button>
                        </>
                      ) : (
                        <button className="btn sm" onClick={() => restore('tariff', t)}>
                          Réactiver</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {typeForm && <AppointmentTypeForm row={typeForm.row} tariffs={d.tariffs}
        specialties={d.specialties} onClose={() => setTypeForm(null)}
        onDone={() => { setTypeForm(null); load(); }} />}

      {tariffForm && <TariffForm row={tariffForm.row} specialties={d.specialties}
        onClose={() => setTariffForm(null)}
        onDone={() => { setTariffForm(null); load(); }} />}

      {archiving && (
        <ConfirmDialog title="Retirer du catalogue ?" danger confirmLabel="Retirer"
          onConfirm={archive} onClose={() => setArchiving(null)}
          message={`« ${archiving.row.label} » n'apparaîtra plus lors de la saisie.`}>
          <p className="muted small">
            Rien n'est supprimé : les rendez-vous et les factures qui s'y
            réfèrent restent intacts et lisibles. L'élément peut être réactivé
            à tout moment via « Afficher les éléments retirés ».
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Formulaire d'un type de rendez-vous : durée, battement, tarif par défaut. */
function AppointmentTypeForm({ row, tariffs, specialties, onClose, onDone }) {
  const editing = Boolean(row);
  const [f, setF] = useState({
    code: row?.code || '', label: row?.label || '',
    specialtyId: row?.specialty_id || '',
    defaultDurationMinutes: row?.default_duration_minutes ?? 20,
    bufferBeforeMinutes: row?.buffer_before_minutes ?? 0,
    bufferAfterMinutes: row?.buffer_after_minutes ?? 5,
    requiresRoom: row?.requires_room ?? true,
    color: row?.color || '#3b82f6',
    defaultTariffId: row?.default_tariff_id || '',
    preparationInstructions: row?.preparation_instructions || '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));
  const num = (k) => (e) => set(k, Number(e.target.value));

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      // Les listes déroulantes rendent '' quand rien n'est choisi ; l'API
      // attend un UUID ou l'absence du champ, pas une chaîne vide.
      const body = { ...f,
        specialtyId: f.specialtyId || undefined,
        defaultTariffId: f.defaultTariffId || undefined };
      if (editing) await api.updateAppointmentType(row.id, body);
      else await api.createAppointmentType(body);
      toast.success(editing ? 'Type mis à jour.' : 'Type créé.');
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const total = Number(f.defaultDurationMinutes || 0)
    + Number(f.bufferBeforeMinutes || 0) + Number(f.bufferAfterMinutes || 0);
  const chosen = tariffs.find((t) => t.id === f.defaultTariffId);

  return (
    <Modal title={editing ? `Modifier « ${row.label} »` : 'Nouveau type de rendez-vous'}
           onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {editing ? 'Enregistrer' : 'Créer'}</button>
      </>
    }>
      <ErrorAlert error={error} />
      <div className="row">
        <Field label="Code *" error={error?.details?.code}
               help="Repère court, par exemple CS-CARDIO.">
          <input value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())}
                 disabled={editing} autoFocus={!editing} /></Field>
        <Field label="Intitulé *" error={error?.details?.label}>
          <input value={f.label} onChange={(e) => set('label', e.target.value)}
                 autoFocus={editing} placeholder="Consultation cardiologie" /></Field>
      </div>

      <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>Durée</h4>
      <div className="row">
        <Field label="Durée de l'acte *" error={error?.details?.defaultDurationMinutes}
               help="Temps passé avec le patient, de 5 à 480 minutes.">
          <input type="number" min="5" max="480" step="5"
                 value={f.defaultDurationMinutes} onChange={num('defaultDurationMinutes')} /></Field>
        <Field label="Battement avant"
               help="Préparation de la salle ou du matériel.">
          <input type="number" min="0" max="120" step="5"
                 value={f.bufferBeforeMinutes} onChange={num('bufferBeforeMinutes')} /></Field>
        <Field label="Battement après"
               help="Nettoyage, compte rendu, marge de retard.">
          <input type="number" min="0" max="120" step="5"
                 value={f.bufferAfterMinutes} onChange={num('bufferAfterMinutes')} /></Field>
      </div>
      <div className="alert info" style={{ marginTop: -4 }}>
        <span>⏱</span>
        <div>
          Ce rendez-vous occupera <strong>{total} minutes</strong> dans l'agenda
          du praticien, soit environ <strong>{Math.floor(480 / (total || 1))}</strong> patients
          sur une journée de 8 heures. Les battements bloquent le créneau sans
          apparaître comme temps de consultation.
        </div>
      </div>

      <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>Facturation</h4>
      <div className="row">
        <Field label="Tarif appliqué par défaut"
               help="Reporté sur la facture ; modifiable acte par acte.">
          <select value={f.defaultTariffId}
                  onChange={(e) => set('defaultTariffId', e.target.value)}>
            <option value="">— Aucun —</option>
            {tariffs.filter((t) => t.is_active).map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.label} ({t.amount})</option>
            ))}
          </select></Field>
        <Field label="Spécialité">
          <select value={f.specialtyId} onChange={(e) => set('specialtyId', e.target.value)}>
            <option value="">— Aucune —</option>
            {specialties.map((sp) => (
              <option key={sp.id} value={sp.id}>{sp.label}</option>))}
          </select></Field>
      </div>
      {chosen && (
        <p className="muted small" style={{ marginTop: -6 }}>
          Un rendez-vous de ce type sera facturé <strong>{fmtMoney(chosen.amount)}</strong>.
        </p>
      )}

      <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>Organisation</h4>
      <div className="row">
        <Field label="Couleur dans l'agenda">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="color" value={f.color}
                   onChange={(e) => set('color', e.target.value)}
                   style={{ width: 42 }} />
            <input value={f.color} onChange={(e) => set('color', e.target.value)}
                   style={{ fontFamily: 'monospace' }} />
          </div></Field>
        <Field label="Salle">
          <label className="check" style={{ minHeight: 38 }}>
            <input type="checkbox" checked={f.requiresRoom}
                   onChange={(e) => set('requiresRoom', e.target.checked)} />
            Une salle est nécessaire
          </label></Field>
      </div>
      <Field label="Consignes de préparation au patient"
             help="Affichées lors de la prise de rendez-vous. Ex. : venir à jeun.">
        <input value={f.preparationInstructions}
               onChange={(e) => set('preparationInstructions', e.target.value)} /></Field>

      {editing && (
        <div className="alert warning" style={{ marginTop: 10 }}>
          <span>⚠</span>
          <div>La nouvelle durée s'appliquera aux <strong>prochains</strong> rendez-vous.
            Ceux déjà planifiés gardent l'horaire annoncé au patient.</div>
        </div>
      )}
    </Modal>
  );
}

/** Formulaire d'un tarif : code, libellé, montant. */
function TariffForm({ row, specialties, onClose, onDone }) {
  const editing = Boolean(row);
  const [f, setF] = useState({
    code: row?.code || '', label: row?.label || '',
    amount: row ? Number(row.amount) : 0,
    vatRate: row ? Number(row.vat_rate) : 0,
    specialtyId: row?.specialty_id || '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const body = { ...f, specialtyId: f.specialtyId || undefined };
      if (editing) await api.updateTariff(row.id, body);
      else await api.createTariff(body);
      toast.success(editing ? 'Tarif mis à jour.' : 'Tarif créé.');
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const priceChanged = editing && Number(row.amount) !== Number(f.amount);

  return (
    <Modal title={editing ? `Modifier le tarif ${row.code}` : 'Nouveau tarif'}
           onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {editing ? 'Enregistrer' : 'Créer'}</button>
      </>
    }>
      <ErrorAlert error={error} />
      <div className="row">
        <Field label="Code *" error={error?.details?.code}
               help="Lettre-clé de la nomenclature : C, CS, K, B…">
          <input value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())}
                 autoFocus={!editing} placeholder="CS-CARDIO" /></Field>
        <Field label="Montant en DA *" error={error?.details?.amount}>
          <input type="number" min="0" step="50" value={f.amount}
                 onChange={(e) => set('amount', Number(e.target.value))}
                 autoFocus={editing} /></Field>
      </div>
      <Field label="Libellé *" error={error?.details?.label}
             help="Texte imprimé sur la facture du patient.">
        <input value={f.label} onChange={(e) => set('label', e.target.value)}
               placeholder="Consultation cardiologie" /></Field>
      <div className="row">
        <Field label="TVA en %"
               help="Les actes médicaux en sont généralement exonérés : laisser 0.">
          <input type="number" min="0" max="100" step="0.5" value={f.vatRate}
                 onChange={(e) => set('vatRate', Number(e.target.value))} /></Field>
        <Field label="Spécialité">
          <select value={f.specialtyId} onChange={(e) => set('specialtyId', e.target.value)}>
            <option value="">— Aucune —</option>
            {specialties.map((sp) => (
              <option key={sp.id} value={sp.id}>{sp.label}</option>))}
          </select></Field>
      </div>

      {priceChanged && (
        <div className="alert info">
          <span>ⓘ</span>
          <div>
            Le prix passera de <strong>{fmtMoney(row.amount)}</strong> à
            {' '}<strong>{fmtMoney(f.amount)}</strong> pour les
            <strong> prochaines</strong> facturations.
            Les factures déjà établies conservent leur montant : elles gardent
            une copie du prix appliqué le jour de leur émission.
          </div>
        </div>
      )}
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
  const [restoring, setRestoring] = useState(null);
  const toast = useToast();

  const load = () => { api.backups().then(setD).catch(setError); };
  // Accolades indispensables : en flèche concise, `load` retournerait la
  // promesse, que React prendrait pour la fonction de nettoyage et
  // appellerait au démontage → « is not a function » à la navigation.
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
                <th>Empreinte</th><th>État</th><th className="num">Actions</th></tr></thead>
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
                    <td className="num nowrap">
                      {b.status === 'SUCCESS' && (
                        <button className="btn sm" onClick={() => setRestoring(b)}
                                title="Vérifier l'archive et afficher la marche à suivre">
                          Restaurer…</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {restoring && <RestoreBackup run={restoring} onClose={() => setRestoring(null)} />}

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

/**
 * Restauration d'une sauvegarde.
 *
 * L'opération ne se fait pas d'un clic, et c'est délibéré : réécrire la base
 * pendant que des postes encaissent et modifient des dossiers provoquerait des
 * pertes silencieuses. Le serveur vérifie donc l'archive (présence, taille,
 * empreinte SHA-256) puis renvoie la marche à suivre, à dérouler application
 * arrêtée. La confirmation « RESTAURER » et le motif alimentent le journal
 * d'audit : une restauration doit rester une décision tracée.
 */
function RestoreBackup({ run, onClose }) {
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      setResult(await api.restoreBackup(run.id, reason));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const commands = result ? result.procedure.join('\n') : '';

  return (
    <Modal title="Restaurer une sauvegarde" onClose={onClose} wide footer={
      result
        ? <button className="btn primary" onClick={onClose}>Fermer</button>
        : <>
            <button className="btn" onClick={onClose}>Annuler</button>
            <button className="btn danger" disabled={busy || confirm !== 'RESTAURER'}
                    onClick={submit}>
              {busy ? 'Vérification…' : 'Vérifier et afficher la procédure'}</button>
          </>
    }>
      <ErrorAlert error={error} />

      <table style={{ marginBottom: 14 }}>
        <tbody>
          <tr><td className="muted small">Date</td>
              <td><strong>{fmtDateTime(run.started_at)}</strong></td></tr>
          <tr><td className="muted small">Fichier</td>
              <td><code style={{ fontSize: 12 }}>
                {(run.target_path || '').split(/[/\\]/).pop()}</code></td></tr>
          <tr><td className="muted small">Taille</td>
              <td>{run.size_bytes
                ? `${(run.size_bytes / 1048576).toFixed(1)} Mo` : '—'}</td></tr>
        </tbody>
      </table>

      {!result ? (
        <>
          <div className="alert warning">
            <span>⚠</span>
            <div>
              <strong>La restauration remplace l'intégralité des données
                actuelles.</strong>
              <p style={{ marginTop: 6, fontSize: 12.5 }}>
                Tout ce qui a été saisi depuis le {fmtDateTime(run.started_at)} —
                rendez-vous, encaissements, dossiers — sera perdu. Lancez une
                sauvegarde de l'état courant avant de poursuivre : elle vous
                permettra de revenir en arrière si la restauration ne donne pas
                le résultat attendu.
              </p>
            </div>
          </div>

          <Field label="Motif de la restauration"
                 help="Consigné au journal d'audit, avec votre nom et l'horodatage.">
            <input value={reason} onChange={(e) => setReason(e.target.value)}
                   placeholder="Ex. : corruption après coupure de courant" /></Field>

          <Field label="Saisissez RESTAURER pour confirmer"
                 help="Cette saisie évite un clic malencontreux sur une opération irréversible.">
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)}
                   autoFocus placeholder="RESTAURER" /></Field>
        </>
      ) : (
        <>
          <div className="alert success">
            <span>✓</span>
            <div>
              <strong>Archive vérifiée et intacte.</strong>
              <p style={{ marginTop: 4, fontSize: 12.5 }}>
                L'empreinte SHA-256 correspond : le fichier n'a pas été altéré.
              </p>
            </div>
          </div>

          <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>Marche à suivre</h4>
          <p className="muted small" style={{ marginTop: 0 }}>
            À dérouler sur le serveur, application arrêtée. La restauration
            n'est pas exécutée automatiquement : elle exige que plus aucun poste
            n'écrive dans la base.
          </p>
          <pre style={{ padding: 12, background: 'var(--surface-2)',
                        border: '1px solid var(--border)', borderRadius: 8,
                        fontSize: 11.5, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {commands}
          </pre>
          <button className="btn sm" onClick={() => {
            navigator.clipboard?.writeText(commands).then(() => setCopied(true));
          }}>{copied ? 'Copié ✓' : 'Copier la procédure'}</button>
        </>
      )}
    </Modal>
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

/* ------------------------------ Vue d'ensemble ---------------------------- */
/*
 * Écran d'accueil de l'administration.
 *
 * Le constat de départ : l'administrateur d'une clinique n'est pas
 * informaticien. C'est souvent le gérant ou un responsable administratif. Les
 * informations dont il a besoin — « la sauvegarde d'hier a-t-elle réussi ? »,
 * « reste-t-il de la place sur le disque ? », « qui a annulé cette facture ? »
 * — étaient dispersées sur quatre onglets et exprimées en termes techniques.
 *
 * Cette page répond à une seule question : « y a-t-il quelque chose à faire
 * aujourd'hui ? ». Chaque anomalie est accompagnée du geste correctif, à
 * portée de clic, sans terminal ni ligne de commande.
 */
function Overview({ go }) {
  // Repli sur les rappels de navigation : cette page peut être montée
  // hors de App.jsx. Un appel sur une prop absente ferait tomber tout
  // l'écran en « is not a function ».
  go = go || (() => {});
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = () => Promise.all([
    api.system(),
    api.backups().catch(() => ({ items: [] })),
    api.users().catch(() => ({ items: [] })),
  ]).then(([sys, backups, users]) => setD({ sys, backups, users })).catch(setError);

  useEffect(() => { load(); }, []);

  const runBackup = async () => {
    setBusy(true);
    try {
      await api.runBackup();
      toast.success('Sauvegarde terminée.');
      await load();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  const { sys, backups, users } = d;
  const last = backups.items?.[0] || sys.lastBackup;

  /* --- Évaluation des indicateurs ---
     Les seuils sont volontairement conservateurs : mieux vaut une alerte de
     trop qu'une base perdue. */
  const now = Date.now();
  const backupAgeH = last?.started_at
    ? (now - new Date(last.started_at).getTime()) / 3.6e6 : Infinity;
  const backupLevel = !last || backupAgeH > 48 ? 'bad'
    : backupAgeH > 26 ? 'warn' : 'ok';

  const lockedUsers = (users.items || []).filter((u) => u.status === 'LOCKED');
  const staleUsers = (users.items || []).filter((u) =>
    u.status === 'ACTIVE' && u.last_login_at &&
    (now - new Date(u.last_login_at).getTime()) > 90 * 864e5);
  const mustChange = (users.items || []).filter((u) => u.must_change_password);

  const problems = [];
  if (backupLevel === 'bad') {
    problems.push({
      key: 'backup',
      text: last
        ? `La dernière sauvegarde remonte à ${Math.floor(backupAgeH / 24)} jour(s).`
        : 'Aucune sauvegarde n\'a jamais été effectuée.',
      action: <button className="btn danger sm" onClick={runBackup} disabled={busy}>
                {busy ? 'Sauvegarde…' : 'Sauvegarder maintenant'}</button>,
      danger: true,
    });
  }
  if (staleUsers.length > 0) {
    problems.push({
      key: 'stale',
      text: `${staleUsers.length} compte(s) sans connexion depuis plus de 90 jours.`,
      action: <button className="btn sm" onClick={() => go('users')}>Examiner</button>,
    });
  }
  if (mustChange.length > 0) {
    problems.push({
      key: 'pwd',
      text: `${mustChange.length} compte(s) avec un mot de passe provisoire non changé.`,
      action: <button className="btn sm" onClick={() => go('users')}>Voir la liste</button>,
    });
  }

  return (
    <>
      <PageHead
        title="Vue d'ensemble"
        subtitle="État de l'installation et actions à entreprendre."
        actions={
          <>
            <button className="btn sm" onClick={load}>Actualiser</button>
            <button className="btn primary sm" onClick={runBackup} disabled={busy}>
              {busy ? 'Sauvegarde en cours…' : 'Sauvegarder la base'}
            </button>
          </>
        }
      />

      {problems.length === 0 ? (
        <div className="alert success">
          <span>✓</span>
          <div>Aucune action requise. La dernière sauvegarde date
            de {fmtDateTime(last?.started_at)}.</div>
        </div>
      ) : problems.map((p) => (
        <ActionStrip key={p.key} danger={p.danger} action={p.action}>{p.text}</ActionStrip>
      ))}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>État du système</h3></div>
        <div className="card-body">
          <div className="health-grid">
            <HealthItem
              level={sys.database?.size ? 'ok' : 'warn'}
              title="Base de données"
              value={`PostgreSQL · ${sys.database?.size || 'taille inconnue'}`}
            />
            <HealthItem
              level={backupLevel}
              title="Sauvegarde"
              value={last
                ? `${fmtDateTime(last.started_at)} · ${
                    ((last.size_bytes || 0) / 1048576).toFixed(1)} Mo`
                : 'jamais exécutée'}
              fix={backupLevel !== 'ok' &&
                <button className="btn sm" onClick={runBackup} disabled={busy}>
                  Lancer une sauvegarde</button>}
            />
            <HealthItem
              level="ok"
              title="Disponibilité du service"
              value={`${Math.floor(sys.uptimeSeconds / 3600)} h ${
                Math.floor((sys.uptimeSeconds % 3600) / 60)} min sans interruption`}
            />
            <HealthItem
              level={lockedUsers.length > 0 ? 'warn' : 'ok'}
              title="Comptes utilisateurs"
              value={`${(users.items || []).length} compte(s)${
                lockedUsers.length ? ` · ${lockedUsers.length} verrouillé(s)` : ''}`}
              fix={lockedUsers.length > 0 &&
                <button className="btn sm" onClick={() => go('users')}>Gérer</button>}
            />
            <HealthItem
              level="ok"
              title="Confidentialité"
              value="Aucune connexion sortante · données hébergées localement"
            />
            <HealthItem
              level="ok"
              title="Journal d'audit"
              value={`${sys.counts?.audit_entries ?? 0} entrées tracées`}
              fix={<button className="btn sm" onClick={() => go('audit')}>Consulter</button>}
            />
          </div>
        </div>
      </div>

      <div className="grid c4">
        <Stat label="Patients" value={sys.counts?.patients ?? 0} accent="teal" />
        <Stat label="Praticiens" value={sys.counts?.practitioners ?? 0} accent="purple" />
        <Stat label="Rendez-vous" value={sys.counts?.appointments ?? 0} accent="green" />
        <Stat label="Factures" value={sys.counts?.invoices ?? 0} accent="orange" />
      </div>
    </>
  );
}
