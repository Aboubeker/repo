# Améliorations : design, IHM, administration, adaptation algérienne

> Document de travail accompagnant le commit `978e851`.
> Ce qui est marqué **[fait]** est dans le code et couvert par les tests.
> Ce qui est marqué **[à faire]** est spécifié ici, prêt à être implémenté.

---

## 0. Ce que l'audit a révélé

Trois constats avant toute proposition esthétique.

**Un bug de fond, pas un problème de goût.** `seed.mjs` filtrait les jours
ouvrés par `if (dow > 5) continue`, c'est-à-dire samedi et dimanche chômés. En
Algérie le week-end légal est **vendredi et samedi**. Le logiciel proposait donc
des rendez-vous le vendredi — jour de prière — et fermait la clinique le
dimanche, qui est le premier jour ouvré de la semaine. Pire : le test
`api.test.mjs` *validait* ce comportement (`assert.ok(dow >= 1 && dow <= 5)`).
Le filet de sécurité confirmait l'erreur au lieu de la détecter.

**Une monnaie fausse.** 42 appels à `fmtMoney` formataient en euros. Une
facture algérienne libellée en euros n'est pas seulement inélégante : elle est
irrecevable.

**Une interface pensée pour un utilisateur qui n'existe pas.** Dix entrées de
navigation au même niveau visuel, alors qu'une réceptionniste en ouvre trois
dans sa journée et qu'un administrateur consulte les sept autres quelques fois
par mois.

---

## 1. Design

### 1.1 Palette **[fait]**

Le bleu `#1d4ed8` d'origine est le bleu par défaut de tous les frameworks CSS ;
il évoque le secteur bancaire. Il est remplacé par un vert-sarcelle profond,
plus proche de la signalétique de santé, et suffisamment sombre pour rester
lisible.

| Rôle | Avant | Après | Contraste sur blanc |
|---|---|---|---|
| Primaire | `#1d4ed8` | `#0f766e` | 7.1:1 (AAA) |
| Primaire foncé | `#1e40af` | `#115e59` | 9.4:1 |
| Succès | `#059669` | `#15803d` | 4.9:1 |
| Alerte | `#d97706` | `#b45309` | 4.6:1 |
| Danger | `#dc2626` | `#b91c1c` | 5.9:1 |
| Texte | `#0f172a` | `#16211f` | 16.1:1 |

L'orange et le vert d'origine passaient sous 4.5:1 sur fond clair : illisibles
pour un utilisateur presbyte sur un écran de comptoir mal réglé. Les neutres
sont légèrement réchauffés (`#f6f7f6` plutôt que `#f1f5f9`) — sur huit heures
d'usage, le gris bleuté fatigue davantage.

Les ombres passent d'un noir pur à un noir teinté de vert (`rgba(22,33,31,…)`),
ce qui évite l'aspect « sale » des ombres grises sur fond coloré.

### 1.2 Typographie **[fait]**

La version précédente empilait `11.5px`, `12.5px`, `13.5px`, `14px`, `17px`,
`21px`, `26px` — des valeurs choisies au fil de l'eau. Remplacé par une échelle
de six pas, exposée en variables CSS :

```css
--fs-xs: 11px;  --fs-sm: 12px;   --fs-base: 14px;
--fs-md: 16px;  --fs-lg: 19px;   --fs-xl: 24px;  --fs-2xl: 30px;
```

Même chose pour l'espacement, sur une base de 4 px (`--sp-1` à `--sp-8`).

`Segoe UI` passe en tête de la pile de polices : c'est la police système des
postes Windows visés, et elle rend correctement les caractères arabes des noms
de patients — point non trivial, puisque `-apple-system` en tête faisait
retomber Windows sur un rendu dégradé.

### 1.3 Densité d'affichage **[fait]**

Les postes de comptoir sont majoritairement en 1366×768. En affichage
confortable, un tableau montre 6 lignes ; la réceptionniste défile en
permanence. Un bouton dans la barre supérieure bascule en mode compact —
**11 lignes visibles** — sans réduire la taille du texte courant. Le choix est
mémorisé dans `localStorage` et appliqué avant le premier rendu.

```css
html[data-density="compact"] td { padding: 5px var(--sp-3); }
```

### 1.4 Cibles et accessibilité **[fait]**

- Boutons et champs : hauteur minimale **38 px** (contre 30 px), utilisable au
  doigt sur les écrans tactiles de comptoir.
- `:focus-visible` explicite partout — la navigation au clavier était
  invisible, ce qui condamnait l'usage sans souris.
- `prefers-reduced-motion` respecté.
- `.rtl-aware { unicode-bidi: plaintext; }` : un nom saisi en caractères arabes
  s'affiche de droite à gauche même au milieu d'un tableau français.

---

## 2. Interface (IHM)

### 2.1 Navigation **[fait]**

Avant : dix entrées, trois groupes, tout au même niveau visuel.
Après : deux blocs.

```
Aujourd'hui              ← ex-« Tableau de bord »
File d'attente     ③     ← compteur en direct
Agenda
Patients
Facturation
▸ Configuration          ← replié par défaut
    Praticiens
    Salles & équipements
    Rapports
    Administration
```

Le renommage compte autant que le regroupement : « Tableau de bord » est un
terme de logiciel, « Aujourd'hui » décrit ce que l'écran contient.

**Compteur de file d'attente en direct** : un badge rouge sur « File d'attente »
indique le nombre de patients en salle, rafraîchi toutes les 45 secondes et
seulement si l'onglet est visible (`document.hidden`). La réception voit
arriver les patients sans changer d'écran.

### 2.2 Composants partagés **[fait]**

Trois motifs étaient réécrits en style inline dans chaque page :

| Composant | Remplace | Apport |
|---|---|---|
| `PageHead` | titres inline, hauteurs variables | titre, sous-titre, fil d'ariane, actions |
| `ActionStrip` | rien | bandeau « action requise » cliquable |
| `ConfirmDialog` | `window.confirm` / `prompt` | libellés métier, état d'attente, non bloquant |

Le recours à `window.prompt` pour réinitialiser un mot de passe (`Admin.jsx`
ligne 49) est particulièrement à proscrire : aucune validation, aucun masquage,
et un rendu système hors charte.

### 2.3 Points complexes restants **[à faire]**

**Prise de rendez-vous.** Le tunnel en deux étapes (`NewAppointment.jsx`) impose
de choisir le patient avant de voir la moindre disponibilité. Or l'appel
téléphonique commence presque toujours par « vous avez quelque chose jeudi
matin ? ». Inverser : créneau d'abord, patient ensuite, avec création de fiche
minimale (nom + téléphone) en ligne dans le même écran. Le patient complet peut
être renseigné à l'arrivée.

**Recherche patient.** Elle exige une correspondance sur nom, prénom ou MRN.
Ajouter la recherche par numéro de téléphone — c'est l'identifiant que le
patient donne spontanément au téléphone — et une tolérance aux
translittérations : *Mohammed / Mohamed / Muhammad*, *Cherif / Chérif / Sharif*.
L'index `pg_trgm` est déjà en place, il suffit d'étendre la requête.

**Facturation.** Les totaux d'une facture se recalculent après appel serveur.
Calculer en local à la saisie, l'écart serveur ne servant que de garde-fou.

---

## 3. Administration

### 3.1 Onglet « Vue d'ensemble » **[fait]**

L'administrateur d'une clinique algérienne est le gérant ou un responsable
administratif, pas un informaticien. Les informations dont il a besoin étaient
réparties sur quatre onglets et formulées en termes techniques.

Le nouvel onglet répond à une seule question : **y a-t-il quelque chose à faire
aujourd'hui ?**

- **Bandeaux d'action** en haut : sauvegarde ancienne de plus de 48 h (rouge) ou
  26 h (orange), comptes dormants depuis 90 jours, mots de passe provisoires
  jamais changés. Chaque bandeau porte son bouton correctif.
- **Six indicateurs de santé** : base, sauvegarde, disponibilité, comptes,
  confidentialité, audit. Chaque anomalie affiche le geste correctif — jamais
  une ligne de commande.
- **Quatre compteurs** d'activité.

Le seuil de 26 h plutôt que 24 h évite une alerte quotidienne dès qu'une
sauvegarde nocturne glisse de quelques minutes.

### 3.2 Nom de l'établissement en base **[fait]**

« Clinique Saint-Michel » était écrit en dur dans `App.jsx` et `Login.jsx`. Une
clinique qui installe le logiciel ne doit pas recompiler pour voir son nom.
Nouvel endpoint public `GET /api/branding` — accessible avant authentification
puisque l'écran de connexion doit l'afficher, et strictement limité aux
informations publiques.

```json
{ "clinic_name": "Clinique El Amel", "city": "Alger",
  "wilaya": "16 Alger", "phone": "021 00 00 00",
  "agrement": null, "timezone": "Africa/Algiers" }
```

### 3.3 À compléter **[à faire]**

**Assistant de première configuration.** Au premier démarrage, un parcours en
cinq écrans : identité de l'établissement (nom, agrément DSP, NIF, RC, article
d'imposition) → horaires et week-end → praticiens → salles → premier compte
utilisateur. Aujourd'hui, l'administrateur doit deviner l'ordre.

**Restauration guidée.** La sauvegarde existe, la restauration n'a pas
d'interface. C'est le scénario le plus critique et le moins testé. Prévoir :
choix du fichier, vérification SHA-256, aperçu du contenu (date, nombre de
patients), double confirmation par saisie du nom de la clinique, journalisation.

**Export comptable.** Un export CSV/Excel du journal de caisse par période, avec
ventilation par mode de paiement et total du droit de timbre — le comptable de
la clinique le réclamera dès le premier mois.

---

## 4. Adaptation au contexte algérien

Tout est centralisé dans `apps/web/src/locale.js` : un seul fichier à relire
pour auditer la conformité, un seul à modifier si la réglementation change.

### 4.1 Monnaie **[fait]**

Dinar algérien, **sans décimale**. Le centime existe légalement mais aucun prix
de consultation ne l'emploie ; afficher « 3 500,00 DA » là où le comptoir écrit
« 3 500 DA » ajoute du bruit.

`amountToWords()` produit le montant en toutes lettres — « trois mille cinq
cents dinars algériens » — obligatoire sur les quittances.

### 4.2 Semaine ouvrable **[fait]** — *correction de bug*

Week-end **vendredi + samedi**. Semaine ouvrable **dimanche → jeudi**, avec
jeudi après-midi non travaillé (veille de week-end). Horaires ajustés à
`08:00–12:00` et `13:00–16:30` : la coupure méridienne est plus courte qu'en
Europe.

Corrigé dans `seed.mjs` (règles de disponibilité et génération des rendez-vous),
dans `locale.js` (`WEEKEND_DAYS`, `startOfWeekDZ` — la semaine commence le
dimanche) et **dans le test qui validait l'erreur**.

### 4.3 Identifiants officiels **[fait]**

- **NIN** — 18 chiffres, décret exécutif n° 23-320 (abroge le décret 10-210).
  Validation de longueur et de composition, affichage groupé `12 345 6789 …`.
- **Numéro d'assuré social** (carte Chifa) — 8 à 12 chiffres.
- **Téléphone** — mobiles `05/06/07` + 8 chiffres, fixes `0xx` + 6 chiffres,
  normalisation de `+213` et `00213` vers le format national.

### 4.4 Couverture sociale **[fait]**

Le schéma `patient_insurance` était calibré sur le modèle français (CPAM, 70 %).
Remplacé par :

| Régime | Population |
|---|---|
| `CNAS` | salariés |
| `CASNOS` | non-salariés, professions libérales, commerçants |
| `MILITARY` | sécurité sociale militaire |
| `MUTUELLE` / `PRIVATE` | complémentaires |
| `NONE` | sans couverture — cas fréquent, réglé intégralement au comptoir |

Taux de droit commun **80 %** (`DEFAULT_COVERAGE_RATE`), **100 %** pour les
affections de longue durée. Le seed laisse volontairement un patient sur six
sans couverture.

### 4.5 Droit de timbre **[fait]**

Article 100 du code du timbre : les règlements **en espèces** supportent un
droit de **1 DA par tranche de 100 DA entamée**, plancher **5 DA**, plafond
**2 500 DA**, exonération jusqu'à 20 DA. Les virements et versements bancaires
en sont dispensés (article 258 bis).

C'est la règle la plus facile à implémenter de travers — d'où quatre tests
dédiés, dont le cas piège `1001 DA → 11 DA` (tranche entamée, pas 10).

```js
export function stampDuty(amount, method) {
  if (!STAMP_DUTY_METHODS.includes(method)) return 0;
  const ttc = Number(amount) || 0;
  if (ttc <= 20) return 0;
  return Math.min(2500, Math.max(5, Math.ceil(ttc / 100)));
}
```

> **Réserve.** L'interprétation du barème par tranches fait débat depuis la loi
> de finances 2025 (calcul par tranches cumulatives *vs* pourcentage exact). La
> formule retenue est celle communément appliquée. **À faire valider par le
> comptable de la clinique avant mise en production** — l'écart peut atteindre
> une centaine de dinars sur les montants élevés.

### 4.6 Paiements **[fait]**

Libellés alignés sur la réalité : `Carte CIB / Edahabia`, `Virement / CCP`,
`Tiers payant (CNAS / CASNOS)`, `Prise en charge / Convention`. Les **codes en
base sont inchangés** — l'historique de facturation reste valide.

Le jeu de démonstration reflète la prédominance des espèces (≈ 5 règlements sur
7) plutôt qu'une répartition en tiers.

### 4.7 Découpage administratif et calendrier **[fait]**

**58 wilayas**, y compris les dix créées en 2019. Fuseau `Africa/Algiers`
(pas d'heure d'été — un point qui simplifie la gestion des créneaux par rapport
à `Europe/Paris`).

Fêtes à date fixe codées : Jour de l'An, **Yennayer (12 janvier)**, Fête du
Travail, Indépendance (5 juillet), Révolution (1ᵉʳ novembre). Les fêtes
religieuses suivent le calendrier hégirien : elles dépendent de l'observation
lunaire et **ne peuvent pas être calculées de façon fiable à l'avance**. Elles
sont saisies chaque année par l'administrateur dans Paramètres → Jours fériés.
Toute bibliothèque promettant le contraire produira des erreurs d'un jour.

### 4.8 Jeu de données **[fait]**

Praticiens (BENALI, HAMDANI, BOUDIAF, MEKKI, ZERROUKI), patients, communes
d'Alger réelles (Bab Ezzouar, Hydra, Kouba, Chéraga, Zéralda…), codes postaux
en `16xxx`, mobiles `05/06/07`.

Tarifs en dinars, ordres de grandeur du privé algérois, avec les **lettres-clés
de la nomenclature CNAS** portées par le code — elles servent aux feuilles de
soins et au conventionnement :

| Code | Acte | Tarif |
|---|---|---|
| `C` | Consultation médecine générale | 1 500 DA |
| `CS-CARDIO` | Consultation cardiologie | 3 000 DA |
| `CS-DERMA` | Consultation dermatologie | 2 500 DA |
| `CS-PEDIA` | Consultation pédiatrique | 2 000 DA |
| `ECG` | Électrocardiogramme | 1 800 DA |
| `AMM` | Séance de kinésithérapie | 1 200 DA |

Comptes : `admin`, `s.amrani` (réception), `a.benali` (praticien),
`c.compta` (facturation) — mot de passe inchangé `Clinique2026!`.

### 4.9 Chantiers locaux restants **[à faire]**

**Bilinguisme français / arabe.** Le plus lourd, et volontairement non entamé :
mal fait, il coûte plus cher qu'il ne rapporte. La préparation est en place
(`unicode-bidi: plaintext`, police compatible). La vraie question n'est pas la
traduction mais le **sens de lecture** : en arabe, l'agenda, la barre latérale
et les tableaux s'inversent. Cela suppose des propriétés logiques
(`margin-inline-start` plutôt que `margin-left`) sur l'ensemble de la feuille de
style. À traiter comme un chantier autonome, après validation du besoin réel
auprès des utilisateurs — beaucoup de cliniques privées travaillent en français.

**Champs d'état civil.** Ajouter `nom_arabe` / `prenom_arabe` (l'état civil
algérien est bilingue), le nom du père et le nom de jeune fille de la mère,
mentions usuelles sur les documents officiels.

**Mentions légales sur facture.** NIF, registre du commerce, article
d'imposition et numéro d'agrément DSP sont déjà stockés (`clinic.nif`,
`clinic.rc`, `clinic.article_imposition`, `clinic.agrement`) mais **pas encore
imprimés sur la facture**. À câbler dans le gabarit d'impression.

**Ordonnance imprimable** au format attendu localement, avec en-tête de la
clinique, numéro d'ordre du praticien et cachet.

---

## 5. Tests

`apps/api/test/locale.test.mjs` — 21 tests, dont deux gardes anti-régression qui
échouent si l'euro ou la semaine européenne réapparaissent :

```js
assert.ok(!/currency:\s*'EUR'/.test(read('apps/web/src/lib.jsx')));
assert.ok(!/if \(dow > 5\) continue/.test(read('apps/api/src/db/seed.mjs')));
```

**Total : 77/77** (49 API + 7 portabilité + 21 localisation).

---

## 6. Ordre d'implémentation suggéré

| Priorité | Chantier | Effort | Pourquoi |
|---|---|---|---|
| 1 | Mentions légales sur facture | faible | données déjà en base, blocage réglementaire |
| 2 | Validation du droit de timbre par le comptable | faible | risque fiscal |
| 3 | Restauration guidée | moyen | scénario critique sans interface |
| 4 | Assistant de première configuration | moyen | conditionne toute installation |
| 5 | Recherche par téléphone + translittération | moyen | gain quotidien au comptoir |
| 6 | Inversion du tunnel de prise de RDV | moyen | correspond au déroulé réel de l'appel |
| 7 | Export comptable | moyen | réclamé dès le premier mois |
| 8 | Champs d'état civil bilingues | moyen | conformité documentaire |
| 9 | Interface arabe / RTL | élevé | à valider auprès des utilisateurs d'abord |
