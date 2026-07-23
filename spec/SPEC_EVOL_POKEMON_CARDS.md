# Évolution engagée — CardScope MVP

Les décisions ci-dessous constituent le contrat d'implémentation.

## Décisions

- **D1 — Surface.** PWA Svelte/Vite installable, responsive mobile, utilisable sans compte et partiellement hors ligne.
- **D2 — Reconnaissance.** Cascade locale MVP `cadrage -> OCR numéro/nom -> empreinte perceptuelle -> top candidats -> confirmation`; après gates, l'embedding de retrieval s'ajoute comme signal avant fusion.
- **D3 — Modèle.** MobileNetV3-Small 224 px, embedding L2 128D, quantification INT8, cible <= 5 Mo ; EfficientNet-Lite0 n'est essayé que si les gates échouent.
- **D4 — Provenance ML.** Aucun code, poids ou dataset sans licence/provenance compatible n'est copié. Le dépôt contient un pipeline propre d'augmentations synthétiques, split par UID, entraînement contrastif, benchmark et export ONNX/TFJS.
- **D5 — Vérité produit.** Une photo n'authentifie pas une carte et ne la grade pas. Finition/variant et état sont confirmés ; le prix est une fourchette avec confiance.
- **D6 — Catalogue.** TCGdex primaire FR/EN, Pokémon TCG API secondaire. Les IDs externes sont des mappings, jamais l'unique clé métier.
- **D7 — Prix.** Une quote porte source, SKU, marché, devise, état, finition, bas/médian/haut, volume, `observed_at` et `stale_after`.
- **D8 — Collecte.** Aucun scraping de TCGplayer/Cardmarket/eBay sans autorisation. Robots.txt, CGU, licence, provenance, stabilité d'identifiant et coût sont des gates d'ingestion.
- **D9 — Rafraîchissement.** Le MVP déduplique les lectures dans un cache TTL borné. La cible suivante est catalogue delta quotidien + contrôle hebdomadaire, prix détenus/liquides quotidien, normaux hebdomadaire, illiquides mensuel, avec une file globale plutôt qu'une requête par utilisateur.
- **D10 — Rétention.** Prix quotidiens 90 jours puis hebdomadaires cinq ans. L'historique utilisateur est constitué d'événements de possession ; les prix globaux ne sont pas copiés par utilisateur.
- **D11 — Stockage.** IndexedDB gratuit localement. Le premier palier cloud utilise SQLite sur PVC avec journal WAL et événements idempotents ; migration PostgreSQL avant le palier de concurrence/volume défini dans la documentation.
- **D12 — Vie privée.** Photos locales, pas de profil public, pas de géolocalisation, export/suppression, collecte de feedback sans photo par défaut.
- **D13 — Auth.** OIDC authorization-code + PKCE, client public `pokemon-cards`, issuer `https://auth.sent-tech.ca`, scopes `openid profile email`, validation JWKS côté API.
- **D14 — Offre.** Scan, collection, estimation courante et export gratuits ; Pass Cloud cinq ans pour sauvegarde, sync et historique. Hypothèse initiale 4,99 USD, revue selon coût complet et conversion, markup jamais supérieur à 50 %.
- **D15 — Infra.** Une image OCI publique publiée avec tag de commit mais déployée par digest `ghcr.io/rhanka/pokemon-cards@sha256:…`, un seul service Node/Svelte, namespace Kubernetes `pokemon-cards`, ingress TLS `pokemon-cards.sent-tech.ca` sur Scaleway `poc`.
- **D16 — Capacité.** Déploiement seulement après création du tenant/DNS et libération ou extension du pool `general`, actuellement proche de la saturation. OVH est explicitement NO-GO.
- **D17 — Qualité.** Tests unitaires parse/OCR/scoring/collection, tests API, build conteneur, smoke `/api/health`, audit mobile et benchmark ML séparé.
- **D18 — Mesure.** Gates pilote : 15 cartes/minute, top-1 >= 95 % avant beta puis >= 98 %, Recall@5 >= 99 %, faux-accept < 0,5 %, conversion Pass >= 25 % et ROI utilisateur médian >= 10 fois le prix.
- **D19 — Stack.** Le runtime livré est exclusivement Svelte/TypeScript : composants `@sentropic/design-system-svelte`, API Hono/Node et SQLite. Aucun backend ou conteneur Python ; Python reste autorisé uniquement comme outil hors ligne de training/export ML, exclu du contexte OCI de l'application.

## Hors MVP

- Authentification ou grading de cartes.
- Marketplace intégrée, publicité, revente de données ou affiliation opaque.
- Envoi systématique des photos à un cloud.
- Modèle génératif/VLM lourd.
- Déploiement OVH avant qu'un cluster, ingress, storage et secrets y soient réellement actifs.
