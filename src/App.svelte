<script lang="ts">
  /* global navigator, window, matchMedia, localStorage, document, File, console, MouseEvent, AbortController, AbortSignal, DOMException */
  import {
    AppChrome,
    Button,
    IdentityMenu,
    ThemeProvider,
    type AppChromeNavItem,
  } from "@sentropic/design-system-svelte";
  import { onMount } from "svelte";
  import {
    ApiRequestError,
    deleteCloudCollection,
    loadRuntimeConfig,
    selectSyncEventBatch,
    syncCollectionEvents,
    SyncProtocolError,
  } from "./lib/api";
  import { authClient, type AuthState } from "./lib/auth";
  import type { AddHoldingInput } from "./lib/collection";
  import CollectionPage from "./lib/components/CollectionPage.svelte";
  import Icon from "./lib/components/Icon.svelte";
  import InsightsPage from "./lib/components/InsightsPage.svelte";
  import ScannerPage from "./lib/components/ScannerPage.svelte";
  import SettingsPage from "./lib/components/SettingsPage.svelte";
  import {
    collectionRepository,
    CollectionSyncGenerationFenceError,
  } from "./lib/db";
  import {
    downloadText,
    eventsFromJson,
    eventsToJson,
    holdingsFromCsv,
    holdingsToCsv,
  } from "./lib/import-export";
  import { translate } from "./lib/i18n";
  import { SyncCoordinator, type SyncState } from "./lib/sync-coordinator";
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
    sync: {
      enabled: false,
      retentionDays: 1826,
      maxBatchSize: 100,
      maxOperationBytes: 64 * 1024,
    },
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
  let syncState = $state<SyncState>("idle");
  let enrollmentState = $state<
    | { status: "idle" }
    | { status: "checking" | "claiming" }
    | {
        status: "merge-required" | "error";
        anonymousEvents: number;
        accountEvents: number;
      }
  >({ status: "idle" });
  let mobileMenuOpen = $state(false);
  let selectedAuthSubject: string | null = null;
  let syncSubjectReady = false;
  let subjectTransitioning = false;
  let subjectSelectionRevision = 0;
  let subjectSelection: Promise<void> = Promise.resolve();
  let activeSync: Promise<void> | null = null;
  let activeSyncController: AbortController | null = null;
  let activeDeleteController: AbortController | null = null;
  let syncSuspended = false;
  let mutationsSuspended = false;
  let dismissedEnrollmentSubject: string | null = null;
  const enrollmentIntentKey = "cardscope-account-enrollment";

  class AccountQueueMissingGenerationError extends SyncProtocolError {
    constructor() {
      super(
        "A signed-in offline queue has no server generation and requires recovery",
      );
      this.name = "AccountQueueMissingGenerationError";
    }
  }

  const appCopy = $derived(
    locale === "fr"
      ? {
          skip: "Aller au contenu",
          navigation: "Navigation principale",
          menu: "Menu",
          storageError: "Le stockage local est indisponible sur ce navigateur.",
        }
      : {
          skip: "Skip to content",
          navigation: "Main navigation",
          menu: "Menu",
          storageError: "Local storage is unavailable in this browser.",
        },
  );
  const syncCoordinator = new SyncCoordinator({
    availability: () => {
      if (syncSuspended || !syncSubjectReady || !config.sync.enabled)
        return "disabled";
      if (!online) return "offline";
      return authState.status === "authenticated" &&
        authState.session &&
        authSubject(authState)
        ? "ready"
        : "auth-required";
    },
    run: performSync,
    onState: (state) => (syncState = state),
  });

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
    const issuer = config.auth.issuer?.replace(/\/$/, "");
    return typeof subject === "string" && subject.trim() && issuer
      ? `${issuer}|${subject.trim()}`
      : null;
  }

  function observeAuthState(state: AuthState): void {
    authState = state;
    const subject = authSubject(state);
    if (subject === selectedAuthSubject) return;
    const revision = ++subjectSelectionRevision;
    selectedAuthSubject = subject;
    syncSubjectReady = false;
    subjectTransitioning = true;
    snapshot = emptySnapshot;
    dismissedEnrollmentSubject = null;
    activeSyncController?.abort(
      new DOMException("Account changed", "AbortError"),
    );
    activeDeleteController?.abort(
      new DOMException("Account changed", "AbortError"),
    );
    const hidePrevious = collectionRepository
      .setSyncSubject(null)
      .catch(() => false);
    subjectSelection = subjectSelection
      .then(async () => {
        if (activeSync) await activeSync.catch(() => undefined);
        await hidePrevious;
        if (revision !== subjectSelectionRevision) return;
        const changed = await collectionRepository.setSyncSubject(subject);
        if (revision !== subjectSelectionRevision) {
          await collectionRepository.setSyncSubject(null);
          return;
        }
        subjectTransitioning = false;
        await collectionRepository.refreshActiveSnapshot();
        syncSubjectReady = subject !== null;
        if (changed || subject === null) syncState = "idle";
        enrollmentState =
          subject !== null &&
          (await collectionRepository.eventCountForSubject(null)) > 0
            ? { status: "checking" }
            : { status: "idle" };
        if (subject) syncCoordinator.request({ immediate: true });
      })
      .catch((error) => {
        console.error(error);
        if (revision === subjectSelectionRevision) subjectTransitioning = false;
        syncState = "error";
      });
  }

  async function beginEnrollment(): Promise<void> {
    localStorage.setItem(enrollmentIntentKey, "requested");
    dismissedEnrollmentSubject = null;
    await authClient.signIn();
  }

  function scheduleSync(): void {
    if (selectedAuthSubject) syncCoordinator.request();
  }

  function requireMutationsEnabled(): void {
    if (mutationsSuspended)
      throw new Error("Collection deletion is in progress");
  }

  async function prepareMutation(): Promise<void> {
    await subjectSelection;
    requireMutationsEnabled();
    const subject = selectedAuthSubject;
    if (!subject) return;
    if ((await collectionRepository.getSyncGeneration(subject)) !== null)
      return;
    if (!online)
      throw new Error(
        "Connect once before editing a newly enrolled account offline",
      );
    if (activeSync) await activeSync;
    else await performSync();
    if ((await collectionRepository.getSyncGeneration(subject)) === null) {
      throw new AccountQueueMissingGenerationError();
    }
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }

  async function addHolding(input: AddHoldingInput): Promise<void> {
    await prepareMutation();
    await collectionRepository.add(input);
    scheduleSync();
  }

  async function adjustHolding(
    holdingId: string,
    delta: number,
  ): Promise<void> {
    await prepareMutation();
    await collectionRepository.adjustQuantity(holdingId, delta);
    scheduleSync();
  }

  async function removeHolding(holdingId: string): Promise<void> {
    await prepareMutation();
    await collectionRepository.remove(holdingId);
    scheduleSync();
  }

  async function updateHolding(
    holdingId: string,
    patch: Parameters<typeof collectionRepository.update>[1],
  ): Promise<void> {
    await prepareMutation();
    await collectionRepository.update(holdingId, patch);
    scheduleSync();
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
    await prepareMutation();
    if (mode === "replace" && selectedAuthSubject) {
      throw new Error(
        "Signed-in collections must be merged until server-side replacement is generation-aware",
      );
    }
    const text = await file.text();
    if (file.name.toLowerCase().endsWith(".csv") || file.type.includes("csv")) {
      const holdings = holdingsFromCsv(text);
      const imported = await collectionRepository.importHoldings(holdings);
      scheduleSync();
      return imported;
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
    scheduleSync();
    return imported;
  }

  async function synchronizeAccountGeneration(
    subject: string,
    session: NonNullable<AuthState["session"]>,
    options: {
      signal?: AbortSignal;
      requireEmptyForFirstWrite?: boolean;
      onBeforeEmptyWrite?: (eventIds: string[]) => Promise<void>;
      onEmptyWriteAccepted?: () => Promise<void>;
    } = {},
  ): Promise<void> {
    const batchSize = Math.min(100, config.sync.maxBatchSize);
    let generation = await collectionRepository.getSyncGeneration(subject);
    let cursor = await collectionRepository.getSyncCursor(subject);
    let pending = selectSyncEventBatch(
      await collectionRepository.unsyncedEvents(subject, batchSize),
      batchSize,
    );
    if (generation === null && pending.length > 0) {
      throw new AccountQueueMissingGenerationError();
    }
    let bootstrap = generation === null;
    let requireEmpty = options.requireEmptyForFirstWrite === true;
    let hasMore = false;
    let page = 0;
    do {
      options.signal?.throwIfAborted();
      // A generation-less request may only discover an account epoch. Never
      // attach writes or a stale legacy cursor to that bootstrap.
      const sent = bootstrap ? [] : pending;
      const guardedWrite = requireEmpty && sent.length > 0;
      if (guardedWrite) {
        await options.onBeforeEmptyWrite?.(sent.map((event) => event.id));
      }
      const result = await syncCollectionEvents(
        sent,
        session,
        bootstrap ? null : cursor,
        generation,
        {
          signal: options.signal,
          requireEmpty: guardedWrite,
        },
      );
      if (generation !== null && result.generation !== generation)
        throw new SyncProtocolError(
          "Sync response changed generation without an explicit conflict",
        );
      const requestGeneration = generation;
      generation = result.generation;
      await collectionRepository.setSyncGeneration(subject, generation, {
        expectedCurrent: requestGeneration,
      });
      bootstrap = false;
      if (result.remoteEvents.length) {
        const remoteEvents = result.remoteEvents.map((event) => ({
          id: event.id,
          type: event.type,
          holdingId: event.holdingId,
          occurredAt: event.occurredAt,
          deviceId: event.deviceId,
          payload: event.payload,
          syncedAt: event.syncedAt,
          serverSequence: event.serverSequence,
        }));
        await collectionRepository.importEvents(remoteEvents, {
          source: "remote",
          subject,
          generation,
        });
      }
      // The idempotent response acknowledges both newly accepted and
      // previously accepted operation ids from this exact batch.
      if (result.acceptedIds.length)
        await collectionRepository.markSynced(
          subject,
          result.acceptedIds,
          undefined,
          { generation },
        );
      if (sent.length > 0) requireEmpty = false;
      cursor = result.cursor;
      await collectionRepository.setSyncCursor(subject, cursor, {
        generation,
      });
      if (guardedWrite) await options.onEmptyWriteAccepted?.();
      hasMore = result.hasMore;
      pending = selectSyncEventBatch(
        await collectionRepository.unsyncedEvents(subject, batchSize),
        batchSize,
      );
      page += 1;
    } while ((hasMore || pending.length > 0) && page < 50);
    if (hasMore || pending.length > 0)
      throw new Error("Sync page safety limit reached");
    await collectionRepository.refreshActiveSnapshot();
  }

  async function synchronizeAccount(signal?: AbortSignal): Promise<void> {
    if (authState.status !== "authenticated" || !authState.session || !online)
      throw new Error("An authenticated online session is required");
    const subject = authSubject(authState);
    if (!subject || subject !== selectedAuthSubject)
      throw new Error("Authenticated OIDC subject is missing");
    const session = authState.session;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const staleGeneration =
        await collectionRepository.getSyncGeneration(subject);
      try {
        await synchronizeAccountGeneration(subject, session, { signal });
        return;
      } catch (error) {
        if (
          !(error instanceof ApiRequestError) ||
          error.code !== "sync_generation_mismatch" ||
          !error.currentGeneration
        )
          throw error;

        // Another authenticated device deleted the account collection. Clear
        // only if this tab still owns the stale epoch it sent. A delayed 409
        // must never erase operations already created in the replacement epoch.
        const cleared = await collectionRepository.clearAccountData(subject, {
          confirmed: true,
          expectedGeneration: staleGeneration,
          replacementGeneration: error.currentGeneration,
        });
        if (cleared === null) continue;
      }
    }
    throw new SyncProtocolError("Account generation kept changing during sync");
  }

  async function probePendingEnrollment(
    subject: string,
    session: NonNullable<AuthState["session"]>,
    attemptedIds: string[],
    signal?: AbortSignal,
  ): Promise<"accepted" | "empty" | "conflict"> {
    const generation = await collectionRepository.getSyncGeneration(subject);
    if (generation === null) throw new AccountQueueMissingGenerationError();
    const remoteIds: string[] = [];
    let cursor = "0";
    let hasMore = false;
    let page = 0;
    do {
      signal?.throwIfAborted();
      const result = await syncCollectionEvents(
        [],
        session,
        cursor,
        generation,
        { signal },
      );
      if (result.generation !== generation)
        throw new SyncProtocolError(
          "Enrollment probe changed generation without an explicit conflict",
        );
      for (const event of result.remoteEvents) {
        if (!remoteIds.includes(event.id)) remoteIds.push(event.id);
      }
      if (result.remoteEvents.length) {
        await collectionRepository.importEvents(result.remoteEvents, {
          source: "remote",
          subject,
          generation,
        });
      }
      cursor = result.cursor;
      await collectionRepository.setSyncCursor(subject, cursor, {
        generation,
      });
      hasMore = result.hasMore;
      page += 1;
    } while (hasMore && page < 50);
    if (hasMore) throw new SyncProtocolError("Enrollment probe page limit");

    const matched = attemptedIds.filter((id) => remoteIds.includes(id)).length;
    if (matched === attemptedIds.length) return "accepted";
    if (matched > 0)
      throw new SyncProtocolError(
        "Only part of the atomic enrollment batch was recovered",
      );
    return remoteIds.length === 0 ? "empty" : "conflict";
  }

  async function resumePendingEnrollment(
    subject: string,
    signal?: AbortSignal,
  ): Promise<"none" | "committed" | "conflict"> {
    const pending = await collectionRepository.getPendingEnrollment(subject);
    if (!pending) return "none";
    if (authState.status !== "authenticated" || !authState.session)
      throw new Error("Authentication required during enrollment");
    const session = authState.session;
    const enrollmentGeneration =
      await collectionRepository.getSyncGeneration(subject);

    const restoreMergeChoice = async (
      nextGeneration?: string,
    ): Promise<"conflict"> => {
      await collectionRepository.returnClaimedEventsToAnonymous(
        subject,
        pending.claimedIds,
      );
      if (nextGeneration) {
        const cleared = await collectionRepository.clearAccountData(subject, {
          confirmed: true,
          expectedGeneration: enrollmentGeneration,
          replacementGeneration: nextGeneration,
        });
        if (cleared === null) throw new CollectionSyncGenerationFenceError();
        await synchronizeAccountGeneration(subject, session, { signal });
      }
      localStorage.removeItem(enrollmentIntentKey);
      enrollmentState = {
        status: "merge-required",
        anonymousEvents: await collectionRepository.eventCountForSubject(null),
        accountEvents: await collectionRepository.eventCountForSubject(subject),
      };
      return "conflict";
    };

    try {
      if (pending.attemptedIds.length > 0) {
        const probe = await probePendingEnrollment(
          subject,
          session,
          pending.attemptedIds,
          signal,
        );
        if (probe === "accepted") {
          await collectionRepository.completePendingEnrollment(subject);
          localStorage.removeItem(enrollmentIntentKey);
          await synchronizeAccountGeneration(subject, session, { signal });
          return "committed";
        }
        if (probe === "conflict") return await restoreMergeChoice();
      }

      await synchronizeAccountGeneration(subject, session, {
        signal,
        requireEmptyForFirstWrite: true,
        onBeforeEmptyWrite: (eventIds) =>
          collectionRepository.setPendingEnrollmentAttempt(subject, eventIds),
        onEmptyWriteAccepted: () =>
          collectionRepository.completePendingEnrollment(subject),
      });
      localStorage.removeItem(enrollmentIntentKey);
      return "committed";
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.code === "sync_enrollment_conflict"
      ) {
        const result = await restoreMergeChoice();
        await synchronizeAccountGeneration(subject, session, { signal });
        return result;
      }
      const changedGeneration =
        error instanceof ApiRequestError &&
        error.code === "sync_generation_mismatch"
          ? error.currentGeneration
          : error instanceof CollectionSyncGenerationFenceError
            ? await collectionRepository.getSyncGeneration(subject)
            : undefined;
      if (changedGeneration) {
        return await restoreMergeChoice(changedGeneration);
      }
      throw error;
    }
  }

  async function reconcileEnrollment(
    subject: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const anonymousCollection =
      await collectionRepository.eventsForSubject(null);
    const anonymousEvents = anonymousCollection.length;
    if (anonymousEvents === 0 || dismissedEnrollmentSubject === subject) {
      enrollmentState = { status: "idle" };
      if (anonymousEvents === 0) localStorage.removeItem(enrollmentIntentKey);
      return;
    }
    const accountEvents =
      await collectionRepository.eventCountForSubject(subject);
    const enrollmentRequested =
      localStorage.getItem(enrollmentIntentKey) === "requested";
    if (enrollmentRequested && accountEvents === 0) {
      enrollmentState = { status: "claiming" };
      await collectionRepository.claimAnonymousEvents(subject, {
        trackEnrollment: true,
      });
      const result = await resumePendingEnrollment(subject, signal);
      if (result === "committed") {
        enrollmentState = { status: "idle" };
      }
      return;
    }
    localStorage.removeItem(enrollmentIntentKey);
    enrollmentState = {
      status: "merge-required",
      anonymousEvents,
      accountEvents,
    };
  }

  function performSync(): Promise<void> {
    if (activeSync) return activeSync;
    const subject = selectedAuthSubject;
    if (!subject) return Promise.reject(new Error("Authentication required"));
    const controller = new AbortController();
    activeSyncController = controller;
    const run = (async () => {
      const enrollment = await resumePendingEnrollment(
        subject,
        controller.signal,
      );
      if (enrollment === "none") await synchronizeAccount(controller.signal);
      controller.signal.throwIfAborted();
      await reconcileEnrollment(subject, controller.signal);
    })();
    activeSync = run;
    void run.then(
      () => {
        if (activeSync === run) {
          activeSync = null;
          activeSyncController = null;
        }
      },
      () => {
        if (activeSync === run) {
          activeSync = null;
          activeSyncController = null;
        }
      },
    );
    return run;
  }

  async function claimAnonymousCollection(): Promise<void> {
    if (
      enrollmentState.status !== "merge-required" &&
      enrollmentState.status !== "error"
    )
      return;
    const { anonymousEvents, accountEvents } = enrollmentState;
    const subject = selectedAuthSubject;
    if (!subject) return;
    enrollmentState = { status: "claiming" };
    try {
      requireMutationsEnabled();
      if (activeSync) await activeSync;
      await collectionRepository.claimAnonymousEvents(subject);
      localStorage.removeItem(enrollmentIntentKey);
      enrollmentState = { status: "idle" };
      syncCoordinator.request({ immediate: true });
    } catch (error) {
      console.error(error);
      enrollmentState = {
        status: "error",
        anonymousEvents,
        accountEvents,
      };
    }
  }

  function keepAnonymousCollectionSeparate(): void {
    dismissedEnrollmentSubject = selectedAuthSubject;
    localStorage.removeItem(enrollmentIntentKey);
    enrollmentState = { status: "idle" };
  }

  async function syncNow(): Promise<void> {
    await subjectSelection;
    syncCoordinator.request({ immediate: true });
  }

  async function deleteCloud(): Promise<void> {
    await subjectSelection;
    if (authState.status !== "authenticated" || !authState.session)
      throw new Error("Authentication required");
    const subject = authSubject(authState);
    if (!subject) throw new Error("Authenticated OIDC subject is missing");
    if (activeDeleteController)
      throw new Error("Collection deletion is already in progress");
    const session = authState.session;
    const revision = subjectSelectionRevision;
    const controller = new AbortController();
    activeDeleteController = controller;
    syncSuspended = true;
    mutationsSuspended = true;
    let releaseMutationLock: (() => Promise<void>) | null = null;
    try {
      releaseMutationLock =
        await collectionRepository.lockAccountMutations(subject);
      activeSyncController?.abort(
        new DOMException("Collection deletion started", "AbortError"),
      );
      if (activeSync) {
        try {
          await activeSync;
        } catch (error) {
          if (!isAbortError(error)) throw error;
        }
      }
      if (
        controller.signal.aborted ||
        revision !== subjectSelectionRevision ||
        selectedAuthSubject !== subject ||
        authState.status !== "authenticated" ||
        authSubject(authState) !== subject
      ) {
        throw new DOMException("Account changed", "AbortError");
      }
      const pending = await collectionRepository.getPendingEnrollment(subject);
      const deleted = await deleteCloudCollection(session, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        revision !== subjectSelectionRevision ||
        selectedAuthSubject !== subject ||
        authState.status !== "authenticated" ||
        authSubject(authState) !== subject
      ) {
        throw new DOMException("Account changed", "AbortError");
      }
      if (pending) {
        await collectionRepository.returnClaimedEventsToAnonymous(
          subject,
          pending.claimedIds,
          { allowMutationLockOwner: true },
        );
      }
      await collectionRepository.clearAccountData(subject, {
        confirmed: true,
        preserveMutationLock: true,
        replacementGeneration: deleted.generation,
      });
      enrollmentState = { status: "idle" };
      syncState = "synced";
    } finally {
      if (releaseMutationLock) await releaseMutationLock();
      if (activeDeleteController === controller) activeDeleteController = null;
      mutationsSuspended = false;
      syncSuspended = false;
    }
  }

  onMount(() => {
    const savedLocale = localStorage.getItem("cardscope-locale");
    changeLocale(
      savedLocale === "fr" || savedLocale === "en"
        ? savedLocale
        : detectBrowserLocale(),
    );
    const unsubscribeCollection = collectionRepository.snapshot.subscribe(
      (value) => {
        if (!subjectTransitioning) snapshot = value;
      },
    );
    const unsubscribeAuth = authClient.state.subscribe(observeAuthState);
    const setOnline = () => {
      online = navigator.onLine;
      if (selectedAuthSubject) syncCoordinator.request({ immediate: online });
    };
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible" && selectedAuthSubject) {
        void collectionRepository
          .refreshActiveSnapshot()
          .then(() => syncCoordinator.request({ immediate: true }));
      }
    };
    const syncOnPageShow = () => {
      if (selectedAuthSubject) {
        void collectionRepository
          .refreshActiveSnapshot()
          .then(() => syncCoordinator.request({ immediate: true }));
      }
    };
    const navigateFromHash = () => {
      const target = window.location.hash.slice(1);
      if (navigation.includes(target as AppView)) navigate(target as AppView);
    };
    window.addEventListener("online", setOnline);
    window.addEventListener("offline", setOnline);
    window.addEventListener("pageshow", syncOnPageShow);
    document.addEventListener("visibilitychange", syncWhenVisible);
    window.addEventListener("hashchange", navigateFromHash);
    navigateFromHash();

    void (async () => {
      try {
        await collectionRepository.init();
        config = await loadRuntimeConfig();
        collectionRepository.setSyncOperationByteLimit(
          config.sync.maxOperationBytes,
        );
        await authClient.init(config.auth);
        await subjectSelection;
        navigateFromHash();
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
      window.removeEventListener("pageshow", syncOnPageShow);
      document.removeEventListener("visibilitychange", syncWhenVisible);
      window.removeEventListener("hashchange", navigateFromHash);
      activeSyncController?.abort(
        new DOMException("Application closed", "AbortError"),
      );
      syncCoordinator.stop();
    };
  });
</script>

<a class="skip-link" href="#content">{appCopy.skip}</a>
{#snippet identityArea()}
  {#if config.auth.enabled}
    <IdentityMenu
      user={identityUser}
      isAuthenticated={authState.status === "authenticated"}
      onLogin={() => void beginEnrollment()}
      onLogout={() => void authClient.signOut()}
      settingsHref="#settings"
      loginLabel={translate(locale, "settings.signIn")}
      settingsLabel={translate(locale, "nav.settings")}
      logoutLabel={translate(locale, "settings.signOut")}
      compact
    />
  {/if}
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
    {#if enrollmentState.status === "checking" || enrollmentState.status === "claiming"}
      <div class="enrollment-progress" role="status">
        <Icon name="cloud" size={17} />
        {translate(
          locale,
          enrollmentState.status === "claiming"
            ? "app.enrollmentMoving"
            : "app.enrollmentChecking",
        )}
      </div>
    {:else if enrollmentState.status === "merge-required" || enrollmentState.status === "error"}
      <section class="enrollment-banner" aria-labelledby="enrollment-title">
        <div>
          <strong id="enrollment-title"
            >{translate(locale, "app.enrollmentTitle")}</strong
          >
          <p>
            {translate(locale, "app.enrollmentHelp", {
              anonymous: enrollmentState.anonymousEvents,
              account: enrollmentState.accountEvents,
            })}
          </p>
          {#if enrollmentState.status === "error"}
            <p class="enrollment-error" role="alert">
              {translate(locale, "app.enrollmentError")}
            </p>
          {/if}
        </div>
        <div class="enrollment-actions">
          <Button onclick={() => void claimAnonymousCollection()}
            >{translate(locale, "app.enrollmentConfirm")}</Button
          >
          <Button variant="secondary" onclick={keepAnonymousCollectionSeparate}
            >{translate(locale, "app.enrollmentSeparate")}</Button
          >
        </div>
      </section>
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
          onValuationPreference={changeValuationPreference}
          onExportJson={exportJson}
          onExportCsv={exportCsv}
          onImport={importJson}
          onSignIn={beginEnrollment}
          onSignOut={() => authClient.signOut()}
          onSync={syncNow}
          onDeleteCloud={deleteCloud}
        />
      {/if}
    </main>
  </div>
</ThemeProvider>
