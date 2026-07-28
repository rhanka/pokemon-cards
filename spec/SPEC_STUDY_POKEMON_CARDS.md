# Étude — reconnaissance et valeur des cartes Pokémon

Date de décision initiale : 2026-07-22. Remplacée pour la reconnaissance et
l'offre par `SPEC_STUDY_VISUAL_RECOGNITION.md` le 2026-07-24.

## Question

Comment livrer une application mobile de reconnaissance, collection et
valorisation utile pour environ 1 000 cartes par personne, sans publicité,
sans dépendre d'une API Vision facturée au scan ?

## Contraintes données par le propriétaire

- SPA/PWA Svelte acceptable ; expérience d'abord mobile.
- Pilote gratuit et non commercial, sans objectif de marge.
- Historique conservé pendant la durée libératoire, prise ici comme cinq ans.
- Zéro publicité; la capacité et le coût sont suivis sans revenu utilisateur.
- Auth Sentropic et déploiement sur l'infrastructure Kubernetes déjà réellement disponible.
- Le serveur authentifié est l'autorité de chaque compte enrôlé ; IndexedDB
  sert uniquement de cache/outbox hors ligne.

## Marché observé

Les offres vérifiées le 2026-07-22 vont du scanner gratuit au portefeuille payant : Collectr Pro coûte 59,99 USD/an, PriceCharting Collector 6 USD/mois, tandis que Ludex, TCGplayer et Rare Candy annoncent le scan gratuit. Le différenciateur n'est donc pas « savoir scanner », mais produire une valeur vendable, datée et explicable : état/finition confirmés, liquidité, frais, provenance et fourchette plutôt qu'un total optimiste.

## Options de reconnaissance

### A. API Vision managée

Rapide à intégrer, mais crée un coût et une dépendance par scan. Le tarif Google Vision cité pendant l'étude n'est pas un bon proxy du coût d'un modèle spécialisé et n'est pas retenu comme argument de décision.

### B. OCR spécialisé sans fournisseur facturé au scan

Après cadrage/réencodage client, un worker Tesseract.js unique dans le service Node lit le numéro/nom puis interroge le catalogue. Le coût marginal fournisseur est nul et l'ajout d'une carte ne demande pas de réentraînement. Borne de planification dans l'image Alpine finale : 3,3 CPU-s/scan, à partir de 3,22 CPU-s et 10,26 s à froid puis 1,66 CPU-s et 5,23 s à chaud sous 300m. Le cgroup final a culminé à 134 MiB avant de revenir à environ 86 MiB ; un essai antérieur sans limite avait culminé autour de 183 MiB RSS.

### C. Petit modèle de retrieval spécialisé

MobileNetV3-Small ou EfficientNet-Lite produit un embedding 128D comparé à environ 21 000 références. Un modèle INT8 vise 3–8 Mo et l'index environ 2,7 Mo. Les augmentations synthétiques simulent perspective, reflets, sleeves, flou, ombres, compression et occlusions. L'artefact sera exécuté dans le recognizer TypeScript, sans backend Python ni API Vision, uniquement après validation juridique et métrique.

### D. Hybride retenu

Cadrage/réencodage client, OCR serveur TypeScript, recherches catalogue
anglaise et française automatiques en parallèle, puis abstention lorsque les
scores sont proches. Aucun choix de langue n'est demandé avant le scan ; la
finition et l'état restent une confirmation humaine. Le futur embedding serveur
accélère ou complète l'OCR ; la photo n'est jamais persistée ni utilisée pour
l'entraînement.

## Modèles et jeux de données trouvés

- `1vcian/Pokemon-TCGP-Card-Scanner` démontre un YOLO11 Nano OBB TFJS d'environ 10,7 Mo, suivi d'un hash RGB. Le dépôt n'a pas de licence : l'architecture peut inspirer une réimplémentation, pas le code ni les poids.
- `turing552/clip-pokemon_cards-10ep` pèse 605 Mo, n'a ni licence ni métrique top-k ; sa loss 4,1391 est presque le hasard InfoNCE `ln(64)=4,1589`. Rejeté.
- `turing552/pokemoncards-vlm-multimodal` contient 13 088 images mais aucune licence/provenance exploitable commercialement.
- `TheFusion21/PokemonCards` est CC-BY-NC-4.0 : interdit au produit payant.
- Plusieurs dumps MIT/CC0 ne peuvent pas re-licencier les illustrations Pokémon. Les badges du dépôt ne suffisent pas à établir les droits amont.

Conclusion : entraîner un petit modèle maison sur des références et photographies dont l'usage est autorisé ; ne publier aucun poids dérivé avant revue des droits.

## Données catalogue et valeur

- TCGdex : meilleur socle multilingue FR/EN, dépôt de base MIT ; caveat séparé sur les illustrations et marques.
- Pokémon TCG API : secondaire utile, 20 000 appels/jour avec clé et 1 000/jour sans clé ; expose TCGplayer USD et Cardmarket EUR.
- TCGplayer, Cardmarket et eBay ne doivent pas être scrapés sans contrat ou autorisation explicite.
- Une « valeur » doit conserver source, devise, variante, état, date, volume/liquidité et confiance ; annonces et ventes conclues ne sont jamais mélangées.

## Économie comparée

Un paiement annuel de 1 USD est pénalisé par les frais fixes. Deux revues indépendantes convergent vers un forfait cinq ans :

- 4,99 USD avec 30 % de conversion : 30 000 passes sur 100 000 comptes, 149 700 USD de chiffre d'affaires, coût complet plafond 99 800 USD, marge 49 900 USD ;
- 7,50 USD avec 20 % de conversion : 20 000 passes, 150 000 USD de chiffre d'affaires, coût complet 100 000 USD, marge 50 000 USD.

Le prix bas maximise l'adoption et respecte la préférence du propriétaire. Le scénario 4,99 USD est retenu comme hypothèse de lancement, sous réserve de mesurer une conversion d'au moins 25–30 % et un coût complet maximal de 3,33 USD/pass sur cinq ans.

La conversion payante affecte les revenus, pas l'autorité des données : le
dimensionnement central couvre les 100 000 comptes, puis migre vers le palier
OVH/PostgreSQL lorsque les gates de volume sont atteintes.

## Revue contradictoire et réconciliation

1. Revue reconnaissance : a écarté toute fausse précision sur l'état/foil et exigé une confirmation humaine, un benchmark par UID et une abstention calibrée.
2. Revue modèles/licences : a montré qu'aucun checkpoint publié n'est simultanément petit, performant, documenté et juridiquement propre ; elle recommande MobileNetV3 INT8 entraîné par le projet.
3. Revue marché : a déplacé le ROI du « total du portfolio » vers la valeur nette vendable, les doublons et les cartes à vérifier en priorité.
4. Revue économie : a simulé explicitement 1 000 comptes ×1 000 cartes et montré 0,51m/6,37m/30,56m OCR moyens selon l'activité, avec import CSV/JSON pour l'onboarding massif.

Les divergences OCR versus vision sont réconciliées ainsi : l'OCR serveur mesuré est le chemin MVP immédiatement exploitable ; le modèle spécialisé ne le remplace qu'après droits et benchmark. Le chiffre d'une API Vision managée est retiré de la décision.

## Gates avant promesse commerciale

- Recall@5 OCR/catalogue >=95 % sur un corpus pilote FR/EN autorisé ; le futur modèle garde les cibles Top-1 >=95 %, Recall@5 >=99 %.
- Faux-accept < 0,5 %, corrections manuelles < 5 %, p95 du pipeline < 250 ms hors OCR froid.
- Première réponse <30 s et p95 chaud <15 s dans l'image Kubernetes finale ; import CSV/JSON pour une collection existante de 1 000 cartes.
- Benchmark séparé par UID, langue, set, époque, finition, téléphone et lumière, avec photos utilisateur jamais vues.
- Conversion Pass >= 25 % à 1 000 comptes et coût complet observé compatible avec 4,99 USD / cinq ans.
- Autorisation/licence explicite pour tout flux de prix, image de référence ou poids redistribué.
- Origine canonique `https://pokemon.sent-tech.ca`, client OIDC de production
  et récupération hors PVC vérifiés avant
  `ACCOUNT_IDENTITY_READY=true`, `ACCOUNT_RECOVERY_READY=true` et
  `OIDC_REQUIRED=true`, requête Kubernetes `20m` et PVC initial de 4 GiB.
