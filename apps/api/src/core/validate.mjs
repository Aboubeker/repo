/** Validation de saisie minimaliste, sans dépendance externe. */
import { badRequest } from './errors.mjs';

export function validate(data, schema) {
  const out = {};
  const errors = {};
  for (const [field, rules] of Object.entries(schema)) {
    let v = data?.[field];
    if (v === '' ) v = undefined;
    if (v === undefined || v === null) {
      if (rules.required) { errors[field] = 'Champ obligatoire.'; continue; }
      if (rules.default !== undefined) out[field] = rules.default;
      else out[field] = null;
      continue;
    }
    switch (rules.type) {
      case 'string':
        if (typeof v !== 'string') { errors[field] = 'Texte attendu.'; continue; }
        v = v.trim();
        if (rules.min && v.length < rules.min) { errors[field] = `${rules.min} caractères minimum.`; continue; }
        if (rules.max && v.length > rules.max) { errors[field] = `${rules.max} caractères maximum.`; continue; }
        if (rules.pattern && !rules.pattern.test(v)) { errors[field] = rules.message || 'Format invalide.'; continue; }
        break;
      case 'number':
        v = Number(v);
        if (Number.isNaN(v)) { errors[field] = 'Nombre attendu.'; continue; }
        if (rules.min !== undefined && v < rules.min) { errors[field] = `Minimum ${rules.min}.`; continue; }
        if (rules.max !== undefined && v > rules.max) { errors[field] = `Maximum ${rules.max}.`; continue; }
        break;
      case 'boolean':
        v = v === true || v === 'true';
        break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { errors[field] = 'Date attendue (AAAA-MM-JJ).'; continue; }
        break;
      case 'datetime': {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) { errors[field] = 'Date/heure invalide.'; continue; }
        v = d.toISOString();
        break;
      }
      case 'uuid':
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
          errors[field] = 'Identifiant invalide.'; continue;
        }
        break;
      case 'enum':
        if (!rules.values.includes(v)) { errors[field] = `Valeur attendue : ${rules.values.join(', ')}.`; continue; }
        break;
      case 'array':
        if (!Array.isArray(v)) { errors[field] = 'Liste attendue.'; continue; }
        break;
    }
    out[field] = v;
  }
  if (Object.keys(errors).length) throw badRequest('Données invalides.', errors);
  return out;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_RE = /^[0-9+\s().-]{6,20}$/;
