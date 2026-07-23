# Volition — CardScope

Le produit sera une PWA Svelte account-central appelée provisoirement
**CardScope**, avec un cache IndexedDB hors ligne.

Sa proposition de valeur : scanner sans limite pendant le pilote, conserver
une collection durable dans le compte, continuer hors ligne sur l’appareil,
puis indiquer ce qui mérite d'être vérifié ou vendu avec une fourchette nette,
datée et sourcée. Le cache local n'est jamais présenté comme une sauvegarde.

## Direction choisie

- Caméra guidée, recadrage et réencodage JPEG local avant envoi.
- OCR Tesseract.js dans le service TypeScript Kubernetes ; petit modèle INT8 serveur uniquement après validation du corpus, des droits et du benchmark.
- Top candidats et abstention ; aucune invention lorsque la confiance est faible.
- Langue de carte recherchée automatiquement en anglais et français ; impression
  confirmée par la personne, puis finition et état renseignés.
- Photos envoyées en TLS pour le scan, traitées uniquement en mémoire et supprimées avant réponse ; aucune conservation ni entraînement.
- TCGdex comme catalogue primaire ; Pokémon TCG API comme source secondaire et de comparaison.
- Aucun scraping de marketplace sans contrat explicite.
- Compte central, cache hors ligne et export inclus ; forfait 4,99 USD pour
  cinq ans comme hypothèse de lancement, toujours borné au coût +50%.
- Auth OIDC Sentropic en public client PKCE ; `OIDC_REQUIRED=false` subsiste
  jusqu'à preuve du client/resource/callback/logout, disposition explicite des
  identités legacy et validation de la sauvegarde/restauration hors PVC.
  L'activation exige les attestations séparées
  `ACCOUNT_IDENTITY_READY=true` et `ACCOUNT_RECOVERY_READY=true`.
- Scaleway Kapsule `poc` est la cible immédiate à 20m CPU demandé et PVC de
  4 GiB, sans nouveau nœud. OVH/PostgreSQL est la cible de montée en charge
  après validation de l'application.

## MVP versus évolution

Le MVP livre immédiatement le cadrage guidé, l'OCR serveur, les candidats
catalogue bilingues, la recherche manuelle, l'enrôlement de compte, le cache
IndexedDB, la synchronisation automatique centrale, la valeur sourcée
lorsqu'une source de prix est autorisée, l'import/export et le protocole de
sync compact avec génération anti-résurrection. Il livre aussi le pipeline
reproductible de génération de données, entraînement, benchmark et export du
petit modèle.

Le passage du modèle en chemin principal est conditionné par le benchmark et les droits sur le corpus/poids. Cette prudence ne bloque pas l'application : elle fonctionne avec OCR serveur + candidats en attendant un checkpoint validé.
