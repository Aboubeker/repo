# 06 — Interface utilisateur : wireframes et spécification des écrans

Principes : densité d'information élevée (l'accueil traite 100+ interactions/jour), tout au clavier, couleurs porteuses de sens (statuts), zéro modale inutile, actions destructrices toujours confirmées et réversibles.

**Raccourcis globaux** : `N` nouveau RDV · `P` recherche patient · `A` agenda · `F` file d'attente · `/` recherche globale · `Échap` fermer · `Ctrl+S` enregistrer · `F1` aide contextuelle · `Ctrl+L` verrouiller l'écran.

**Codes couleur des statuts** : gris = planifié · bleu = confirmé · vert = arrivé · orange = en consultation · vert foncé = terminé · rouge rayé = annulé · rouge plein = absent (no-show) · hachuré = indisponibilité.

---

## 1. Écran de connexion

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│                    ╭──────────────────╮                       │
│                    │   CliniRDV       │                       │
│                    │  Clinique Saint- │                       │
│                    │      Michel      │                       │
│                    ╰──────────────────╯                       │
│                                                               │
│        Identifiant  [ s.martin                    ]           │
│        Mot de passe [ ••••••••••••          👁    ]           │
│        Code TOTP    [ _ _ _  _ _ _ ]  (si MFA activé)         │
│                                                               │
│                    [   Se connecter   ]                       │
│                                                               │
│        ⚠ 2 tentatives restantes avant verrouillage            │
│                                                               │
│  ─────────────────────────────────────────────────────────    │
│  Serveur local · v2.0.0 · Base : OK · Sauvegarde : 01:00 ✓    │
│  Accès réservé au personnel autorisé. Activité journalisée.   │
└───────────────────────────────────────────────────────────────┘
```

Le bandeau bas rassure sur l'état du système (aucune connexion externe, dernière sauvegarde).

---

## 2. Tableau de bord — Réceptionniste

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ CliniRDV  [🔍 Rechercher patient, RDV… (/)          ]   🔔3  S.Martin ▾  🔒 12:45     │
├────────────┬─────────────────────────────────────────────────────────────────────────┤
│ ◧ Accueil  │  Mardi 2 septembre 2026                        [+ Nouveau RDV (N)]      │
│ ▤ Agenda   │                                                                          │
│ ⚕ Patients │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│ ⏱ File     │  │ RDV jour│ │ Arrivés │ │ En cons.│ │ Absents │ │ À encais│            │
│ 👤 Praticie│  │   87    │ │   34    │ │    6    │ │    3    │ │   11    │            │
│ 🏥 Ressourc│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│ 💶 Factura │                                                                          │
│ 📊 Rapports│  PROCHAINS RENDEZ-VOUS (2 h)          │  À FAIRE                         │
│ ⚙ Admin    │  ─────────────────────────────────    │  ──────────────────────────      │
│            │  10:40 Dupont Marie  Dr Bernard  S12  │  ⚠ 4 assurances expirées         │
│            │        ● confirmé                     │  📞 7 rappels à passer (J-1)     │
│            │  10:40 Nkosi Jean    Dr Leroy    S03  │  💶 11 factures à encaisser      │
│            │        ○ non confirmé  [Appeler]      │  📄 3 documents manquants        │
│            │  11:00 Sow Fatou     Dr Bernard  S12  │  🕐 2 patients en liste d'attente│
│            │  11:00 Martin Luc    Dr Aziz    Éch.  │     → créneau libéré 14:20 ▸     │
│            │  ...                    [Voir tout ▸] │                                  │
│            │                                                                          │
│            │  OCCUPATION DU JOUR                   │  ALERTES SYSTÈME                 │
│            │  Dr Bernard  ████████████░░  86 %     │  ✓ Sauvegarde 01:04 (2,3 Go)     │
│            │  Dr Leroy    ██████████████ 100 %     │  ✓ Disque 62 % · Base OK         │
│            │  Dr Aziz     ███████░░░░░░░  52 %     │                                  │
└────────────┴─────────────────────────────────────────────────────────────────────────┘
```

Chaque bloc « À faire » est cliquable et mène à une liste filtrée et actionnable.

---

## 3. Agenda (écran le plus utilisé)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◂ ▸ [Aujourd'hui]  Semaine 36 · 31 août – 6 sept. 2026     [Jour][Semaine][Mois][Res]│
│ Praticiens: [☑Bernard ☑Leroy ☑Aziz ☐Tous ▾]  Spécialité:[Toutes▾]  Salle:[Toutes▾]  │
│ [🖨 Imprimer] [+ Nouveau RDV]                              🟢 3 utilisateurs connectés│
├──────┬───────────────┬───────────────┬───────────────┬───────────────┬───────────────┤
│      │ LUN 31        │ MAR 1         │ MER 2         │ JEU 3         │ VEN 4         │
├──────┼───────────────┼───────────────┼───────────────┼───────────────┼───────────────┤
│08:00 │▓▓ Dr Bernard ▓│               │▓ DUPONT M.   ▓│               │░░░░░░░░░░░░░░░│
│08:20 │▓ MARTIN L.   ▓│  KONE A.      │▓ Contrôle S12▓│  BEN ALI S.   │░ Dr Bernard  ░│
│08:40 │  ● confirmé   │  ○ planifié   │  ● arrivé     │  ● confirmé   │░  ABSENCE    ░│
│09:00 │───────────────│───────────────│═══════════════│───────────────│░  Formation  ░│
│09:20 │  SOW F.       │  ╳ ANNULÉ     │▓ NKOSI J.    ▓│  DIALLO M.    │░░░░░░░░░░░░░░░│
│09:40 │  ● confirmé   │               │▓ En cons. 🟠 ▓│  ○ planifié   │               │
│10:00 │╔═════════════╗│               │───────────────│               │               │
│10:20 │║ URGENCE     ║│  ⬚ libre      │  ⬚ libre      │  ⬚ libre      │               │
│10:40 │║ TRAORE K. ⚡║│               │  ⬚ libre      │               │               │
│11:00 │╚═════════════╝│               │═══ PAUSE ═════│               │               │
│12:00 │▒▒▒▒ DÉJEUNER ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│14:00 │  …            │  …            │  …            │  …            │  …            │
└──────┴───────────────┴───────────────┴───────────────┴───────────────┴───────────────┘
 Légende: ● confirmé ○ planifié 🟠 en consultation ╳ annulé ⚡ urgence ⬚ libre ░ absence
```

Interactions : clic sur un créneau libre → création pré-remplie ; clic sur un RDV → panneau latéral détail ; **drag & drop** pour déplacer (bordure verte = possible, rouge = conflit avec la raison affichée en infobulle) ; poignée basse pour allonger la durée ; clic droit → menu contextuel (Confirmer, Check-in, Déplacer, Annuler, Imprimer convocation, Créer facture, Voir le dossier) ; molette+Ctrl = zoom temporel (5/10/15/20/30 min) ; les modifications faites par un autre poste apparaissent en temps réel avec un halo bleu de 2 s.

**Vue Ressources** : colonnes = salles/équipements, mêmes interactions, pour visualiser les conflits matériels.

### Panneau latéral « Détail RDV »

```
┌──────────────────────────────────────┐
│ RDV-2026-004512            ✕         │
│ ─────────────────────────────────────│
│ 👤 DUPONT Marie, 47 ans   [Dossier ▸]│
│    ☎ 06 12 34 56 78                  │
│    ⚠ Allergie: Pénicilline (CRITIQUE)│
│    ⓘ 2 no-shows sur 12 mois          │
│ ─────────────────────────────────────│
│ 📅 Mer. 2 sept. 2026 · 08:20 → 08:40 │
│ ⚕ Dr Bernard · Cardiologie           │
│ 🏥 Salle 12 · ECG-02                 │
│ 🏷 Consultation de contrôle          │
│ ● Statut : Arrivé (08:14)            │
│ 💬 Motif : suivi post-opératoire     │
│ 🔔 Rappel SMS envoyé 31/08 09:00 ✓   │
│ ─────────────────────────────────────│
│ [Appeler le patient] [Déplacer]      │
│ [Annuler]  [🖨 Convocation]  [Facture]│
│ ─────────────────────────────────────│
│ Historique                            │
│ 31/08 09:00 Confirmé (SMS)           │
│ 28/08 14:32 Créé par s.martin        │
└──────────────────────────────────────┘
```

---

## 4. Assistant de prise de rendez-vous (3 étapes, plein écran)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Nouveau rendez-vous            ①Patient ──── ②Créneau ──── ③Confirmation      ✕     │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ÉTAPE 2 — Choix du créneau                                                          │
│                                                                                       │
│  Patient : DUPONT Marie (P-2019-004521) · 47 ans · ☎ 06 12 34 56 78     [Changer]    │
│                                                                                       │
│  Type de RDV [Consultation de contrôle (20 min) ▾]   Priorité [Normale ▾]            │
│  Praticien   [Dr Bernard ▾]  ou  Spécialité [Cardiologie ▾] ☑ Premier disponible     │
│  À partir du [02/09/2026 📅]  Préférence [☑ Matin ☐ Après-midi]  Jours [L M M J V]   │
│                                                                                       │
│  ┌── CRÉNEAUX DISPONIBLES ─────────────────────────────────────────────────────────┐ │
│  │ Mer. 2 sept.   [10:20] [10:40] [11:00]                    Salle 12 · ECG-02     │ │
│  │ Jeu. 3 sept.   [08:00] [08:20] [09:20] [10:00] [+4]       Salle 12              │ │
│  │ Ven. 4 sept.   — Dr Bernard absent (formation) —                                │ │
│  │ Lun. 7 sept.   [08:00] [08:40] [11:00] [+9]               Salle 12              │ │
│  └─────────────────────────────────────────────────────────────────────────────────┘ │
│  ⓘ Aucun créneau ne convient ?   [Inscrire en liste d'attente]                       │
│                                                                                       │
│  Motif de consultation [ suivi post-opératoire                                ]      │
│  Notes internes        [                                                       ]      │
│  Rappels  ☑ SMS (consentement OK)  ☑ E-mail  ☐ Convocation papier                    │
│                                                                                       │
│                                          [◂ Retour]  [Valider le rendez-vous ▸]      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Recherche et liste des patients

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Patients                                              [+ Nouveau patient]  [Importer]│
│ 🔍 [ dupon                              ]  Filtres: [Actifs ▾] [Tous praticiens ▾]   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ MRN            Nom, Prénom          Naissance    Téléphone       Dernier RDV  Solde  │
│ P-2019-004521  DUPONT Marie         12/03/1979   06 12 34 56 78  02/09/2026   0,00 € │
│ P-2021-001180  DUPONT Jean-Pierre   04/07/1962   06 98 76 54 32  14/06/2026  45,00 €⚠│
│ P-2024-000902  DUPOND Léa           22/11/2001   07 11 22 33 44  —            0,00 € │
│                                                            3 résultats · 12 ms        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Recherche tolérante aux fautes (trigram + unaccent), par nom, prénom, MRN, téléphone, date de naissance (`12/03/1979` ou `120379`). Ligne cliquable → fiche. Survol → aperçu rapide.

---

## 6. Fiche patient

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◂ Patients │ DUPONT Marie · 47 ans · F · P-2019-004521          [✎ Modifier] [+ RDV] │
│ ╔══════════════════════════════════════════════════════════════════════════════════╗ │
│ ║ ⚠ ALLERGIE CRITIQUE : Pénicilline  ·  Anticoagulant en cours                     ║ │
│ ╚══════════════════════════════════════════════════════════════════════════════════╝ │
│ [Identité] [Médical] [Rendez-vous] [Documents] [Facturation] [Consentements] [Journal]│
├──────────────────────────────────────────────────────────────────────────────────────┤
│  IDENTITÉ                              │  COORDONNÉES                                 │
│  Nom            DUPONT                 │  Mobile    06 12 34 56 78   ✓ vérifié       │
│  Nom de nais.   LEROY                  │  Fixe      01 23 45 67 89                    │
│  Prénom         Marie                  │  E-mail    m.dupont@…       ✓                │
│  Naissance      12/03/1979 (47 ans)    │  Adresse   12 rue des Lilas                  │
│  Lieu           Lyon (69)              │            69003 LYON                        │
│  NIR            2 79 03 69•••••• 🔒    │                                              │
│  Groupe sanguin A+                     │  PERSONNE DE CONFIANCE                       │
│  Médecin trait. Dr Petit (externe)     │  DUPONT Marc (époux) · 06 55 44 33 22        │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  COUVERTURE                            │  SYNTHÈSE                                    │
│  Régime obligatoire  100 % ALD         │  Patient depuis 03/2019 · 34 consultations   │
│  Mutuelle  MutuSanté · exp. 31/12/2026 │  Dernier RDV 02/09/2026 (Dr Bernard)         │
│                                        │  Prochain    14/10/2026                      │
│                                        │  No-shows 2/12 mois ⚠ · Solde dû 0,00 €      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Onglet **Médical** : allergies, antécédents, traitements, vaccinations (accès PRACTITIONER uniquement, lecture journalisée).
Onglet **Rendez-vous** : historique complet avec statuts, filtre, bouton « Reprendre ce RDV ».
Onglet **Journal** : qui a consulté/modifié la fiche et quand (transparence, visible par l'admin et le patient sur demande).

---

## 7. File d'attente du jour (écran d'accueil temps réel)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ File d'attente · Mercredi 2 septembre 2026 · 10:42        🔄 temps réel   [🖨 Liste]  │
├──────────────────┬──────────────────┬──────────────────┬─────────────────────────────┤
│ ATTENDUS (18)    │ EN SALLE (5)     │ EN CONSULT. (6)  │ TERMINÉS (34)               │
├──────────────────┼──────────────────┼──────────────────┼─────────────────────────────┤
│ 10:40 NKOSI J.   │ 10:20 SOW F.     │ 10:00 DUPONT M.  │ 09:40 KONE A.    💶 à payer │
│  Dr Leroy · S03  │  Dr Bernard      │  Dr Bernard S12  │  Dr Aziz     [Créer facture]│
│  ☎ [Appeler]     │  ⏱ attend 22 min │  ⏱ 12 min        │                             │
│  [✓ Check-in]    │  ⚠ retard 15 min │                  │ 09:20 BEN ALI S. ✓ payé     │
│                  │                  │                  │                             │
│ 11:00 SOW F.     │ 10:30 DIALLO M.  │ 10:15 TRAORE K.  │ 09:00 MARTIN L.  ✓ payé     │
│  [✓ Check-in]    │  ⏱ attend 12 min │  Dr Leroy S03    │                             │
│                  │                  │                  │                             │
│ 09:20 MARTIN P.  │                  │                  │ ABSENTS (3)                 │
│  ⏰ retard 82 min │                  │                  │ 08:40 BERGER T.  [No-show]  │
│  [No-show] [✓]   │                  │                  │                             │
└──────────────────┴──────────────────┴──────────────────┴─────────────────────────────┘
```

Colonnes déplaçables par glisser-déposer (= changement de statut). Alerte visuelle au-delà de 20 min d'attente.

---

## 8. Disponibilités d'un praticien

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Dr BERNARD Alice · Cardiologie          [Profil] [Disponibilités] [Absences] [Stats] │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ RÈGLES HEBDOMADAIRES                                          [+ Ajouter une plage]  │
│ Jour     Horaires        Salle    Créneau  Type          Validité          Actions   │
│ Lundi    08:00–12:00     S12      20 min   Tous          01/01/26 → ∞      ✎ 🗑      │
│ Lundi    14:00–18:00     S12      20 min   Tous          01/01/26 → ∞      ✎ 🗑      │
│ Mardi    08:00–12:00     S12      20 min   Tous          01/01/26 → ∞      ✎ 🗑      │
│ Mercredi 08:00–11:00     S12      30 min   Bilan complet 01/09/26 → ∞      ✎ 🗑      │
│ Jeudi    08:00–12:00     S12      20 min   Tous          01/01/26 → 31/12  ✎ 🗑      │
│                                                                                       │
│ APERÇU (8 semaines)   Capacité théorique : 92 RDV/semaine · Occupation moy. 78 %     │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐│
│ │ S36 ████████████████░░░░  86 %   S37 ██████████████░░░░░░  71 %  S38 ░ congés    ││
│ └──────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                       │
│ ABSENCES                                                        [+ Déclarer]          │
│ 04/09/2026 journée     Formation      3 RDV impactés  [Replanifier ▸]                │
│ 21/12 → 04/01          Congés         0 RDV                                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

L'assistant **Replanifier** liste les RDV impactés et propose pour chacun 3 créneaux alternatifs, avec envoi groupé des notifications.

---

## 9. Facturation

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Facturation   [Factures] [Paiements] [Caisse] [Impayés] [Exports]                    │
│ Période [Septembre 2026 ▾]  Statut [Toutes ▾]  🔍[            ]   [+ Nouvelle]       │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ N°            Date      Patient          Praticien   Total    Payé    Solde   Statut │
│ F-2026-01847  02/09     DUPONT Marie     Bernard     50,00 €  50,00 €  0,00 € ✓ Payée│
│ F-2026-01846  02/09     KONE Awa         Aziz        75,00 €  25,00 € 50,00 € ◐ Part.│
│ F-2026-01845  01/09     DUPONT J-P       Leroy       45,00 €   0,00 € 45,00 € ⚠ Retard│
│ …                                                                                     │
│ ───────────────────────────────────────────────────────────────────────────────────  │
│ Total période 12 480 € · Encaissé 11 205 € · Encours 1 275 € · Retard > 30 j : 340 € │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Modale d'encaissement** : montant dû, modes de paiement multiples (répartition espèces/carte/chèque), rendu de monnaie calculé, bouton « Encaisser et imprimer le reçu » (`Entrée`).
**Clôture de caisse** : comptage par coupure, total théorique vs compté, écart, commentaire obligatoire si écart, rapport imprimé et archivé.

---

## 10. Rapports

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Rapports   Période [01/08/2026 → 31/08/2026]  Praticien [Tous ▾]  [Exporter CSV/PDF] │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Taux d'occupation global      82 %   ▲ +4 pts vs juillet                            │
│  RDV honorés 1 842 · Annulés 118 (6 %) · No-shows 74 (3,9 %) ▼ -0,6 pt               │
│  Délai moyen d'obtention 6,2 jours · Durée moyenne 21 min · Attente moyenne 14 min   │
│  Chiffre d'affaires 92 340 € · Encaissé 88 120 € · Encours 4 220 €                   │
│                                                                                       │
│  OCCUPATION PAR PRATICIEN            │  RÉPARTITION PAR SPÉCIALITÉ                   │
│  Bernard  ████████████████░░  86 %   │  Cardiologie   ████████████ 38 %              │
│  Leroy    ██████████████████  94 %   │  Généraliste   █████████    29 %              │
│  Aziz     ██████████░░░░░░░░  58 %   │  Dermatologie  ██████       19 %              │
│                                       │  Kinésithérap. ████         14 %              │
│  OCCUPATION HORAIRE (heures creuses) │  OCCUPATION DES SALLES                        │
│  08h ██████░ 09h █████████ 10h ██████│  S12 91 % · S03 78 % · S07 44 % · Bloc 62 %   │
│  14h ████░░░ 15h ███████░░ 16h ████░░│                                               │
│  ⓘ Créneaux de 14 h sous-utilisés (41 %) → potentiel +12 RDV/semaine                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Rapports standards : occupation, activité par praticien/spécialité, no-show et annulations, délais d'accès, financier, occupation des ressources, journal d'audit. Générateur personnalisé (dimensions × mesures × filtres), export CSV/PDF vers un dossier local, impression planifiée.

---

## 11. Administration — Sauvegardes

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Administration › Sauvegardes                              [⟳ Sauvegarder maintenant] │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ État : ✓ Sain   Dernière sauvegarde réussie : aujourd'hui 01:04 (il y a 9 h 38)      │
│ Espace disque sauvegardes : 412 Go / 1 To (41 %)   Dernier test de restauration : ✓  │
│                                                     28/08/2026 (durée 41 min)         │
│ ───────────────────────────────────────────────────────────────────────────────────  │
│ Date/heure        Type          Durée   Taille   Cible        Statut   Restauration  │
│ 02/09 01:04       Incrémentale  4 min   2,3 Go   NAS-01       ✓        [Restaurer ▸] │
│ 01/09 01:03       Incrémentale  4 min   2,1 Go   NAS-01       ✓        [Restaurer ▸] │
│ 31/08 02:00       Complète      38 min  186 Go   NAS-01 + USB ✓ testée [Restaurer ▸] │
│ 30/08 01:05       Incrémentale  —       —        NAS-01       ✗ échec  Voir l'erreur │
│ ───────────────────────────────────────────────────────────────────────────────────  │
│ Planification : incrémentale quotidienne 01:00 · complète dimanche 02:00 ·           │
│ WAL continu · rétention 30 j / 12 sem.                                [⚙ Modifier]   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

La restauration ouvre un assistant en 4 étapes (choix du point de restauration → impact → confirmation par saisie du mot « RESTAURER » → exécution avec journal en direct).

---

## 12. Impressions

| Document | Contenu | Format |
|---|---|---|
| Convocation patient | Logo, patient, date/heure, praticien, salle, plan d'accès, consignes de préparation, téléphone d'annulation, QR code interne (référence RDV) | A5 ou A4 |
| Planning du jour (praticien) | Liste horaire, patients, motifs, alertes | A4 paysage |
| Liste d'appels | Patients à rappeler, téléphone, RDV concerné, case à cocher | A4 |
| Reçu de paiement | Montant, mode, facture liée, mentions légales | Ticket 80 mm ou A5 |
| Facture | Mentions légales, lignes, TVA, parts assurance/patient | A4 |
| Rapport de caisse | Session, détail par mode, écart, signatures | A4 |

---

## 13. Ergonomie et accessibilité

- Contraste AA minimum, statuts jamais signalés par la seule couleur (icône + libellé).
- Cibles tactiles ≥ 44 px (postes à écran tactile à l'accueil).
- Navigation clavier complète, ordre de tabulation logique, `aria-live` pour les mises à jour temps réel.
- Réglage de la taille de police (100/125/150 %) mémorisé par utilisateur ; mode sombre pour les postes de garde.
- Aide contextuelle `F1`, info-bulles sur les règles métier, messages d'erreur rédigés en langage clair et orientés action.
- Sauvegarde automatique des brouillons de formulaire (récupération après coupure).
