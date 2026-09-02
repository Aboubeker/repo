/**
 * Client API. Utilise exclusivement des URL relatives : le navigateur du poste
 * de travail n'a jamais besoin de connaître l'adresse du serveur applicatif.
 */
let accessToken = null;
let onUnauthorized = () => {};

export const setToken = (t) => { accessToken = t; };
export const getToken = () => accessToken;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

async function request(path, { method = 'GET', body, retry = true } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });

  // Rafraîchissement silencieux du jeton d'accès expiré
  if (res.status === 401 && retry && path !== '/api/auth/refresh' && path !== '/api/auth/login') {
    const ok = await tryRefresh();
    if (ok) return request(path, { method, body, retry: false });
    onUnauthorized();
    throw new ApiError(401, 'UNAUTHENTICATED', 'Session expirée.');
  }

  if (res.status === 204) return null;

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new ApiError(res.status, 'HTTP_ERROR', `Erreur ${res.status}`);
    return res;
  }

  const data = await res.json();
  if (!res.ok) {
    const e = data.error || {};
    throw new ApiError(res.status, e.code || 'ERROR', e.message || 'Erreur inconnue', e.details);
  }
  return data;
}

async function tryRefresh() {
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: '{}',
    });
    if (!res.ok) return false;
    const d = await res.json();
    accessToken = d.accessToken;
    return true;
  } catch { return false; }
}

const qs = (params = {}) => {
  const s = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return s.toString() ? `?${s}` : '';
};

export const api = {
  // Authentification
  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST', body: {} }),
  refresh: tryRefresh,
  me: () => request('/api/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    request('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),

  // Patients
  patients: (p) => request(`/api/patients${qs(p)}`),
  patient: (id) => request(`/api/patients/${id}`),
  createPatient: (b) => request('/api/patients', { method: 'POST', body: b }),
  updatePatient: (id, b) => request(`/api/patients/${id}`, { method: 'PATCH', body: b }),
  addHistory: (id, b) => request(`/api/patients/${id}/history`, { method: 'POST', body: b }),
  mergePatients: (targetId, sourceId) =>
    request(`/api/patients/${targetId}/merge`, { method: 'POST', body: { sourceId } }),

  // Praticiens
  practitioners: (p) => request(`/api/practitioners${qs(p)}`),
  practitioner: (id) => request(`/api/practitioners/${id}`),
  addAvailability: (id, b) =>
    request(`/api/practitioners/${id}/availability`, { method: 'POST', body: b }),
  deleteAvailability: (pid, id) =>
    request(`/api/practitioners/${pid}/availability/${id}`, { method: 'DELETE' }),
  addAbsence: (id, b) => request(`/api/practitioners/${id}/absences`, { method: 'POST', body: b }),
  previewSlots: (id, p) => request(`/api/practitioners/${id}/preview-slots${qs(p)}`),

  // Rendez-vous
  appointments: (p) => request(`/api/appointments${qs(p)}`),
  appointment: (id) => request(`/api/appointments/${id}`),
  slots: (p) => request(`/api/appointments/slots${qs(p)}`),
  createAppointment: (b) => request('/api/appointments', { method: 'POST', body: b }),
  reschedule: (id, b) => request(`/api/appointments/${id}/reschedule`, { method: 'PATCH', body: b }),
  setStatus: (id, b) => request(`/api/appointments/${id}/status`, { method: 'PATCH', body: b }),
  queue: (date) => request(`/api/appointments/today/queue${qs({ date })}`),
  saveEncounter: (id, b) => request(`/api/appointments/${id}/encounter`, { method: 'PUT', body: b }),
  encounter: (id) => request(`/api/appointments/${id}/encounter`),
  waitingList: () => request('/api/waiting-list'),
  addToWaitingList: (b) => request('/api/waiting-list', { method: 'POST', body: b }),

  // Référentiels
  appointmentTypes: () => request('/api/appointment-types'),
  specialties: () => request('/api/specialties'),
  rooms: () => request('/api/rooms'),
  roomSchedule: (id, date) => request(`/api/rooms/${id}/schedule${qs({ date })}`),
  equipment: () => request('/api/equipment'),
  tariffs: () => request('/api/tariffs'),

  // Facturation
  invoices: (p) => request(`/api/invoices${qs(p)}`),
  invoice: (id) => request(`/api/invoices/${id}`),
  createInvoice: (b) => request('/api/invoices', { method: 'POST', body: b }),
  addInvoiceLine: (id, b) => request(`/api/invoices/${id}/lines`, { method: 'POST', body: b }),
  issueInvoice: (id) => request(`/api/invoices/${id}/issue`, { method: 'POST', body: {} }),
  creditInvoice: (id, reason) =>
    request(`/api/invoices/${id}/credit`, { method: 'POST', body: { reason } }),
  pay: (id, b) => request(`/api/invoices/${id}/payments`, { method: 'POST', body: b }),
  currentCashSession: () => request('/api/cash-sessions/current'),
  openCash: (b) => request('/api/cash-sessions/open', { method: 'POST', body: b }),
  closeCash: (id, b) => request(`/api/cash-sessions/${id}/close`, { method: 'POST', body: b }),
  outstanding: () => request('/api/invoices/reports/outstanding'),

  // Rapports
  overview: (p) => request(`/api/reports/overview${qs(p)}`),
  occupancy: (p) => request(`/api/reports/occupancy${qs(p)}`),
  hourly: (p) => request(`/api/reports/hourly${qs(p)}`),
  bySpecialty: (p) => request(`/api/reports/by-specialty${qs(p)}`),
  roomsReport: (p) => request(`/api/reports/rooms${qs(p)}`),
  daily: (p) => request(`/api/reports/daily${qs(p)}`),
  exportUrl: (p) => `/api/reports/export${qs(p)}`,
  audit: (p) => request(`/api/audit${qs(p)}`),

  // Administration
  users: () => request('/api/admin/users'),
  createUser: (b) => request('/api/admin/users', { method: 'POST', body: b }),
  updateUser: (id, b) => request(`/api/admin/users/${id}`, { method: 'PATCH', body: b }),
  roles: () => request('/api/admin/roles'),
  settings: () => request('/api/admin/settings'),
  updateSetting: (key, value) =>
    request(`/api/admin/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }),
  closures: () => request('/api/closures'),
  addClosure: (b) => request('/api/closures', { method: 'POST', body: b }),
  processNotifications: () => request('/api/notifications/process', { method: 'POST', body: {} }),
  restoreBackup: (id, reason) =>
    request(`/api/admin/backups/${id}/restore`, { method: 'POST', body: { confirm: 'RESTAURER', reason } }),
  system: () => request('/api/admin/system'),
  integrity: () => request('/api/admin/integrity'),
  backups: () => request('/api/admin/backups'),
  runBackup: () => request('/api/admin/backups', { method: 'POST', body: { kind: 'MANUAL' } }),
  notifications: (p) => request(`/api/notifications${qs(p)}`),
  callList: (date) => request(`/api/notifications/call-list${qs({ date })}`),
  health: () => request('/api/health'),
  branding: () => request('/api/branding'),

  // --- Gouvernance : archivage de patients, suppression de comptes -------
  // Côté serveur la fiche patient n'est jamais détruite : elle passe en
  // statut ARCHIVED, ce qui préserve l'historique de soins et la facturation.
  archivePatient: (id) => request(`/api/patients/${id}`, { method: 'DELETE' }),
  restorePatient: (id) =>
    request(`/api/patients/${id}/restore`, { method: 'POST', body: {} }),
  deleteUser: (id) => request(`/api/admin/users/${id}`, { method: 'DELETE' }),
  setSuperuser: (id, isSuperuser) =>
    request(`/api/admin/users/${id}/superuser`, { method: 'PATCH', body: { isSuperuser } }),

  // --- Rôles et permissions ---------------------------------------------
  roleCatalog: () => request('/api/admin/roles/catalog'),
  createRole: (b) => request('/api/admin/roles', { method: 'POST', body: b }),
  updateRole: (id, b) => request(`/api/admin/roles/${id}`, { method: 'PATCH', body: b }),
  deleteRole: (id) => request(`/api/admin/roles/${id}`, { method: 'DELETE' }),

  // --- Apparence ---------------------------------------------------------
  theme: () => request('/api/theme'),
  updateTheme: (b) => request('/api/theme', { method: 'PUT', body: b }),
  resetTheme: () => request('/api/theme/reset', { method: 'POST', body: {} }),

  // --- Catalogue : actes, durées et tarifs -------------------------------
  catalogue: () => request('/api/catalogue'),
  createTariff: (b) => request('/api/tariffs', { method: 'POST', body: b }),
  updateTariff: (id, b) => request(`/api/tariffs/${id}`, { method: 'PATCH', body: b }),
  // Désactivation, jamais suppression : les lignes de facture y renvoient.
  archiveTariff: (id) => request(`/api/tariffs/${id}`, { method: 'DELETE' }),
  restoreTariff: (id) => request(`/api/tariffs/${id}/restore`, { method: 'POST', body: {} }),
  createAppointmentType: (b) => request('/api/appointment-types', { method: 'POST', body: b }),
  updateAppointmentType: (id, b) =>
    request(`/api/appointment-types/${id}`, { method: 'PATCH', body: b }),
  archiveAppointmentType: (id) =>
    request(`/api/appointment-types/${id}`, { method: 'DELETE' }),
  restoreAppointmentType: (id) =>
    request(`/api/appointment-types/${id}/restore`, { method: 'POST', body: {} }),
};
