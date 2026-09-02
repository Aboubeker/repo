import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, Empty, Modal, Field, ErrorAlert, fmtName, fmtMoney,
         age, can, useToast } from '../lib.jsx';

export default function Patients({ user, go }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = (query) => {
    setData(null);
    api.patients({ q: query, limit: 100 }).then(setData).catch(setError);
  };

  useEffect(() => {
    const t = setTimeout(() => load(q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="search-global" style={{ width: 380 }}>
            <span className="icon">🔍</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
                   placeholder="Nom, prénom, identifiant, téléphone, date de naissance…" />
          </div>
          <div className="spacer" />
          {data && <span className="muted small">{data.total} patient(s)</span>}
          {can(user, 'patient.write') && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              + Nouveau patient</button>
          )}
        </div>

        <div className="card-body tight">
          <ErrorAlert error={error} />
          {!data ? <Spinner /> : data.items.length === 0 ? (
            <Empty icon="⚕" text={q ? 'Aucun patient ne correspond à cette recherche.'
                                    : 'Aucun patient enregistré.'} />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Identifiant</th><th>Nom, prénom</th><th>Naissance</th>
                  <th>Téléphone</th><th>Dernière visite</th><th>Prochain RDV</th>
                  <th className="num">Solde</th><th></th>
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
                    <td className="muted small">
                      {p.last_visit_at ? new Date(p.last_visit_at).toLocaleDateString('fr-FR') : '—'}</td>
                    <td className="small">
                      {p.next_visit_at
                        ? <span className="badge blue">
                            {new Date(p.next_visit_at).toLocaleDateString('fr-FR')}</span>
                        : <span className="muted">—</span>}</td>
                    <td className="num">
                      {Number(p.outstanding_balance) > 0
                        ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                            {fmtMoney(p.outstanding_balance)}</span>
                        : <span className="muted">0,00 €</span>}</td>
                    <td>
                      {Number(p.critical_allergy_count) > 0 &&
                        <span className="badge red" title="Allergie critique">⚠</span>}
                      {Number(p.no_show_count) >= 3 &&
                        <span className="badge orange" title="Absences répétées">
                          {p.no_show_count} abs.</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {creating && <CreatePatient onClose={() => setCreating(false)}
        onCreated={(p) => { setCreating(false); go('patient', p.id); }} />}
    </>
  );
}

function CreatePatient({ onClose, onCreated }) {
  const [f, setF] = useState({
    lastName: '', firstName: '', birthDate: '', sex: 'U', phoneMobile: '',
    email: '', addressLine1: '', postalCode: '', city: '', bloodType: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const p = await api.createPatient(f);
      toast.success(`Patient ${p.mrn} créé.`);
      onCreated(p);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal title="Nouveau patient" onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn primary" disabled={busy} onClick={submit}>Créer la fiche</button>
      </>
    }>
      <form onSubmit={submit}>
        <ErrorAlert error={error} />
        {error?.code === 'DUPLICATE_PATIENT' && (
          <div className="alert warning">
            <span>⚠</span>
            <div>Un patient identique existe déjà ({error.details?.mrn}).
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
                   placeholder="06 12 34 56 78" /></Field>
          <Field label="Adresse e-mail" error={error?.details?.email}>
            <input type="email" value={f.email} onChange={set('email')} /></Field>
        </div>
        <Field label="Adresse"><input value={f.addressLine1} onChange={set('addressLine1')} /></Field>
        <div className="row">
          <Field label="Code postal"><input value={f.postalCode} onChange={set('postalCode')} /></Field>
          <Field label="Ville"><input value={f.city} onChange={set('city')} /></Field>
        </div>
      </form>
    </Modal>
  );
}
