<script lang="ts">
  /* global HTMLVideoElement, MediaStream, Blob, HTMLElement, navigator, document, Event, HTMLInputElement, URL, console, SubmitEvent, AbortController, AbortSignal, DOMException */
  import { Button, Card, Input } from "@sentropic/design-system-svelte";
  import { onDestroy, tick } from "svelte";
  import { getCatalogCard, recognizeCardImage, searchCatalog } from "../api";
  import type { AddHoldingInput } from "../collection";
  import { prepareImageForRecognition } from "../image-upload";
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
    RuntimeConfig,
    ValuationPreference,
    VisualMatch,
  } from "../types";
  import { selectPriceQuote } from "../value";
  import Icon from "./Icon.svelte";
  import PriceQuote from "./PriceQuote.svelte";

  let {
    locale,
    config,
    online,
    valuationPreference,
    onAdd,
  }: {
    locale: Locale;
    config: RuntimeConfig;
    online: boolean;
    valuationPreference: ValuationPreference;
    onAdd: (input: AddHoldingInput) => Promise<void>;
  } = $props();

  type Stage =
    | "idle"
    | "camera"
    | "ocr"
    | "search"
    | "visual"
    | "hydrate"
    | "results"
    | "confirm"
    | "added"
    | "error";

  let stage = $state<Stage>("idle");
  let video = $state<HTMLVideoElement>();
  let stream: MediaStream | null = null;
  let previewUrl = $state<string>();
  let progress = $state(0);
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
      code === "recognition_busy" ||
      code === "recognition_upload_busy" ||
      code === "recognition_rate_limited"
    ) {
      return translate(locale, "scanner.busy");
    }
    if (
      code === "recognition_timeout" ||
      (error instanceof DOMException && error.name === "TimeoutError")
    ) {
      return translate(locale, "scanner.timeout");
    }
    if (code === "catalogue_unavailable") {
      return translate(locale, "scanner.catalogueUnavailable");
    }
    return translate(locale, "scanner.error");
  }

  function stopCamera(): void {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (stage === "camera") stage = "idle";
  }

  async function startCamera(): Promise<void> {
    errorMessage = "";
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 1920 },
        },
      });
      stage = "camera";
      await tick();
      if (!video) throw new Error("Camera preview is unavailable");
      video.srcObject = stream;
      await video.play();
    } catch (error) {
      errorMessage =
        error instanceof Error
          ? error.message
          : translate(locale, "scanner.error");
      stage = "error";
    }
  }

  async function captureCamera(): Promise<void> {
    if (!video?.videoWidth || !video.videoHeight) return;
    const cardRatio = 2.5 / 3.5;
    let cropHeight = video.videoHeight * 0.86;
    let cropWidth = cropHeight * cardRatio;
    if (cropWidth > video.videoWidth * 0.9) {
      cropWidth = video.videoWidth * 0.9;
      cropHeight = cropWidth / cardRatio;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(cropWidth);
    canvas.height = Math.round(cropHeight);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(
      video,
      (video.videoWidth - cropWidth) / 2,
      (video.videoHeight - cropHeight) / 2,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    stopCamera();
    if (blob) await processImage(blob);
  }

  async function chooseFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) await processImage(file);
  }

  function replacePreview(blob: Blob): void {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
  }

  function cancelRecognition(): void {
    recognitionAttempt += 1;
    recognitionController?.abort();
    recognitionController = null;
    resetResult();
  }

  async function processImage(blob: Blob): Promise<void> {
    const attempt = ++recognitionAttempt;
    recognitionController?.abort();
    const controller = new AbortController();
    recognitionController = controller;
    resetResult(false);
    stage = "ocr";
    progress = 0;
    try {
      const prepared = await prepareImageForRecognition(blob);
      if (attempt !== recognitionAttempt || controller.signal.aborted) return;
      if (prepared.size > config.recognition.maxImageBytes) {
        throw new Error("Prepared recognition image exceeds the upload limit");
      }
      replacePreview(prepared);
      if (!config.recognition.enabled) {
        throw new Error("Server recognition is disabled");
      }
      const recognition = await recognizeCardImage(
        prepared,
        locale,
        controller.signal,
      );
      if (attempt !== recognitionAttempt || controller.signal.aborted) return;
      progress = 100;
      const textResult: ParsedCardText = {
        rawText: "",
        ...recognition.evidence,
      };
      parsed = textResult;
      await showCandidates(
        textResult,
        recognition.cards,
        recognition.visualMatches.map((match) => ({
          ...match,
          provider: "server-model" as const,
        })),
      );
    } catch (error) {
      if (attempt !== recognitionAttempt || controller.signal.aborted) return;
      console.error(error);
      errorMessage = scanFailureMessage(error);
      stage = "error";
    } finally {
      if (recognitionController === controller) recognitionController = null;
    }
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
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
    stage = "added";
  }

  function resetResult(clearPreview = true): void {
    decision = undefined;
    selected = undefined;
    parsed = undefined;
    finish = "";
    condition = "";
    cost = "";
    costCurrency = "";
    errorMessage = "";
    if (clearPreview && previewUrl) URL.revokeObjectURL(previewUrl);
    if (clearPreview) previewUrl = undefined;
    stage = "idle";
  }

  onDestroy(() => {
    recognitionAttempt += 1;
    recognitionController?.abort();
    recognitionController = null;
    stopCamera();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
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

  {#if stage === "camera"}
    <div class="camera-shell">
      <video
        bind:this={video}
        autoplay
        muted
        playsinline
        aria-label={translate(locale, "scanner.title")}
      ></video>
      <div class="card-guide" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
      </div>
      <div class="camera-actions">
        <button
          class="capture-button"
          onclick={captureCamera}
          aria-label={translate(locale, "scanner.capture")}
        >
          <span></span>
        </button>
        <button class="button ghost light" onclick={stopCamera}
          >{translate(locale, "scanner.stop")}</button
        >
      </div>
    </div>
  {:else if stage === "idle" || stage === "added" || stage === "error"}
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

    {#if config.recognition.enabled}
      <Card class="scan-card">
        <div class="scan-illustration" aria-hidden="true">
          <div class="card-back"><span class="scan-lens"></span></div>
          <div class="focus-corners">
            <span></span><span></span><span></span><span></span>
          </div>
        </div>
        <div class="scan-actions">
          <Button size="lg" class="scan-main" onclick={startCamera}>
            <Icon name="camera" />
            {translate(locale, "scanner.camera")}
          </Button>
          <label class="button secondary">
            <Icon name="image" />
            {translate(locale, "scanner.photo")}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              onchange={chooseFile}
            />
          </label>
        </div>
      </Card>
    {:else}
      <Card class="scan-card">
        <p class="scan-unavailable">
          {translate(locale, "scanner.visualUnavailable")}
        </p>
      </Card>
    {/if}

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
  {:else if stage === "ocr" || stage === "search" || stage === "visual" || stage === "hydrate"}
    <Card class="processing-card" role="status" aria-live="polite">
      {#if previewUrl}<img src={previewUrl} alt="" />{/if}
      <div class="processing-copy">
        <span class="spinner" aria-hidden="true"></span>
        <strong>
          {stage === "ocr"
            ? translate(locale, "scanner.processing")
            : stage === "search"
              ? translate(locale, "scanner.searching")
              : stage === "hydrate"
                ? translate(locale, "common.loading")
                : translate(locale, "scanner.model")}
        </strong>
        {#if stage === "ocr"}
          <div class="progress-track">
            <span style={`width: ${progress}%`}></span>
          </div>
          <small>{progress}%</small>
          <Button
            variant="secondary"
            class="ocr-cancel"
            onclick={cancelRecognition}
            >{translate(locale, "common.cancel")}</Button
          >
        {:else if parsed?.query}
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
  .scan-illustration {
    position: relative;
    display: grid;
    place-items: center;
    min-height: 19rem;
    overflow: hidden;
    border-radius: 1rem;
    background: var(--st-semantic-surface-inverse);
  }
  .scan-illustration::before {
    content: "";
    position: absolute;
    inset: 0;
    border: 1px solid
      color-mix(in srgb, var(--st-semantic-text-inverse) 16%, transparent);
    border-radius: inherit;
  }
  .card-back {
    position: relative;
    display: grid;
    place-items: center;
    width: 8.6rem;
    aspect-ratio: 2.5/3.5;
    border: 5px solid
      color-mix(in srgb, var(--st-semantic-text-inverse) 84%, transparent);
    border-radius: 0.7rem;
    background: var(--st-semantic-action-primary);
    box-shadow: var(--st-shadow-floating);
    transform: rotate(-5deg);
  }
  .card-back::after {
    content: "";
    position: absolute;
    inset: 0.45rem;
    border: 2px solid
      color-mix(in srgb, var(--st-semantic-text-inverse) 48%, transparent);
    border-radius: 0.25rem;
  }
  .scan-lens {
    position: relative;
    z-index: 1;
    width: 3.1rem;
    aspect-ratio: 1;
    border: 0.55rem solid
      color-mix(in srgb, var(--st-semantic-text-inverse) 92%, transparent);
    border-radius: 1rem;
    background: var(--st-semantic-data-category1);
    box-shadow: var(--st-shadow-medium);
  }
  .focus-corners {
    position: absolute;
    inset: 1.35rem;
  }
  .focus-corners span {
    position: absolute;
    width: 2.4rem;
    height: 2.4rem;
    border-color: var(--st-semantic-text-inverse);
    border-style: solid;
  }
  .focus-corners span:nth-child(1) {
    top: 0;
    left: 0;
    border-width: 3px 0 0 3px;
    border-radius: 0.5rem 0 0;
  }
  .focus-corners span:nth-child(2) {
    top: 0;
    right: 0;
    border-width: 3px 3px 0 0;
    border-radius: 0 0.5rem 0 0;
  }
  .focus-corners span:nth-child(3) {
    bottom: 0;
    right: 0;
    border-width: 0 3px 3px 0;
    border-radius: 0 0 0.5rem;
  }
  .focus-corners span:nth-child(4) {
    bottom: 0;
    left: 0;
    border-width: 0 0 3px 3px;
    border-radius: 0 0 0 0.5rem;
  }
  .scan-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.65rem;
    margin-top: 0.85rem;
  }
  .scan-actions input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .scan-actions label:has(input:focus-visible) {
    outline: var(--st-focus-width) solid var(--st-focus-color);
    outline-offset: var(--st-focus-offset);
  }
  .manual-search {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.55rem;
    align-items: end;
    margin-top: 1.1rem;
  }
  .camera-shell {
    position: relative;
    overflow: hidden;
    min-height: calc(100dvh - 11rem);
    margin: -1rem;
    border-radius: 0 0 1.5rem 1.5rem;
    background: var(--st-semantic-surface-inverse);
  }
  .camera-shell video {
    width: 100%;
    height: calc(100dvh - 10rem);
    object-fit: cover;
  }
  .card-guide {
    position: absolute;
    top: 50%;
    left: 50%;
    width: min(75vw, 20rem);
    aspect-ratio: 2.5/3.5;
    transform: translate(-50%, -55%);
    border: 1px solid
      color-mix(in srgb, var(--st-semantic-text-inverse) 52%, transparent);
    border-radius: 0.75rem;
    box-shadow: 0 0 0 100vmax var(--st-semantic-surface-overlay);
  }
  .card-guide span {
    position: absolute;
    width: 2.8rem;
    height: 2.8rem;
    border: solid var(--st-semantic-text-inverse);
  }
  .card-guide span:nth-child(1) {
    top: -2px;
    left: -2px;
    border-width: 4px 0 0 4px;
    border-radius: 0.75rem 0 0;
  }
  .card-guide span:nth-child(2) {
    top: -2px;
    right: -2px;
    border-width: 4px 4px 0 0;
    border-radius: 0 0.75rem 0 0;
  }
  .card-guide span:nth-child(3) {
    bottom: -2px;
    right: -2px;
    border-width: 0 4px 4px 0;
    border-radius: 0 0 0.75rem;
  }
  .card-guide span:nth-child(4) {
    bottom: -2px;
    left: -2px;
    border-width: 0 0 4px 4px;
    border-radius: 0 0 0 0.75rem;
  }
  .camera-actions {
    position: absolute;
    inset: auto 0 1rem;
    display: grid;
    justify-items: center;
    gap: 0.6rem;
  }
  .capture-button {
    display: grid;
    place-items: center;
    width: 4.5rem;
    aspect-ratio: 1;
    border: 3px solid var(--st-semantic-text-inverse);
    border-radius: 50%;
    background: transparent;
  }
  .capture-button:focus-visible,
  .candidate:focus-visible,
  .back-button:focus-visible,
  .text-button:focus-visible {
    outline: var(--st-focus-width) solid var(--st-focus-color);
    outline-offset: var(--st-focus-offset);
  }
  .capture-button span {
    width: 3.5rem;
    aspect-ratio: 1;
    border-radius: 50%;
    background: var(--st-semantic-text-inverse);
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
  :global(.processing-card) img {
    width: 100%;
    max-height: 18rem;
    object-fit: cover;
    border-radius: 0.75rem;
  }
  .processing-copy {
    display: grid;
    gap: 0.6rem;
  }
  .processing-copy small {
    color: var(--muted);
  }
  :global(.ocr-cancel) {
    justify-self: start;
    margin-top: 0.15rem;
  }
  .spinner {
    width: 2rem;
    aspect-ratio: 1;
    border: 3px solid var(--primary-soft);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .progress-track {
    overflow: hidden;
    height: 0.35rem;
    border-radius: 1rem;
    background: var(--primary-soft);
  }
  .progress-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--primary);
    transition: width var(--st-motion-normal) var(--st-motion-easing);
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
    .scan-illustration {
      min-height: 24rem;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      border-top-color: var(--st-semantic-border-strong);
    }
    .progress-track span {
      transition: none;
    }
    .card-back,
    .hero-orb {
      transform: none;
    }
  }
</style>
