/**
 * Document imprimable : facture et avoir.
 *
 * Pourquoi un composant séparé plutôt qu'une impression de la modale ?
 * La facture s'affichait dans un conteneur « .overlay », que la feuille
 * d'impression masque (display:none). Le bouton Imprimer produisait donc
 * une page vide. Surtout, un écran et un document papier n'ont pas les
 * mêmes exigences : le papier doit porter l'en-tête de la clinique, les
 * mentions légales, le montant en lettres et le droit de timbre.
 *
 * Ce bloc est masqué à l'écran et n'apparaît qu'à l'impression (.print-doc).
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { fmtMoney, fmtDate, fmtName, amountToWords } from './lib.jsx';

/*
 * Le document est monté DANS <body>, hors de l'arbre de l'application.
 *
 * Il vivait auparavant dans la modale, donc à l'intérieur de « .content » :
 * pour n'imprimer que lui, la feuille devait masquer ses frères au moyen de
 * « :has() ». Or si le navigateur ignore « :has() », la règle entière est
 * invalide et la LISTE COMPLÈTE des factures s'imprime à la place de la
 * facture. En sortant le document de l'arbre, la règle d'impression devient
 * binaire — masquer #root, montrer le document — sans sélecteur conditionnel.
 */
function printRoot() {
  let el = document.getElementById('print-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'print-root';
    document.body.appendChild(el);
  }
  return el;
}

function Mentions({ b }) {
  const bits = [
    b.nif && `NIF : ${b.nif}`,
    b.rc && `RC : ${b.rc}`,
    b.article_imposition && `Article d'imposition : ${b.article_imposition}`,
    b.agrement && `Agrément : ${b.agrement}`,
  ].filter(Boolean);
  if (!bits.length) return null;
  return <div className="pd-legal">{bits.join(' · ')}</div>;
}

export default function InvoicePrint({ invoice, lines, payments, branding }) {
  /*
   * Tant qu'un document est monté, <body> porte « printing-doc » : la
   * feuille d'impression masque alors l'application entière. La classe est
   * retirée au démontage, sinon les autres écrans deviendraient
   * inimprimables après la première facture consultée.
   */
  React.useEffect(function markPrinting() {
    if (!invoice) return undefined;
    document.body.classList.add('printing-doc');
    return function cleanup() {
      document.body.classList.remove('printing-doc');
    };
  }, [invoice]);

  if (!invoice) return null;
  const b = branding || {};
  const inv = invoice;
  const isCredit = (inv.number || '').startsWith('AV-');
  const stamp = Number(inv.stamp_duty) || 0;

  // Le client doit lire ce qu'il paie réellement : la part à sa charge,
  // pas le montant total dont l'assurance règle une partie.
  const insurance = Number(inv.insurance_part) || 0;
  const patientPart = insurance > 0
    ? Number(inv.patient_part) || 0
    : Number(inv.total_amount) || 0;
  const dueTotal = patientPart + stamp;

  return createPortal((
    <div className="print-doc" aria-hidden="true">
      <header className="pd-head">
        <div>
          <div className="pd-clinic">{b.clinic_name || 'Clinique'}</div>
          <div className="pd-sub">
            {[b.address, b.city, b.wilaya].filter(Boolean).join(', ')}
            {b.phone && <><br />Tél. {b.phone}</>}
          </div>
          <Mentions b={b} />
        </div>
        <div className="pd-doc">
          <div className="pd-title">{isCredit ? 'AVOIR' : 'FACTURE'}</div>
          <div className="pd-num">{inv.number || 'BROUILLON'}</div>
          <div className="pd-sub">
            Date : {fmtDate(inv.issued_at || inv.created_at)}
            {inv.due_date && !isCredit && <><br />Échéance : {fmtDate(inv.due_date)}</>}
          </div>
        </div>
      </header>

      <section className="pd-parties">
        <div>
          <div className="pd-label">Client</div>
          <strong>{fmtName(inv.patient_last_name, inv.patient_first_name)}</strong>
          <div className="pd-sub">
            Dossier {inv.mrn}
            {inv.address_line1 && <><br />{inv.address_line1}</>}
            {(inv.postal_code || inv.city) && <><br />{inv.postal_code} {inv.city}</>}
          </div>
        </div>
        <div>
          <div className="pd-label">Praticien</div>
          {inv.practitioner_last_name
            ? `Dr ${inv.practitioner_first_name || ''} ${inv.practitioner_last_name}`.trim()
            : '—'}
        </div>
      </section>

      <table className="pd-table">
        <thead>
          <tr>
            <th>Désignation</th>
            <th className="num">Qté</th>
            <th className="num">P.U.</th>
            <th className="num">Montant</th>
          </tr>
        </thead>
        <tbody>
          {(lines || []).map((l) => (
            <tr key={l.id}>
              <td>{l.label}</td>
              <td className="num">{Number(l.quantity)}</td>
              <td className="num">{fmtMoney(l.unit_price)}</td>
              <td className="num">{fmtMoney(l.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pd-totals">
        <table>
          <tbody>
            <tr><td>Sous-total</td><td className="num">{fmtMoney(inv.subtotal)}</td></tr>
            {Number(inv.vat_amount) > 0 && (
              <tr><td>TVA</td><td className="num">{fmtMoney(inv.vat_amount)}</td></tr>
            )}
            <tr className="pd-strong">
              <td>Total</td><td className="num">{fmtMoney(inv.total_amount)}</td>
            </tr>
            {insurance > 0 && (
              <>
                <tr><td>Part organisme (tiers payant)</td>
                  <td className="num">− {fmtMoney(insurance)}</td></tr>
                <tr className="pd-strong"><td>Reste à charge client</td>
                  <td className="num">{fmtMoney(patientPart)}</td></tr>
              </>
            )}
            {stamp > 0 && (
              <tr><td>Droit de timbre (art. 100)</td>
                <td className="num">{fmtMoney(stamp)}</td></tr>
            )}
            <tr className="pd-total"><td>Net à payer</td>
              <td className="num">{fmtMoney(dueTotal)}</td></tr>
            {Number(inv.paid_amount) > 0 && (
              <>
                <tr><td>Déjà réglé</td><td className="num">{fmtMoney(inv.paid_amount)}</td></tr>
                <tr className="pd-strong"><td>Solde</td>
                  <td className="num">{fmtMoney(dueTotal - Number(inv.paid_amount))}</td></tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      <div className="pd-words">
        Arrêtée la présente {isCredit ? 'note d\'avoir' : 'facture'} à la somme de :{' '}
        <strong>{amountToWords(dueTotal)}</strong>.
      </div>

      {payments && payments.length > 0 && (
        <div className="pd-pay">
          <div className="pd-label">Règlements</div>
          {payments.map((p) => (
            <div key={p.id}>
              {fmtDate(p.received_at)} — {p.method === 'CASH' ? 'Espèces'
                : p.method === 'CARD' ? 'Carte'
                : p.method === 'CHECK' ? 'Chèque'
                : p.method === 'TRANSFER' ? 'Virement' : p.method}
              {' : '}{p.is_refund ? '− ' : ''}{fmtMoney(p.amount)}
              {p.reference ? ` (réf. ${p.reference})` : ''}
            </div>
          ))}
        </div>
      )}

      <footer className="pd-foot">
        <div className="pd-sign">Cachet et signature</div>
        {inv.notes && <div className="pd-notes">{inv.notes}</div>}
      </footer>
    </div>
  ), printRoot());
}
