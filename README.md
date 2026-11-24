# Mes papiers retraite

Application web installable (PWA, PC et Android) pour :

- ranger bulletins de paie et déclarations Urssaf dans un coffre **chiffré sur l'appareil** (AES-256-GCM, clé dérivée de votre phrase secrète) ;
- les classer automatiquement en dossiers **année › employeur** (ou employeur › année), avec filtre et recherche par employeur ;
- les ouvrir, télécharger (à l'unité, par dossier ou tout en ZIP) et imprimer ;
- détecter les **doublons** (même fichier, ou même bulletin re-téléchargé) et ne pas les enregistrer deux fois ;
- importer un ZIP ou un PDF regroupant plusieurs bulletins (découpé en documents séparés) ;
- importer par glisser-déposer, fichier `.eml` (pièces jointes extraites) ou **Partager → Mes papiers retraite** depuis Gmail sur Android ;
- reconstituer la carrière année par année (trimestres, revenus) et estimer âge de départ, décote/surcote et pension (base + Agirc-Arrco), avec les droits liés aux enfants selon le sexe.

**Aucun document n'est envoyé sur GitHub ni sur un serveur** : GitHub n'héberge que le code. La sauvegarde chiffrée (onglet Sauvegarde) permet de passer d'un appareil à l'autre.

## Mise en ligne (GitHub Pages)

1. Créez un dépôt (public ou privé), poussez ce dossier sur la branche `main`.
2. Réglages → Pages → Source : **GitHub Actions**.
3. Ouvrez l'adresse `https://<utilisateur>.github.io/<depot>/`. Sur Android, Chrome → ⋮ → *Installer l'application*.

Ne mettez **jamais** vos vrais documents dans le dépôt.

## Version clé USB (sans internet)

`portable/Mes-papiers-retraite.html` est un **fichier unique** (code, styles et bibliothèques PDF compris) qui s'ouvre par double-clic depuis une clé USB, sans serveur ni connexion. Dans Chrome ou Edge, il enregistre les documents chiffrés **dans un dossier de la clé** (`portable/donnees/`) ; on retrouve ses données sur n'importe quel ordinateur en rechoisissant ce dossier. Copiez le contenu du dossier `portable/` sur la clé (voir `portable/LISEZMOI.txt`). L'application en ligne propose aussi de copier le coffre existant vers une clé et de télécharger ce fichier.

Le fichier est régénéré par `npm run build` (esbuild) et par le workflow GitHub à chaque déploiement.

## Développement

```
npm test                       # tests du moteur de calcul
python3 -m http.server 8000    # puis http://localhost:8000
```

Les paramètres légaux (âge, durée, SMIC, PASS, points Agirc-Arrco) sont dans `js/params.js` : à mettre à jour chaque année. Calendrier retenu : LFSS 2026, réforme suspendue du 1er septembre 2026 au 1er janvier 2028.

## Limites

Estimation indicative. Non modélisés : CIPAV/RCI (pension à saisir à la main), carrière longue, adoption, handicap, plafonnement des majorations Agirc-Arrco, carrières à l'étranger. La lecture automatique des PDF (pdf.js, embarqué dans `vendor/`, fonctionne hors ligne) est au mieux : vérifiez toujours les valeurs proposées. Les PDF scannés ou photographiés (sans texte) ne sont pas lisibles : saisie manuelle.
