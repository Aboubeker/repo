/**
 * Taxonomie d'erreurs applicatives et traduction des erreurs PostgreSQL
 * en codes métier exploitables par l'interface.
 */
export class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const badRequest   = (m, d) => new AppError(400, 'VALIDATION_ERROR', m, d);
export const unauthorized = (m = 'Authentification requise.') => new AppError(401, 'UNAUTHENTICATED', m);
export const forbidden    = (m = "Vous n'avez pas les droits nécessaires.") => new AppError(403, 'FORBIDDEN', m);
export const notFound     = (m = 'Ressource introuvable.') => new AppError(404, 'NOT_FOUND', m);
export const conflict     = (m, code = 'CONFLICT', d) => new AppError(409, code, m, d);
export const unprocessable= (m, code = 'BUSINESS_RULE', d) => new AppError(422, code, m, d);
export const tooMany      = (m = 'Trop de tentatives.') => new AppError(429, 'TOO_MANY_REQUESTS', m);

/** Traduit une erreur PostgreSQL en AppError lisible par l'utilisateur. */
export function translateDbError(err) {
  if (err instanceof AppError) return err;

  // 23P01 : violation de contrainte d'exclusion => collision de planning
  if (err.code === '23P01') {
    const c = err.constraint || '';
    if (c.includes('no_overlap_practitioner'))
      return conflict('Ce praticien a déjà un rendez-vous sur ce créneau.', 'SLOT_CONFLICT_PRACTITIONER');
    if (c.includes('no_overlap_patient'))
      return conflict('Ce patient a déjà un rendez-vous sur ce créneau.', 'SLOT_CONFLICT_PATIENT');
    if (c.includes('room'))
      return conflict('Cette salle est déjà occupée sur ce créneau.', 'RESOURCE_CONFLICT_ROOM');
    if (c.includes('equipment'))
      return conflict('Cet équipement est déjà réservé sur ce créneau.', 'RESOURCE_CONFLICT_EQUIPMENT');
    if (c.includes('absence'))
      return conflict('Une absence existe déjà sur cette période.', 'ABSENCE_OVERLAP');
    return conflict('Conflit de planning détecté.', 'SLOT_CONFLICT');
  }

  // 23505 : unicité
  if (err.code === '23505') {
    if ((err.constraint || '').includes('uq_patient_identity'))
      return conflict('Un patient avec ces nom, prénom et date de naissance existe déjà.',
        'DUPLICATE_PATIENT');
    return conflict('Cette valeur existe déjà.', 'DUPLICATE', { constraint: err.constraint });
  }

  // Conflit de concurrence : la requête peut être rejouée par le client
  if (err.code === '40001' || err.code === '40P01')
    return conflict('Conflit d\'accès concurrent, veuillez réessayer.', 'CONCURRENCY_CONFLICT');

  if (err.code === '23503') return unprocessable('Référence invalide : l\'élément lié n\'existe pas.', 'FK_VIOLATION');
  if (err.code === '23514' || err.code === 'P0001')
    return unprocessable(err.message.replace(/^.*?:\s*/, ''), 'BUSINESS_RULE');
  if (err.code === '23502') return badRequest(`Le champ « ${err.column} » est obligatoire.`);
  if (err.code === '22P02') return badRequest('Format de donnée invalide.');

  return new AppError(500, 'INTERNAL_ERROR', 'Une erreur interne est survenue.');
}
