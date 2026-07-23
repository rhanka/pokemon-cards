import type { Locale } from "./types";
import { formatCurrencySafely } from "./money";

const en = {
  "app.tagline": "Know every card. Keep every cent.",
  "nav.scanner": "Scanner",
  "nav.collection": "Collection",
  "nav.insights": "Insights",
  "nav.settings": "Settings",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.retry": "Try again",
  "common.close": "Close",
  "common.loading": "Loading…",
  "common.unavailable": "Unavailable",
  "common.offline": "Offline — your collection is still available",
  "scanner.eyebrow": "Private on-device scan",
  "scanner.title": "Frame one Pokémon card",
  "scanner.help":
    "Fill the guide, avoid glare, and keep the collector number visible.",
  "scanner.camera": "Use camera",
  "scanner.photo": "Choose photo",
  "scanner.capture": "Capture card",
  "scanner.stop": "Close camera",
  "scanner.privacy":
    "Your photo stays on this device and is discarded after matching.",
  "scanner.processing": "Reading the card locally",
  "scanner.searching": "Searching the catalogue",
  "scanner.model": "Checking visual references locally",
  "scanner.error":
    "This card could not be read. Try a sharper, glare-free photo.",
  "scanner.offlineSearch":
    "Connect once to search the catalogue. No photo will be uploaded.",
  "scanner.results": "Possible matches",
  "scanner.matchScore": "Match score: {score}%",
  "scanner.confident": "Strong match — please confirm",
  "scanner.review": "A quick check is needed",
  "scanner.noMatch": "No reliable match",
  "scanner.correct": "This is my card",
  "scanner.notCorrect": "Scan another card",
  "scanner.finish": "Finish",
  "scanner.condition": "Condition",
  "scanner.cardLanguage": "Card language",
  "scanner.cardLanguageHelp":
    "Choose the language printed on the card. This is separate from the app language.",
  "scanner.languageRequired":
    "Choose the card language before scanning or searching.",
  "scanner.requiredChoices":
    "Choose the card language, finish, and condition before adding.",
  "scanner.cost": "What did you pay? (optional)",
  "scanner.costCurrency": "Purchase currency",
  "scanner.add": "Add to collection",
  "scanner.added": "Card added. Duplicate copies are grouped automatically.",
  "scanner.manual": "Search by name or collector number",
  "scanner.search": "Search",
  "scanner.visualSkipped":
    "Image comparison unavailable; text matching was used.",
  "collection.title": "Your collection",
  "collection.eyebrow": "CardScope library",
  "collection.subtitle": "{cards} cards · {unique} unique",
  "collection.empty": "Your first scan will appear here, even offline.",
  "collection.search": "Filter cards",
  "collection.value": "Estimated market value",
  "collection.range": "Observed range",
  "collection.cost": "Recorded cost",
  "collection.costPartial": "Partial cost coverage",
  "collection.net": "Value minus recorded cost",
  "collection.fresh": "Updated {age}",
  "collection.stale": "Price needs refreshing",
  "collection.source": "Source: {source}",
  "collection.confirmRemove": "Remove this card from the collection?",
  "collection.noValues": "No price or acquisition cost recorded yet.",
  "collection.saveCost": "Save acquisition cost",
  "collection.costAmount": "Unit acquisition cost",
  "collection.costCurrency": "Cost currency",
  "collection.decrease": "Remove one copy",
  "collection.increase": "Add one copy",
  "collection.remove": "Remove holding",
  "collection.history": "Recent activity",
  "insights.title": "Collection insights",
  "insights.eyebrow": "ROI dashboard",
  "insights.subtitle": "Transparent estimates, never a grading claim.",
  "insights.market": "Market estimate",
  "insights.range": "{low} – {high}",
  "insights.net": "Net vs. recorded cost",
  "insights.review": "Cards to verify",
  "insights.reviewHelp": "High-value, stale, or uncertain cards come first.",
  "insights.allGood": "Nothing urgent to review.",
  "insights.priceCoverage": "Price coverage",
  "insights.costCoverage": "Costs recorded",
  "insights.methodNote":
    "Indicative values from observed quotes. CardScope does not authenticate or grade cards.",
  "reason.missing-price": "No current price",
  "reason.stale-price": "Stale quote",
  "reason.low-liquidity": "Few observed sales",
  "reason.unknown-liquidity": "Liquidity unknown",
  "reason.missing-cost": "Cost not entered",
  "settings.title": "Settings & data",
  "settings.language": "Language",
  "settings.english": "English",
  "settings.french": "Français",
  "settings.englishContent": "English interface",
  "settings.frenchContent": "French interface",
  "settings.valuationTitle": "Valuation preference",
  "settings.valuationHelp":
    "Choose which available market quote CardScope should prefer. This setting is independent from interface and card language.",
  "settings.marketLabel": "Reference market",
  "settings.currencyLabel": "Reference currency",
  "settings.noConversion":
    "CardScope selects an available quote in this order; it does not perform hidden currency conversion.",
  "settings.dataTitle": "Your data",
  "settings.localEvents": "{count} local events",
  "settings.restorable": "restorable",
  "settings.signedInAccount": "Signed-in account",
  "settings.noAds": "No ads · No data resale",
  "settings.localFirst": "Local-first by design",
  "settings.localDetail":
    "Scans and collection events are stored on this device. Photos are never saved.",
  "settings.exportJson": "Backup as JSON",
  "settings.exportCsv": "Export spreadsheet CSV",
  "settings.importJson": "Restore JSON backup",
  "settings.importFile": "Import JSON or CSV",
  "settings.imported": "{count} events imported",
  "settings.importError": "That backup could not be imported.",
  "settings.restoreMode": "JSON restore mode",
  "settings.restoreHelp":
    "Choose how a JSON backup affects the active collection. CSV files always append rows.",
  "settings.restoreMerge": "Merge with active collection",
  "settings.restoreMergeHelp":
    "Keep current events and add new events from the backup.",
  "settings.restoreReplace": "Replace active collection",
  "settings.restoreReplaceHelp":
    "Erase only the current anonymous or signed-in collection, then restore this backup.",
  "settings.replaceWarning":
    "Replacement erases the active collection on this device. Other account domains are preserved.",
  "settings.replaceConfirm":
    "This will erase the active collection on this device and replace it with the selected JSON backup. Other account domains are preserved. Continue?",
  "settings.account": "Optional cloud sync",
  "settings.accountHelp":
    "A free local collection works without an account. Sync is shown only on deployments whose identity and backup gates are enabled.",
  "settings.signIn": "Sign in",
  "settings.signOut": "Sign out",
  "settings.authDisabled":
    "Cloud sync and server backup are not enabled on this deployment.",
  "settings.sync": "Sync now",
  "settings.synced": "Sync complete — the active server copy was updated",
  "settings.syncError": "Sync is unavailable. Your local data is safe.",
  "settings.deleteCloud": "Delete active server copy",
  "settings.deleteCloudConfirm":
    "Delete the active server copy? Your local collection remains. Retained snapshots or backups follow the deployment’s published erasure policy.",
  "settings.deletedCloud": "Active server copy deleted. Local data was kept.",
  "settings.retention":
    "When enabled, active cloud events are retained for up to {years} years.",
  "price.noPrice": "Price unavailable",
  "price.today": "today",
  "price.days": "{count}d ago",
  "price.conditionUnknown": "Condition is not included in this quote",
  "price.observed": "Observed {date}",
  "price.liquidity-high": "High liquidity",
  "price.liquidity-medium": "Medium liquidity",
  "price.liquidity-low": "Low liquidity",
  "price.liquidity-unknown": "Liquidity unknown",
  "language.en": "English",
  "language.fr": "French",
  "finish.normal": "Normal",
  "finish.reverse": "Reverse holo",
  "finish.holo": "Holo",
  "finish.first-edition": "First edition",
  "finish.other": "Other",
  "condition.mint": "Mint",
  "condition.near-mint": "Near mint",
  "condition.excellent": "Excellent",
  "condition.good": "Good",
  "condition.played": "Played",
  "condition.poor": "Poor",
} as const;

type TranslationKey = keyof typeof en;

const fr: Record<TranslationKey, string> = {
  "app.tagline": "Connaissez chaque carte. Gardez chaque sou.",
  "nav.scanner": "Scanner",
  "nav.collection": "Collection",
  "nav.insights": "Valeur",
  "nav.settings": "Réglages",
  "common.cancel": "Annuler",
  "common.confirm": "Confirmer",
  "common.retry": "Réessayer",
  "common.close": "Fermer",
  "common.loading": "Chargement…",
  "common.unavailable": "Indisponible",
  "common.offline": "Hors ligne — votre collection reste disponible",
  "scanner.eyebrow": "Scan privé sur cet appareil",
  "scanner.title": "Cadrez une carte Pokémon",
  "scanner.help":
    "Remplissez le cadre, évitez les reflets et gardez le numéro visible.",
  "scanner.camera": "Utiliser la caméra",
  "scanner.photo": "Choisir une photo",
  "scanner.capture": "Photographier la carte",
  "scanner.stop": "Fermer la caméra",
  "scanner.privacy":
    "La photo reste sur cet appareil et est supprimée après la recherche.",
  "scanner.processing": "Lecture locale de la carte",
  "scanner.searching": "Recherche dans le catalogue",
  "scanner.model": "Comparaison visuelle locale",
  "scanner.error":
    "Carte illisible. Essayez une photo plus nette et sans reflet.",
  "scanner.offlineSearch":
    "Connectez-vous une fois pour chercher le catalogue. Aucune photo ne sera envoyée.",
  "scanner.results": "Correspondances possibles",
  "scanner.matchScore": "Score de correspondance : {score} %",
  "scanner.confident": "Bonne correspondance — à confirmer",
  "scanner.review": "Une vérification rapide est nécessaire",
  "scanner.noMatch": "Aucune correspondance fiable",
  "scanner.correct": "C’est bien ma carte",
  "scanner.notCorrect": "Scanner une autre carte",
  "scanner.finish": "Finition",
  "scanner.condition": "État",
  "scanner.cardLanguage": "Langue de la carte",
  "scanner.cardLanguageHelp":
    "Choisissez la langue imprimée sur la carte, indépendamment de celle de l’application.",
  "scanner.languageRequired":
    "Choisissez la langue de la carte avant de scanner ou chercher.",
  "scanner.requiredChoices":
    "Choisissez la langue de la carte, la finition et l’état avant l’ajout.",
  "scanner.cost": "Prix payé ? (facultatif)",
  "scanner.costCurrency": "Devise d’achat",
  "scanner.add": "Ajouter à la collection",
  "scanner.added": "Carte ajoutée. Les doubles sont regroupés automatiquement.",
  "scanner.manual": "Chercher par nom ou numéro",
  "scanner.search": "Chercher",
  "scanner.visualSkipped":
    "Comparaison d’image indisponible ; le texte a été utilisé.",
  "collection.title": "Votre collection",
  "collection.eyebrow": "Bibliothèque CardScope",
  "collection.subtitle": "{cards} cartes · {unique} uniques",
  "collection.empty": "Votre premier scan apparaîtra ici, même hors ligne.",
  "collection.search": "Filtrer les cartes",
  "collection.value": "Valeur de marché estimée",
  "collection.range": "Fourchette observée",
  "collection.cost": "Coût renseigné",
  "collection.costPartial": "Couverture des coûts partielle",
  "collection.net": "Valeur moins coût renseigné",
  "collection.fresh": "Actualisé {age}",
  "collection.stale": "Prix à actualiser",
  "collection.source": "Source : {source}",
  "collection.confirmRemove": "Retirer cette carte de la collection ?",
  "collection.noValues": "Aucun prix ni coût d’acquisition renseigné.",
  "collection.saveCost": "Enregistrer le coût d’acquisition",
  "collection.costAmount": "Coût d’acquisition unitaire",
  "collection.costCurrency": "Devise du coût",
  "collection.decrease": "Retirer un exemplaire",
  "collection.increase": "Ajouter un exemplaire",
  "collection.remove": "Retirer la carte",
  "collection.history": "Activité récente",
  "insights.title": "Analyse de la collection",
  "insights.eyebrow": "Tableau de bord ROI",
  "insights.subtitle": "Des estimations transparentes, jamais une note d’état.",
  "insights.market": "Estimation de marché",
  "insights.range": "{low} – {high}",
  "insights.net": "Net par rapport au coût renseigné",
  "insights.review": "Cartes à vérifier",
  "insights.reviewHelp":
    "Les cartes de valeur, anciennes ou incertaines passent en premier.",
  "insights.allGood": "Aucune vérification urgente.",
  "insights.priceCoverage": "Couverture des prix",
  "insights.costCoverage": "Coûts renseignés",
  "insights.methodNote":
    "Valeurs indicatives selon les cotes observées. CardScope ne certifie ni authenticité ni état.",
  "reason.missing-price": "Aucun prix actuel",
  "reason.stale-price": "Cote périmée",
  "reason.low-liquidity": "Peu de ventes observées",
  "reason.unknown-liquidity": "Liquidité inconnue",
  "reason.missing-cost": "Coût non renseigné",
  "settings.title": "Réglages et données",
  "settings.language": "Langue",
  "settings.english": "English",
  "settings.french": "Français",
  "settings.englishContent": "Interface en anglais",
  "settings.frenchContent": "Interface en français",
  "settings.valuationTitle": "Préférence de valorisation",
  "settings.valuationHelp":
    "Choisissez la cote de marché disponible que CardScope doit privilégier. Ce réglage est indépendant de la langue de l’interface et de la carte.",
  "settings.marketLabel": "Marché de référence",
  "settings.currencyLabel": "Devise de référence",
  "settings.noConversion":
    "CardScope choisit une cote disponible dans cet ordre ; aucune conversion de devise cachée n’est effectuée.",
  "settings.dataTitle": "Vos données",
  "settings.localEvents": "{count} événements locaux",
  "settings.restorable": "restaurable",
  "settings.signedInAccount": "Compte connecté",
  "settings.noAds": "Sans publicité · Sans revente de données",
  "settings.localFirst": "Local par conception",
  "settings.localDetail":
    "Scans et événements restent sur cet appareil. Les photos ne sont jamais enregistrées.",
  "settings.exportJson": "Sauvegarde JSON",
  "settings.exportCsv": "Exporter en CSV",
  "settings.importJson": "Restaurer une sauvegarde JSON",
  "settings.importFile": "Importer JSON ou CSV",
  "settings.imported": "{count} événements importés",
  "settings.importError": "Impossible d’importer cette sauvegarde.",
  "settings.restoreMode": "Mode de restauration JSON",
  "settings.restoreHelp":
    "Choisissez l’effet d’une sauvegarde JSON sur la collection active. Les fichiers CSV ajoutent toujours des lignes.",
  "settings.restoreMerge": "Fusionner avec la collection active",
  "settings.restoreMergeHelp":
    "Conserver les événements actuels et ajouter ceux de la sauvegarde.",
  "settings.restoreReplace": "Remplacer la collection active",
  "settings.restoreReplaceHelp":
    "Effacer uniquement la collection anonyme ou connectée actuelle, puis restaurer cette sauvegarde.",
  "settings.replaceWarning":
    "Le remplacement efface la collection active sur cet appareil. Les autres domaines de compte sont conservés.",
  "settings.replaceConfirm":
    "Cette opération efface la collection active sur cet appareil et la remplace par la sauvegarde JSON sélectionnée. Les autres domaines de compte sont conservés. Continuer ?",
  "settings.account": "Synchronisation cloud facultative",
  "settings.accountHelp":
    "La collection locale gratuite fonctionne sans compte. La synchronisation n’apparaît que si les gates d’identité et de sauvegarde sont activés.",
  "settings.signIn": "Se connecter",
  "settings.signOut": "Se déconnecter",
  "settings.authDisabled":
    "La synchronisation cloud et la sauvegarde serveur ne sont pas activées sur ce déploiement.",
  "settings.sync": "Synchroniser",
  "settings.synced":
    "Synchronisation terminée — la copie serveur active est à jour",
  "settings.syncError":
    "Synchronisation indisponible. Vos données locales sont intactes.",
  "settings.deleteCloud": "Supprimer la copie serveur active",
  "settings.deleteCloudConfirm":
    "Supprimer la copie serveur active ? Votre collection locale reste disponible. Les snapshots ou sauvegardes suivent la politique d’effacement publiée du déploiement.",
  "settings.deletedCloud":
    "Copie serveur active supprimée. Les données locales sont conservées.",
  "settings.retention":
    "Une fois activés, les événements cloud sont conservés jusqu’à {years} ans.",
  "price.noPrice": "Prix indisponible",
  "price.today": "aujourd’hui",
  "price.days": "il y a {count} j",
  "price.conditionUnknown": "L’état n’est pas intégré à cette cote",
  "price.observed": "Observé le {date}",
  "price.liquidity-high": "Liquidité élevée",
  "price.liquidity-medium": "Liquidité moyenne",
  "price.liquidity-low": "Faible liquidité",
  "price.liquidity-unknown": "Liquidité inconnue",
  "language.en": "Anglais",
  "language.fr": "Français",
  "finish.normal": "Normale",
  "finish.reverse": "Reverse holo",
  "finish.holo": "Holo",
  "finish.first-edition": "Première édition",
  "finish.other": "Autre",
  "condition.mint": "Neuve",
  "condition.near-mint": "Quasi neuve",
  "condition.excellent": "Excellente",
  "condition.good": "Bonne",
  "condition.played": "Jouée",
  "condition.poor": "Très usée",
};

const dictionaries: Record<Locale, Record<TranslationKey, string>> = { en, fr };

export function translate(
  locale: Locale,
  key: TranslationKey,
  values: Record<string, string | number> = {},
): string {
  let result = dictionaries[locale][key] ?? en[key];
  for (const [name, value] of Object.entries(values))
    result = result.replaceAll(`{${name}}`, String(value));
  return result;
}

export function formatMoney(
  locale: Locale,
  amount: number,
  currency = "USD",
): string {
  return formatCurrencySafely(
    locale === "fr" ? "fr-CA" : "en-CA",
    amount,
    currency,
  );
}

export function formatOptionalMoney(
  locale: Locale,
  amount: number | null | undefined,
  currency = "USD",
): string {
  return amount === null || amount === undefined
    ? translate(locale, "common.unavailable")
    : formatMoney(locale, amount, currency);
}

export type { TranslationKey };
