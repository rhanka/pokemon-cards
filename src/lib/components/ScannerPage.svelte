<script lang="ts">
  /* global HTMLElement, console, SubmitEvent, AbortController, AbortSignal, DOMException */
  import { Button, Card, Input } from "@sentropic/design-system-svelte";
  import { onDestroy, tick } from "svelte";
  import { getCatalogCard, searchCatalog } from "../api";
  import type { AddHoldingInput } from "../collection";
  import { formatOptionalMoney, translate, type TranslationKey } from "../i18n";
  import { parseCardText } from "../../../shared/card-text";
  import { decideRecognition, scoreCandidates } from "../scoring";
  import type {
    CardCondition,
    CardFinish,
    CatalogLanguage,
    Locale,
    ParsedCardText,
    RecognitionCandidate,
    RecognitionDecision,
    ValuationPreference,
    VisualMatch,
  } from "../types";
  import { selectPriceQuote } from "../value";
  import Icon from "./Icon.svelte";
  import PriceQuote from "./PriceQuote.svelte";

  let {
    locale,
    online,
    valuationPreference,
    onAdd,
  }: {
    locale: Locale;
    online: boolean;
    valuationPreference: ValuationPreference;
    onAdd: (input: AddHoldingInput) => Promise<void>;
  } = $props();

  type Stage =
    | "idle"
    | "search"
    | "hydrate"
    | "results"
    | "confirm"
    | "added"
    | "error";

  let stage = $state<Stage>("idle");
  let parsed = $state<ParsedCardText>();
  let decision = $state<RecognitionDecision>();
  let selected = $state<RecognitionCandidate>();
  let finish = $state<CardFinish | "">("");
  let condition = $state<CardCondition | "">("");
  let cost = $state("");
  let costCurrency = $state("");
  let manualQuery = $state("");
  let errorMessage = $state("");
  let resultsHeading = $state<HTMLElement>();
  let recognitionController: AbortController | null = null;
  let recognitionAttempt = 0;

  const finishes: CardFinish[] = [
    "normal",
    "reverse",
    "holo",
    "first-edition",
    "other",
  ];
  const conditions: CardCondition[] = [
    "mint",
    "near-mint",
    "excellent",
    "good",
    "played",
    "poor",
  ];
  const selectedQuote = $derived(
    selected && finish && condition
      ? selectPriceQuote(
          selected.quotes ?? [],
          locale,
          finish,
          condition,
          valuationPreference,
        )
      : undefined,
  );
  const costCurrencies = $derived([
    ...new Set(
      [selectedQuote?.currency, "USD", "EUR", "CAD"].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ]);
  const canAdd = $derived(
    Boolean(
      selected &&
      catalogLanguage(selected.language) &&
      finish &&
      condition &&
      (!cost || costCurrency),
    ),
  );

  function catalogLanguage(
    language: RecognitionCandidate["language"],
  ): CatalogLanguage | null {
    return language === "en" || language === "fr" ? language : null;
  }

  function cardLanguageLabel(
    language: RecognitionCandidate["language"],
  ): string {
    const supported = catalogLanguage(language);
    return supported
      ? translate(locale, `language.${supported}` as TranslationKey)
      : (language?.toUpperCase() ?? "—");
  }

  function scanFailureMessage(error: unknown): string {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (
      code === "catalogue_rate_limited"
    ) {
      return translate(locale, "scanner.busy");
    }
    if (
      code === "catalogue_timeout" ||
      (error instanceof DOMException && error.name === "TimeoutError")
    ) {
      return translate(locale, "scanner.timeout");
    }
    if (code === "catalogue_unavailable") {
      return translate(locale, "scanner.catalogueUnavailable");
    }
    return translate(locale, "scanner.error");
  }

  async function findCandidates(
    text: ParsedCardText,
    visualMatches: VisualMatch[] = [],
    signal?: AbortSignal,
    attempt = recognitionAttempt,
  ): Promise<void> {
    if (!online) {
      errorMessage = translate(locale, "scanner.offlineSearch");
      stage = "error";
      return;
    }
    stage = "search";
    try {
      const cards = await searchCatalog(
        text,
        "auto",
        locale,
        signal,
        valuationPreference,
      );
      if (attempt !== recognitionAttempt || signal?.aborted) return;
      await showCandidates(text, cards, visualMatches);
    } catch (error) {
      if (attempt !== recognitionAttempt || signal?.aborted) return;
      console.error(error);
      errorMessage = scanFailureMessage(error);
      stage = "error";
    }
  }

  async function showCandidates(
    text: ParsedCardText,
    cards: Awaited<ReturnType<typeof searchCatalog>>,
    visualMatches: VisualMatch[] = [],
  ): Promise<void> {
    decision = decideRecognition(scoreCandidates(text, cards, visualMatches));
    selected = decision.status === "confident" ? decision.best : undefined;
    stage = "results";
    await tick();
    resultsHeading?.focus();
  }

  async function manualSearch(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const text = parseCardText(manualQuery);
    const fraction = manualQuery.match(
      /\b([A-Z]{0,4}\d{1,3}[A-Z]?)\s*\/\s*([A-Z]{0,4}\d{1,3})\b/i,
    );
    const manual: ParsedCardText = {
      ...text,
      name:
        text.name ??
        (manualQuery.replace(fraction?.[0] ?? "", "").trim() || undefined),
      number: text.number ?? fraction?.[1]?.toUpperCase(),
      setTotal: text.setTotal ?? fraction?.[2]?.toUpperCase(),
      query: manualQuery.trim(),
    };
    parsed = manual;
    const attempt = ++recognitionAttempt;
    recognitionController?.abort();
    const controller = new AbortController();
    recognitionController = controller;
    try {
      await findCandidates(manual, [], controller.signal, attempt);
    } finally {
      if (recognitionController === controller) recognitionController = null;
    }
  }

  async function chooseCandidate(
    candidate: RecognitionCandidate,
  ): Promise<void> {
    const language = catalogLanguage(candidate.language);
    if (!language) {
      errorMessage = translate(locale, "scanner.error");
      stage = "error";
      return;
    }
    stage = "hydrate";
    try {
      const hydrated = await getCatalogCard(candidate.id, language, locale, {
        valuationPreference,
      });
      selected = {
        ...candidate,
        ...hydrated,
        score: candidate.score,
        scoreParts: candidate.scoreParts,
        matchReasons: candidate.matchReasons,
        language,
      };
      finish = "";
      condition = "";
      costCurrency = "";
      stage = "confirm";
    } catch (error) {
      console.error(error);
      errorMessage = translate(locale, "scanner.error");
      stage = "error";
    }
  }

  async function addSelected(): Promise<void> {
    const language = catalogLanguage(selected?.language);
    if (
      !selected ||
      !language ||
      !finish ||
      !condition ||
      (cost && !costCurrency)
    ) {
      errorMessage = translate(locale, "scanner.requiredChoices");
      return;
    }
    const parsedCost = Number.parseFloat(cost);
    await onAdd({
      card: { ...selected, language, quote: selectedQuote },
      finish,
      condition,
      quote: selectedQuote,
      unitCost:
        Number.isFinite(parsedCost) && parsedCost >= 0 && costCurrency
          ? { amount: parsedCost, currency: costCurrency }
          : undefined,
    });
    stage = "added";
  }

  function resetResult(): void {
    decision = undefined;
    selected = undefined;
    parsed = undefined;
    finish = "";
    condition = "";
    cost = "";
    costCurrency = "";
    errorMessage = "";
    stage = "idle";
  }

  onDestroy(() => {
    recognitionAttempt += 1;
    recognitionController?.abort();
    recognitionController = null;
  });
</script>

<section class="scanner-page page" aria-labelledby="scanner-title">
  <header class="hero">
    <div>
      <span class="eyebrow"
        ><Icon name="sparkle" size={16} />
        {translate(locale, "scanner.eyebrow")}</span
      >
      <h1 id="scanner-title">{translate(locale, "scanner.title")}</h1>
      <p>{translate(locale, "scanner.help")}</p>
    </div>
    <div class="hero-orb" aria-hidden="true">
      <Icon name="sparkle" size={34} />
    </div>
  </header>

  {#if stage === "idle" || stage === "added" || stage === "error"}
    {#if stage === "added"}
      <div class="notice success" role="status">
        <Icon name="check" />
        {translate(locale, "scanner.added")}
      </div>
    {:else if stage === "error"}
      <div class="notice error" role="alert">
        <span>{errorMessage || translate(locale, "scanner.error")}</span>
        <button class="text-button" onclick={() => resetResult()}
          >{translate(locale, "common.retry")}</button
        >
      </div>
    {/if}

    <Card class="scan-card">
      <p class="scan-unavailable">
        {translate(locale, "scanner.visualUnavailable")}
      </p>
    </Card>

    <form class="manual-search" onsubmit={manualSearch}>
      <Input
        id="manual-query"
        label={translate(locale, "scanner.manual")}
        size="lg"
        bind:value={manualQuery}
        placeholder="Pikachu 025/165"
        required
      />
      <Button type="submit" size="lg" disabled={!online}
        ><Icon name="search" size={18} />
        {translate(locale, "scanner.search")}</Button
      >
    </form>
  {:else if stage === "search" || stage === "hydrate"}
    <Card class="processing-card" role="status" aria-live="polite">
      <div class="processing-copy">
        <span class="spinner" aria-hidden="true"></span>
        <strong>
          {stage === "search"
            ? translate(locale, "scanner.searching")
            : translate(locale, "common.loading")}
        </strong>
        {#if parsed?.query}
          <small>“{parsed.query}”</small>
        {/if}
      </div>
    </Card>
  {:else if stage === "results" && decision}
    <div class="results">
      <div class="results-heading" tabindex="-1" bind:this={resultsHeading}>
        <span
          class:warning={decision.status !== "confident"}
          class="result-icon"
        >
          <Icon name={decision.status === "confident" ? "check" : "search"} />
        </span>
        <div>
          <h2>
            {translate(
              locale,
              decision.status === "confident"
                ? "scanner.confident"
                : decision.status === "review"
                  ? "scanner.review"
                  : "scanner.noMatch",
            )}
          </h2>
          {#if parsed?.query}<p>“{parsed.query}”</p>{/if}
        </div>
      </div>
      {#if decision.candidates.length}
        <div
          class="candidate-list"
          aria-label={translate(locale, "scanner.results")}
        >
          {#each decision.candidates as candidate, index (candidate.id)}
            <button
              class="candidate"
              class:top={index === 0}
              onclick={() => void chooseCandidate(candidate)}
            >
              <div class="candidate-image">
                {#if candidate.images?.small}
                  <img
                    src={candidate.images.small}
                    alt=""
                    crossorigin="anonymous"
                  />
                {:else}
                  <Icon name="image" />
                {/if}
              </div>
              <div class="candidate-copy">
                <span class="candidate-rank"
                  >#{index + 1} · {translate(locale, "scanner.matchScore", {
                    score: Math.round(candidate.score * 100),
                  })}</span
                >
                <strong>{candidate.name}</strong>
                <span
                  >{candidate.setName ?? "—"} · {candidate.printedNumber ??
                    candidate.number ??
                    "—"} · {cardLanguageLabel(candidate.language)}</span
                >
                {#if candidate.quote}
                  <b
                    >{formatOptionalMoney(
                      locale,
                      candidate.quote.marketPrice ?? candidate.quote.low,
                      candidate.quote.currency,
                    )}</b
                  >
                {/if}
              </div>
              <Icon name="arrow" size={20} />
            </button>
          {/each}
        </div>
      {/if}
      <Button variant="secondary" class="full" onclick={() => resetResult()}
        >{translate(locale, "scanner.notCorrect")}</Button
      >
    </div>
  {:else if stage === "confirm" && selected}
    <div class="confirmation">
      <button class="back-button" onclick={() => (stage = "results")}
        >← {translate(locale, "common.cancel")}</button
      >
      <Card class="selected-card">
        {#if selected.images?.small}<img
            src={selected.images.small}
            alt={selected.name}
          />{/if}
        <div>
          <span
            >{selected.setName} · {selected.printedNumber ?? selected.number} · {cardLanguageLabel(
              selected.language,
            )}</span
          >
          <h2>{selected.name}</h2>
          <PriceQuote quote={selectedQuote} {locale} />
        </div>
      </Card>

      <form
        class="confirmation-form"
        onsubmit={(event) => {
          event.preventDefault();
          void addSelected();
        }}
      >
        <fieldset>
          <legend>{translate(locale, "scanner.finish")}</legend>
          <div class="choice-grid">
            {#each finishes as item (item)}
              <label class:chosen={finish === item}>
                <input
                  type="radio"
                  name="finish"
                  value={item}
                  bind:group={finish}
                />
                {translate(locale, `finish.${item}` as TranslationKey)}
              </label>
            {/each}
          </div>
        </fieldset>
        <fieldset>
          <legend>{translate(locale, "scanner.condition")}</legend>
          <div class="choice-grid compact">
            {#each conditions as item (item)}
              <label class:chosen={condition === item}>
                <input
                  type="radio"
                  name="condition"
                  value={item}
                  bind:group={condition}
                />
                {translate(locale, `condition.${item}` as TranslationKey)}
              </label>
            {/each}
          </div>
        </fieldset>
        <label class="field">
          <span>{translate(locale, "scanner.cost")}</span>
          <div class="money-input">
            <input
              type="number"
              min="0"
              step="0.01"
              inputmode="decimal"
              bind:value={cost}
            />
            <select
              aria-label={translate(locale, "scanner.costCurrency")}
              bind:value={costCurrency}
              required={Boolean(cost)}
            >
              <option value="">—</option>
              {#each costCurrencies as currency (currency)}
                <option value={currency}>{currency}</option>
              {/each}
            </select>
          </div>
        </label>
        {#if !canAdd}<p class="required-note">
            {translate(locale, "scanner.requiredChoices")}
          </p>{/if}
        <Button type="submit" size="lg" class="full" disabled={!canAdd}
          ><Icon name="plus" /> {translate(locale, "scanner.add")}</Button
        >
      </form>
    </div>
  {/if}
</section>

<style>
  .hero {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    margin: 0.4rem 0 1.3rem;
  }
  .hero h1 {
    margin: 0.35rem 0 0.4rem;
    max-width: 15ch;
    font: 700 clamp(1.75rem, 7vw, 2.35rem)/1.02 var(--font-display);
    letter-spacing: -0.045em;
  }
  .hero p {
    margin: 0;
    max-width: 35rem;
    color: var(--muted);
    font-size: 0.92rem;
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--primary);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .hero-orb {
    display: grid;
    place-items: center;
    width: 3.5rem;
    aspect-ratio: 1;
    color: var(--primary);
    background: var(--primary-soft);
    border-radius: 50%;
    transform: rotate(7deg);
  }
  :global(.scan-card) {
    padding: 1rem;
    border-radius: 1.6rem;
    background: var(--st-semantic-surface-raised);
    box-shadow: var(--st-component-card-shadow);
  }
  .manual-search {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.55rem;
    align-items: end;
    margin-top: 1.1rem;
  }
  .candidate:focus-visible,
  .candidate:focus-visible,
  .back-button:focus-visible,
  .text-button:focus-visible {
    outline: var(--st-focus-width) solid var(--st-focus-color);
    outline-offset: var(--st-focus-offset);
  }
  :global(.processing-card) {
    display: grid;
    grid-template-columns: minmax(7rem, 36%) 1fr;
    gap: 1.2rem;
    align-items: center;
    padding: 1rem;
    border-radius: 1.4rem;
    box-shadow: var(--st-component-card-shadow);
  }
  .processing-copy {
    display: grid;
    gap: 0.6rem;
  }
  .processing-copy small {
    color: var(--muted);
  }
  .spinner {
    width: 2rem;
    aspect-ratio: 1;
    border: 3px solid var(--primary-soft);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .results {
    display: grid;
    gap: 1rem;
  }
  .results-heading {
    display: flex;
    gap: 0.8rem;
    align-items: center;
  }
  .results-heading:focus-visible {
    outline: var(--st-focus-width) solid var(--st-focus-color);
    outline-offset: var(--st-focus-offset);
  }
  .results-heading h2 {
    margin: 0;
    font: 700 1.25rem/1.2 var(--font-display);
  }
  .results-heading p {
    margin: 0.2rem 0 0;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .result-icon {
    display: grid;
    place-items: center;
    flex: 0 0 2.8rem;
    aspect-ratio: 1;
    color: var(--success);
    background: var(--success-soft);
    border-radius: 50%;
  }
  .result-icon.warning {
    color: var(--warning);
    background: var(--warning-soft);
  }
  .candidate-list {
    display: grid;
    gap: 0.65rem;
  }
  .candidate {
    display: grid;
    grid-template-columns: 3.7rem 1fr auto;
    gap: 0.8rem;
    align-items: center;
    width: 100%;
    min-height: 5.2rem;
    padding: 0.65rem;
    text-align: left;
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 1rem;
    background: var(--surface);
    box-shadow: var(--st-shadow-subtle);
  }
  .candidate.top {
    border-color: color-mix(in srgb, var(--primary) 35%, var(--line));
    box-shadow: var(--st-shadow-medium);
  }
  .candidate-image {
    display: grid;
    place-items: center;
    overflow: hidden;
    height: 4rem;
    color: var(--muted);
    border-radius: 0.4rem;
    background: var(--surface-muted);
  }
  .candidate-image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .candidate-copy {
    display: grid;
    min-width: 0;
    gap: 0.12rem;
  }
  .candidate-copy strong,
  .candidate-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .candidate-copy strong {
    font-size: 0.92rem;
  }
  .candidate-copy span {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .candidate-copy .candidate-rank {
    color: var(--primary);
    font-weight: 800;
  }
  .candidate-copy b {
    margin-top: 0.12rem;
    font-size: 0.8rem;
  }
  .confirmation {
    display: grid;
    gap: 1rem;
  }
  .back-button {
    justify-self: start;
    min-height: 2.75rem;
    padding: 0;
    color: var(--muted);
    border: 0;
    background: transparent;
    font-weight: 700;
  }
  :global(.selected-card) {
    display: grid;
    grid-template-columns: 5.2rem 1fr;
    gap: 1rem;
    align-items: center;
    padding: 0.9rem;
    border-radius: 1.2rem;
    box-shadow: var(--st-component-card-shadow);
  }
  :global(.selected-card > img) {
    width: 100%;
    border-radius: 0.4rem;
  }
  :global(.selected-card h2) {
    margin: 0.15rem 0 0.55rem;
    font: 700 1.25rem/1.1 var(--font-display);
  }
  :global(.selected-card > div > span) {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .confirmation-form {
    display: grid;
    gap: 1.1rem;
  }
  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend,
  .field > span {
    margin-bottom: 0.55rem;
    color: var(--ink);
    font-size: 0.8rem;
    font-weight: 800;
  }
  .choice-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.45rem;
  }
  .choice-grid label {
    display: grid;
    place-items: center;
    min-height: 2.8rem;
    padding: 0.35rem;
    text-align: center;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 0.75rem;
    background: var(--surface);
    font-size: 0.76rem;
    font-weight: 700;
  }
  .choice-grid label.chosen {
    color: var(--primary);
    border-color: var(--primary);
    background: var(--primary-soft);
  }
  .choice-grid input {
    position: absolute;
    opacity: 0;
  }
  .choice-grid label:has(input:focus-visible) {
    outline: var(--st-focus-width) solid var(--st-focus-color);
    outline-offset: var(--st-focus-offset);
  }
  .choice-grid.compact {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .field {
    display: grid;
  }
  .money-input {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 5.2rem;
    align-items: center;
    gap: 0.6rem;
    min-height: 3rem;
    padding: 0 0.8rem;
    border: 1px solid var(--line);
    border-radius: 0.8rem;
    background: var(--surface);
  }
  .money-input input {
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    font: inherit;
  }
  .money-input select {
    min-width: 0;
    height: 2.2rem;
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 0.55rem;
    background: var(--surface);
    font: 700 0.72rem/1 var(--font-body);
  }
  .money-input:has(input:focus-visible),
  .money-input select:focus-visible {
    outline: var(--st-focus-width) solid var(--st-focus-color);
    outline-offset: var(--st-focus-offset);
  }
  .required-note {
    margin: -0.4rem 0 0;
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.4;
  }
  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
    margin-bottom: 0.8rem;
    padding: 0.75rem 0.85rem;
    border-radius: 0.8rem;
    font-size: 0.8rem;
    font-weight: 650;
  }
  .notice.success {
    color: var(--success);
    background: var(--success-soft);
  }
  .notice.error {
    color: var(--danger);
    background: var(--danger-soft);
  }
  :global(.scan-main),
  :global(.full) {
    width: 100%;
  }
  .text-button {
    min-height: 2.7rem;
    padding: 0 0.4rem;
    color: inherit;
    border: 0;
    background: transparent;
    font-weight: 800;
    white-space: nowrap;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (min-width: 48rem) {
    .scanner-page {
      max-width: 42rem;
      margin-inline: auto;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      border-top-color: var(--st-semantic-border-strong);
    }
    .hero-orb {
      transform: none;
    }
  }
</style>
