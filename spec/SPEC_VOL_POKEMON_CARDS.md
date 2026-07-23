# Volition — CardScope

Le produit sera une PWA Svelte local-first appelée provisoirement **CardScope**.

Sa proposition de valeur : scanner sans limite et gratuitement, conserver la collection sur l'appareil, puis indiquer ce qui mérite d'être vérifié ou vendu avec une fourchette nette, datée et sourcée. Le compte n'est requis que pour la sauvegarde, la synchronisation multiappareil et l'historique cloud.

## Direction choisie

- Caméra guidée, recadrage et réencodage JPEG local avant envoi.
- OCR Tesseract.js dans le service TypeScript Kubernetes ; petit modèle INT8 serveur uniquement après validation du corpus, des droits et du benchmark.
- Top candidats et abstention ; aucune invention lorsque la confiance est faible.
- Variante, langue et état confirmés par la personne ; état par défaut `inconnu`.
- Photos envoyées en TLS pour le scan, traitées uniquement en mémoire et supprimées avant réponse ; aucune conservation ni entraînement.
- TCGdex comme catalogue primaire ; Pokémon TCG API comme source secondaire et de comparaison.
- Aucun scraping de marketplace sans contrat explicite.
- Collection et export gratuits ; Pass Cloud 4,99 USD pour cinq ans comme hypothèse de lancement.
- Auth OIDC Sentropic en public client PKCE, désactivée tant que le client/audience et la sauvegarde cloud ne sont pas approuvés.
- Scaleway Kapsule `poc` est la cible immédiate à 20m CPU demandé, sans nouveau nœud. OVH/PostgreSQL est la cible de montée en charge après validation de l'application.

## MVP versus évolution

Le MVP livre immédiatement le cadrage guidé, l'OCR serveur transitoire, les candidats catalogue, la recherche manuelle, la collection IndexedDB, la valeur sourcée lorsqu'une source de prix est autorisée, l'import/export et le protocole de sync compact. Il livre aussi le pipeline reproductible de génération de données, entraînement, benchmark et export du petit modèle.

Le passage du modèle en chemin principal est conditionné par le benchmark et les droits sur le corpus/poids. Cette prudence ne bloque pas l'application : elle fonctionne avec OCR serveur + candidats en attendant un checkpoint validé.
