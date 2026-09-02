# 03 — Spécification fonctionnelle détaillée

---

## 1. Acteurs et rôles

| Rôle | Utilisateur type | Droits principaux |
|---|---|---|
| **ADMIN** | Responsable informatique / direction | Tout : utilisateurs, paramétrage, tarifs, sauvegardes, audit, rapports globaux |
| **RECEPTION** | Secrétaire / réceptionniste | Patients (CRUD hors données médicales), agenda complet, check-in, encaissement, impression, notifications |
| **PRACTITIONER** | Médecin, kiné, infirmier | Son agenda, ses patients (dossier médical complet), saisie de consultation, ses disponibilités et absences, ses statistiques |
| **BILLING** | Comptable / facturation | Factures, paiements, relances, clôture de caisse, exports comptables |
| **READONLY** | Direction, auditeur | Consultation des rapports agrégés, aucun accès nominatif médical |

Matrice de permissions (extrait) :

| Permission | ADMIN | RECEPTION | PRACTITIONER | BILLING | READONLY |
|---|:--:|:--:|:--:|:--:|:--:|
| patient.read.identity | ✔ | ✔ | ✔ | ✔ | — |
| patient.read.medical | — | — | ✔ (ses patients) | — | — |
| patient.write | ✔ | ✔ | ✔ | — | — |
| patient.merge | ✔ | — | — | — | — |
| appointment.read.all | ✔ | ✔ | ✔ | ✔ | — |
| appointment.write | ✔ | ✔ | ✔ (le sien) | — | — |
| appointment.override_conflict | ✔ | — | ✔ | — | — |
| encounter.write | — | — | ✔ | — | — |
| invoice.create / payment.record | ✔ | ✔ | — | ✔ | — |
| invoice.void / credit | ✔ | — | — | ✔ | — |
| report.global | ✔ | — | — | ✔ | ✔ |
| admin.users / admin.settings / admin.backup | ✔ | — | — | — | — |
| audit.read | ✔ | — | — | — | — |
| patient.break_glass | — | — | ✔ (tracé + justifié) | — | — |

---

## 2. Cartographie des écrans

```
Connexion
└── Tableau de bord (adapté au rôle)
    ├── Agenda            (jour / semaine / mois / ressources / multi-praticiens)
    ├── Patients          → Fiche patient (Identité | Médical | RDV | Documents | Facturation | Consentements)
    ├── File d'attente du jour (check-in, salle d'attente, en cours)
    ├── Praticiens        → Fiche praticien (Profil | Disponibilités | Absences | Statistiques)
    ├── Ressources        (Salles | Équipements | Plan d'occupation)
    ├── Facturation       (Factures | Paiements | Caisse | Relances | Exports)
    ├── Rapports          (Occupation | Activité | No-show | Financier | Personnalisé)
    └── Administration    (Utilisateurs | Rôles | Types de RDV | Tarifs | Modèles de notification |
                           Paramètres | Sauvegardes | Journal d'audit)
```

---

## 3. Machine à états d'un rendez-vous

```
                 ┌──── annuler ────► CANCELLED
                 │
  [créer] → SCHEDULED ─ confirmer ─► CONFIRMED ─ arrivée ─► CHECKED_IN
                 │                       │                      │
                 │                       └─ déplacer ─► RESCHEDULED (nouveau RDV lié)
                 │                                              │ appel patient
                 └── absence constatée ──► NO_SHOW              ▼
                                                          IN_PROGRESS ─ fin ─► COMPLETED
                                                                                  │
                                                                        (facturation possible)
```

Transitions autorisées uniquement selon ce graphe. `NO_SHOW` n'est possible que ≥ 15 min après l'heure de début (paramétrable). `COMPLETED` déclenche la proposition automatique de facturation.

---

## 4. Workflows principaux

### WF-01 — Prise de rendez-vous au comptoir/téléphone (parcours nominal, cible ≤ 45 s)

1. Réceptionniste ouvre l'**Agenda** ou clique « Nouveau RDV » (raccourci `N`).
2. **Recherche patient** : saisie de 3 caractères → recherche floue (nom, prénom, date de naissance, MRN, téléphone). Résultats en < 300 ms.
   - Si absent : bouton « Créer patient » → formulaire minimal (nom, prénom, date de naissance, téléphone) ; complétion possible plus tard. Contrôle de doublon en direct (même nom+prénom+DDN → alerte bloquante avec lien vers la fiche existante).
3. Choix du **type de RDV** → durée, buffers, salle requise et tarif pré-remplis.
4. Choix du **praticien** ou de la **spécialité** (« premier disponible »).
5. Le moteur affiche les **créneaux libres** (calcul : règles de disponibilité − absences − fermetures − RDV existants − indisponibilités des ressources requises), groupés par jour, avec filtre matin/après-midi et « les 5 premiers créneaux ».
6. Sélection d'un créneau → attribution automatique de salle/équipement (première ressource compatible libre, priorité au bureau du praticien).
7. Saisie du motif, priorité, commentaire ; case « rappel SMS/e-mail » (grisée si pas de consentement).
8. **Validation** : transaction unique — insertion du RDV + des ressources + planification des notifications. En cas de collision (`23P01`), message clair « Ce créneau vient d'être réservé par <utilisateur> » + rafraîchissement automatique.
9. Confirmation affichée : récapitulatif + boutons **Imprimer la convocation**, **Envoyer confirmation**, **Nouveau RDV pour ce patient**.

**Variantes** : urgence (insertion en surbooking avec permission `override_conflict`, motif obligatoire) ; série récurrente (n séances, même horaire, gestion des conflits séance par séance avec proposition d'alternatives) ; RDV multi-praticiens (bilan) ; inscription en liste d'attente si aucun créneau convenable.

### WF-02 — Déplacement / annulation

- Déplacement : drag & drop dans l'agenda **ou** bouton « Déplacer ». Contrôle de conflit en temps réel (surbrillance verte/rouge pendant le glissé). Le RDV d'origine passe en `RESCHEDULED`, un nouveau est créé avec `rescheduled_from_id`. Notification de changement envoyée.
- Annulation : motif obligatoire (choix dans une liste + texte libre), horodatage, auteur. Si annulation < délai paramétré (ex. 24 h) → marquage « tardive » pour statistiques. Le créneau libéré déclenche l'examen de la **liste d'attente** : proposition automatique aux 3 premiers patients éligibles (impression d'une liste d'appels ou SMS « rappelez-nous »).

### WF-03 — Journée type de la réceptionniste

1. Ouverture de session + **ouverture de caisse** (fond de caisse).
2. Écran **File d'attente du jour** : colonnes *Attendu / Arrivé / En consultation / Terminé*.
3. Arrivée patient → recherche → **Check-in** : contrôle d'identité, vérification des coordonnées et de la couverture (alerte si assurance expirée), documents manquants signalés.
4. Le praticien voit le patient passer en « salle d'attente » sur son propre écran ; il clique « Appeler » → `IN_PROGRESS`.
5. Fin de consultation → `COMPLETED` → une **tâche de facturation** apparaît côté accueil.
6. Encaissement : facture générée depuis les actes, paiement enregistré, reçu imprimé.
7. Fin de journée : **clôture de caisse** (comptage, écart, rapport imprimé), revue des `NO_SHOW`, préparation du lendemain (liste d'appels de rappel si pas de SMS).

### WF-04 — Journée type du praticien

Tableau de bord : patients du jour, retard cumulé estimé, prochains RDV, alertes (allergies critiques du patient suivant), documents à valider. Ouverture du dossier depuis l'agenda en un clic : bandeau patient (âge, allergies, antécédents actifs, dernier passage) + saisie de consultation (motif, observations, diagnostic, plan, actes à facturer) + « Programmer un RDV de suivi » en un bouton. Verrouillage/signature du compte-rendu → lecture seule.

### WF-05 — Gestion des disponibilités

Le praticien ou l'admin définit des règles hebdomadaires (jour, plage, salle, durée de créneau, type dédié) avec période de validité. Prévisualisation du calendrier généré sur 8 semaines avant enregistrement. Déclaration d'absence : si des RDV existent dans la période → assistant de **replanification en masse** (liste des RDV impactés, proposition de créneaux alternatifs, génération des notifications, ou transfert vers un confrère de même spécialité).

### WF-06 — Facturation et paiement

1. Depuis un RDV `COMPLETED` : « Créer facture » → lignes pré-remplies par les actes/tarifs du type de RDV.
2. Ajustements : remise (motif obligatoire au-delà d'un seuil), actes supplémentaires, part assurance / part patient calculée depuis `patient_insurance`.
3. **Émission** → numéro attribué, PDF généré et archivé, facture immuable.
4. Paiement total ou partiel (espèces, carte, chèque, virement, tiers payant). Reçu imprimé.
5. Impayés : tableau des soldes, relances (impression de courrier ou e-mail interne) à J+15, J+30, J+60.
6. Correction d'une facture émise = **avoir** (`CREDITED`) puis nouvelle facture.
7. Exports comptables CSV/FEC vers un répertoire local.

### WF-07 — Notifications

Planification automatique à la création du RDV, selon `notifications.reminder_offsets` (par défaut J-2 et H-2) et le consentement du patient. Canaux : e-mail (serveur SMTP interne), SMS (passerelle GSM sur le LAN, protocole SMPP/HTTP local), impression (convocation papier), interne (notification dans l'application). Le worker traite la file toutes les minutes, 3 tentatives avec back-off, journalisation intégrale. Si aucun canal disponible : génération d'une **liste d'appels** imprimable pour l'accueil. Réponse « STOP » du patient → révocation du consentement.

### WF-08 — Administration

Création d'utilisateur (mot de passe temporaire à changer, MFA obligatoire pour ADMIN/BILLING), gestion des rôles, paramétrage clinique (horaires, jours fériés, durée par défaut, seuils), types de RDV et tarifs (versionnés par date de validité), modèles de notification avec aperçu, supervision des sauvegardes, consultation et export du journal d'audit.

---

## 5. Cas d'usage détaillés (format compact)

| ID | Cas d'usage | Acteur | Préconditions | Scénario nominal | Alternatives / erreurs |
|---|---|---|---|---|---|
| UC-01 | Créer un patient | Reception | Authentifié | Saisie identité → contrôle doublon → enregistrement → MRN attribué | Doublon détecté → fusion ou ouverture de l'existant |
| UC-02 | Rechercher un patient | Tous | — | Saisie ≥ 3 car. → résultats classés par pertinence | Aucun résultat → proposition de création |
| UC-03 | Fusionner deux fiches | Admin | 2 fiches identifiées | Choix de la fiche cible, arbitrage champ par champ, réaffectation RDV/factures | Factures émises sur les deux → conservation des deux historiques, lien de fusion |
| UC-04 | Créer un RDV | Reception/Practitioner | Patient et praticien actifs | cf. WF-01 | Créneau pris (409), hors disponibilité, ressource indisponible, patient déjà en RDV |
| UC-05 | Déplacer un RDV | Reception | RDV actif | Drag & drop → validation → notification | Conflit → refus ou surbooking autorisé |
| UC-06 | Annuler un RDV | Reception | RDV actif | Motif → annulation → liste d'attente examinée | Annulation tardive marquée |
| UC-07 | Check-in | Reception | RDV du jour | Vérif identité → `CHECKED_IN` | Patient sans RDV → création immédiate ; assurance expirée → alerte |
| UC-08 | Constater une absence | Reception | Heure dépassée +15 min | `NO_SHOW` → compteur patient incrémenté | Patient arrive en retard → retour possible en `CHECKED_IN` (tracé) |
| UC-09 | Saisir une consultation | Practitioner | RDV `IN_PROGRESS` | Observations → diagnostic → actes → clôture | Sauvegarde brouillon automatique toutes les 30 s |
| UC-10 | Déclarer une absence praticien | Practitioner/Admin | — | Période → conflits listés → replanification assistée | Aucun créneau alternatif → mise en liste d'attente |
| UC-11 | Réserver une salle hors RDV | Reception | — | Blocage de la salle sur une période (réunion, ménage) | Conflit → refus |
| UC-12 | Émettre une facture | Reception/Billing | RDV `COMPLETED` | Lignes → total → émission → PDF | Tarif expiré → sélection manuelle |
| UC-13 | Encaisser | Reception | Facture émise | Mode de paiement → montant → reçu | Trop-perçu → remboursement tracé |
| UC-14 | Clôturer la caisse | Reception/Billing | Session ouverte | Comptage → écart → rapport | Écart > seuil → validation ADMIN requise |
| UC-15 | Consulter le taux d'occupation | Admin/Readonly | — | Filtres période/praticien/salle → graphiques → export | Données volumineuses → export asynchrone |
| UC-16 | Restaurer une sauvegarde | Admin | Fichier de sauvegarde valide | Mode maintenance → restauration → vérification → réouverture | Checksum invalide → abandon |
| UC-17 | Accès « bris de glace » | Practitioner | Patient hors patientèle | Justification obligatoire → accès 1 h → alerte à l'admin | Refus → pas d'accès |
| UC-18 | Export RGPD / droit d'accès | Admin | Demande patient | Génération d'un dossier PDF+CSV complet | Tracé dans l'audit |

---

## 6. Règles de gestion transverses

| Code | Règle | Paramétrable |
|---|---|---|
| RG-01 | Un patient ne peut avoir deux RDV actifs simultanés | non |
| RG-02 | Un praticien ne peut avoir deux RDV actifs qui se chevauchent (buffers inclus) | surbooking autorisé par permission |
| RG-03 | Une salle/un équipement ne peut être réservé deux fois sur la même période | non |
| RG-04 | RDV interdit hors plage de disponibilité, pendant une absence ou une fermeture | dérogeable par ADMIN |
| RG-05 | Délai minimal de prise de RDV | oui (défaut 0 h) |
| RG-06 | Horizon maximal de réservation | oui (défaut 365 j) |
| RG-07 | Patient avec ≥ 3 no-shows sur 12 mois → alerte à la prise de RDV | oui (seuil) |
| RG-08 | Facture émise immuable ; correction par avoir | non |
| RG-09 | Mot de passe : 12 car. min, 3 classes, historique 5, expiration 180 j | oui |
| RG-10 | Session inactive fermée après 15 min (verrouillage écran) | oui |
| RG-11 | Toute lecture d'un dossier médical est journalisée | non |
| RG-12 | Suppression physique d'un patient impossible ; anonymisation seule | non |
| RG-13 | Les données restent sur le serveur : aucun appel réseau sortant hors LAN (vérifié par pare-feu) | non |

---

## 7. Exigences non fonctionnelles

| Domaine | Exigence |
|---|---|
| Performance | Recherche patient < 300 ms (300 k fiches) ; affichage agenda semaine < 500 ms ; création de RDV < 400 ms (P95) ; 50 utilisateurs simultanés |
| Disponibilité | 99,5 % sur les heures d'ouverture ; redémarrage < 60 s ; mode dégradé lecture seule si la base passe en read-only |
| Sauvegarde | RPO ≤ 5 min (WAL), RTO ≤ 1 h ; test de restauration mensuel automatisé |
| Sécurité | cf. doc 05 ; audit complet ; chiffrement au repos et en transit |
| Ergonomie | Tout le parcours de prise de RDV au clavier ; ≤ 3 clics pour les actions fréquentes ; contraste WCAG AA ; taille de police ajustable |
| Accessibilité | Navigation clavier complète, `aria-*`, focus visible |
| Internationalisation | i18n prête (fr par défaut), formats de date/heure locaux, fuseau unique de la clinique |
| Impression | Convocation, reçu, facture, planning du jour, liste d'appels, rapport de caisse (A4, imprimante locale) |
| Traçabilité | Toute écriture horodatée avec auteur ; historique consultable |
| Reprise | Documentation d'exploitation, scripts d'installation, jeu de données de démonstration |
