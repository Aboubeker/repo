import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Spinner, Empty, Modal, Field, ErrorAlert, Badge, INVOICE_STATUS, PAYMENT_METHODS,
  Stat, fmtDate, fmtMoney, fmtName, can, useToast, stampDuty,
} from '../lib.jsx';
import InvoicePrint from '../InvoicePrint.jsx';

export default function Billing({ user, go }) {
  // Repli sur les rappels de navigation : cette page peut être montée
  // hors de App.jsx. Un appel sur une prop absente ferait tomber tout
  // l'écran en « is not a function ».
  go = go || (() => {});
  const [tab, setTab] = useState('invoices');
  return (
    <>
      <div className="tabs">
        <button className={tab === 'invoices' ? 'active' : ''}
                onClick={() => setTab('invoices')}>Factures</button>
        <button className={tab === 'outstanding' ? 'active' : ''}
                onClick={() => setTab('outstanding')}>Impayés</button>
        <button className={tab === 'cash' ? 'active' : ''}
                onClick={() => setTab('cash')}>Caisse</button>
      </div>
      {tab === 'invoices'    && <Invoices user={user} go={go} />}
      {tab === 'outstanding' && <Outstanding user={user} go={go} />}
      {tab === 'cash'        && <Cash user={user} />}
    </>
  );
}

/* ------------------------------ Factures -------------------------------- */
function Invoices({ user, go }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = () => {
    setData(null);
    api.invoices({ status: status || undefined }).then(setData).catch(setError);
  };
  useEffect(load, [status]);

  if (error) return <ErrorAlert error={error} />;

  return (
    <>
      {data && (
        <div className="grid c3" style={{ marginBottom: 14 }}>
          <Stat label="Total facturé" value={fmtMoney(data.totals.total)} accent="blue" />
          <Stat label="Encaissé" value={fmtMoney(data.totals.paid)} accent="green" />
          <Stat label="Encours" value={fmtMoney(data.totals.outstanding)} accent="orange" />
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Factures</h3>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
                  style={{ width: 190 }}>
            <option value="">Tous les statuts</option>
            {Object.entries(INVOICE_STATUS).map(([k, v]) =>
              <option key={k} value={k}>{v.label}</option>)}
          </select>
          <div className="spacer" />
          <button className="btn sm" onClick={load}>Actualiser</button>
        </div>
        <div className="card-body tight">
          {!data ? <Spinner /> : data.items.length === 0
            ? <Empty icon="▤" text="Aucune facture pour ce filtre." /> : (
            <table>
              <thead><tr><th>Numéro</th><th>Date</th><th>Client</th><th>Praticien</th>
                <th className="num">Total</th><th className="num">Payé</th>
                <th className="num">Solde</th><th>Statut</th></tr></thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => setOpenId(i.id)}>
                    <td><strong>{i.number || '—'}</strong></td>
                    <td className="muted small">{fmtDate(i.issued_at || i.created_at)}</td>
                    <td>{fmtName(i.patient_last_name, i.patient_first_name)}
                      <div className="muted small">{i.mrn}</div></td>
                    <td className="muted small">
                      {i.practitioner_last_name ? `Dr ${i.practitioner_last_name}` : '—'}</td>
                    <td className="num">{fmtMoney(i.total_amount)}</td>
                    <td className="num muted">{fmtMoney(i.paid_amount)}</td>
                    <td className="num" style={{ color: Number(i.balance) > 0
                      ? 'var(--danger)' : undefined, fontWeight: Number(i.balance) > 0 ? 600 : 400 }}>
                      {fmtMoney(i.balance)}</td>
                    <td><Badge status={i.status} map={INVOICE_STATUS} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {openId && <InvoiceDetail id={openId} user={user} go={go}
        onClose={() => setOpenId(null)} onChanged={() => { setOpenId(null); load(); }} />}
    </>
  );
}

function InvoiceDetail({ id, user, go, onClose, onChanged }) {
  // Panneau réutilisable : selon l'appelant, tous les rappels ne sont pas
  // fournis. Sans repli, un simple clic ferait tomber l'écran entier.
  go = go || (() => {});
  onClose = onClose || (() => {});
  onChanged = onChanged || (() => {});
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const toast = useToast();

  const [branding, setBranding] = useState(null);
  // L'en-tête du document imprimé vient du paramétrage de la clinique :
  // le coder en dur produirait une facture au nom d'une autre structure.
  useEffect(function loadBranding() {
    api.branding().then(setBranding).catch(() => setBranding({}));
  }, []);

  const load = () => { api.invoice(id).then(setD).catch(setError); };
  // Accolades indispensables : en flèche concise, `load` retournerait la
  // promesse, que React prendrait pour la fonction de nettoyage et
  // appellerait au démontage → « is not a function » à la navigation.
  useEffect(load, [id]);

  if (!d) return <Modal title="Facture" onClose={onClose}><Spinner /></Modal>;
  const inv = d.invoice;

  const act = async (fn, msg) => {
    setBusy(true); setError(null);
    try { await fn(); toast.success(msg); onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  /*
   * Une facture n'est modifiable qu'a l'etat de brouillon : l'emission lui
   * attribue un numero legal et la rend immuable (le serveur repond 422
   * INVOICE_NOT_DRAFT). On n'affiche donc les controles d'edition que la ou
   * ils peuvent aboutir, plutot que de laisser l'utilisateur decouvrir le
   * refus apres coup.
   */
  const editable = inv.status === 'DRAFT' && can(user, 'invoice.write');

  const changeLine = async (line, patch, previous) => {
    const [field] = Object.keys(patch);
    if (patch[field] === previous || Number.isNaN(patch[field])) return;
    setBusy(true); setError(null);
    try { await api.updateInvoiceLine(id, line.id, patch); load(); onChanged(); }
    catch (e) { setError(e); load(); } finally { setBusy(false); }
  };

  const removeLine = async (line) => {
    setBusy(true); setError(null);
    try { await api.deleteInvoiceLine(id, line.id); load(); onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title={inv.number || 'Facture (brouillon)'} onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={() => window.print()}>🖨 Imprimer</button>
        {inv.status === 'DRAFT' && can(user, 'invoice.write') && (
          <button className="btn primary" disabled={busy}
            onClick={() => act(() => api.issueInvoice(id), 'Facture émise.')}>Émettre</button>
        )}
        {['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status) && can(user, 'payment.write') && (
          <button className="btn success" onClick={() => setPaying(true)}>Encaisser</button>
        )}
        {['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'].includes(inv.status)
          && can(user, 'invoice.void') && (
          <button className="btn danger" disabled={busy} onClick={() => {
            const r = prompt('Motif de l\'avoir :');
            if (r) act(() => api.creditInvoice(id, r), 'Avoir émis.');
          }}>Émettre un avoir</button>
        )}
      </>
    }>
      <ErrorAlert error={error} />

      <div className="grid c2" style={{ marginBottom: 16 }}>
        <div>
          <div className="muted small">Client</div>
          <strong>{fmtName(inv.patient_last_name, inv.patient_first_name)}</strong>
          <div className="muted small">{inv.mrn}</div>
          {inv.address_line1 && <div className="muted small">
            {inv.address_line1}<br />{inv.postal_code} {inv.city}</div>}
        </div>
        <div>
          <div className="muted small">Facture</div>
          <dl className="dl" style={{ gridTemplateColumns: '110px 1fr' }}>
            <dt>Statut</dt><dd><Badge status={inv.status} map={INVOICE_STATUS} /></dd>
            <dt>Émise le</dt><dd>{inv.issued_at ? fmtDate(inv.issued_at) : '—'}</dd>
            <dt>Échéance</dt><dd>{inv.due_date ? fmtDate(inv.due_date) : '—'}</dd>
            <dt>Praticien</dt><dd>{inv.practitioner_last_name
              ? `Dr ${inv.practitioner_last_name}` : '—'}</dd>
          </dl>
        </div>
      </div>

      <table style={{ marginBottom: 14 }}>
        <thead><tr><th>Désignation</th><th className="num">Qté</th>
          <th className="num">P.U.</th><th className="num">Total</th>
          {editable && <th />}</tr></thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.label}</td>
              <td className="num">
                {editable ? (
                  /* Edition en place : ouvrir une sous-fenetre pour changer
                     un « 1 » en « 2 » couterait trois clics au lieu d'un. */
                  <input type="number" min="0.01" step="1" defaultValue={Number(l.quantity)}
                    style={{ width: 62, textAlign: 'right' }} disabled={busy}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    onBlur={(e) => changeLine(l, { quantity: Number(e.target.value) },
                                              Number(l.quantity))} />
                ) : Number(l.quantity)}
              </td>
              <td className="num">
                {editable ? (
                  <input type="number" min="0" step="50" defaultValue={Number(l.unit_price)}
                    style={{ width: 92, textAlign: 'right' }} disabled={busy}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    onBlur={(e) => changeLine(l, { unitPrice: Number(e.target.value) },
                                              Number(l.unit_price))} />
                ) : fmtMoney(l.unit_price)}
              </td>
              <td className="num">{fmtMoney(l.line_total)}</td>
              {editable && (
                <td className="num">
                  <button className="btn ghost danger sm" disabled={busy}
                          title="Retirer cette ligne"
                          onClick={() => removeLine(l)}>✕</button>
                </td>
              )}
            </tr>
          ))}
          {editable && (
            <tr>
              <td colSpan={5}>
                <AddLine invoiceId={id} disabled={busy}
                         onAdded={() => { load(); onChanged(); }}
                         onError={setError} />
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr><td colSpan={3} className="num muted">Sous-total</td>
            <td className="num">{fmtMoney(inv.subtotal)}</td></tr>
          {Number(inv.insurance_part) > 0 && (
            <>
              <tr><td colSpan={3} className="num muted">Part organisme (tiers payant)</td>
                <td className="num">− {fmtMoney(inv.insurance_part)}</td></tr>
              {/* Le reste à charge est le seul chiffre qui intéresse le
                  client au guichet : il doit être lisible sans calcul. */}
              <tr><td colSpan={3} className="num"><strong>Reste à charge client</strong></td>
                <td className="num"><strong>{fmtMoney(inv.patient_part)}</strong></td></tr>
            </>
          )}
          {Number(inv.stamp_duty) > 0 && (
            <tr><td colSpan={3} className="num muted">Droit de timbre (art. 100)</td>
              <td className="num">{fmtMoney(inv.stamp_duty)}</td></tr>
          )}
          <tr><td colSpan={3} className="num"><strong>Total</strong></td>
            <td className="num"><strong>{fmtMoney(inv.total_amount)}</strong></td></tr>
          <tr><td colSpan={3} className="num muted">Réglé</td>
            <td className="num">{fmtMoney(inv.paid_amount)}</td></tr>
          <tr><td colSpan={3} className="num"><strong>Reste à payer</strong></td>
            <td className="num"><strong style={{ color: Number(inv.balance) > 0
              ? 'var(--danger)' : 'var(--success)' }}>{fmtMoney(inv.balance)}</strong></td></tr>
        </tfoot>
      </table>

      {d.payments.length > 0 && (
        <>
          <h4 style={{ fontSize: 13, marginBottom: 8 }}>Paiements</h4>
          <table>
            <thead><tr><th>Date</th><th>Mode</th><th>Référence</th>
              <th>Encaissé par</th><th className="num">Montant</th></tr></thead>
            <tbody>
              {d.payments.map((p) => (
                <tr key={p.id}>
                  <td className="muted small">{fmtDate(p.received_at)}</td>
                  <td>{PAYMENT_METHODS[p.method] || p.method}</td>
                  <td className="muted small">{p.reference || '—'}</td>
                  <td className="muted small">{p.received_by_name || '—'}</td>
                  <td className="num">{p.is_refund ? '−' : ''}{fmtMoney(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {paying && <PayModal invoice={inv} onClose={() => setPaying(false)}
        onDone={() => { setPaying(false); load(); onChanged(); }} />}

      {/* Masqué à l'écran, seul visible à l'impression. */}
      <InvoicePrint invoice={inv} lines={d.lines} payments={d.payments}
                    branding={branding} />
    </Modal>
  );
}

/*
 * Ajout d'une ligne a une facture brouillon.
 *
 * Deux entrees, selon ce que l'on facture :
 *  - le catalogue (GET /api/tariffs), cas courant : le libelle et le prix se
 *    remplissent seuls, aucune saisie ;
 *  - la saisie libre, pour ce qui n'y figure pas.
 * C'est ce qui permet de porter plusieurs consultations sur une meme facture.
 */
function AddLine({ invoiceId, disabled, onAdded, onError }) {
  const [tariffs, setTariffs] = useState(null);
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [qty, setQty] = useState('1');
  const [tariffId, setTariffId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(function loadTariffs() {
    api.tariffs().then((d) => setTariffs(d.items.filter((t) => t.is_active)))
      .catch(() => setTariffs([]));
  }, []);

  const pick = (id) => {
    setTariffId(id);
    const t = (tariffs || []).find((x) => x.id === id);
    if (t) { setLabel(t.label); setAmount(String(Number(t.amount))); }
  };

  const submit = async () => {
    const unitPrice = Number(amount);
    const quantity = Number(qty);
    if (!label.trim() || Number.isNaN(unitPrice) || !quantity) return;
    setBusy(true);
    try {
      await api.addInvoiceLine(invoiceId, {
        label: label.trim(), quantity, unitPrice,
        tariffId: tariffId || undefined,
      });
      setLabel(''); setAmount(''); setQty('1'); setTariffId('');
      onAdded();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  const ready = label.trim() && amount !== '' && !Number.isNaN(Number(amount));

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
                  paddingTop: 6 }}>
      <select value={tariffId} onChange={(e) => pick(e.target.value)}
              disabled={disabled || busy || !tariffs} style={{ width: 260 }}>
        <option value="">Choisir une prestation…</option>
        {(tariffs || []).map((t) => (
          <option key={t.id} value={t.id}>{t.label} — {fmtMoney(t.amount)}</option>
        ))}
      </select>
      <input placeholder="ou désignation libre" value={label}
             onChange={(e) => { setLabel(e.target.value); setTariffId(''); }}
             disabled={disabled || busy} style={{ flex: 1, minWidth: 170 }} />
      <input type="number" min="0.01" step="1" value={qty} title="Quantité"
             onChange={(e) => setQty(e.target.value)}
             disabled={disabled || busy} style={{ width: 62, textAlign: 'right' }} />
      <input type="number" min="0" step="50" placeholder="Montant" value={amount}
             onChange={(e) => setAmount(e.target.value)}
             onKeyDown={(e) => { if (e.key === 'Enter' && ready) submit(); }}
             disabled={disabled || busy} style={{ width: 108, textAlign: 'right' }} />
      <button className="btn primary sm" onClick={submit}
              disabled={disabled || busy || !ready}>+ Ajouter</button>
    </div>
  );
}

function PayModal({ invoice, onClose, onDone }) {
  const [method, setMethod] = useState('CASH');
  const [amount, setAmount] = useState(String(invoice.balance));
  const [reference, setReference] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const given = Number(amount);
  /*
   * Droit de timbre (art. 100) : dû sur les règlements en espèces. Il
   * s'ajoute à la somme réclamée au client, donc la caissière doit le
   * voir AVANT d'annoncer le montant. La base le recalcule à l'insertion
   * du paiement : l'affichage ici n'est qu'une prévisualisation.
   */
  const due = Number(invoice.balance);
  const stamp = stampDuty(Math.min(given || due, due), method);
  const toCollect = due + stamp;
  const change = method === 'CASH' && given > toCollect ? given - toCollect : 0;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api.pay(invoice.id, {
        method, amount: Math.min(given, Number(invoice.balance)), reference });
      toast.success('Paiement enregistré.');
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title="Encaissement" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn success" disabled={busy || !given} onClick={submit}>
          Encaisser</button>
      </>
    }>
      <ErrorAlert error={error} />
      <div className="stat accent-blue" style={{ marginBottom: 14 }}>
        <div className="label">Reste à payer</div>
        <div className="value">{fmtMoney(invoice.balance)}</div>
      </div>
      {stamp > 0 && (
        <div className="alert info" style={{ marginBottom: 12 }}>
          <span>🧾</span>
          <div>Droit de timbre sur espèces : <strong>{fmtMoney(stamp)}</strong>
            {' — '}total à encaisser <strong>{fmtMoney(toCollect)}</strong></div>
        </div>
      )}
      <Field label="Mode de paiement">
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></Field>
      <Field label="Montant reçu">
        <input type="number" step="0.01" min="0" value={amount}
               onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
      {change > 0 && (
        <div className="alert success">
          <span>💶</span><div>Monnaie à rendre : <strong>{fmtMoney(change)}</strong></div>
        </div>
      )}
      {['CHECK', 'CARD', 'TRANSFER'].includes(method) && (
        <Field label="Référence" help="Numéro de chèque, ticket de terminal…">
          <input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      )}
    </Modal>
  );
}

/* ------------------------------- Impayés -------------------------------- */
function Outstanding({ user, go }) {
  go = go || (() => {});
  const [items, setItems] = useState(null);
  /*
   * Un impaye se consulte pour etre ENCAISSE : la ligne ouvre donc la
   * facture, pas la fiche client. Elle renvoyait auparavant vers le dossier,
   * ce qui obligeait a repasser par l'onglet Factures pour retrouver le
   * document et le regler.
   */
  const [openId, setOpenId] = useState(null);
  const load = () => { api.outstanding().then((d) => setItems(d.items)); };
  useEffect(load, []);
  if (!items) return <Spinner />;

  const total = items.reduce((s, i) => s + Number(i.balance), 0);
  const late = items.filter((i) => i.days_overdue > 0);

  return (
    <>
      <div className="grid c3" style={{ marginBottom: 14 }}>
        <Stat label="Encours total" value={fmtMoney(total)} accent="orange" />
        <Stat label="Factures non soldées" value={items.length} accent="blue" />
        <Stat label="En retard" value={late.length} accent="red"
              hint={fmtMoney(late.reduce((s, i) => s + Number(i.balance), 0))} />
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Factures impayées</h3>
          <div className="spacer" />
          <button className="btn sm" onClick={() => window.print()}>🖨 Liste de relance</button>
        </div>
        <div className="card-body tight">
          {items.length === 0 ? <Empty icon="✓" text="Aucun impayé." /> : (
            <table>
              <thead><tr><th>Numéro</th><th>Client</th><th>Téléphone</th>
                <th>Échéance</th><th className="num">Retard</th>
                <th className="num">Solde</th><th /></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => setOpenId(i.id)}>
                    <td>{i.number}</td>
                    <td>{fmtName(i.last_name, i.first_name)}
                      <div className="muted small">{i.mrn}</div></td>
                    <td className="muted">{i.phone_mobile || '—'}</td>
                    <td className="muted small">{fmtDate(i.due_date)}</td>
                    <td className="num">
                      {i.days_overdue > 0
                        ? <span className={`badge ${i.days_overdue > 30 ? 'red' : 'orange'}`}>
                            {i.days_overdue} j</span>
                        : <span className="muted">—</span>}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(i.balance)}</td>
                    <td className="num">
                      {/* L'acces au dossier reste possible, sans etre le
                          comportement par defaut de la ligne. */}
                      <button className="btn ghost sm" title="Ouvrir la fiche client"
                              onClick={(e) => { e.stopPropagation(); go('patient', i.patient_id); }}>
                        Fiche</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {openId && <InvoiceDetail id={openId} user={user} go={go}
        onClose={() => setOpenId(null)} onChanged={load} />}
    </>
  );
}

/* -------------------------------- Caisse -------------------------------- */
function Cash({ user }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(false);
  const [counted, setCounted] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = () => { api.currentCashSession().then(setD).catch(setError); };
  // Accolades indispensables : en flèche concise, `load` retournerait la
  // promesse, que React prendrait pour la fonction de nettoyage et
  // appellerait au démontage → « is not a function » à la navigation.
  useEffect(load, []);

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  const open = async () => {
    const f = prompt('Fond de caisse initial (DA) :', '5000');
    if (f === null) return;
    setBusy(true);
    try { await api.openCash({ openingFloat: Number(f) }); toast.success('Caisse ouverte.'); load(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const close = async () => {
    setBusy(true);
    try {
      const r = await api.closeCash(d.session.id, { countedCash: Number(counted), comment });
      toast[Math.abs(r.discrepancy) > 0.001 ? 'error' : 'success'](
        `Caisse clôturée. Écart : ${fmtMoney(r.discrepancy)}`);
      setClosing(false); load();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  if (!d.session) return (
    <div className="card">
      <div className="card-body">
        <Empty icon="🔒" text="Aucune session de caisse ouverte."
          action={can(user, 'payment.write') &&
            <button className="btn primary" disabled={busy} onClick={open}>Ouvrir la caisse</button>} />
      </div>
    </div>
  );

  const s = d.session;
  return (
    <>
      <div className="grid c3" style={{ marginBottom: 14 }}>
        <Stat label="Fond de caisse" value={fmtMoney(s.opening_float)} accent="blue"
              hint={`Ouverte le ${fmtDate(s.opened_at)}`} />
        <Stat label="Espèces attendues" value={fmtMoney(d.expectedCash)} accent="green" />
        <Stat label="Encaissements" value={d.totals.reduce((a, t) => a + Number(t.count), 0)}
              accent="purple" />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Session en cours</h3>
          <div className="spacer" />
          {can(user, 'payment.write') && (
            <button className="btn primary" onClick={() => setClosing(true)}>Clôturer la caisse</button>
          )}
        </div>
        <div className="card-body tight">
          <table>
            <thead><tr><th>Mode de paiement</th><th className="num">Nombre</th>
              <th className="num">Montant</th></tr></thead>
            <tbody>
              {d.totals.length === 0
                ? <tr><td colSpan={3} className="muted" style={{ textAlign: 'center' }}>
                    Aucun encaissement pour l'instant.</td></tr>
                : d.totals.map((t) => (
                  <tr key={t.method}>
                    <td>{PAYMENT_METHODS[t.method] || t.method}</td>
                    <td className="num">{t.count}</td>
                    <td className="num">{fmtMoney(t.total)}</td>
                  </tr>
                ))}
            </tbody>
            <tfoot>
              <tr><td><strong>Total</strong></td>
                <td className="num">{d.totals.reduce((a, t) => a + Number(t.count), 0)}</td>
                <td className="num"><strong>
                  {fmtMoney(d.totals.reduce((a, t) => a + Number(t.total), 0))}</strong></td></tr>
            </tfoot>
          </table>
        </div>
      </div>

      {closing && (
        <Modal title="Clôture de caisse" onClose={() => setClosing(false)} footer={
          <>
            <button className="btn" onClick={() => setClosing(false)}>Annuler</button>
            <button className="btn primary" disabled={counted === '' || busy}
                    onClick={close}>Clôturer et imprimer</button>
          </>
        }>
          <div className="alert info">
            <span>ⓘ</span>
            <div>Espèces théoriques en caisse : <strong>{fmtMoney(d.expectedCash)}</strong>
              {' '}(fond {fmtMoney(s.opening_float)} + encaissements).</div>
          </div>
          <Field label="Espèces comptées">
            <input type="number" step="0.01" value={counted} autoFocus
                   onChange={(e) => setCounted(e.target.value)} /></Field>
          {counted !== '' && (
            <div className={`alert ${Math.abs(Number(counted) - d.expectedCash) < 0.01
              ? 'success' : 'warning'}`}>
              <span>{Math.abs(Number(counted) - d.expectedCash) < 0.01 ? '✓' : '⚠'}</span>
              <div>Écart : <strong>{fmtMoney(Number(counted) - d.expectedCash)}</strong></div>
            </div>
          )}
          <Field label="Commentaire" help="Obligatoire en cas d'écart.">
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        </Modal>
      )}
    </>
  );
}
