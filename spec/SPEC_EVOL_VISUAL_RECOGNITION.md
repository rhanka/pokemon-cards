# Évolution engagée — reconnaissance visuelle

Les décisions ci-dessous complètent et, lorsqu'elles divergent, remplacent les
décisions OCR antérieures.

## Décisions

- **D1 — Produit gratuit.** Le pilote est gratuit et non commercial : pas de
  paiement, publicité, affiliation, revente de données ou promotion
  commerciale. La viabilité est suivie comme coût et capacité, pas comme
  marge.
- **D2 — Séparation des licences.** Le code original est MIT. Chaque jeu de
  données, image, poids ONNX et index garde sa licence et son manifeste; aucun
  artefact tiers n'est implicitement MIT.
- **D3 — Source expérimentale.** `TheFusion21/PokemonCards` peut être
  téléchargé pour une expérimentation locale non commerciale selon la
  déclaration CC-BY-NC-4.0 de sa fiche Hugging Face. Ses liens
  `images.pokemontcg.io` ne prouvent pas une autorité sur les illustrations;
  cette limite est enregistrée et empêche la publication ou le service d'un
  artefact dérivé tant qu'elle n'est pas levée.
- **D4 — Pipeline.** L'intake TypeScript est borné, idempotent et
  content-addressed. Il ne télécharge jamais d'images sans limite implicite,
  ne les ajoute jamais à Git, et produit un manifeste vérifiable avant tout
  entraînement hors ligne.
- **D5 — Reconnaissance.** Le chemin cible est `photo guidée -> correction
  locale -> Web Worker ONNX/WASM -> embedding L2 128D -> API TypeScript top-5
  dans un index INT8 -> confiance ou abstention -> confirmation humaine`.
  Aucune OCR n'est une preuve d'identité.
- **D6 — Vie privée et capacité.** Le navigateur ne transmet pas de photo au
  chemin de retrieval. L'API valide uniquement un vecteur borné et cherche dans
  un index central; elle reste compatible avec la demande Kubernetes de 20m
  CPU. WebGPU est une optimisation facultative, WASM/SIMD est la base.
- **D7 — Modèle et distribution.** Les poids/artéfacts issus d'une source
  CC-BY-NC ne peuvent être distribués que si la licence le permet explicitement
  et si l'autorité amont est vérifiée. Ils ne sont jamais appelés « MIT ».
- **D8 — Gates.** Activation seulement avec split par UID, captures de phones
  indépendantes, Top-1 >=98 %, Recall@5 >=99 % (>=99,5 % hautes valeurs si
  statistiquement significatif), borne supérieure unilatérale 95 % de faux
  accept <0,5 %, auto-sélection calibrée >=99 %, p95 warm <=750 ms, cold <=2 s
  et mémoire Worker <=100 MiB sur un iPhone Safari et Android milieu de gamme.
- **D9 — Vérité produit.** Tant que les gates ne passent pas, la recherche
  catalogue manuelle est le fallback honnête. Le produit ne prétend ni
  authentifier ni grader une carte.

## Hors périmètre

- Réutiliser les images, poids ou index expérimentaux dans une offre payante ou
  une publicité.
- Publier un poids dérivé sous MIT.
- Déployer un backend Python ou un service de vision facturé au scan.
