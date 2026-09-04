# Encaissement immédiat après consultation — conception de l'interface

> Document de conception. Il décrit l'écran à construire, le flux, et les
> décisions d'architecture. Il s'appuie sur l'état réel du code au
> 3 septembre 2026 (branche `arena/01a0629d-repo`), pas sur une cible
> théorique : chaque manque signalé ci-dessous a été vérifié dans les sources.

---

## 1. État des lieux : ce qui existe et ce qui manque

Avant de dessiner quoi que ce soit, il faut savoir ce dont on part. Trois
constats structurent toute la conception.

### 1.1 Le lien consultation → facture n'existe pas

`api.createInvoice` est **défini dans `apps/web/src/api.js` (l. 148) et n'est
appelé nulle part** dans l'interface. Côté serveur, `POST /api/invoices`
accepte pourtant un `appointmentId`, vérifie que le rendez-vous est
`COMPLETED`, refuse le double-facturation (`ALREADY_INVOICED`) et
**pré-remplit automatiquement la première ligne** depuis le tarif par défaut
du type de rendez-vous (`billing.routes.mjs` l. 72-133).

Autrement dit : **le moteur est déjà là, il manque le fil qui l'actionne.**
C'est le point le plus important de ce document. La fonctionnalité demandée
n'est pas un développement lourd ; c'est essentiellement un raccordement.

### 1.2 La facture est aujourd'hui en lecture seule

`InvoiceDetail` (`apps/web/src/pages/Billing.jsx`) affiche les lignes dans un
tableau statique. Il n'y a **aucune interface d'ajout, de modification ou de
suppression de ligne** — vérifié : aucune occurrence de `addInvoiceLine` hors
de sa définition dans `api.js`.

### 1.3 Il manque une seule route serveur

| Opération | Route | État |
|---|---|---|
| Ajouter une ligne | `POST /api/invoices/:id/lines` | existe |
| Supprimer une ligne | `DELETE /api/invoices/:iid/lines/:id` | existe, avec contrôle propre |
| **Modifier une ligne** | `PATCH /api/invoices/:iid/lines/:id` | **absente** |

C'est la seule brique serveur à écrire. Bonne nouvelle : le garde-fou en base
`fn_invoice_line_guard` (`infra/db/001_schema.sql` l. 642) couvre déjà
`BEFORE INSERT OR UPDATE OR DELETE` — la protection « facture émise =
immuable » s'appliquera automatiquement à la nouvelle route, sans rien ajouter.

---

## 2. Le parcours actuel, chiffré

Aujourd'hui, encaisser une consultation qui vient de se terminer impose :

1. File d'attente → « Terminer » (le rendez-vous passe `COMPLETED`)
2. Navigation vers Facturation
3. …et là, **impasse** : aucune facture n'a été créée. Rien ne relie les deux.

Le parcours est donc littéralement **impossible à terminer depuis l'interface**.
La facture ne peut naître que par un appel API direct. C'est le vrai problème à
résoudre, au-delà de l'ergonomie.

**Cible : 1 clic.** « Terminer et encaisser » ouvre la facture, pré-remplie,
modifiable, prête à encaisser.

---

## 3. Architecture de l'écran

### 3.1 Choix structurant : un tiroir, pas une page

La facture s'ouvre dans un **panneau latéral** (`Drawer`, déjà présent dans
`lib.jsx`) superposé à la file d'attente, et non dans une page à part.

Justification : la réceptionniste enchaîne les clients. Si l'encaissement la
sort de la file d'attente, elle perd le contexte de la salle — qui attend, qui
est en cabine — et doit y revenir manuellement à chaque fois. Le tiroir
préserve la liste en arrière-plan. À la fermeture, elle est exactement là où
elle était.

Corollaire : **pas de changement de page, donc pas de rechargement**, et
l'écran de file d'attente qui se rafraîchit toutes les 20 secondes
(`Queue.jsx`) continue de vivre derrière.

### 3.2 Découpage en composants

```
Queue.jsx / Calendar.jsx
  └── bouton « Terminer et encaisser »   ← point d'entrée unique
        │  POST /api/appointments/:id/status  (COMPLETED)
        │  POST /api/invoices { appointmentId }   ← enchaîné
        ▼
  CheckoutDrawer.jsx                      ← NOUVEAU
    ├── CheckoutHeader     client, dossier, praticien, statut
    ├── LineEditor         ← NOUVEAU  lignes éditables en place
    │     ├── LineRow          désignation / qté / P.U. / total / ✕
    │     └── AddLineBar       catalogue + saisie libre
    ├── TotalsPanel        sous-total, tiers payant, timbre, TOTAL
    └── CollectBar         « Émettre et encaisser »
          └── PayModal     (réutilisé tel quel depuis Billing.jsx)
```

`PayModal` est repris **sans modification** : il gère déjà le droit de timbre,
le rendu de monnaie et les modes de paiement. Le réécrire dupliquerait une
logique fiscale délicate.

---

## 4. Les éléments de l'écran

### 4.1 En-tête — le contexte, en une ligne

Nom du client, numéro de dossier, praticien, statut de la facture. Compact :
l'information utile au guichet tient en une ligne, le reste est du bruit.

### 4.2 L'éditeur de lignes — le cœur

| Désignation | Qté | P.U. | Total | |
|---|---:|---:|---:|---|
| Consultation dermatologie | `1` | `2 500` | 2 500 DA | ✕ |
| *+ Ajouter une prestation…* | | | | |

**Édition en place.** La quantité et le prix unitaire sont des champs de
saisie directement dans le tableau — pas de sous-fenêtre « modifier la
ligne ». Ouvrir une boîte de dialogue pour changer un « 1 » en « 2 » coûte
trois clics là où un seul suffit.

**Deux façons d'ajouter, selon ce qu'on vend :**

- **Depuis le catalogue** — une liste déroulante alimentée par
  `GET /api/tariffs` (route existante). Le libellé, le prix et le taux de TVA
  se remplissent seuls. C'est le cas courant : produit ou soin au tarif.
- **En saisie libre** — désignation et montant tapés à la main, pour le cas
  hors catalogue. Le serveur l'accepte déjà : `label` et `unitPrice` sont les
  seuls champs requis par `POST /lines`.

**Suppression** par la croix en fin de ligne, avec confirmation *uniquement*
si la ligne a été enregistrée. Confirmer la suppression d'une ligne ajoutée
par erreur trois secondes plus tôt est une friction gratuite.

### 4.3 Le bandeau des totaux — toujours visible

Ancré en bas du tiroir, il ne défile pas avec les lignes :

```
Sous-total                        2 500 DA
Part organisme (tiers payant)   − 2 000 DA
Reste à charge client             500 DA
Droit de timbre (espèces)           5 DA
─────────────────────────────────────────
TOTAL À ENCAISSER                 505 DA
```

Le **reste à charge** et le **total à encaisser** sont les deux seuls chiffres
que la caissière annonce à voix haute. Ils doivent être lisibles sans
recalculer quoi que ce soit, et sans faire défiler.

Le droit de timbre n'apparaît **que** si le règlement est en espèces
(art. 100 du code du timbre ; les virements en sont exonérés par l'art. 258
bis). Il est affiché *avant* l'encaissement, jamais découvert après.

---

## 5. Flux d'interaction

### 5.1 Le chemin nominal

```
[File d'attente]  Mme BELKACEM — en cabine
        │
        │  clic « Terminer et encaisser »
        ▼
[Tiroir]  Facture (brouillon)
          Consultation dermatologie    1 × 2 500 = 2 500 DA
          TOTAL                                    2 500 DA
        │
        │  clic « Émettre et encaisser »
        ▼
[Encaissement]  espèces / carte / chèque…
        ▼
   « Encaissé. » — le tiroir se ferme, la file est à jour
```

**Trois clics** du fauteuil à l'encaissement, sans saisie si rien ne change.

### 5.2 Le chemin avec ajout

Le praticien a fourni une crème en plus. La réceptionniste ouvre le
catalogue, choisit le produit, la ligne s'ajoute et **le total se met à jour
immédiatement**. Puis elle encaisse.

### 5.3 Décision : émission et encaissement en un geste

Le serveur impose que la facture soit **émise** avant tout paiement
(`INVOICE_NOT_ISSUED`, `billing.routes.mjs` l. 242). L'émission attribue le
numéro légal et rend le document immuable.

Exposer deux boutons distincts — « Émettre » puis « Encaisser » — obligerait
la caissière à comprendre une subtilité comptable qui ne la concerne pas. Le
bouton unique **« Émettre et encaisser »** enchaîne les deux appels. La
sémantique légale est respectée, la complexité reste dans la machine.

En revanche, l'action est **irréversible** et doit le dire : une fois émise,
la facture ne se corrige que par un avoir. Le bouton est donc précédé d'une
mention discrète : *« La facture sera numérotée définitivement. »*

---

## 6. Le calcul en temps réel : où le faire ?

C'est la décision technique la plus délicate de cet écran, et la plus facile
à rater.

**Le total ne doit jamais être calculé dans le navigateur.** Il est déjà
calculé en base :

- `invoice.subtotal`, `vat_amount` et `total_amount` sont recalculés par le
  trigger `trg_recalc_invoice_totals`, qui se déclenche `AFTER INSERT OR
  UPDATE OR DELETE` sur `invoice_line` ;
- ce même trigger enchaîne `fn_recalc_invoice_shares` (migration 005 l. 98),
  qui met à jour la ventilation assurance / client ;
- `balance` est une colonne **générée**
  (`GENERATED ALWAYS AS (total_amount - paid_amount) STORED`).

Conséquence pratique : **ajouter, modifier ou supprimer une ligne suffit** —
totaux et ventilation suivent seuls, dans la même transaction. L'interface n'a
aucun recalcul à déclencher, et le futur `PATCH` en bénéficiera sans une ligne
de code supplémentaire.

Un total recalculé côté React donnerait un deuxième chiffre, issu d'une
deuxième logique, qui dériverait du premier à la première subtilité — un taux
de couverture à 80 %, un arrondi, une remise. Ce défaut existait déjà dans ce
projet : la ventilation était autrefois calculée à la création, et **toute
ligne ajoutée ensuite laissait `insurance_part + patient_part` inférieur au
total** (le commentaire est encore dans `billing.routes.mjs` l. 119). C'est
exactement l'erreur à ne pas refaire.

**Règle retenue :** chaque modification de ligne déclenche l'appel serveur,
puis **relit la facture** et réaffiche les totaux renvoyés. La source de
vérité reste unique.

**Mais l'utilisateur ne doit pas attendre le réseau.** Le compromis :

- le tableau des lignes est mis à jour **optimiste**, immédiatement ;
- le bandeau des totaux affiche brièvement un état « en cours » puis les
  valeurs **du serveur** ;
- en cas d'échec, la ligne est retirée et l'erreur affichée.

On obtient la réactivité perçue sans jamais afficher un total que la
comptabilité ne reconnaîtrait pas.

### 6.1 Vérification sur l'API réelle

Ces affirmations ont été testées contre le serveur en fonctionnement, sur la
base de démonstration, avant d'être écrites :

| Étape | Appel | Résultat observé |
|---|---|---|
| Facturer un RDV terminé | `POST /api/invoices {appointmentId}` | facture `DRAFT`, **pré-remplie à 3 000 DA**, sans numéro |
| Ajouter un produit | `POST /lines` (2 × 800) | `201` |
| Relire la facture | `GET /api/invoices/:id` | total **4 600 DA**, mis à jour seul |
| Cohérence | — | `insurance_part + patient_part = 4 600` = total |
| RDV déjà facturé | `POST /api/invoices` | `422 ALREADY_INVOICED` **avec `details.invoiceId`** |

Le dernier point justifie directement la recommandation du § 7 : le serveur
fournit l'identifiant de la facture existante, l'interface a donc tout ce
qu'il faut pour l'ouvrir au lieu d'afficher une erreur.

*(La facture créée pour ce test a été supprimée ; la suite reste à 168/168.)*

---

## 7. Bonnes pratiques UX retenues

**Le montant à encaisser est l'information principale.** Tout le reste —
numéro, échéance, praticien — est secondaire et traité comme tel
typographiquement.

**Aucune saisie dans le cas courant.** La ligne de consultation est
pré-remplie par le serveur depuis le tarif du type de rendez-vous. Le cas
majoritaire se traite sans toucher au clavier.

**Les erreurs se préviennent, elles ne se rattrapent pas.** Deux cas concrets
identifiés dans le code :

- *Caisse fermée.* Encaisser des espèces sans session ouverte est refusé
  (`NO_OPEN_CASH_SESSION`). Plutôt que de laisser la caissière découvrir le
  refus après avoir saisi le montant, l'écran vérifie
  `GET /api/cash-sessions/current` **à l'ouverture du tiroir** et affiche un
  avertissement avec un lien direct vers l'ouverture de caisse.
- *Rendez-vous déjà facturé.* Le serveur renvoie `ALREADY_INVOICED` **avec
  l'identifiant de la facture existante**. L'interface ne doit pas afficher
  une erreur sèche : elle ouvre la facture en question. Le double clic
  accidentel devient inoffensif.

**Protéger l'irréversible, fluidifier le reste.** Confirmation avant
l'émission (irréversible), aucune avant la suppression d'une ligne de
brouillon (sans conséquence).

**Le clavier reste utilisable.** `Échap` ferme, `Entrée` valide la ligne en
cours de saisie. Un guichet travaille vite.

**Ne pas régresser sur l'accessibilité des boutons.** Le contrat de style
existant (`.ghost` combiné à une couleur porte la teinte sur le *texte*) est
vérifié par `ui-contract.test.mjs`. La croix de suppression, discrète et
rouge, tombe précisément dans ce cas — un bouton invisible reste cliquable, ce
qui est exactement le défaut que ces tests empêchent de réintroduire.

---

## 8. Ce qu'il reste à écrire

| # | Élément | Nature | Remarque |
|---|---|---|---|
| 1 | `PATCH /api/invoices/:iid/lines/:id` | serveur | seule route manquante ; le trigger de garde couvre déjà l'`UPDATE` |
| 2 | Bouton « Terminer et encaisser » | front | `Queue.jsx` et `Calendar.jsx` |
| 3 | `CheckoutDrawer.jsx` | front | nouveau composant |
| 4 | `LineEditor` | front | édition en place |
| 5 | `updateInvoiceLine` / `deleteInvoiceLine` | front | à ajouter dans `api.js` |
| 6 | Tests | test | voir ci-dessous |

**Tests à prévoir**, dans la ligne de ce qui existe (168 actuellement) :

- le `PATCH` recalcule bien `line_total` et le total de la facture ;
- le `PATCH` sur une facture **émise** est refusé en 422, pas en 500 —
  c'est le défaut M4 déjà corrigé sur le `DELETE`, à ne pas réintroduire ;
- la ventilation reste cohérente après ajout **et** modification de ligne :
  `insurance_part + patient_part = total_amount` — le trigger est censé s'en
  charger, ce test verrouille cette garantie ;
- « Terminer et encaisser » sur un rendez-vous déjà facturé rouvre la facture
  existante au lieu d'échouer.

Chacun de ces tests doit être validé par mutation — réintroduire la panne et
vérifier que le test la signale — comme cela a été fait pour les correctifs
de facturation précédents.
