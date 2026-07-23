<script lang="ts">
  /* global navigator, window, matchMedia, localStorage, document, File, console, MouseEvent */
  import {
    AppChrome,
    IdentityMenu,
    ThemeProvider,
    type AppChromeNavItem,
  } from "@sentropic/design-system-svelte";
  import { onMount } from "svelte";
  import {
    deleteCloudCollection,
    loadRuntimeConfig,
    syncCollectionEvents,
  } from "./lib/api";
  import { authClient, type AuthState } from "./lib/auth";
  import type { AddHoldingInput } from "./lib/collection";
  import CollectionPage from "./lib/components/CollectionPage.svelte";
  import Icon from "./lib/components/Icon.svelte";
  import InsightsPage from "./lib/components/InsightsPage.svelte";
  import ScannerPage from "./lib/components/ScannerPage.svelte";
  import SettingsPage from "./lib/components/SettingsPage.svelte";
  import { collectionRepository } from "./lib/db";
  import {
    downloadText,
    eventsFromJson,
    eventsToJson,
    holdingsFromCsv,
    holdingsToCsv,
  } from "./lib/import-export";
  import { translate } from "./lib/i18n";
  import type {
    AppView,
    CollectionSnapshot,
    Locale,
    RestoreMode,
    RuntimeConfig,
    ValuationPreference,
  } from "./lib/types";
  import {
    loadValuationPreference,
    saveValuationPreference,
  } from "./lib/value";

  const defaultConfig: RuntimeConfig = {
    appName: "CardScope",
    recognition: {
      enabled: false,
      processing: "server",
      maxImageBytes: 2 * 1024 * 1024,
    },
    auth: { enabled: false, scope: "openid profile email" },
    sync: { enabled: false, retentionDays: 1826 },
    valuation: { marketQuotesEnabled: false },
  };
  const emptySnapshot: CollectionSnapshot = {
    holdings: [],
    activities: [],
    eventCount: 0,
  };

  function detectBrowserLocale(): Locale {
    if (typeof navigator === "undefined") return "en";
    const preferred = navigator.languages?.[0] ?? navigator.language;
    return preferred.toLowerCase().startsWith("fr") ? "fr" : "en";
  }

  let view = $state<AppView>("scanner");
  let locale = $state<Locale>(detectBrowserLocale());
  let config = $state<RuntimeConfig>(defaultConfig);
  let snapshot = $state<CollectionSnapshot>(emptySnapshot);
  let valuationPreference = $state<ValuationPreference>(
    loadValuationPreference(),
  );
  let authState = $state<AuthState>({ status: "loading" });
  let online = $state(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  let loading = $state(true);
  let initError = $state("");
  let syncState = $state<"idle" | "syncing" | "success" | "error">("idle");
  let mobileMenuOpen = $state(false);
  let selectedAuthSubject: string | null = null;
  let subjectSelection: Promise<void> = Promise.resolve();

  const appCopy = $derived(
    locale === "fr"
      ? {
          skip: "Aller au contenu",
          localFirst: "Local avant tout",
          offline: "Hors ligne",
          navigation: "Navigation principale",
          menu: "Menu",
          storageError: "Le stockage local est indisponible sur ce navigateur.",
        }
      : {
          skip: "Skip to content",
          localFirst: "Local-first",
          offline: "Offline",
          navigation: "Main navigation",
          menu: "Menu",
          storageError: "Local storage is unavailable in this browser.",
        },
  );

  const navigation: AppView[] = [
    "scanner",
    "collection",
    "insights",
    "settings",
  ];
  const chromeNavigation = $derived<AppChromeNavItem[]>(
    navigation.map((id) => ({
      label: navigationLabel(id),
      href: `#${id}`,
      active: view === id,
      onClick: (event: MouseEvent) => {
        event.preventDefault();
        navigate(id);
      },
    })),
  );
  const identityUser = $derived.by(() => {
    if (authState.status !== "authenticated" || !authState.session) return null;
    const profile = authState.session.profile ?? {};
    const email = typeof profile.email === "string" ? profile.email : undefined;
    const displayName =
      typeof profile.name === "string" ? profile.name : (email ?? "CardScope");
    return { displayName, email };
  });

  function navigationLabel(id: AppView): string {
    return translate(locale, `nav.${id}`);
  }

  function navigate(next: AppView): void {
    view = next;
    mobileMenuOpen = false;
    window.scrollTo({
      top: 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }

  function changeLocale(next: Locale): void {
    locale = next;
    localStorage.setItem("cardscope-locale", next);
    document.documentElement.lang = next;
  }

  function changeValuationPreference(next: ValuationPreference): void {
    valuationPreference = saveValuationPreference(next);
  }

  function authSubject(state: AuthState): string | null {
    if (state.status !== "authenticated" || !state.session) return null;
    const subject = state.session.profile?.sub;
    return typeof subject === "string" && subject.trim()
      ? subject.trim()
      : null;
  }

  function observeAuthState(state: AuthState): void {
    authState = state;
    const subject = authSubject(state);
    if (subject === selectedAuthSubject) return;
    selectedAuthSubject = subject;
    subjectSelection = subjectSelection
      .then(async () => {
        const changed = await collectionRepository.setSyncSubject(subject);
        if (changed) syncState = "idle";
      })
      .catch((error) => {
        console.error(error);
        syncState = "error";
      });
  }

  async function addHolding(input: AddHoldingInput): Promise<void> {
    await subjectSelection;
    await collectionRepository.add(input);
  }

  async function adjustHolding(holdingId: string, delta: number): Promise<void> {
    await subjectSelection;
    await collectionRepository.adjustQuantity(holdingId, delta);
  }

  async function removeHolding(holdingId: string): Promise<void> {
    await subjectSelection;
    await collectionRepository.remove(holdingId);
  }

  async function updateHolding(
    holdingId: string,
    patch: Parameters<typeof collectionRepository.update>[1],
  ): Promise<void> {
    await subjectSelection;
    await collectionRepository.update(holdingId, patch);
  }

  async function exportJson(): Promise<void> {
    await subjectSelection;
    const events = await collectionRepository.allEvents();
    downloadText(
      `cardscope-backup-${new Date().toISOString().slice(0, 10)}.json`,
      eventsToJson(events),
      "application/json",
    );
  }

  async function exportCsv(): Promise<void> {
    await subjectSelection;
    downloadText(
      `cardscope-collection-${new Date().toISOString().slice(0, 10)}.csv`,
      holdingsToCsv(snapshot.holdings),
      "text/csv;charset=utf-8",
    );
  }

  async function importJson(file: File, mode: RestoreMode): Promise<number> {
    await subjectSelection;
    const text = await file.text();
    if (file.name.toLowerCase().endsWith(".csv") || file.type.includes("csv")) {
      const holdings = holdingsFromCsv(text);
      return collectionRepository.importHoldings(holdings);
    }
    const events = eventsFromJson(text);
    const imported =
      mode === "replace"
        ? await collectionRepository.importEvents(events, {
            source: "restore",
            mode: "replace",
            confirmed: true,
          })
        : await collectionRepository.importEvents(events, {
            source: "restore",
            mode: "merge",
          });
    syncState = "idle";
    return imported;
  }

  async function syncNow(): Promise<void> {
    if (authState.status !== "authenticated" || !authState.session || !online) {
      syncState = "error";
      return;
    }
    syncState = "syncing";
    try {
      await subjectSelection;
      const subject = authSubject(authState);
      if (!subject) throw new Error("Authenticated OIDC subject is missing");
      await collectionRepository.setSyncSubject(subject);
      let cursor = await collectionRepository.getSyncCursor(subject);
      let pending = await collectionRepository.unsyncedEvents(subject, 100);
      let hasMore = false;
      let page = 0;
      do {
        const sent = pending;
        const result = await syncCollectionEvents(
          sent,
          authState.session,
          cursor,
        );
        if (result.remoteEvents.length) {
          // Strip server transport metadata (sequence/receivedAt) before the
          // strict CollectionEvent validator sees the durable event payload.
          const remoteEvents = result.remoteEvents.map((event) => ({
            id: event.id,
            type: event.type,
            holdingId: event.holdingId,
            occurredAt: event.occurredAt,
            deviceId: event.deviceId,
            payload: event.payload,
            syncedAt: event.syncedAt,
          }));
          await collectionRepository.importEvents(remoteEvents, {
            source: "remote",
            subject,
          });
        }
        // A successful idempotent response also acknowledges duplicate operation ids.
        if (sent.length)
          await collectionRepository.markSynced(
            subject,
            sent.map((event) => event.id),
          );
        cursor = result.cursor;
        await collectionRepository.setSyncCursor(subject, cursor);
        hasMore = result.hasMore;
        pending = await collectionRepository.unsyncedEvents(subject, 100);
        page += 1;
      } while ((hasMore || pending.length > 0) && page < 50);
      if (hasMore || pending.length > 0)
        throw new Error("Sync page safety limit reached");
      syncState = "success";
    } catch (error) {
      console.error(error);
      syncState = "error";
    }
  }

  async function deleteCloud(): Promise<void> {
    if (authState.status !== "authenticated" || !authState.session)
      throw new Error("Authentication required");
    await subjectSelection;
    const subject = authSubject(authState);
    if (!subject) throw new Error("Authenticated OIDC subject is missing");
    await deleteCloudCollection(authState.session);
    // The reset only prepares a possible future, deliberate reseed. Deletion
    // never calls syncNow automatically.
    await collectionRepository.resetSyncState(subject);
    syncState = "idle";
  }

  onMount(() => {
    const savedLocale = localStorage.getItem("cardscope-locale");
    changeLocale(
      savedLocale === "fr" || savedLocale === "en"
        ? savedLocale
        : detectBrowserLocale(),
    );
    const unsubscribeCollection = collectionRepository.snapshot.subscribe(
      (value) => (snapshot = value),
    );
    const unsubscribeAuth = authClient.state.subscribe(observeAuthState);
    const setOnline = () => (online = navigator.onLine);
    const navigateFromHash = () => {
      const target = window.location.hash.slice(1);
      if (navigation.includes(target as AppView)) navigate(target as AppView);
    };
    window.addEventListener("online", setOnline);
    window.addEventListener("offline", setOnline);
    window.addEventListener("hashchange", navigateFromHash);
    navigateFromHash();

    void (async () => {
      try {
        await collectionRepository.init();
        config = await loadRuntimeConfig();
        await authClient.init(config.auth);
        await subjectSelection;
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker
            .register("/sw.js")
            .catch((error) =>
              console.info("Service worker unavailable", error),
            );
        }
      } catch (error) {
        console.error(error);
        initError = error instanceof Error ? error.message : String(error);
      } finally {
        loading = false;
      }
    })();

    return () => {
      unsubscribeCollection();
      unsubscribeAuth();
      window.removeEventListener("online", setOnline);
      window.removeEventListener("offline", setOnline);
      window.removeEventListener("hashchange", navigateFromHash);
    };
  });
</script>

<a class="skip-link" href="#content">{appCopy.skip}</a>
{#snippet identityArea()}
  {#if config.auth.enabled}
    <IdentityMenu
      user={identityUser}
      isAuthenticated={authState.status === "authenticated"}
      onLogin={() => void authClient.signIn()}
      onLogout={() => void authClient.signOut()}
      settingsHref="#settings"
      loginLabel={translate(locale, "settings.signIn")}
      settingsLabel={translate(locale, "nav.settings")}
      logoutLabel={translate(locale, "settings.signOut")}
      compact
    />
  {/if}
{/snippet}

{#snippet networkState()}
  <span class:offline={!online} class="network-state">
    {#if online}<span class="online-dot"></span>{:else}<Icon
        name="wifi-off"
        size={15}
      />{/if}
    {online ? appCopy.localFirst : appCopy.offline}
  </span>
{/snippet}

<ThemeProvider>
  <div class="app-shell">
    <AppChrome
      brandName={config.appName}
      productName={translate(locale, "app.tagline")}
      brandHref="#scanner"
      brandLabel={config.appName}
      nav={chromeNavigation}
      navLabel={appCopy.navigation}
      {locale}
      onLocaleChange={changeLocale}
      localeLabel={translate(locale, "settings.language")}
      identity={identityArea}
      extraSelectors={networkState}
      {mobileMenuOpen}
      onMobileMenuToggle={() => (mobileMenuOpen = !mobileMenuOpen)}
      menuLabel={appCopy.menu}
    />

    {#if !online}
      <div class="offline-banner" role="status">
        <Icon name="wifi-off" size={17} />
        {translate(locale, "common.offline")}
      </div>
    {/if}
    {#if !loading && !config.valuation.marketQuotesEnabled}
      <div class="valuation-banner" role="status">
        <Icon name="shield" size={17} />
        {translate(locale, "app.valuationPending")}
      </div>
    {/if}

    <main id="content">
      {#if loading}
        <div class="app-loading" role="status">
          <span></span><strong>{translate(locale, "common.loading")}</strong>
        </div>
      {:else if initError}
        <div class="fatal-error" role="alert">
          <h1>CardScope</h1>
          <p>{appCopy.storageError}</p>
          <small>{initError}</small>
        </div>
      {:else if view === "scanner"}
        <ScannerPage
          {locale}
          {config}
          {online}
          {valuationPreference}
          onAdd={addHolding}
        />
      {:else if view === "collection"}
        <CollectionPage
          {locale}
          {snapshot}
          {valuationPreference}
          onAdjust={adjustHolding}
          onRemove={removeHolding}
          onUpdate={updateHolding}
        />
      {:else if view === "insights"}
        <InsightsPage {locale} {snapshot} />
      {:else}
        <SettingsPage
          {locale}
          {snapshot}
          {config}
          {authState}
          {syncState}
          {valuationPreference}
          onLocale={changeLocale}
          onValuationPreference={changeValuationPreference}
          onExportJson={exportJson}
          onExportCsv={exportCsv}
          onImport={importJson}
          onSignIn={() => authClient.signIn()}
          onSignOut={() => authClient.signOut()}
          onSync={syncNow}
          onDeleteCloud={deleteCloud}
        />
      {/if}
    </main>
  </div>
</ThemeProvider>
