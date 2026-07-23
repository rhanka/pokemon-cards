<script lang="ts">
  /* global window, HTMLSelectElement, HTMLFormElement, FormData, SubmitEvent */
  import { Button, Card, Input } from '@sentropic/design-system-svelte';
  import { formatOptionalMoney, translate, type TranslationKey } from '../i18n';
  import type {
    CardCondition,
    CardFinish,
    CollectionSnapshot,
    Holding,
    Locale,
    Money,
    PriceQuote as Quote,
    ValuationPreference,
  } from '../types';
  import { collectionTotals, holdingMarketValue, selectPriceQuote } from '../value';
  import Icon from './Icon.svelte';
  import PriceQuote from './PriceQuote.svelte';

  let {
    locale,
    snapshot,
    valuationPreference,
    onAdjust,
    onRemove,
    onUpdate,
  }: {
    locale: Locale;
    snapshot: CollectionSnapshot;
    valuationPreference: ValuationPreference;
    onAdjust: (holdingId: string, delta: number) => Promise<void>;
    onRemove: (holdingId: string) => Promise<void>;
    onUpdate: (
      holdingId: string,
      patch: { finish?: CardFinish; condition?: CardCondition; unitCost?: Money | null; quote?: Quote | null },
    ) => Promise<void>;
  } = $props();

  let query = $state('');
  const totals = $derived(collectionTotals(snapshot.holdings));
  const filtered = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return snapshot.holdings;
    return snapshot.holdings.filter((holding) =>
      [holding.card.name, holding.card.setName, holding.card.printedNumber, holding.card.number]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(needle)),
    );
  });

  const finishes: CardFinish[] = ['normal', 'reverse', 'holo', 'first-edition', 'other'];
  const conditions: CardCondition[] = ['mint', 'near-mint', 'excellent', 'good', 'played', 'poor'];

  function confirmRemove(holdingId: string): void {
    if (window.confirm(translate(locale, 'collection.confirmRemove'))) {
      void onRemove(holdingId);
    }
  }

  async function updateFinish(holding: Holding, finish: CardFinish): Promise<void> {
    const quotes = holding.card.quotes ?? (holding.card.quote ? [holding.card.quote] : []);
    const quote = selectPriceQuote(
      quotes,
      locale,
      finish,
      holding.condition,
      valuationPreference,
    );
    await onUpdate(holding.id, { finish, quote: quote ?? null });
  }

  async function updateCondition(holding: Holding, condition: CardCondition): Promise<void> {
    const quotes = holding.card.quotes ?? (holding.card.quote ? [holding.card.quote] : []);
    const quote = selectPriceQuote(
      quotes,
      locale,
      holding.finish,
      condition,
      valuationPreference,
    );
    await onUpdate(holding.id, { condition, quote: quote ?? null });
  }

  async function saveCost(event: SubmitEvent, holding: Holding): Promise<void> {
    event.preventDefault();
    const values = new FormData(event.currentTarget as HTMLFormElement);
    const rawAmount = String(values.get('cost') ?? '').trim();
    const currency = String(values.get('currency') ?? '').trim().toUpperCase();
    if (!rawAmount) {
      await onUpdate(holding.id, { unitCost: null });
      return;
    }
    const amount = Number.parseFloat(rawAmount);
    if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) return;
    await onUpdate(holding.id, { unitCost: { amount, currency } });
  }
</script>

<section class="page collection-page" aria-labelledby="collection-title">
  <header class="page-heading">
    <div>
      <span class="eyebrow">{translate(locale, 'collection.eyebrow')}</span>
      <h1 id="collection-title">{translate(locale, 'collection.title')}</h1>
      <p>{translate(locale, 'collection.subtitle', { cards: totals.cards, unique: totals.unique })}</p>
    </div>
    <div class="count-orb" aria-hidden="true">{totals.cards}</div>
  </header>

  <div class="value-hero">
    <span>{translate(locale, 'collection.value')}</span>
    {#if totals.currencies.length}
      <div class="currency-totals">
        {#each totals.currencies as total (total.currency)}
          <article>
            <div class="currency-market">
              <strong>{formatOptionalMoney(locale, total.market, total.currency)}</strong>
              <span>{total.currency}</span>
            </div>
            <div class="value-range">
              <span>{translate(locale, 'collection.range')}</span>
              <b>{formatOptionalMoney(locale, total.low, total.currency)} – {formatOptionalMoney(locale, total.high, total.currency)}</b>
            </div>
            <div class="value-grid">
              <div>
                <span>{translate(locale, 'collection.cost')}</span>
                <b>{formatOptionalMoney(locale, total.cost, total.currency)}</b>
                {#if total.costCoverage === 'partial'}<small>{translate(locale, 'collection.costPartial')}</small>{/if}
              </div>
              <div><span>{translate(locale, 'collection.net')}</span><b class:negative={total.net !== null && total.net < 0}>{formatOptionalMoney(locale, total.net, total.currency)}</b></div>
            </div>
          </article>
        {/each}
      </div>
    {:else}
      <strong class="no-values">{translate(locale, 'collection.noValues')}</strong>
    {/if}
  </div>

  {#if snapshot.holdings.length}
    <Input class="filter-field" label={translate(locale, 'collection.search')} bind:value={query} placeholder="Pikachu, 025/165…" />
    <div class="holding-list">
      {#each filtered as holding (holding.id)}
        <Card class="holding-card">
          <div class="holding-main">
            <div class="card-thumbnail">
              {#if holding.card.images?.small}
                <img src={holding.card.images.small} alt={holding.card.name} loading="lazy" />
              {:else}
                <Icon name="image" />
              {/if}
              {#if holding.quantity > 1}<span class="duplicate-badge">×{holding.quantity}</span>{/if}
            </div>
            <div class="holding-copy">
              <span>{holding.card.setName ?? '—'} · {holding.card.printedNumber ?? holding.card.number ?? '—'}</span>
              <h2>{holding.card.name}</h2>
              <PriceQuote quote={holding.quote} {locale} compact />
            </div>
            <strong class="holding-value">{formatOptionalMoney(locale, holdingMarketValue(holding), holding.quote?.currency ?? 'USD')}</strong>
          </div>
          <div class="holding-details">
            <label>
              <span>{translate(locale, 'scanner.finish')}</span>
              <select
                value={holding.finish}
                onchange={(event) => void updateFinish(holding, (event.currentTarget as HTMLSelectElement).value as CardFinish)}
              >
                {#each finishes as finish (finish)}<option value={finish}>{translate(locale, `finish.${finish}` as TranslationKey)}</option>{/each}
              </select>
            </label>
            <label>
              <span>{translate(locale, 'scanner.condition')}</span>
              <select
                value={holding.condition}
                onchange={(event) => void updateCondition(holding, (event.currentTarget as HTMLSelectElement).value as CardCondition)}
              >
                {#each conditions as condition (condition)}<option value={condition}>{translate(locale, `condition.${condition}` as TranslationKey)}</option>{/each}
              </select>
            </label>
            <form class="cost-form" aria-label={`${translate(locale, 'collection.saveCost')}: ${holding.card.name}`} onsubmit={(event) => void saveCost(event, holding)}>
              <label>
                <span>{translate(locale, 'collection.costAmount')}</span>
                <input name="cost" type="number" min="0" step="0.01" inputmode="decimal" value={holding.unitCost?.amount ?? ''} />
              </label>
              <label>
                <span>{translate(locale, 'collection.costCurrency')}</span>
                <input name="currency" value={holding.unitCost?.currency ?? holding.quote?.currency ?? 'USD'} maxlength="3" pattern={'[A-Za-z]{3}'} required />
              </label>
              <Button type="submit" variant="secondary" size="sm">{translate(locale, 'collection.saveCost')}</Button>
            </form>
            <div class="quantity-controls" aria-label={`${holding.card.name}: ${holding.quantity}`}>
              <Button variant="secondary" size="sm" class="quantity-button" onclick={() => void onAdjust(holding.id, -1)} aria-label={translate(locale, 'collection.decrease')}><Icon name="minus" size={17} /></Button>
              <strong>{holding.quantity}</strong>
              <Button variant="secondary" size="sm" class="quantity-button" onclick={() => void onAdjust(holding.id, 1)} aria-label={translate(locale, 'collection.increase')}><Icon name="plus" size={17} /></Button>
              <Button variant="danger" size="sm" class="quantity-button delete" onclick={() => confirmRemove(holding.id)} aria-label={translate(locale, 'collection.remove')}><Icon name="trash" size={17} /></Button>
            </div>
          </div>
        </Card>
      {/each}
    </div>

    <section class="history" aria-labelledby="history-title">
      <h2 id="history-title">{translate(locale, 'collection.history')}</h2>
      <ol>
        {#each snapshot.activities.slice(0, 8) as activity (activity.id)}
          <li>
            <span class="activity-dot"></span>
            <div><strong>{activity.cardName}</strong><small>{new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(activity.occurredAt))}</small></div>
            {#if activity.quantityDelta}<b>{activity.quantityDelta > 0 ? '+' : ''}{activity.quantityDelta}</b>{/if}
          </li>
        {/each}
      </ol>
    </section>
  {:else}
    <div class="empty-state">
      <div><Icon name="collection" size={38} /></div>
      <h2>{translate(locale, 'collection.empty')}</h2>
    </div>
  {/if}
</section>

<style>
  .page-heading { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1rem; }
  .page-heading h1 { margin: .25rem 0 .2rem; font: 700 2rem/1 var(--font-display); letter-spacing: -.04em; }
  .page-heading p { margin: 0; color: var(--muted); font-size: .85rem; }
  .eyebrow { color: var(--primary); font-size: .68rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  .count-orb { display: grid; place-items: center; width: 3.4rem; aspect-ratio: 1; color: var(--primary); background: var(--primary-soft); border-radius: 50%; font: 800 .95rem/1 var(--font-display); }
  .value-hero { display: grid; gap: .25rem; padding: 1.15rem; color: white; border-radius: 1.3rem; background: radial-gradient(circle at 90% 0, rgba(117,122,255,.72), transparent 42%), linear-gradient(145deg, #18213d, #273967); box-shadow: 0 1rem 2rem rgba(24,33,61,.18); }
  .value-hero > span, .value-range span, .value-grid span { color: rgba(255,255,255,.68); font-size: .72rem; }
  .currency-totals { display: grid; gap: .85rem; }
  .currency-totals article { display: grid; gap: .25rem; }
  .currency-totals article + article { padding-top: .85rem; border-top: 1px solid rgba(255,255,255,.2); }
  .currency-market { display: flex; justify-content: space-between; align-items: baseline; gap: .7rem; }
  .currency-market strong { font: 750 2.15rem/1.15 var(--font-display); letter-spacing: -.035em; }
  .currency-market span { color: rgba(255,255,255,.72); font-size: .72rem; font-weight: 800; }
  .no-values { font-size: .85rem; line-height: 1.4; }
  .value-range { display: flex; align-items: center; justify-content: space-between; gap: .6rem; padding-bottom: .9rem; border-bottom: 1px solid rgba(255,255,255,.15); }
  .value-range b { font-size: .78rem; }
  .value-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; padding-top: .55rem; }
  .value-grid > div { display: grid; gap: .15rem; }
  .value-grid b { font-size: .9rem; }
  .value-grid small { color: #ffd58a; font-size: .62rem; font-weight: 700; }
  .value-grid b.negative { color: #ffb2b2; }
  :global(.filter-field) { max-width: none; margin: 1rem 0 .75rem; }
  .holding-list { display: grid; gap: .75rem; }
  :global(.holding-card) { overflow: hidden; padding: 0; border-radius: 1.15rem; }
  .holding-main { display: grid; grid-template-columns: 3.6rem minmax(0,1fr) auto; gap: .75rem; align-items: center; padding: .75rem; }
  .card-thumbnail { position: relative; display: grid; place-items: center; overflow: visible; height: 4.6rem; color: var(--muted); border-radius: .35rem; background: var(--surface-muted); }
  .card-thumbnail img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
  .duplicate-badge { position: absolute; right: -.35rem; bottom: -.3rem; display: grid; place-items: center; min-width: 1.65rem; height: 1.65rem; padding: 0 .3rem; color: white; border: 2px solid white; border-radius: 1rem; background: var(--primary); font-size: .68rem; font-weight: 800; }
  .holding-copy { display: grid; min-width: 0; gap: .12rem; }
  .holding-copy > span { overflow: hidden; color: var(--muted); font-size: .69rem; text-overflow: ellipsis; white-space: nowrap; }
  .holding-copy h2 { overflow: hidden; margin: 0; font: 700 .96rem/1.2 var(--font-display); text-overflow: ellipsis; white-space: nowrap; }
  .holding-value { align-self: start; padding-top: .1rem; font-size: .86rem; }
  .holding-details { display: grid; grid-template-columns: 1fr 1fr; gap: .55rem; align-items: end; padding: .65rem .75rem; border-top: 1px solid var(--line); background: var(--surface-muted); }
  .holding-details label { display: grid; gap: .25rem; }
  .holding-details label span { color: var(--muted); font-size: .62rem; font-weight: 700; }
  select, .cost-form input { min-width: 0; height: 2.5rem; padding: 0 .45rem; color: var(--ink); border: 1px solid var(--line); border-radius: .6rem; background: var(--surface); font: 650 .7rem/1 var(--font-body); }
  select:focus-visible, .cost-form input:focus-visible { outline: 3px solid color-mix(in srgb, var(--primary) 52%, transparent); outline-offset: 2px; }
  .cost-form { grid-column: 1/-1; display: grid; grid-template-columns: minmax(0, 1fr) 5.5rem; gap: .45rem; align-items: end; }
  .cost-form :global(button) { grid-column: 1/-1; width: 100%; }
  .quantity-controls { grid-column: 1/-1; display: grid; grid-template-columns: 2.6rem 2rem 2.6rem 1fr; align-items: center; justify-items: center; gap: .25rem; }
  :global(.quantity-button) { width: 2.6rem; min-width: 2.6rem; }
  :global(.quantity-button.delete) { justify-self: end; }
  .history { margin-top: 1.3rem; }
  .history h2 { font: 700 1rem/1.2 var(--font-display); }
  .history ol { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
  .history li { display: grid; grid-template-columns: auto 1fr auto; gap: .65rem; align-items: center; min-height: 3.4rem; border-bottom: 1px solid var(--line); }
  .activity-dot { width: .55rem; aspect-ratio: 1; border: 2px solid var(--primary); border-radius: 50%; background: var(--surface); }
  .history li div { display: grid; gap: .1rem; }
  .history strong { font-size: .78rem; }
  .history small { color: var(--muted); font-size: .65rem; }
  .history b { color: var(--success); font-size: .75rem; }
  .empty-state { display: grid; justify-items: center; gap: .7rem; margin-top: 1.2rem; padding: 3rem 1rem; text-align: center; color: var(--muted); border: 1px dashed var(--line-strong); border-radius: 1.25rem; }
  .empty-state > div { display: grid; place-items: center; width: 4.7rem; aspect-ratio: 1; color: var(--primary); background: var(--primary-soft); border-radius: 50%; }
  .empty-state h2 { max-width: 20rem; margin: 0; font: 650 1rem/1.4 var(--font-display); }
  @media (min-width: 48rem) { .collection-page { max-width: 48rem; margin-inline: auto; } .quantity-controls { grid-column: 1/-1; } .holding-details { grid-template-columns: 1fr 1fr; } }
</style>
