# Évolution engagée — CardScope MVP

Les décisions ci-dessous constituent le contrat d'implémentation.

## Décisions

- **D1 — Surface.** PWA Svelte/Vite installable, responsive mobile, utilisable sans compte et partiellement hors ligne.
- **D2 — Reconnaissance.** Le chemin produit est `photo guidée -> correction locale -> Web Worker ONNX/WASM -> embedding L2 128D -> top-5 TypeScript dans index INT8 -> abstention/confiance -> confirmation humaine`. Aucun sélecteur de langue avant scan, aucun OCR comme preuve d'identité, aucune API Vision facturée au scan et aucune file mémoire non bornée.
- **D3 — Modèle.** MobileNetV3-Small 224 px, embedding L2 128D et quantification INT8 sont le candidat initial; WASM/SIMD est le chemin compatible Safari, WebGPU une optimisation. Aucun modèle n'est activé avant les gates de `SPEC_EVOL_VISUAL_RECOGNITION.md`.
- **D4 — Provenance ML.** Aucun code, poids ou dataset sans licence/provenance compatible n'est copié. Le dépôt contient un pipeline propre d'augmentations synthétiques, split par UID, entraînement contrastif, benchmark et export ONNX/TFJS.
- **D5 — Vérité produit.** Une photo n'authentifie pas une carte et ne la grade pas. Finition/variant et état sont confirmés ; le prix est une fourchette avec confiance.
- **D6 — Catalogue.** TCGdex primaire FR/EN, Pokémon TCG API secondaire. Les IDs externes sont des mappings, jamais l'unique clé métier.
- **D7 — Prix.** Une quote porte source, SKU, marché, devise, état, finition, bas/médian/haut, volume, `observed_at` et `stale_after`.
- **D8 — Collecte.** Aucun scraping de TCGplayer/Cardmarket/eBay sans autorisation. Robots.txt, CGU, licence, provenance, stabilité d'identifiant et coût sont des gates d'ingestion.
- **D9 — Rafraîchissement.** Le MVP déduplique les lectures dans un cache TTL borné. La cible suivante est catalogue delta quotidien + contrôle hebdomadaire, prix détenus/liquides quotidien, normaux hebdomadaire, illiquides mensuel, avec une file globale plutôt qu'une requête par utilisateur.
- **D10 — Rétention.** Prix quotidiens 90 jours puis hebdomadaires cinq ans. L'historique utilisateur est constitué d'événements de possession ; les prix globaux ne sont pas copiés par utilisateur.
- **D11 — Stockage.** Le journal serveur authentifié est l'autorité durable de chaque compte enrôlé. IndexedDB est uniquement son cache matérialisé et son outbox hors ligne, isolés par compte. Le premier palier central utilise SQLite WAL sur un PVC de 4 GiB avec événements idempotents ; migration PostgreSQL avant le palier de concurrence/volume défini dans la documentation.
- **D12 — Vie privée.** La photo est recadrée et réencodée côté client pour retirer EXIF/GPS puis encodée localement; seul un embedding borné est envoyé pour le top-5. Aucune écriture photo/texte OCR/IP, aucun entraînement de photos utilisateur, pas de profil public, export/suppression.
- **D13 — Auth.** OIDC authorization-code + PKCE, client public `pokemon-cards`, issuer `https://auth.sent-tech.ca`, scopes `openid profile email`, validation JWKS côté API. `OIDC_REQUIRED=false` reste le défaut transitoire jusqu'à preuve du client/resource/callback/logout, traitement explicite de toute identité legacy, sauvegarde hors PVC et restauration isolée. L'activation exige aussi `ACCOUNT_IDENTITY_READY=true` et `ACCOUNT_RECOVERY_READY=true`.
- **D14 — Offre.** Le pilote est gratuit et non commercial : scan, compte central, cache hors ligne, estimation courante et export sont inclus. Il n'y a ni paiement, publicité, affiliation, vente de données, ni objectif de marge. Tout changement commercial exige une nouvelle revue des données et modèles.
- **D15 — Infra.** Une image OCI publique publiée avec tag de commit mais déployée par digest `ghcr.io/rhanka/pokemon-cards@sha256:…`, un seul service Node/Svelte, namespace Kubernetes `pokemon-cards`, ingress TLS `pokemon.sent-tech.ca` sur Scaleway `poc`.
- **D16 — Capacité.** Le POC Scaleway garde `requests.cpu=20m`, `limits.cpu=300m`, `requests.memory=256Mi`, `limits.memory=384Mi`, un PVC de 4 GiB, une réplique et `Recreate`. Aucun second nœud maintenant ; recheck immédiat avant apply. Migration OVH/PostgreSQL/multi-réplique après validation de l'application ou saturation observée.
- **D17 — Qualité.** Tests unitaires d'intake/provenance/scoring/collection, sécurité cache/sync, tests API, image Alpine exacte, smoke `/api/health`, audit mobile et benchmark de retrieval visual séparé.
- **D18 — Mesure.** L'OCR serveur mesuré est une référence historique, pas une cible produit. Gates pilote : Top-1 >=98 %, Recall@5 >=99 %, faux accept <0,5 %, aucune insertion automatique, p95 warm <=750 ms, cold <=2 s et mémoire Worker <=100 MiB sur deux téléphones nommés.
- **D19 — Stack.** Le runtime livré est exclusivement Svelte/TypeScript : composants `@sentropic/design-system-svelte`, API Hono/Node et SQLite. Aucun backend ou conteneur Python ; Python reste autorisé uniquement comme outil hors ligne de training/export ML, exclu du contexte OCI de l'application.
- **D20 — Capacité mesurée.** Le simulateur TypeScript prend 1 000 comptes ×1 000 cartes. Les consultations, sync et stockage sont dimensionnés pour tous les comptes, sans différencier une population payante; l'encodage visual client évite une facturation d'inférence par scan.

## Hors MVP

- Authentification ou grading de cartes.
- Marketplace intégrée, publicité, revente de données ou affiliation opaque.
- Conservation ou réutilisation des photos envoyées pour reconnaissance.
- Modèle génératif/VLM lourd.
- Déploiement OVH avant qu'un cluster, ingress, storage et secrets y soient réellement actifs.
