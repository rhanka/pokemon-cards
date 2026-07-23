# Étude — reconnaissance et valeur des cartes Pokémon

Date de décision : 2026-07-22.

## Question

Comment livrer une application mobile de reconnaissance, collection et valorisation utile pour environ 1 000 cartes par personne, sans publicité, rentable dès la première cohorte et sans dépendre d'une API Vision facturée au scan ?

## Contraintes données par le propriétaire

- SPA/PWA Svelte acceptable ; expérience d'abord mobile.
- Gratuit ou prix limité au coût complet majoré de 50 %.
- Cible idéale proche de 1 USD/an ; un forfait est préférable.
- Historique conservé pendant la durée libératoire, prise ici comme cinq ans.
- Zéro publicité ; 100 000 comptes et environ 50 000 USD de marge constituent la cible.
- Auth Sentropic et déploiement sur l'infrastructure Kubernetes déjà réellement disponible.

## Marché observé

Les offres vérifiées le 2026-07-22 vont du scanner gratuit au portefeuille payant : Collectr Pro coûte 59,99 USD/an, PriceCharting Collector 6 USD/mois, tandis que Ludex, TCGplayer et Rare Candy annoncent le scan gratuit. Le différenciateur n'est donc pas « savoir scanner », mais produire une valeur vendable, datée et explicable : état/finition confirmés, liquidité, frais, provenance et fourchette plutôt qu'un total optimiste.

## Options de reconnaissance

### A. API Vision managée

Rapide à intégrer, mais crée un coût et une dépendance par scan. Le tarif Google Vision cité pendant l'étude n'est pas un bon proxy du coût d'un modèle spécialisé et n'est pas retenu comme argument de décision.

### B. OCR + empreintes perceptuelles locales

Après cadrage/redressement, OCR du numéro/nom pour réduire les candidats, puis fusion pHash/dHash/hash RGB/ORB. Le coût marginal est nul et l'ajout d'une carte ne demande pas de réentraînement. Cette voie est le socle de repli explicable.

### C. Petit modèle de retrieval spécialisé

MobileNetV3-Small ou EfficientNet-Lite produit un embedding 128D comparé à environ 21 000 références. Un modèle INT8 vise 3–8 Mo et l'index environ 2,7 Mo. Les augmentations synthétiques simulent perspective, reflets, sleeves, flou, ombres, compression et occlusions. Il n'y a aucun coût d'inférence serveur lorsque le modèle tourne via WebGPU/WASM.

### D. Hybride retenu

Détection/cadrage, embedding local, OCR complémentaire, recherche dans le catalogue et abstention lorsque les scores sont proches. La finition et l'état restent une confirmation humaine. Une voie serveur n'est qu'un fallback explicite et sans conservation de photo.

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

- 4,99 USD avec 30 % de conversion : 30 000 passes sur 100 000 comptes, 149 700 USD de chiffre d'affaires, coût complet plafond 99 900 USD, marge 49 800 USD ;
- 7,50 USD avec 20 % de conversion : 20 000 passes, 150 000 USD de chiffre d'affaires, coût complet 100 000 USD, marge 50 000 USD.

Le prix bas maximise l'adoption et respecte la préférence du propriétaire. Le scénario 4,99 USD est retenu comme hypothèse de lancement, sous réserve de mesurer une conversion d'au moins 25–30 % et un coût complet maximal de 3,33 USD/pass sur cinq ans.

## Revue contradictoire et réconciliation

1. Revue reconnaissance : a écarté toute fausse précision sur l'état/foil et exigé une confirmation humaine, un benchmark par UID et une abstention calibrée.
2. Revue modèles/licences : a montré qu'aucun checkpoint publié n'est simultanément petit, performant, documenté et juridiquement propre ; elle recommande MobileNetV3 INT8 entraîné par le projet.
3. Revue marché : a déplacé le ROI du « total du portfolio » vers la valeur nette vendable, les doublons et les cartes à vérifier en priorité.
4. Revue économie : a établi qu'un cœur gratuit reste viable uniquement si son coût serveur est quasi nul et si le pass convertit suffisamment.

Les divergences OCR versus vision sont réconciliées ainsi : le modèle spécialisé est le chemin principal visé, OCR/hash sont des signaux complémentaires et un fallback immédiatement testable. Le chiffre d'une API Vision managée est retiré de la décision.

## Gates avant promesse commerciale

- Top-1 exact >= 95 % au pilote, cible produit >= 98 % ; Recall@5 >= 99 % et >= 99,5 % au-dessus de 20 USD.
- Faux-accept < 0,5 %, corrections manuelles < 5 %, p95 du pipeline < 250 ms hors OCR froid.
- Au moins 15 cartes/minute en mode continu ; 1 000 cartes en moins de 75 minutes avec vérifications.
- Benchmark séparé par UID, langue, set, époque, finition, téléphone et lumière, avec photos utilisateur jamais vues.
- Conversion Pass >= 25 % à 1 000 comptes et coût complet observé compatible avec 4,99 USD / cinq ans.
- Autorisation/licence explicite pour tout flux de prix, image de référence ou poids redistribué.
