import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Spinner, Empty, Modal, Field, ErrorAlert, Badge, INVOICE_STATUS, PAYMENT_METHODS,
  Stat, fmtDate, fmtMoney, fmtName, can, useToast,
} from '../lib.jsx';

export default function Billing({ user, go }) {
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
      {tab === 'outstanding' && <Outstanding go={go} />}
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
            ? <Empty icon="€" text="Aucune facture pour ce filtre." /> : (
            <table>
              <thead><tr><th>Numéro</th><th>Date</th><th>Patient</th><th>Praticien</th>
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
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const toast = useToast();

  const load = () => api.invoice(id).then(setD).catch(setError);
  useEffect(load, [id]);

  if (!d) return <Modal title="Facture" onClose={onClose}><Spinner /></Modal>;
  const inv = d.invoice;

  const act = async (fn, msg) => {
    setBusy(true); setError(null);
    try { await fn(); toast.success(msg); onChanged(); }
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
          <div className="muted small">Patient</div>
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
          <th className="num">P.U.</th><th className="num">Total</th></tr></thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.label}</td>
              <td className="num">{Number(l.quantity)}</td>
              <td className="num">{fmtMoney(l.unit_price)}</td>
              <td className="num">{fmtMoney(l.line_total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={3} className="num muted">Sous-total</td>
            <td className="num">{fmtMoney(inv.subtotal)}</td></tr>
          {Number(inv.insurance_part) > 0 && (
            <tr><td colSpan={3} className="num muted">Part assurance</td>
              <td className="num">{fmtMoney(inv.insurance_part)}</td></tr>
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
    </Modal>
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
  const change = method === 'CASH' && given > Number(invoice.balance)
    ? given - Number(invoice.balance) : 0;

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
          Encaisser et imprimer le reçu</button>
      </>
    }>
      <ErrorAlert error={error} />
      <div className="stat accent-blue" style={{ marginBottom: 14 }}>
        <div className="label">Reste à payer</div>
        <div className="value">{fmtMoney(invoice.balance)}</div>
      </div>
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
function Outstanding({ go }) {
  const [items, setItems] = useState(null);
  useEffect(() => { api.outstanding().then((d) => setItems(d.items)); }, []);
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
              <thead><tr><th>Numéro</th><th>Patient</th><th>Téléphone</th>
                <th>Échéance</th><th className="num">Retard</th>
                <th className="num">Solde</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => go('patient', i.patient_id)}>
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
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
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

  const load = () => api.currentCashSession().then(setD).catch(setError);
  useEffect(load, []);

  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  const open = async () => {
    const f = prompt('Fond de caisse initial (€) :', '100');
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
