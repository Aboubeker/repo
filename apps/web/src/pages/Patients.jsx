import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, Empty, Modal, Field, ErrorAlert, ConfirmDialog, RowActions, fmtName, fmtMoney,
         age, can, useToast } from '../lib.jsx';

export default function Clients({ user, go }) {
  // Repli sur les rappels de navigation : cette page peut être montée
  // hors de App.jsx. Un appel sur une prop absente ferait tomber tout
  // l'écran en « is not a function ».
  go = go || (() => {});
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [archiving, setArchiving] = useState(null);
  const [status, setStatus] = useState('ACTIVE');
  const toast = useToast();
  const writable = can(user, 'patient.write');
  const [exporting, setExporting] = useState(false);

  /*
   * L'export porte sur la recherche et le filtre en cours, mais sur la
   * TOTALITÉ des fiches correspondantes : l'écran n'en affiche que 100,
   * exporter le tableau visible produirait un fichier tronqué sans le dire.
   */
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const name = await api.exportPatientsCsv({ q: q || undefined, status });
      toast.success(`Export téléchargé : ${name}`);
    } catch (err) { setError(err); } finally { setExporting(false); }
  };

  const load = (query, st) => {
    setData(null);
    api.clients({ q: query, status: st, limit: 100 }).then(setData).catch(setError);
  };

  useEffect(function reloadOnSearch() {
    const t = setTimeout(() => load(q, status), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, status]);

  const archive = async () => {
    try {
      await api.archivePatient(archiving.id);
      toast.success(`Fiche ${archiving.mrn} archivée.`);
      load(q, status);
    } catch (err) { setError(err); }
  };

  const restore = async (p) => {
    try {
      await api.restorePatient(p.id);
      toast.success(`Fiche ${p.mrn} réactivée.`);
      load(q, status);
    } catch (err) { setError(err); }
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="search-global" style={{ width: 380 }}>
            <span className="icon">🔍</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
                   placeholder="Nom, prénom, identifiant, téléphone, date de naissance…" />
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
                  style={{ maxWidth: 180 }}>
            <option value="ACTIVE">Fiches actives</option>
            <option value="ARCHIVED">Fiches archivées</option>
          </select>
          <div className="spacer" />
          {data && <span className="muted small">{data.total} client(s)</span>}
          <button className="btn sm" onClick={exportCsv} disabled={exporting || !data}
                  title="Télécharger la liste complète au format CSV">
            {exporting ? 'Export…' : '⭳ Exporter (CSV)'}</button>
          {can(user, 'patient.write') && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              + Nouveau client</button>
          )}
        </div>

        <div className="card-body tight">
          <ErrorAlert error={error} />
          {!data ? <Spinner /> : data.items.length === 0 ? (
            <Empty icon="⚕" text={q ? 'Aucun client ne correspond à cette recherche.'
                                    : 'Aucun client enregistré.'} />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Identifiant</th><th>Nom, prénom</th><th>Naissance</th>
                  <th>Téléphone</th><th className="hide-md">Dernière visite</th><th className="hide-md">Prochain RDV</th>
                  <th className="num">Solde</th><th></th><th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => go('patient', p.id)}>
                    <td className="muted small">{p.mrn}</td>
                    <td><strong>{fmtName(p.last_name, p.first_name)}</strong></td>
                    <td>{new Date(p.birth_date).toLocaleDateString('fr-FR')}
                      <span className="muted small"> ({age(p.birth_date)} ans)</span></td>
                    <td className="muted">{p.phone_mobile || '—'}</td>
                    <td className="muted small hide-md">
                      {p.last_visit_at ? new Date(p.last_visit_at).toLocaleDateString('fr-FR') : '—'}</td>
                    <td className="small hide-md">
                      {p.next_visit_at
                        ? <span className="badge blue">
                            {new Date(p.next_visit_at).toLocaleDateString('fr-FR')}</span>
                        : <span className="muted">—</span>}</td>
                    <td className="num">
                      {Number(p.outstanding_balance) > 0
                        ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                            {fmtMoney(p.outstanding_balance)}</span>
                        : <span className="muted">{fmtMoney(0)}</span>}</td>
                    <td>
                      {Number(p.critical_allergy_count) > 0 &&
                        <span className="badge red" title="Allergie critique">⚠</span>}
                      {Number(p.no_show_count) >= 3 &&
                        <span className="badge orange" title="Absences répétées">
                          {p.no_show_count} abs.</span>}
                    </td>
                    {/* onClick={stop} : sans cela, un clic sur « Modifier »
                        déclencherait aussi la navigation portée par la ligne. */}
                    <td className="num actions-cell" onClick={(e) => e.stopPropagation()}>
                      {writable && (
                        <RowActions label={`Actions pour ${p.mrn}`} items={
                          status === 'ACTIVE' ? [
                            { icon: '✎', label: 'Modifier',
                              title: "Modifier l'identité et les coordonnées",
                              onSelect: () => setEditing(p) },
                            { icon: '📁', label: 'Ouvrir le dossier',
                              onSelect: () => go('patient', p.id) },
                            { sep: true },
                            { icon: '🗑', label: 'Archiver', danger: true,
                              title: 'Retirer la fiche des listes actives',
                              onSelect: () => setArchiving(p) },
                          ] : [
                            { icon: '▶', label: 'Réactiver',
                              title: 'Remettre la fiche parmi les clients actifs',
                              onSelect: () => restore(p) },
                          ]
                        } />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {creating && <PatientForm onClose={() => setCreating(false)}
        onSaved={(p) => { setCreating(false); go('patient', p.id); }} />}

      {editing && <PatientForm client={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(q, status); }} />}

      {archiving && (
        <ConfirmDialog
          title="Archiver cette fiche client ?"
          danger confirmLabel="Archiver la fiche"
          onConfirm={archive} onClose={() => setArchiving(null)}
          message={`La fiche de ${fmtName(archiving.last_name, archiving.first_name)} (${archiving.mrn}) quittera les listes actives.`}>
          <p className="muted small">
            Rien n'est effacé : l'historique de soins, les rendez-vous passés et
            les factures restent consultables, et la fiche peut être réactivée à
            tout moment depuis le filtre « Fiches archivées ». L'archivage est
            refusé s'il reste des rendez-vous à venir.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * Formulaire de fiche client, en création comme en modification.
 *
 * Un seul composant pour les deux usages : les champs, les règles de saisie et
 * les messages d'erreur sont par construction identiques, alors que deux
 * formulaires jumeaux finiraient par diverger au fil des évolutions.
 */
function PatientForm({ client, onClose, onSaved }) {
  const editing = Boolean(client);
  const [f, setF] = useState({
    lastName: '', firstName: '', birthDate: '', sex: 'U', phoneMobile: '',
    email: '', addressLine1: '', postalCode: '', city: '', bloodType: '',
  });
  // En modification, la ligne de tableau ne porte qu'un extrait des colonnes :
  // on recharge la fiche complète pour ne pas réécrire l'adresse avec du vide.
  const [loading, setLoading] = useState(editing);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  useEffect(function loadFullRecord() {
    if (!editing) return undefined;
    let cancelled = false;
    api.client(client.id).then((d) => {
      if (cancelled) return;
      const p = d.patient;
      setF({
        lastName: p.last_name || '', firstName: p.first_name || '',
        birthDate: (p.birth_date || '').slice(0, 10), sex: p.sex || 'U',
        phoneMobile: p.phone_mobile || '', email: p.email || '',
        addressLine1: p.address_line1 || '', postalCode: p.postal_code || '',
        city: p.city || '', bloodType: p.blood_type || '',
      });
      setLoading(false);
    }).catch((err) => { if (!cancelled) { setError(err); setLoading(false); } });
    return () => { cancelled = true; };
  }, [editing, client && client.id]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || loading) return;
    setBusy(true); setError(null);
    try {
      const saved = editing
        ? await api.updatePatient(client.id, f)
        : await api.createPatient(f);
      toast.success(editing ? `Fiche ${saved.mrn} mise à jour.` : `Client ${saved.mrn} créé.`);
      onSaved(saved);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal title={editing ? `Modifier la fiche ${client.mrn}` : 'Nouveau client'}
           onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={busy || loading} onClick={submit}>
          {editing ? 'Enregistrer' : 'Créer la fiche'}
        </button>
      </>
    }>
      {loading ? <Spinner /> : (
        <form onSubmit={submit}>
          <ErrorAlert error={error} />
          {error?.code === 'DUPLICATE_PATIENT' && (
            <div className="alert warning">
              <span>⚠</span>
              <div>Un client identique existe déjà ({error.details?.mrn}).
                Vérifiez avant de créer un doublon.</div>
            </div>
          )}
          <h4 style={{ fontSize: 13, marginBottom: 10 }}>Identité</h4>
          <div className="row">
            <Field label="Nom *" error={error?.details?.lastName}>
              <input value={f.lastName} onChange={set('lastName')} required autoFocus /></Field>
            <Field label="Prénom *" error={error?.details?.firstName}>
              <input value={f.firstName} onChange={set('firstName')} required /></Field>
          </div>
          <div className="row">
            <Field label="Date de naissance *" error={error?.details?.birthDate}>
              <input type="date" value={f.birthDate} onChange={set('birthDate')} required /></Field>
            <Field label="Sexe">
              <select value={f.sex} onChange={set('sex')}>
                <option value="U">Non précisé</option><option value="F">Féminin</option>
                <option value="M">Masculin</option></select></Field>
            <Field label="Groupe sanguin">
              <select value={f.bloodType} onChange={set('bloodType')}>
                <option value="">—</option>
                {['A+','A-','B+','B-','AB+','AB-','O+','O-'].map((g) =>
                  <option key={g}>{g}</option>)}</select></Field>
          </div>

          <h4 style={{ fontSize: 13, margin: '14px 0 10px' }}>Coordonnées</h4>
          <div className="row">
            <Field label="Téléphone mobile" error={error?.details?.phoneMobile}>
              <input value={f.phoneMobile} onChange={set('phoneMobile')}
                     placeholder="0551 23 45 67" /></Field>
            <Field label="Adresse e-mail" error={error?.details?.email}>
              <input type="email" value={f.email} onChange={set('email')} /></Field>
          </div>
          <Field label="Adresse"><input value={f.addressLine1} onChange={set('addressLine1')} /></Field>
          <div className="row">
            <Field label="Code postal"><input value={f.postalCode} onChange={set('postalCode')} /></Field>
            <Field label="Ville"><input value={f.city} onChange={set('city')} /></Field>
          </div>
        </form>
      )}
    </Modal>
  );
}
