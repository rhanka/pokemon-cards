import type { Locale } from "./types";
import { formatCurrencySafely } from "./money";

const en = {
  "app.tagline": "Know every card. Keep every cent.",
  "app.valuationPending":
    "Identification is live. Market values remain unavailable until commercial quote-feed rights are confirmed.",
  "app.enrollmentChecking": "Preparing your account collection…",
  "app.enrollmentTitle": "Add this device’s cards to your account?",
  "app.enrollmentHelp":
    "This browser has {anonymous} offline events and your account already has {account}. Nothing will move until you confirm.",
  "app.enrollmentConfirm": "Add them to my account",
  "app.enrollmentSeparate": "Keep them separate",
  "app.enrollmentMoving": "Adding cards to your account…",
  "app.enrollmentError":
    "The cards were not moved. Try again; both collections remain intact.",
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
  "common.offline":
    "Offline — your collection remains available and changes will sync automatically",
  "scanner.eyebrow": "Automatic card recognition",
  "scanner.title": "Frame one Pokémon card",
  "scanner.help":
    "Fill the guide, avoid glare, and keep the collector number visible.",
  "scanner.camera": "Use camera",
  "scanner.photo": "Choose photo",
  "scanner.capture": "Capture card",
  "scanner.stop": "Close camera",
  "scanner.processing": "Reading the card securely",
  "scanner.searching": "Searching the catalogue",
  "scanner.model": "Checking server recognition",
  "scanner.error":
    "This card could not be read. Try a sharper, glare-free photo.",
  "scanner.busy":
    "Recognition is busy right now. Wait a few seconds and try again.",
  "scanner.timeout":
    "Recognition took too long. Try again with a tighter, sharper photo.",
  "scanner.catalogueUnavailable":
    "The card catalogue is temporarily unavailable. Try again shortly.",
  "scanner.offlineSearch":
    "Connect to scan with server recognition. Manual catalogue search remains available online.",
  "scanner.results": "Possible matches",
  "scanner.matchScore": "Match score: {score}%",
  "scanner.confident": "Strong match — please confirm",
  "scanner.review": "A quick check is needed",
  "scanner.noMatch": "No reliable match",
  "scanner.correct": "This is my card",
  "scanner.notCorrect": "Scan another card",
  "scanner.finish": "Finish",
  "scanner.condition": "Condition",
  "scanner.requiredChoices": "Choose the finish and condition before adding.",
  "scanner.cost": "What did you pay? (optional)",
  "scanner.costCurrency": "Purchase currency",
  "scanner.add": "Add to collection",
  "scanner.added": "Card added to your collection.",
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
  "collection.edit": "Edit",
  "collection.closeEdit": "Close",
  "collection.editCard": "Edit {card}",
  "collection.closeEditCard": "Close editor for {card}",
  "collection.pagination": "Collection pages",
  "collection.previous": "Previous",
  "collection.next": "Next",
  "collection.pageStatus": "{start}–{end} of {total}",
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
  "settings.localEvents": "{count} events in this device’s offline cache",
  "settings.restorable": "restorable",
  "settings.signedInAccount": "Signed-in account",
  "settings.noAds": "No ads · No data resale",
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
    "Erase the anonymous collection on this browser, then restore this backup.",
  "settings.restoreReplaceAccountHelp":
    "Signed-in collections are synchronized centrally. Merge this backup to avoid deleting data on another device.",
  "settings.replaceWarning":
    "Replacement erases the active collection on this device. Other account domains are preserved.",
  "settings.replaceConfirm":
    "This will erase the active collection on this device and replace it with the selected JSON backup. Other account domains are preserved. Continue?",
  "settings.account": "Your CardScope account",
  "settings.accountHelp":
    "Your account is the durable collection source. This browser keeps an offline cache and sends queued changes automatically.",
  "settings.signIn": "Create account / Sign in",
  "settings.signInAgain": "Sign in again",
  "settings.signOut": "Sign out on this device",
  "settings.signOutHelp":
    "The offline cache stays on this browser so queued changes are not lost. It is hidden after sign-out and restored only when the same account signs in again.",
  "settings.authDisabled":
    "Account enrollment is not enabled on this deployment yet. Cards you add remain in this device’s offline cache.",
  "settings.sync": "Sync now",
  "settings.retrySync": "Retry saving",
  "settings.syncPreparing": "Preparing the offline cache for this account.",
  "settings.syncPending": "Changes are queued and will be saved automatically.",
  "settings.syncing": "Saving changes to your account…",
  "settings.synced": "All changes are saved to your account.",
  "settings.syncOffline":
    "Offline cache active. Queued changes will be saved when the connection returns.",
  "settings.syncAuthRequired": "Sign in again to resume automatic saving.",
  "settings.syncError":
    "CardScope could not reach your account. Changes remain queued on this device.",
  "settings.deleteCloud": "Delete account collection",
  "settings.deleteCloudConfirm":
    "Delete this collection from your account and this device? Other devices will receive the empty account state. Retained backups follow the published erasure policy.",
  "settings.deletedCloud":
    "The collection was deleted from your account and this device.",
  "settings.retention":
    "Account collection history is retained for up to {years} years.",
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
  "app.valuationPending":
    "L’identification est active. Les valeurs de marché restent indisponibles tant que les droits commerciaux du flux de prix ne sont pas confirmés.",
  "app.enrollmentChecking": "Préparation de votre collection de compte…",
  "app.enrollmentTitle": "Ajouter les cartes de cet appareil au compte ?",
  "app.enrollmentHelp":
    "Ce navigateur contient {anonymous} événements hors ligne et votre compte en contient déjà {account}. Rien ne sera déplacé sans votre confirmation.",
  "app.enrollmentConfirm": "Les ajouter à mon compte",
  "app.enrollmentSeparate": "Les garder séparées",
  "app.enrollmentMoving": "Ajout des cartes à votre compte…",
  "app.enrollmentError":
    "Les cartes n’ont pas été déplacées. Réessayez : les deux collections sont intactes.",
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
  "common.offline":
    "Hors ligne — votre collection reste disponible et les changements se synchroniseront automatiquement",
  "scanner.eyebrow": "Reconnaissance automatique des cartes",
  "scanner.title": "Cadrez une carte Pokémon",
  "scanner.help":
    "Remplissez le cadre, évitez les reflets et gardez le numéro visible.",
  "scanner.camera": "Utiliser la caméra",
  "scanner.photo": "Choisir une photo",
  "scanner.capture": "Photographier la carte",
  "scanner.stop": "Fermer la caméra",
  "scanner.processing": "Lecture sécurisée de la carte",
  "scanner.searching": "Recherche dans le catalogue",
  "scanner.model": "Vérification par le service de reconnaissance",
  "scanner.error":
    "Carte illisible. Essayez une photo plus nette et sans reflet.",
  "scanner.busy":
    "Le service de reconnaissance est occupé. Patientez quelques secondes puis réessayez.",
  "scanner.timeout":
    "La reconnaissance a pris trop de temps. Recadrez la carte et réessayez.",
  "scanner.catalogueUnavailable":
    "Le catalogue de cartes est temporairement indisponible. Réessayez bientôt.",
  "scanner.offlineSearch":
    "Connectez-vous pour utiliser la reconnaissance serveur. La recherche manuelle reste disponible en ligne.",
  "scanner.results": "Correspondances possibles",
  "scanner.matchScore": "Score de correspondance : {score} %",
  "scanner.confident": "Bonne correspondance — à confirmer",
  "scanner.review": "Une vérification rapide est nécessaire",
  "scanner.noMatch": "Aucune correspondance fiable",
  "scanner.correct": "C’est bien ma carte",
  "scanner.notCorrect": "Scanner une autre carte",
  "scanner.finish": "Finition",
  "scanner.condition": "État",
  "scanner.requiredChoices": "Choisissez la finition et l’état avant l’ajout.",
  "scanner.cost": "Prix payé ? (facultatif)",
  "scanner.costCurrency": "Devise d’achat",
  "scanner.add": "Ajouter à la collection",
  "scanner.added": "Carte ajoutée à votre collection.",
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
  "collection.edit": "Modifier",
  "collection.closeEdit": "Fermer",
  "collection.editCard": "Modifier {card}",
  "collection.closeEditCard": "Fermer l’éditeur de {card}",
  "collection.pagination": "Pages de la collection",
  "collection.previous": "Précédent",
  "collection.next": "Suivant",
  "collection.pageStatus": "{start}–{end} sur {total}",
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
  "settings.localEvents":
    "{count} événements dans le cache hors ligne de cet appareil",
  "settings.restorable": "restaurable",
  "settings.signedInAccount": "Compte connecté",
  "settings.noAds": "Sans publicité · Sans revente de données",
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
    "Effacer la collection anonyme de ce navigateur, puis restaurer cette sauvegarde.",
  "settings.restoreReplaceAccountHelp":
    "Les collections connectées sont synchronisées au centre. Fusionnez cette sauvegarde pour éviter d’effacer les données d’un autre appareil.",
  "settings.replaceWarning":
    "Le remplacement efface la collection active sur cet appareil. Les autres domaines de compte sont conservés.",
  "settings.replaceConfirm":
    "Cette opération efface la collection active sur cet appareil et la remplace par la sauvegarde JSON sélectionnée. Les autres domaines de compte sont conservés. Continuer ?",
  "settings.account": "Votre compte CardScope",
  "settings.accountHelp":
    "Votre compte est la source durable de la collection. Ce navigateur garde un cache hors ligne et envoie automatiquement les changements en attente.",
  "settings.signIn": "Créer un compte / Se connecter",
  "settings.signInAgain": "Se reconnecter",
  "settings.signOut": "Quitter ce compte sur cet appareil",
  "settings.signOutHelp":
    "Le cache hors ligne reste dans ce navigateur pour ne pas perdre les changements en attente. Il est masqué après la déconnexion et restauré uniquement lorsque le même compte se reconnecte.",
  "settings.authDisabled":
    "L’enrôlement des comptes n’est pas encore activé sur ce déploiement. Les cartes ajoutées restent dans le cache hors ligne de cet appareil.",
  "settings.sync": "Synchroniser",
  "settings.retrySync": "Réessayer l’enregistrement",
  "settings.syncPreparing": "Préparation du cache hors ligne pour ce compte.",
  "settings.syncPending":
    "Les changements sont en attente et seront enregistrés automatiquement.",
  "settings.syncing": "Enregistrement des changements sur votre compte…",
  "settings.synced": "Tous les changements sont enregistrés sur votre compte.",
  "settings.syncOffline":
    "Cache hors ligne actif. Les changements seront enregistrés au retour de la connexion.",
  "settings.syncAuthRequired":
    "Reconnectez-vous pour reprendre l’enregistrement automatique.",
  "settings.syncError":
    "CardScope ne peut pas joindre votre compte. Les changements restent en attente sur cet appareil.",
  "settings.deleteCloud": "Supprimer la collection du compte",
  "settings.deleteCloudConfirm":
    "Supprimer cette collection du compte et de cet appareil ? Les autres appareils recevront l’état vide du compte. Les sauvegardes conservées suivent la politique d’effacement publiée.",
  "settings.deletedCloud":
    "La collection a été supprimée du compte et de cet appareil.",
  "settings.retention":
    "L’historique de la collection du compte est conservé jusqu’à {years} ans.",
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
