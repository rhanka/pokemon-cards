# Catalogue, price, and refresh policy

## Source register

| Source                                                                                           | Role                                                                          | Current facts                                                                                                        | Commercial gate                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [TCGdex cards database](https://github.com/tcgdex/cards-database) and [API](https://tcgdex.dev/) | Primary multilingual catalogue and current Cardmarket/TCGplayer quote adapter | Explicit MIT repository licence; live sample `base1-4` returned FR metadata and both EUR/USD quotes dated 2026-07-22 | MIT covers the database/code contribution, not necessarily upstream artwork, logos, trademarks, or marketplace price rights |
| [Pokémon TCG API](https://docs.pokemontcg.io/)                                                   | Secondary EN catalogue and quote comparison                                   | 20,000 requests/day with a free key; 1,000/day and 30/minute without a key                                           | Its public availability is not a blanket redistribution or marketplace licence                                              |
| TCGplayer                                                                                        | US quote market                                                               | Useful SKU-specific USD values                                                                                       | Use an authorised API/feed or an upstream source whose commercial rights are documented; do not scrape HTML                 |
| Cardmarket                                                                                       | EU quote market                                                               | Useful EUR values; freshness can differ from US data                                                                 | Same contract requirement; never label a stale quote “live”                                                                 |
| eBay completed sales                                                                             | Sale evidence and liquidity                                                   | Valuable for rare cards                                                                                              | Marketplace API/licence required; no page scraping                                                                          |

`PokemonTCG/pokemon-tcg-data` has no repository licence as of the study date. It must not be treated as commercially redistributable merely because it is on GitHub.

## Ingestion acceptance

A source or scraper is enabled only when all mandatory fields pass:

1. explicit authority for commercial access and reuse;
2. source identity, retrieval time, market, and currency;
3. stable printing and market-SKU mapping;
4. language, finish, condition/grade, and first-edition semantics;
5. completed-sale versus listing distinction;
6. sample count or a documented confidence surrogate;
7. robots.txt and terms compliance when crawling is explicitly authorised;
8. bounded request rate, cacheability, retry/backoff, and a kill switch;
9. schema-change and duplicate-ID monitoring;
10. a removal path for withdrawn or disputed data.

If any legal or provenance gate fails, CardScope disables that source rather than silently falling back to scraping.

The runtime enforces those decisions with separate, fail-closed switches:

| Switch                        | Default | Required approval                                                         |
| ----------------------------- | ------- | ------------------------------------------------------------------------- |
| `TCGDEX_CATALOG_ENABLED`      | `false` | Recorded commercial catalogue access/reuse decision for TCGdex            |
| `POKEMON_TCG_CATALOG_ENABLED` | `false` | Recorded commercial catalogue access/reuse decision for Pokémon TCG API   |
| `CARD_IMAGES_ENABLED`         | `false` | Recorded artwork/image delivery and cache rights for every enabled source |
| `MARKET_QUOTES_ENABLED`       | `false` | Recorded price-feed access, reuse, attribution, and freshness terms       |

A disabled catalogue is never called and its cached entries are not returned. Cache keys include the complete source/image/quote policy, so enabling or disabling one data class cannot expose a response produced under another policy. Image URLs and quotes are removed from responses unless their own switches are enabled. Fixtures and tests opt in explicitly; production does not inherit test permissions.

## Current MVP refresh

The implemented MVP refreshes only on a bounded user query: it uses a shared server-side TTL cache, per-client and global rate limits, a concurrency cap, upstream timeout/backoff, a hard byte budget before JSON parsing (`CATALOG_MAX_RESPONSE_BYTES`, 2 MiB by default and never above 16 MiB), at most 50 upstream cards per response, and bounded repeated/text/URL fields. It does not yet run the portfolio-aware scheduler described below. Market quotes are stripped by default (`MARKET_QUOTES_ENABLED=false`) and may only be enabled after the relevant commercial access and reuse rights are recorded. A quote whose upstream observation time is absent remains explicitly unknown; retrieval time is not presented as market observation time.

## Target adaptive refresh

- Catalogue: conditional delta check every day, full integrity diff every week, immediate priority for new set releases.
- Held/liquid/high-value SKU: daily; at most every six hours only when an authorised feed updates that often.
- Normal held SKU: weekly.
- Illiquid or unheld SKU: monthly.
- User reads of stale data enqueue one global refresh request with a cooldown. They never create one upstream request per user.

Priority is proportional to:

```text
holders × estimated_value × volatility × liquidity × staleness / fetch_cost
```

The future scheduler must apply per-source quotas, exponential backoff with jitter, and a circuit breaker. A source-level watermark and ETag/Last-Modified should be stored when available. It ships only after authorised source rights and measured cohort costs satisfy the ingestion gates above.

## Retention and presentation

- Store price changes, not repeated identical daily rows.
- Keep daily changes for 90 days, then weekly aggregates for five years.
- Keep one global price history per market SKU; never duplicate it per account.
- Label quotes stale after the source-specific SLA. Default: warning after 48 hours, unreliable after seven days.
- Display low/market/high, source, market, currency, observed time, condition/finish, liquidity, and confidence together.
- Never merge USD TCGplayer and EUR Cardmarket into one unlabeled number.
