<script lang="ts">
  import { formatOptionalMoney, translate, type TranslationKey } from '../i18n';
  import type { Locale, PriceQuote as Quote } from '../types';
  import { quoteAgeInDays, quoteIsStale } from '../value';
  import Icon from './Icon.svelte';

  let { quote, locale, compact = false }: { quote?: Quote; locale: Locale; compact?: boolean } = $props();

  const age = $derived(quote ? quoteAgeInDays(quote) : 0);
  const stale = $derived(quote ? quoteIsStale(quote) : false);
  const observedDate = $derived.by(() => {
    if (!quote) return '';
    const date = new Date(quote.observedAt);
    if (Number.isNaN(date.getTime())) return quote.observedAt;
    return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium' }).format(date);
  });
</script>

{#if quote}
  <div class:compact class:stale class="price-quote">
    <div class="price-main">
      <strong>{formatOptionalMoney(locale, quote.marketPrice ?? quote.low, quote.currency)}</strong>
      {#if !compact}
        <span>
          {formatOptionalMoney(locale, quote.low, quote.currency)}–{formatOptionalMoney(locale, quote.high, quote.currency)}
        </span>
      {/if}
    </div>
    <div class="freshness">
      <Icon name={stale ? 'clock' : 'check'} size={14} />
      <span>{stale ? translate(locale, 'collection.stale') : translate(locale, 'collection.fresh', { age: age ? translate(locale, 'price.days', { count: age }) : translate(locale, 'price.today') })}</span>
    </div>
    <div class="provenance">
      {#if quote.sourceUrl}
        <a href={quote.sourceUrl} target="_blank" rel="noreferrer">
          {translate(locale, 'collection.source', { source: quote.source })}
        </a>
      {:else}
        <span>{translate(locale, 'collection.source', { source: quote.source })}</span>
      {/if}
      <span>{translate(locale, 'price.observed', { date: observedDate })}</span>
    </div>
    {#if !compact}
      <div class="quote-context">
        <span>{quote.market} · {quote.currency}</span>
        {#if quote.finish}<span>{translate(locale, `finish.${quote.finish}` as TranslationKey)}</span>{/if}
        {#if quote.condition}<span>{translate(locale, `condition.${quote.condition}` as TranslationKey)}</span>{/if}
        <span>{translate(locale, `price.liquidity-${quote.liquidity ?? 'unknown'}` as TranslationKey)}</span>
      </div>
      {#if quote.conditionIncluded === false}
        <span class="condition-note">{translate(locale, 'price.conditionUnknown')}</span>
      {/if}
    {/if}
  </div>
{:else}
  <span class="no-price">{translate(locale, 'price.noPrice')}</span>
{/if}

<style>
  .price-quote { display: grid; gap: .35rem; }
  .price-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: .5rem; }
  .price-main strong { color: var(--ink); font-size: 1.12rem; }
  .price-main span, .freshness, a, .no-price, .provenance { color: var(--muted); font-size: .78rem; }
  .freshness { display: flex; align-items: center; gap: .3rem; color: var(--success); }
  .stale .freshness { color: var(--warning); }
  a { width: fit-content; text-decoration: underline; text-underline-offset: 3px; }
  a:focus-visible { border-radius: .15rem; outline: 3px solid color-mix(in srgb, var(--primary) 52%, transparent); outline-offset: 2px; }
  .provenance { display: flex; flex-wrap: wrap; gap: .25rem .55rem; }
  .compact { gap: .15rem; }
  .compact .price-main strong { font-size: .96rem; }
  .quote-context { display: flex; flex-wrap: wrap; gap: .3rem; }
  .quote-context span { padding: .18rem .35rem; color: var(--muted); border-radius: .35rem; background: var(--surface-muted); font-size: .62rem; font-weight: 700; }
  .condition-note { color: var(--warning); font-size: .68rem; font-weight: 650; }
</style>
