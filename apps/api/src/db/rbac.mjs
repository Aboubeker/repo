/**
 * Socle RBAC : le catalogue de permissions et les rôles livrés.
 *
 * Défaut corrigé : les rôles n'existaient QUE dans seed.mjs, jeu de données
 * de démonstration que la production n'exécute jamais. Sur une installation
 * vierge (exécutable distribué, « --setup »), l'administrateur créé en premier
 * ne portait aucun rôle et l'application refusait tout : « Permission
 * requise : patient.read ».
 *
 * Ce module est la source unique du socle :
 *   - seed.mjs l'importe pour le jeu de démonstration (dev),
 *   - db/install.mjs l'appelle dans « --setup » AVANT la création de
 *     l'administrateur (production).
 *
 * ensureRbac() est idempotent : on peut l'appeler à chaque installation et
 * à chaque mise à jour, il ne crée que ce qui manque.
 */
import { pool } from '../core/db.mjs';

/**
 * Les 23 permissions de base, avec leur libellé et leur catégorie
 * (catégorie = groupe affiché dans l'éditeur de rôles).
 *
 * Quatre permissions supplémentaires (« admin.roles », « admin.theme »,
 * « patient.delete », « user.delete ») sont ajoutées par la migration
 * 003_rbac_theme.sql : elles font partie du schéma, pas du socle d'amorçage,
 * car elles accompagnent des tables créées dans cette migration.
 */
export const PERMISSIONS = [
  ['patient.read', 'Consulter les patients', 'Patients'],
  ['patient.write', 'Créer / modifier les patients', 'Patients'],
  ['patient.write.medical', 'Saisir les données médicales', 'Patients'],
  ['patient.merge', 'Fusionner des fiches patients', 'Patients'],
  ['practitioner.read', 'Consulter les praticiens', 'Praticiens'],
  ['practitioner.write', 'Gérer les praticiens et disponibilités', 'Praticiens'],
  ['appointment.read', "Consulter l'agenda", 'Rendez-vous'],
  ['appointment.read.all', "Consulter l'agenda de tous les praticiens", 'Rendez-vous'],
  ['appointment.write', 'Créer / modifier des rendez-vous', 'Rendez-vous'],
  ['appointment.override', 'Forcer un créneau indisponible', 'Rendez-vous'],
  ['encounter.read', 'Lire les comptes rendus', 'Consultations'],
  ['encounter.write', 'Rédiger les comptes rendus', 'Consultations'],
  ['resource.read', 'Consulter les ressources', 'Ressources'],
  ['resource.write', 'Gérer salles et équipements', 'Ressources'],
  ['billing.read', 'Consulter la facturation', 'Facturation'],
  ['invoice.write', 'Créer et émettre des factures', 'Facturation'],
  ['invoice.void', 'Émettre des avoirs', 'Facturation'],
  ['payment.write', 'Encaisser des paiements', 'Facturation'],
  ['report.read', 'Consulter les rapports', 'Rapports'],
  ['audit.read', "Consulter le journal d'audit", 'Administration'],
  ['admin.users', 'Gérer les utilisateurs', 'Administration'],
  ['admin.settings', 'Modifier le paramétrage', 'Administration'],
  ['admin.backup', 'Gérer les sauvegardes', 'Administration'],
];

/**
 * Les cinq rôles livrés, avec leurs permissions (codes du socle ci-dessus).
 * ADMIN porte le socle complet ; la migration 003 lui ajoute les
 * permissions qui suivent l'apparition des tables correspondantes.
 */
export const ROLES = {
  ADMIN: { label: 'Administrateur', perms: PERMISSIONS.map((p) => p[0]) },
  RECEPTION: { label: 'Réceptionniste', perms: [
    'patient.read','patient.write','practitioner.read','appointment.read','appointment.read.all',
    'appointment.write',
    'resource.read','billing.read','invoice.write','payment.write'] },
  PRACTITIONER: { label: 'Praticien', perms: [
    'patient.read','patient.write','patient.write.medical','practitioner.read','practitioner.write',
    'appointment.read','appointment.write','appointment.override',
    'encounter.read','encounter.write','resource.read','report.read'] },
  BILLING: { label: 'Facturation', perms: [
    'patient.read','appointment.read','appointment.read.all','billing.read','invoice.write','invoice.void',
    'payment.write','report.read'] },
  READONLY: { label: 'Consultation seule', perms: ['report.read'] },
};

/**
 * Applique le socle RBAC de façon idempotente.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} [client] client de
 *   transaction (seed.mjs l'appelle dans sa transaction) ou pool par défaut.
 * @returns {Promise<{permissionsCreated:number, roles:number,
 *   rolePermissionsCreated:number}>} ce qui a réellement été créé.
 */
export async function ensureRbac(client = pool) {
  const q = (sql, params) => client.query(sql, params);
  let permissionsCreated = 0;
  let rolePermissionsCreated = 0;

  for (const [code, label, category] of PERMISSIONS) {
    const r = await q(`INSERT INTO permission (code, label, category) VALUES ($1,$2,$3)
                       ON CONFLICT (code) DO NOTHING`, [code, label, category]);
    permissionsCreated += r.rowCount;
  }

  for (const [code, { label, perms }] of Object.entries(ROLES)) {
    // Rôle système : ni supprimable ni renommable depuis l'interface, pour
    // qu'une clinique ne puisse pas se verrouiller hors de son application.
    const r = await q(`INSERT INTO role (code, label, is_system) VALUES ($1,$2,true)
                       ON CONFLICT (code)
                         DO UPDATE SET label = EXCLUDED.label, is_system = true
                       RETURNING id`, [code, label]);
    const roleId = r.rows[0].id;
    for (const p of perms) {
      const x = await q(`INSERT INTO role_permission (role_id, permission_code)
                         VALUES ($1,$2)
                         ON CONFLICT DO NOTHING`, [roleId, p]);
      rolePermissionsCreated += x.rowCount;
    }
  }

  return {
    permissionsCreated,
    roles: Object.keys(ROLES).length,
    rolePermissionsCreated,
  };
}
