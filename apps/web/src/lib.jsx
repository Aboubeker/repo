/** Utilitaires partagés : formatage, statuts, composants d'interface communs. */
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

/* ------------------------------ Formatage ------------------------------ */
export const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-DZ') : '—';
export const fmtTime = (d) => d
  ? new Date(d).toLocaleTimeString('fr-DZ', { hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtDateTime = (d) => d ? `${fmtDate(d)} ${fmtTime(d)}` : '—';
export const fmtLongDate = (d) => d
  ? new Date(d).toLocaleDateString('fr-DZ', { weekday: 'long', day: 'numeric', month: 'long' }) : '—';
/* Monnaie, dates et identifiants : voir locale.js (adaptation Algérie).
   Réexporté ici pour que les pages existantes en bénéficient sans modification. */
export { fmtMoney, fmtAmount, fmtPhone, fmtNIN, amountToWords, stampDuty,
         validateNIN, validatePhone, validateSecuriteSociale,
         INSURANCE_SCHEMES, WILAYAS, WEEKEND_DAYS, isWeekend, isoDay,
         startOfWeekDZ, fixedHolidayFor, DAY_NAMES } from './locale.js';
export const fmtName = (last, first) => `${(last || '').toUpperCase()} ${first || ''}`.trim();

export function age(birthDate) {
  if (!birthDate) return '';
  const b = new Date(birthDate), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a;
}

export const toISODate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function startOfWeek(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}

/* ------------------------------- Statuts -------------------------------- */
export const STATUS = {
  SCHEDULED:   { label: 'Planifié',      cls: 'gray',   color: '#94a3b8' },
  CONFIRMED:   { label: 'Confirmé',      cls: 'blue',   color: '#2563eb' },
  CHECKED_IN:  { label: 'Arrivé',        cls: 'green',  color: '#16a34a' },
  IN_PROGRESS: { label: 'En consultation', cls: 'orange', color: '#ea580c' },
  COMPLETED:   { label: 'Terminé',       cls: 'green',  color: '#059669' },
  CANCELLED:   { label: 'Annulé',        cls: 'red',    color: '#dc2626' },
  NO_SHOW:     { label: 'Absent',        cls: 'red',    color: '#b91c1c' },
  RESCHEDULED: { label: 'Déplacé',       cls: 'purple', color: '#7c3aed' },
};

export const INVOICE_STATUS = {
  DRAFT:          { label: 'Brouillon',   cls: 'gray' },
  ISSUED:         { label: 'Émise',       cls: 'blue' },
  PARTIALLY_PAID: { label: 'Part. payée', cls: 'orange' },
  PAID:           { label: 'Payée',       cls: 'green' },
  OVERDUE:        { label: 'En retard',   cls: 'red' },
  CANCELLED:      { label: 'Annulée',     cls: 'gray' },
  CREDITED:       { label: 'Avoir émis',  cls: 'purple' },
};

/* Moyens de paiement effectivement utilisés en clinique algérienne.
   Les libellés restent adossés aux codes existants en base pour ne pas
   invalider l'historique de facturation. */
export const PAYMENT_METHODS = {
  CASH:      'Espèces',
  CARD:      'Carte CIB / Edahabia',
  CHECK:     'Chèque',
  TRANSFER:  'Virement / CCP',
  INSURANCE: 'Tiers payant (CNAS / CASNOS)',
  VOUCHER:   'Prise en charge / Convention',
};

export const Badge = ({ status, map = STATUS }) => {
  const s = map[status] || { label: status, cls: 'gray' };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
};

/* --------------------------- Notifications UI --------------------------- */
/*
 * Contexte des notifications.
 *
 * La valeur par défaut n'est PAS `null`. Un composant rendu hors du Provider
 * — cas d'un écran d'erreur, d'un test, ou d'un arbre monté séparément —
 * recevrait alors `null`, et le premier `toast.success(...)` lèverait
 * « TypeError: r is not a function » après minification : un message
 * impossible à relier à sa cause.
 *
 * Le repli journalise dans la console au lieu d'interrompre l'application.
 * Une notification est un confort, jamais une raison de faire écran blanc.
 */
const noopToast = {
  info:    (m) => console.info('[toast]', m),
  success: (m) => console.info('[toast ✓]', m),
  error:   (m) => console.error('[toast ✗]', m),
};

const ToastCtx = createContext(noopToast);

export const useToast = () => useContext(ToastCtx) ?? noopToast;

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, type = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems((l) => [...l, { id, message, type }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), 5000);
  }, []);
  // useMemo : sans cela, `toast` est un objet neuf à chaque rendu du
  // Provider. Tout useEffect qui le déclare en dépendance se relancerait en
  // boucle — y compris les rafraîchissements périodiques.
  const toast = useMemo(() => ({
    info:    (m) => push(m, 'info'),
    success: (m) => push(m, 'success'),
    error:   (m) => push(m, 'error'),
  }), [push]);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span>{t.type === 'error' ? '⚠' : t.type === 'success' ? '✓' : 'ⓘ'}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------------------- Composants UI ----------------------------- */
export const Spinner = ({ label = 'Chargement…' }) => (
  <div className="empty"><span className="spinner" /><div style={{ marginTop: 10 }}>{label}</div></div>
);

export const Empty = ({ icon = '∅', text, action }) => (
  <div className="empty">
    <div className="big">{icon}</div>
    <div>{text}</div>
    {action && <div style={{ marginTop: 12 }}>{action}</div>}
  </div>
);

export const Stat = ({ label, value, hint, accent, onClick, title }) => {
  const cls = `stat ${accent ? `accent-${accent}` : ''} ${onClick ? 'clickable' : ''}`;
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </>
  );
  // Un compteur cliquable doit être un vrai bouton : accessible au clavier et
  // annoncé comme actionnable par les lecteurs d'écran.
  return onClick
    ? <button type="button" className={cls} onClick={onClick} title={title}
              style={{ textAlign: 'left', font: 'inherit', color: 'inherit' }}>
        {body}
      </button>
    : <div className={cls}>{body}</div>;
};

export function Modal({ title, children, onClose, footer, wide }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, children, onClose, footer }) {
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <h3 style={{ flex: 1, fontSize: 15 }}>{title}</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  );
}

export function Field({ label, error, help, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {error && <div className="err">{error}</div>}
      {help && !error && <div className="help">{help}</div>}
    </div>
  );
}

export const Bar = ({ value, max = 100, color }) => (
  <div className="bar">
    <i style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
  </div>
);

export function ErrorAlert({ error }) {
  if (!error) return null;
  return (
    <div className="alert error">
      <span>⚠</span>
      <div>
        <div>{error.message}</div>
        {error.details && typeof error.details === 'object' && (
          <ul style={{ marginTop: 4, paddingLeft: 16, fontSize: 12 }}>
            {Object.entries(error.details).map(([k, v]) => (
              <li key={k}>{typeof v === 'string' ? `${k} : ${v}` : k}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export const can = (user, perm) => (user?.permissions || []).includes(perm);

/* ======================================================================
   Composants ajoutés : en-tête de page, densité, santé système
   ====================================================================== */

/** En-tête normalisé. Remplace les titres en style inline page par page. */
export function PageHead({ title, subtitle, crumbs, actions }) {
  return (
    <div>
      {crumbs?.length > 0 && (
        <nav className="crumbs" aria-label="Fil d'ariane">
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span aria-hidden="true">›</span>}
              {c.onClick
                ? <button onClick={c.onClick}>{c.label}</button>
                : <span>{c.label}</span>}
            </React.Fragment>
          ))}
        </nav>
      )}
      <div className="page-head">
        <div className="ph-main">
          <h1>{title}</h1>
          {subtitle && <div className="ph-sub">{subtitle}</div>}
        </div>
        {actions && <div className="ph-actions">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * Densité d'affichage. Sur un écran 1366×768 — la résolution la plus courante
 * sur les postes de comptoir — le mode compact fait passer un tableau de
 * 6 à 11 lignes visibles, ce qui évite un défilement permanent.
 */
const DENSITY_KEY = 'clinirdv.density';

export function applyStoredDensity() {
  const d = localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  document.documentElement.setAttribute('data-density', d);
  return d;
}

export function useDensity() {
  const [density, setDensity] = useState(
    () => (typeof document !== 'undefined'
      && document.documentElement.getAttribute('data-density')) || 'comfortable');
  const toggle = useCallback(() => {
    setDensity((cur) => {
      const next = cur === 'compact' ? 'comfortable' : 'compact';
      document.documentElement.setAttribute('data-density', next);
      try { localStorage.setItem(DENSITY_KEY, next); } catch { /* mode privé */ }
      return next;
    });
  }, []);
  return [density, toggle];
}

/**
 * Indicateur de santé. `level` vaut 'ok' | 'warn' | 'bad'.
 * `fix` est l'action corrective : un administrateur non technicien doit
 * pouvoir agir sans ouvrir un terminal.
 */
export function HealthItem({ level = 'ok', title, value, fix }) {
  return (
    <div className={`health-item ${level}`}>
      <span className="hdot" aria-hidden="true" />
      <div style={{ minWidth: 0 }}>
        <div className="ht">{title}</div>
        <div className="hv">{value}</div>
        {fix && <div className="hfix">{fix}</div>}
      </div>
      <span className="sr-only">
        {level === 'ok' ? 'Normal' : level === 'warn' ? 'Avertissement' : 'Anomalie'}
      </span>
    </div>
  );
}

/** Bandeau d'action requise, cliquable, en tête de page. */
export const ActionStrip = ({ icon = '⚠', children, action, danger }) => (
  <div className={`action-strip ${danger ? 'danger' : ''}`}>
    <span aria-hidden="true">{icon}</span>
    <span>{children}</span>
    <span className="spacer" />
    {action}
  </div>
);

/** Confirmation explicite pour les actes irréversibles (remplace window.confirm). */
export function ConfirmDialog({ title, message, confirmLabel = 'Confirmer',
                                danger, onConfirm, onClose, children }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await onConfirm(); onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose} disabled={busy}>Annuler</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`}
                onClick={run} disabled={busy}>
          {busy ? 'En cours…' : confirmLabel}
        </button>
      </>
    }>
      <p style={{ marginBottom: children ? 12 : 0 }}>{message}</p>
      {children}
    </Modal>
  );
}

/* ======================================================================
   Retour visuel : squelettes, progression, onde au clic
   ====================================================================== */

/**
 * Squelette de chargement.
 *
 * Préférable au disque tournant : la structure de la page reste en place, ce
 * qui supprime le sursaut de mise en page quand les données arrivent. Sur un
 * réseau local la réponse est quasi immédiate, mais les rapports et les
 * sauvegardes prennent plusieurs secondes.
 */
export const SkeletonText = ({ lines = 3 }) => (
  <div aria-hidden="true">
    {Array.from({ length: lines }, (_, i) => (
      <div key={i} className={`skeleton skeleton-line ${
        i === lines - 1 ? 'w60' : i % 3 === 1 ? 'w40' : ''}`} />
    ))}
  </div>
);

/** Squelette de tableau, calé sur le nombre réel de colonnes. */
export const SkeletonTable = ({ rows = 6, cols = 5 }) => (
  <table aria-busy="true">
    <tbody>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}><div className="skeleton skeleton-line" /></td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

/**
 * Barre de progression indéterminée, en haut de la fenêtre.
 * Pour les opérations longues : sauvegarde, restauration, export.
 */
export const TopProgress = ({ active }) => active
  ? <div className="top-progress" role="progressbar" aria-label="Traitement en cours">
      <i />
    </div>
  : null;

/**
 * Onde au clic : positionne l'origine du dégradé sous le curseur.
 *
 * L'effet est purement CSS ; ce gestionnaire ne fait que renseigner deux
 * variables. Installé une seule fois sur le document plutôt que sur chaque
 * bouton — l'application en compte plusieurs centaines à l'écran.
 */
export function installRipple() {
  if (typeof document === 'undefined') return;
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest?.('button.btn');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    btn.style.setProperty('--rx', `${((e.clientX - r.left) / r.width) * 100}%`);
    btn.style.setProperty('--ry', `${((e.clientY - r.top) / r.height) * 100}%`);
  }, { passive: true });
}
