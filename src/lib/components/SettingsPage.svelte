<script lang="ts">
  /* global File, Event, HTMLInputElement, HTMLSelectElement, window */
  import { Button, Card } from "@sentropic/design-system-svelte";
  import type { AuthState } from "../auth";
  import { translate } from "../i18n";
  import type { SyncState } from "../sync-coordinator";
  import type {
    CollectionSnapshot,
    Locale,
    RestoreMode,
    RuntimeConfig,
    ValuationPreference,
  } from "../types";
  import Icon from "./Icon.svelte";

  let {
    locale,
    snapshot,
    config,
    authState,
    syncState,
    valuationPreference,
    onValuationPreference,
    onExportJson,
    onExportCsv,
    onImport,
    onSignIn,
    onSignOut,
    onSync,
    onDeleteCloud,
  }: {
    locale: Locale;
    snapshot: CollectionSnapshot;
    config: RuntimeConfig;
    authState: AuthState;
    syncState: SyncState;
    valuationPreference: ValuationPreference;
    onValuationPreference: (preference: ValuationPreference) => void;
    onExportJson: () => Promise<void>;
    onExportCsv: () => Promise<void>;
    onImport: (file: File, mode: RestoreMode) => Promise<number>;
    onSignIn: () => Promise<void>;
    onSignOut: () => Promise<void>;
    onSync: () => Promise<void>;
    onDeleteCloud: () => Promise<void>;
  } = $props();

  let importStatus = $state<"idle" | "success" | "error">("idle");
  let importedCount = $state(0);
  let restoreMode = $state<RestoreMode>("merge");
  let deleteState = $state<"idle" | "deleting" | "success" | "error">("idle");
  const signedIn = $derived(authState.status === "authenticated");

  $effect(() => {
    if (signedIn && restoreMode === "replace") restoreMode = "merge";
  });

  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    importStatus = "idle";
    const isCsv =
      file.name.toLowerCase().endsWith(".csv") || file.type.includes("csv");
    const mode: RestoreMode = isCsv ? "merge" : restoreMode;
    if (
      mode === "replace" &&
      !window.confirm(translate(locale, "settings.replaceConfirm"))
    )
      return;
    try {
      importedCount = await onImport(file, mode);
      importStatus = "success";
    } catch {
      importStatus = "error";
    }
  }

  async function deleteCloud(): Promise<void> {
    if (!window.confirm(translate(locale, "settings.deleteCloudConfirm")))
      return;
    deleteState = "deleting";
    try {
      await onDeleteCloud();
      deleteState = "success";
    } catch {
      deleteState = "error";
    }
  }

  function changeMarket(event: Event): void {
    onValuationPreference({
      ...valuationPreference,
      market: (event.currentTarget as HTMLSelectElement).value,
    });
  }

  function changeCurrency(event: Event): void {
    onValuationPreference({
      ...valuationPreference,
      currency: (event.currentTarget as HTMLSelectElement).value,
    });
  }
</script>

<section class="page settings-page" aria-labelledby="settings-title">
  <header class="page-heading">
    <span class="eyebrow">CardScope</span>
    <h1 id="settings-title">{translate(locale, "settings.title")}</h1>
  </header>

  <Card class="settings-group valuation-card" aria-labelledby="valuation-title">
    <div class="group-heading">
      <h2 id="valuation-title">{translate(locale, "settings.valuationTitle")}</h2>
      <p>{translate(locale, "settings.valuationHelp")}</p>
    </div>
    <div class="preference-grid">
      <label>
        <span>{translate(locale, "settings.marketLabel")}</span>
        <select value={valuationPreference.market} onchange={changeMarket}>
          <option value="tcgplayer">TCGplayer</option>
          <option value="cardmarket">Cardmarket</option>
          <option value="tcgdex">TCGdex</option>
        </select>
      </label>
      <label>
        <span>{translate(locale, "settings.currencyLabel")}</span>
        <select value={valuationPreference.currency} onchange={changeCurrency}>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="CAD">CAD</option>
          <option value="GBP">GBP</option>
          <option value="JPY">JPY</option>
        </select>
      </label>
    </div>
    <p class="preference-note">{translate(locale, "settings.noConversion")}</p>
  </Card>

  <section class="settings-group" aria-labelledby="data-title">
    <div class="group-heading">
      <div>
        <h2 id="data-title">{translate(locale, "settings.dataTitle")}</h2>
        <p>
          {translate(locale, "settings.localEvents", {
            count: snapshot.eventCount,
          })}
        </p>
      </div>
    </div>
    <fieldset class="restore-options">
      <legend>{translate(locale, "settings.restoreMode")}</legend>
      <p>{translate(locale, "settings.restoreHelp")}</p>
      <div class="restore-choice">
        <label>
          <input
            type="radio"
            name="restore-mode"
            value="merge"
            checked={restoreMode === "merge"}
            onchange={() => (restoreMode = "merge")}
          />
          <span>
            <strong>{translate(locale, "settings.restoreMerge")}</strong>
            <small>{translate(locale, "settings.restoreMergeHelp")}</small>
          </span>
        </label>
        <label class:danger={restoreMode === "replace"}>
          <input
            type="radio"
            name="restore-mode"
            value="replace"
            disabled={signedIn}
            checked={restoreMode === "replace"}
            onchange={() => (restoreMode = "replace")}
          />
          <span>
            <strong>{translate(locale, "settings.restoreReplace")}</strong>
            <small
              >{translate(
                locale,
                signedIn
                  ? "settings.restoreReplaceAccountHelp"
                  : "settings.restoreReplaceHelp",
              )}</small
            >
          </span>
        </label>
      </div>
      {#if restoreMode === "replace"}
        <p class="replace-warning" role="status">
          {translate(locale, "settings.replaceWarning")}
        </p>
      {/if}
    </fieldset>
    <div class="action-list">
      <button onclick={() => void onExportJson()}
        ><span class="action-icon"><Icon name="download" /></span><span
          ><strong>{translate(locale, "settings.exportJson")}</strong><small
            >.json · {translate(locale, "settings.restorable")}</small
          ></span
        ><Icon name="arrow" size={18} /></button
      >
      <button onclick={onExportCsv}
        ><span class="action-icon"><Icon name="download" /></span><span
          ><strong>{translate(locale, "settings.exportCsv")}</strong><small
            >.csv · Excel / Sheets</small
          ></span
        ><Icon name="arrow" size={18} /></button
      >
      <label class="import-action"
        ><span class="action-icon"><Icon name="upload" /></span><span
          ><strong>{translate(locale, "settings.importFile")}</strong><small
            >.json / .csv · CardScope</small
          ></span
        ><Icon name="arrow" size={18} /><input
          type="file"
          accept="application/json,text/csv,.json,.csv"
          onchange={importFile}
        /></label
      >
    </div>
    {#if importStatus === "success"}<p class="status success" role="status">
        {translate(locale, "settings.imported", { count: importedCount })}
      </p>{/if}
    {#if importStatus === "error"}<p class="status error" role="alert">
        {translate(locale, "settings.importError")}
      </p>{/if}
  </section>

  <Card class="settings-group cloud-group" aria-labelledby="cloud-title">
    <div class="cloud-heading">
      <div class="icon-box cloud"><Icon name="cloud" /></div>
      <div>
        <h2 id="cloud-title">{translate(locale, "settings.account")}</h2>
        <p>{translate(locale, "settings.accountHelp")}</p>
      </div>
    </div>
    {#if authState.status === "disabled"}
      <div class="disabled-message">
        {translate(locale, "settings.authDisabled")}
      </div>
    {:else if authState.status === "loading"}
      <Button variant="secondary" class="full" disabled
        >{translate(locale, "common.loading")}</Button
      >
    {:else if authState.status === "authenticated"}
      <div class="account-state">
        <span
          ><Icon name="check" size={17} />
          {String(
            authState.session?.profile?.email ??
              authState.session?.profile?.name ??
              translate(locale, "settings.signedInAccount"),
          )}</span
        ><button onclick={() => void onSignOut()}
          >{translate(locale, "settings.signOut")}</button
        >
      </div>
      <p class="account-cache-note">
        {translate(locale, "settings.signOutHelp")}
      </p>
      {#if syncState === "error"}
        <Button class="full" onclick={() => void onSync()}
          ><Icon name="cloud" />
          {translate(locale, "settings.retrySync")}</Button
        >
      {:else if syncState === "auth-required"}
        <Button class="full" onclick={() => void onSignIn()}
          >{translate(locale, "settings.signInAgain")}</Button
        >
      {/if}
      {#if syncState === "synced"}<p class="status success" role="status">
          {translate(locale, "settings.synced")}
        </p>{/if}
      {#if syncState === "idle"}<p class="status" role="status">
          {translate(locale, "settings.syncPreparing")}
        </p>{/if}
      {#if syncState === "pending"}<p class="status" role="status">
          {translate(locale, "settings.syncPending")}
        </p>{/if}
      {#if syncState === "syncing"}<p class="status" role="status">
          {translate(locale, "settings.syncing")}
        </p>{/if}
      {#if syncState === "offline"}<p class="status" role="status">
          {translate(locale, "settings.syncOffline")}
        </p>{/if}
      {#if syncState === "auth-required"}<p class="status error" role="alert">
          {translate(locale, "settings.syncAuthRequired")}
        </p>{/if}
      {#if syncState === "error"}<p class="status error" role="alert">
          {translate(locale, "settings.syncError")}
        </p>{/if}
      {#if config.sync.enabled}
        <Button
          variant="danger"
          class="delete-cloud"
          disabled={deleteState === "deleting"}
          onclick={() => void deleteCloud()}
        >
          <Icon name="trash" size={17} />
          {deleteState === "deleting"
            ? translate(locale, "common.loading")
            : translate(locale, "settings.deleteCloud")}
        </Button>
        {#if deleteState === "success"}<p class="status success" role="status">
            {translate(locale, "settings.deletedCloud")}
          </p>{/if}
        {#if deleteState === "error"}<p class="status error" role="alert">
            {translate(locale, "settings.syncError")}
          </p>{/if}
      {/if}
    {:else}
      <Button class="full" onclick={() => void onSignIn()}
        >{translate(locale, "settings.signIn")}</Button
      >
      {#if authState.status === "error"}<p class="status error">
          {translate(locale, "settings.syncError")}
        </p>{/if}
    {/if}
    {#if config.sync.enabled}
      <p class="retention">
        <Icon name="clock" size={15} />
        {translate(locale, "settings.retention", {
          years: Math.round(config.sync.retentionDays / 365),
        })}
      </p>
    {/if}
  </Card>

  <footer>
    <span>CardScope 0.1</span><span>{translate(locale, "settings.noAds")}</span>
  </footer>
</section>

<style>
  .page-heading {
    margin-bottom: 1.25rem;
  }
  .page-heading h1 {
    margin: 0.25rem 0 0;
    font: 700 2rem/1 var(--font-display);
    letter-spacing: -0.04em;
  }
  .eyebrow {
    color: var(--primary);
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .settings-group {
    margin-bottom: 1.2rem;
  }
  :global(.valuation-card) {
    padding: 1rem;
    border-radius: 1rem;
  }
  .preference-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.65rem;
  }
  .preference-grid label {
    display: grid;
    gap: 0.3rem;
  }
  .preference-grid label > span,
  .restore-options legend {
    color: var(--muted);
    font-size: 0.66rem;
    font-weight: 750;
  }
  .preference-grid select {
    width: 100%;
    height: 2.75rem;
    padding: 0 0.65rem;
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 0.65rem;
    background: var(--surface);
    font: 650 0.72rem/1 var(--font-body);
  }
  .preference-grid select:focus-visible,
  .restore-choice input:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--primary) 52%, transparent);
    outline-offset: 2px;
  }
  .preference-note {
    margin: 0.6rem 0 0;
    color: var(--muted);
    font-size: 0.64rem;
    line-height: 1.45;
  }
  .group-heading h2,
  .cloud-heading h2 {
    margin: 0 0 0.55rem;
    font: 700 0.95rem/1.25 var(--font-display);
  }
  .group-heading p,
  .cloud-heading p {
    margin: -0.3rem 0 0.6rem;
    color: var(--muted);
    font-size: 0.7rem;
  }
  .cloud-heading {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.75rem;
    align-items: flex-start;
  }
  .icon-box {
    display: grid;
    place-items: center;
    width: 2.8rem;
    aspect-ratio: 1;
    color: var(--success);
    border-radius: 0.75rem;
    background: var(--surface);
  }
  .icon-box.cloud {
    color: var(--primary);
    background: var(--primary-soft);
  }
  .action-list {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 1rem;
    background: var(--surface);
  }
  .restore-options {
    display: grid;
    gap: 0.5rem;
    margin: 0 0 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--line);
    border-radius: 0.85rem;
    background: var(--surface-muted);
  }
  .restore-options legend {
    padding: 0 0.25rem;
    color: var(--ink);
  }
  .restore-options > p {
    margin: 0;
    color: var(--muted);
    font-size: 0.65rem;
    line-height: 1.45;
  }
  .restore-choice {
    display: grid;
    gap: 0.4rem;
  }
  .restore-choice label {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.5rem;
    align-items: flex-start;
    padding: 0.55rem;
    border: 1px solid var(--line);
    border-radius: 0.65rem;
    background: var(--surface);
    cursor: pointer;
  }
  .restore-choice label.danger {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
    background: var(--danger-soft);
  }
  .restore-choice input {
    width: 1rem;
    height: 1rem;
    margin: 0.1rem 0 0;
    accent-color: var(--primary);
  }
  .restore-choice span {
    display: grid;
    gap: 0.1rem;
  }
  .restore-choice strong {
    font-size: 0.72rem;
  }
  .restore-choice small {
    color: var(--muted);
    font-size: 0.62rem;
    line-height: 1.4;
  }
  .restore-options > .replace-warning {
    padding: 0.5rem;
    color: var(--danger);
    border-radius: 0.5rem;
    background: var(--danger-soft);
    font-weight: 700;
  }
  .action-list button,
  .import-action {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.7rem;
    align-items: center;
    width: 100%;
    min-height: 4rem;
    padding: 0.55rem 0.7rem;
    text-align: left;
    color: var(--ink);
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
  }
  .action-list > :last-child {
    border-bottom: 0;
  }
  .action-list button > span:nth-child(2),
  .import-action > span:nth-child(2) {
    display: grid;
    gap: 0.1rem;
  }
  .action-list strong {
    font-size: 0.78rem;
  }
  .action-list small {
    color: var(--muted);
    font-size: 0.64rem;
  }
  .action-icon {
    display: grid;
    place-items: center;
    width: 2.5rem;
    aspect-ratio: 1;
    color: var(--primary);
    border-radius: 0.65rem;
    background: var(--primary-soft);
  }
  .import-action {
    cursor: pointer;
  }
  .import-action:has(input:focus-visible) {
    position: relative;
    z-index: 1;
    outline: 3px solid color-mix(in srgb, var(--primary) 52%, transparent);
    outline-offset: -3px;
    border-radius: 0.35rem;
  }
  .import-action input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  :global(.cloud-group) {
    padding: 1rem;
    border-radius: 1rem;
  }
  .cloud-heading {
    margin-bottom: 0.8rem;
  }
  .account-state {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.65rem;
    color: var(--muted);
    font-size: 0.7rem;
  }
  .account-state span {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 0.3rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .account-state button {
    min-height: 2.75rem;
    color: var(--danger);
    border: 0;
    background: transparent;
    font-weight: 700;
  }
  .account-cache-note {
    margin: 0 0 0.65rem;
    color: var(--muted);
    font-size: 0.63rem;
    line-height: 1.45;
  }
  .disabled-message {
    padding: 0.75rem;
    color: var(--muted);
    border-radius: 0.7rem;
    background: var(--surface-muted);
    font-size: 0.72rem;
  }
  .retention {
    display: flex;
    align-items: flex-start;
    gap: 0.35rem;
    margin: 0.7rem 0 0;
    color: var(--muted);
    font-size: 0.63rem;
  }
  :global(.full),
  :global(.delete-cloud) {
    width: 100%;
  }
  :global(.delete-cloud) {
    margin-top: 0.55rem;
  }
  .status {
    margin: 0.55rem 0 0;
    padding: 0.55rem 0.7rem;
    border-radius: 0.55rem;
    font-size: 0.68rem;
    font-weight: 700;
  }
  .status.success {
    color: var(--success);
    background: var(--success-soft);
  }
  .status.error {
    color: var(--danger);
    background: var(--danger-soft);
  }
  footer {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 1rem 0;
    color: var(--muted);
    border-top: 1px solid var(--line);
    font-size: 0.62rem;
  }
  @media (min-width: 48rem) {
    .settings-page {
      max-width: 42rem;
      margin-inline: auto;
    }
  }
  @media (max-width: 30rem) {
    .preference-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
