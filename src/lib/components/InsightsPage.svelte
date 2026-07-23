<script lang="ts">
  import { formatOptionalMoney, translate, type TranslationKey } from '../i18n';
  import type { CollectionSnapshot, Locale } from '../types';
  import { buildReviewQueue, collectionTotals, holdingMarketValue } from '../value';
  import Icon from './Icon.svelte';

  let { locale, snapshot }: { locale: Locale; snapshot: CollectionSnapshot } = $props();

  const totals = $derived(collectionTotals(snapshot.holdings));
  const reviewQueue = $derived(buildReviewQueue(snapshot.holdings));
  const pricedCount = $derived(snapshot.holdings.filter((holding) => holding.quote).length);
  const priceCoverage = $derived(snapshot.holdings.length ? Math.round((pricedCount / snapshot.holdings.length) * 100) : 0);
  const costCoverage = $derived(
    snapshot.holdings.length
      ? Math.round((snapshot.holdings.filter((holding) => holding.unitCost).length / snapshot.holdings.length) * 100)
      : 0,
  );
</script>

<section class="page insights-page" aria-labelledby="insights-title">
  <header class="page-heading">
    <span class="eyebrow">{translate(locale, 'insights.eyebrow')}</span>
    <h1 id="insights-title">{translate(locale, 'insights.title')}</h1>
    <p>{translate(locale, 'insights.subtitle')}</p>
  </header>

  <div class="market-list">
    {#each totals.currencies as total (total.currency)}
      <div class="market-card">
        <div class="market-top">
          <span>{translate(locale, 'insights.market')} · {total.currency}</span>
          <div aria-hidden="true"><Icon name="chart" size={22} /></div>
        </div>
        <strong>{formatOptionalMoney(locale, total.market, total.currency)}</strong>
        <span class="range">{translate(locale, 'insights.range', { low: formatOptionalMoney(locale, total.low, total.currency), high: formatOptionalMoney(locale, total.high, total.currency) })}</span>
        {#if total.costCoverage === 'partial'}<span class="cost-warning">{translate(locale, 'collection.costPartial')}</span>{/if}
        <div class="net" class:negative={total.net !== null && total.net < 0}>
          <span>{translate(locale, 'insights.net')}</span>
          <b>{total.net !== null && total.net >= 0 ? '+' : ''}{formatOptionalMoney(locale, total.net, total.currency)}</b>
        </div>
      </div>
    {:else}
      <div class="market-card empty-market">{translate(locale, 'collection.noValues')}</div>
    {/each}
  </div>

  <div class="coverage-grid">
    <article>
      <div class="ring" style={`--value: ${priceCoverage * 3.6}deg`}><span>{priceCoverage}%</span></div>
      <div><strong>{translate(locale, 'insights.priceCoverage')}</strong><small>{pricedCount}/{snapshot.holdings.length || 0}</small></div>
    </article>
    <article>
      <div class="ring cost" style={`--value: ${costCoverage * 3.6}deg`}><span>{costCoverage}%</span></div>
      <div><strong>{translate(locale, 'insights.costCoverage')}</strong><small>{snapshot.holdings.filter((holding) => holding.unitCost).length}/{snapshot.holdings.length || 0}</small></div>
    </article>
  </div>

  <section class="review-section" aria-labelledby="review-title">
    <div class="section-heading">
      <div><h2 id="review-title">{translate(locale, 'insights.review')}</h2><p>{translate(locale, 'insights.reviewHelp')}</p></div>
      {#if reviewQueue.length}<span>{reviewQueue.length}</span>{/if}
    </div>
    {#if reviewQueue.length}
      <ol>
        {#each reviewQueue.slice(0, 12) as item (item.holding.id)}
          <li>
            <div class="review-image">
              {#if item.holding.card.images?.small}<img src={item.holding.card.images.small} alt="" loading="lazy" />{:else}<Icon name="image" />{/if}
            </div>
            <div class="review-copy">
              <strong>{item.holding.card.name}</strong>
              <span>{item.holding.card.setName} · {item.holding.card.printedNumber ?? item.holding.card.number}</span>
              <div class="reason-list">
                {#each item.reasons as reason (reason)}<small>{translate(locale, `reason.${reason}` as TranslationKey)}</small>{/each}
              </div>
            </div>
            <b>{formatOptionalMoney(locale, holdingMarketValue(item.holding), item.holding.quote?.currency ?? 'USD')}</b>
          </li>
        {/each}
      </ol>
    {:else}
      <div class="all-good"><Icon name="check" /><span>{translate(locale, 'insights.allGood')}</span></div>
    {/if}
  </section>

  <p class="method-note"><Icon name="shield" size={16} /> {translate(locale, 'insights.methodNote')}</p>
</section>

<style>
  .page-heading { margin-bottom: 1rem; }
  .page-heading h1 { margin: .25rem 0 .35rem; font: 700 2rem/1 var(--font-display); letter-spacing: -.04em; }
  .page-heading p { margin: 0; color: var(--muted); font-size: .84rem; }
  .eyebrow { color: var(--primary); font-size: .68rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  .market-list { display: grid; gap: .7rem; }
  .market-card { display: grid; gap: .3rem; padding: 1.15rem; border: 1px solid var(--line); border-radius: 1.3rem; background: linear-gradient(150deg, #fff, #f4f5ff); box-shadow: var(--shadow); }
  .empty-market { color: var(--muted); font-size: .8rem; }
  .market-top { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: .76rem; font-weight: 700; }
  .market-top div { display: grid; place-items: center; width: 2.5rem; aspect-ratio: 1; color: var(--primary); background: var(--primary-soft); border-radius: .75rem; }
  .market-card > strong { font: 750 2.35rem/1.1 var(--font-display); letter-spacing: -.045em; }
  .range { color: var(--muted); font-size: .75rem; }
  .cost-warning { color: var(--warning); font-size: .7rem; font-weight: 700; }
  .net { display: flex; justify-content: space-between; gap: .6rem; margin-top: .7rem; padding-top: .8rem; border-top: 1px solid var(--line); font-size: .78rem; }
  .net b { color: var(--success); }
  .net.negative b { color: var(--danger); }
  .coverage-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .65rem; margin: .75rem 0 1.2rem; }
  .coverage-grid article { display: grid; justify-items: center; gap: .5rem; padding: .8rem .45rem; text-align: center; border: 1px solid var(--line); border-radius: 1rem; background: var(--surface); }
  .coverage-grid article > div:last-child { display: grid; gap: .15rem; }
  .coverage-grid strong { font-size: .72rem; }
  .coverage-grid small { color: var(--muted); font-size: .64rem; }
  .ring { --value: 0deg; display: grid; place-items: center; width: 3.6rem; aspect-ratio: 1; border-radius: 50%; background: conic-gradient(var(--primary) var(--value), var(--surface-muted) 0); }
  .ring::before { content: ''; grid-area: 1/1; width: 2.75rem; aspect-ratio: 1; border-radius: 50%; background: var(--surface); }
  .ring span { z-index: 1; grid-area: 1/1; font-size: .68rem; font-weight: 800; }
  .ring.cost { background: conic-gradient(var(--accent) var(--value), var(--surface-muted) 0); }
  .section-heading { display: flex; justify-content: space-between; gap: .8rem; align-items: flex-start; }
  .section-heading h2 { margin: 0; font: 700 1.1rem/1.2 var(--font-display); }
  .section-heading p { margin: .25rem 0 .7rem; color: var(--muted); font-size: .72rem; }
  .section-heading > span { display: grid; place-items: center; min-width: 1.65rem; height: 1.65rem; color: var(--warning); background: var(--warning-soft); border-radius: 1rem; font-size: .7rem; font-weight: 800; }
  ol { display: grid; gap: .55rem; margin: 0; padding: 0; list-style: none; }
  li { display: grid; grid-template-columns: 2.9rem 1fr auto; gap: .65rem; align-items: center; padding: .65rem; border: 1px solid var(--line); border-radius: .85rem; background: var(--surface); }
  .review-image { display: grid; place-items: center; overflow: hidden; height: 3.8rem; color: var(--muted); border-radius: .3rem; background: var(--surface-muted); }
  .review-image img { width: 100%; height: 100%; object-fit: cover; }
  .review-copy { display: grid; min-width: 0; gap: .1rem; }
  .review-copy > strong, .review-copy > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .review-copy > strong { font-size: .8rem; }
  .review-copy > span { color: var(--muted); font-size: .63rem; }
  li > b { font-size: .72rem; }
  .reason-list { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .2rem; }
  .reason-list small { padding: .2rem .35rem; color: var(--warning); border-radius: .35rem; background: var(--warning-soft); font-size: .56rem; font-weight: 700; }
  .all-good { display: flex; align-items: center; gap: .6rem; padding: 1rem; color: var(--success); border-radius: .9rem; background: var(--success-soft); font-size: .8rem; font-weight: 700; }
  .method-note { display: flex; align-items: flex-start; gap: .4rem; margin: 1rem 0 0; color: var(--muted); font-size: .67rem; line-height: 1.45; }
  @media (min-width: 48rem) { .insights-page { max-width: 44rem; margin-inline: auto; } }
</style>
