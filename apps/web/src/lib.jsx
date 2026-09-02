/** Utilitaires partagés : formatage, statuts, composants d'interface communs. */
import React, { createContext, useContext, useState, useCallback } from 'react';

/* ------------------------------ Formatage ------------------------------ */
export const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '—';
export const fmtTime = (d) => d
  ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtDateTime = (d) => d ? `${fmtDate(d)} ${fmtTime(d)}` : '—';
export const fmtLongDate = (d) => d
  ? new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : '—';
export const fmtMoney = (n) =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(n || 0));
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

export const PAYMENT_METHODS = {
  CASH: 'Espèces', CARD: 'Carte bancaire', CHECK: 'Chèque',
  TRANSFER: 'Virement', INSURANCE: 'Tiers payant', VOUCHER: 'Bon de prise en charge',
};

export const Badge = ({ status, map = STATUS }) => {
  const s = map[status] || { label: status, cls: 'gray' };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
};

/* --------------------------- Notifications UI --------------------------- */
const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, type = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems((l) => [...l, { id, message, type }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), 5000);
  }, []);
  const toast = {
    info: (m) => push(m, 'info'),
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'error'),
  };
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

export const Stat = ({ label, value, hint, accent }) => (
  <div className={`stat ${accent ? `accent-${accent}` : ''}`}>
    <div className="label">{label}</div>
    <div className="value">{value}</div>
    {hint && <div className="hint">{hint}</div>}
  </div>
);

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
