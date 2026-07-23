# Évolution engagée — CardScope MVP

Les décisions ci-dessous constituent le contrat d'implémentation.

## Décisions

- **D1 — Surface.** PWA Svelte/Vite installable, responsive mobile, utilisable sans compte et partiellement hors ligne.
- **D2 — Reconnaissance.** Cascade MVP `recadrage/réencodage JPEG client -> upload TLS -> Sharp + Tesseract.js dans le service Node -> recherches catalogue FR/EN automatiques et parallèles -> top candidats -> confirmation de l'impression si nécessaire`. Aucun sélecteur de langue avant scan, aucun OCR navigateur, aucune API Vision facturée au scan et aucune file mémoire non bornée.
- **D3 — Modèle.** Le MVP utilise l'OCR serveur mesuré. Après gates juridiques et benchmark, MobileNetV3-Small 224 px, embedding L2 128D, quantification INT8, cible <= 5 Mo, pourra accélérer le recognizer TypeScript ; EfficientNet-Lite0 n'est essayé que si les gates échouent.
- **D4 — Provenance ML.** Aucun code, poids ou dataset sans licence/provenance compatible n'est copié. Le dépôt contient un pipeline propre d'augmentations synthétiques, split par UID, entraînement contrastif, benchmark et export ONNX/TFJS.
- **D5 — Vérité produit.** Une photo n'authentifie pas une carte et ne la grade pas. Finition/variant et état sont confirmés ; le prix est une fourchette avec confiance.
- **D6 — Catalogue.** TCGdex primaire FR/EN, Pokémon TCG API secondaire. Les IDs externes sont des mappings, jamais l'unique clé métier.
- **D7 — Prix.** Une quote porte source, SKU, marché, devise, état, finition, bas/médian/haut, volume, `observed_at` et `stale_after`.
- **D8 — Collecte.** Aucun scraping de TCGplayer/Cardmarket/eBay sans autorisation. Robots.txt, CGU, licence, provenance, stabilité d'identifiant et coût sont des gates d'ingestion.
- **D9 — Rafraîchissement.** Le MVP déduplique les lectures dans un cache TTL borné. La cible suivante est catalogue delta quotidien + contrôle hebdomadaire, prix détenus/liquides quotidien, normaux hebdomadaire, illiquides mensuel, avec une file globale plutôt qu'une requête par utilisateur.
- **D10 — Rétention.** Prix quotidiens 90 jours puis hebdomadaires cinq ans. L'historique utilisateur est constitué d'événements de possession ; les prix globaux ne sont pas copiés par utilisateur.
- **D11 — Stockage.** Le journal serveur authentifié est l'autorité durable de chaque compte enrôlé. IndexedDB est uniquement son cache matérialisé et son outbox hors ligne, isolés par compte. Le premier palier central utilise SQLite WAL sur un PVC de 4 GiB avec événements idempotents ; migration PostgreSQL avant le palier de concurrence/volume défini dans la documentation.
- **D12 — Vie privée.** La photo est recadrée et réencodée côté client pour retirer EXIF/GPS, transférée en TLS, traitée transitoirement en mémoire, puis supprimée du MEMFS et de l'API native Tesseract avant réponse. Aucune écriture photo/texte OCR/IP, aucun entraînement, pas de profil public, export/suppression.
- **D13 — Auth.** OIDC authorization-code + PKCE, client public `pokemon-cards`, issuer `https://auth.sent-tech.ca`, scopes `openid profile email`, validation JWKS côté API. `OIDC_REQUIRED=false` reste le défaut transitoire jusqu'à preuve du client/resource/callback/logout, traitement explicite de toute identité legacy, sauvegarde hors PVC et restauration isolée. L'activation exige aussi `ACCOUNT_IDENTITY_READY=true` et `ACCOUNT_RECOVERY_READY=true`.
- **D14 — Offre.** Scan, compte central, cache hors ligne, estimation courante et export sont inclus pour chaque compte enrôlé ; le paiement cinq ans est une hypothèse commerciale, pas un filtre de stockage. Hypothèse initiale 4,99 USD, revue selon coût complet et conversion, markup jamais supérieur à 50 %.
- **D15 — Infra.** Une image OCI publique publiée avec tag de commit mais déployée par digest `ghcr.io/rhanka/pokemon-cards@sha256:…`, un seul service Node/Svelte, namespace Kubernetes `pokemon-cards`, ingress TLS `pokemon.sent-tech.ca` sur Scaleway `poc`.
- **D16 — Capacité.** Le POC Scaleway garde `requests.cpu=20m`, `limits.cpu=300m`, `requests.memory=256Mi`, `limits.memory=384Mi`, un PVC de 4 GiB, une réplique et `Recreate`. Aucun second nœud maintenant ; recheck immédiat avant apply. Migration OVH/PostgreSQL/multi-réplique après validation de l'application ou saturation observée.
- **D17 — Qualité.** Tests unitaires parse/OCR/scoring/collection, sécurité upload/cache/sync, tests API, image Alpine exacte, smoke `/api/health`, audit mobile et benchmark OCR/ML séparé.
- **D18 — Mesure.** OCR de référence dans l'image Alpine finale : 3,22 CPU-s et 10,26 s à froid, 1,66 CPU-s et 5,23 s à chaud sous 300m/384 MiB ; la planification facture 3,3 CPU-s à chaque scan. Le cgroup final culmine à 134 MiB, revient à ~86 MiB et ne déclenche aucun OOM. Gates pilote : première réponse <30 s, p95 chaud <15 s, Recall@5 >=95 % sur corpus autorisé, aucune insertion automatique, conversion Pass >=25 % et ROI utilisateur médian >=10 fois le prix.
- **D19 — Stack.** Le runtime livré est exclusivement Svelte/TypeScript : composants `@sentropic/design-system-svelte`, API Hono/Node et SQLite. Aucun backend ou conteneur Python ; Python reste autorisé uniquement comme outil hors ligne de training/export ML, exclu du contexte OCI de l'application.
- **D20 — Économie mesurée.** Le simulateur TypeScript prend 1 000 comptes ×1 000 cartes. Les scénarios courant/base/actif consomment en moyenne ~0,51m/6,37m/30,56m OCR ; un million de photos représente ~917 vCPU-h, donc l'import CSV/JSON est le chemin de masse.

## Hors MVP

- Authentification ou grading de cartes.
- Marketplace intégrée, publicité, revente de données ou affiliation opaque.
- Conservation ou réutilisation des photos envoyées pour reconnaissance.
- Modèle génératif/VLM lourd.
- Déploiement OVH avant qu'un cluster, ingress, storage et secrets y soient réellement actifs.
