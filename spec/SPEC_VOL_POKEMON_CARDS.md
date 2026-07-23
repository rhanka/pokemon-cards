# Volition — CardScope

Le produit sera une PWA Svelte local-first appelée provisoirement **CardScope**.

Sa proposition de valeur : scanner sans limite et gratuitement, conserver la collection sur l'appareil, puis indiquer ce qui mérite d'être vérifié ou vendu avec une fourchette nette, datée et sourcée. Le compte n'est requis que pour la sauvegarde, la synchronisation multiappareil et l'historique cloud.

## Direction choisie

- Caméra guidée et redressement local.
- OCR et empreintes perceptuelles locaux dès le MVP ; retrieval par petit modèle INT8 uniquement après validation du corpus, du benchmark et de l'artefact navigateur.
- Top candidats et abstention ; aucune invention lorsque la confiance est faible.
- Variante, langue et état confirmés par la personne ; état par défaut `inconnu`.
- Photos non envoyées et non conservées par défaut.
- TCGdex comme catalogue primaire ; Pokémon TCG API comme source secondaire et de comparaison.
- Aucun scraping de marketplace sans contrat explicite.
- Collection et export gratuits ; Pass Cloud 4,99 USD pour cinq ans comme hypothèse de lancement.
- Auth OIDC Sentropic en public client PKCE, désactivée tant que le client/audience et la sauvegarde cloud ne sont pas approuvés.
- Scaleway Kapsule `poc` est la seule cible techniquement compatible mais reste NO-GO tant que capacité, tenant, DNS et sauvegarde ne sont pas prêts ; OVH reste hors périmètre jusqu'à activation réelle.

## MVP versus évolution

Le MVP livre immédiatement le cadrage guidé, l'OCR local, le reranking visuel des candidats, la recherche manuelle, la collection IndexedDB, la valeur sourcée, l'export et le protocole de sync. Il livre aussi le pipeline reproductible de génération de données, entraînement, benchmark et export du petit modèle.

Le passage du modèle en chemin principal est conditionné par le benchmark et les droits sur le corpus/poids. Cette prudence ne bloque pas l'application : elle fonctionne avec OCR + candidats + empreintes en attendant un checkpoint validé.
