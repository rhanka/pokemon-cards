import { describe, expect, it, vi } from "vitest";
import {
  findDuplicate,
  nextCollectionEventTimestamp,
  replayCollection,
} from "../../src/lib/collection";
import { holdingsFromCsv, holdingsToCsv } from "../../src/lib/import-export";
import type { CollectionEvent, Holding } from "../../src/lib/types";

const holding: Holding = {
  id: "holding-1",
  cardId: "sv3pt5-025",
  card: {
    id: "sv3pt5-025",
    name: "Pikachu",
    printedNumber: "025",
    setName: "151",
  },
  quantity: 1,
  finish: "normal",
  condition: "near-mint",
  addedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function event(value: Omit<CollectionEvent, "deviceId">): CollectionEvent {
  return { ...value, deviceId: "device-1" } as CollectionEvent;
}

describe("event-sourced collection", () => {
  it("should replay additions and duplicate quantity changes in chronological order", () => {
    const snapshot = replayCollection([
      event({
        id: "event-2",
        type: "holding.quantity-adjusted",
        holdingId: holding.id,
        occurredAt: "2026-01-02T00:00:00.000Z",
        payload: { delta: 2 },
      }),
      event({
        id: "event-1",
        type: "holding.added",
        holdingId: holding.id,
        occurredAt: holding.addedAt,
        payload: { holding },
      }),
    ]);

    expect(snapshot.holdings).toHaveLength(1);
    expect(snapshot.holdings[0].quantity).toBe(3);
    expect(snapshot.eventCount).toBe(2);
    expect(snapshot.activities[0].quantityDelta).toBe(2);
  });

  it("should prefer the central sequence over skewed device clocks", () => {
    const snapshot = replayCollection([
      event({
        id: "adjustment",
        type: "holding.quantity-adjusted",
        holdingId: holding.id,
        occurredAt: "2025-12-31T23:59:59.000Z",
        serverSequence: 12,
        payload: { delta: 1 },
      }),
      event({
        id: "addition",
        type: "holding.added",
        holdingId: holding.id,
        occurredAt: "2026-01-01T00:00:00.000Z",
        serverSequence: 11,
        payload: { holding },
      }),
    ]);

    expect(snapshot.holdings[0].quantity).toBe(2);
    expect(snapshot.activities[0].id).toBe("adjustment");
  });

  it("should replay a new local event after its sequenced central base", () => {
    const snapshot = replayCollection([
      event({
        id: "local-adjustment",
        type: "holding.quantity-adjusted",
        holdingId: holding.id,
        occurredAt: "2025-01-01T00:00:00.000Z",
        payload: { delta: 1 },
      }),
      event({
        id: "central-addition",
        type: "holding.added",
        holdingId: holding.id,
        occurredAt: "2026-01-01T00:00:00.000Z",
        serverSequence: 11,
        payload: { holding },
      }),
    ]);

    expect(snapshot.holdings[0].quantity).toBe(2);
  });

  it("should create local timestamps after the state observed with a slow clock", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      expect(nextCollectionEventTimestamp("2026-01-02T00:00:00.000Z")).toBe(
        "2026-01-02T00:00:00.001Z",
      );
      expect(nextCollectionEventTimestamp()).toBe("2026-01-01T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should retain condition, finish, cost, and quote changes as history", () => {
    const snapshot = replayCollection([
      event({
        id: "a",
        type: "holding.added",
        holdingId: holding.id,
        occurredAt: holding.addedAt,
        payload: { holding },
      }),
      event({
        id: "b",
        type: "holding.updated",
        holdingId: holding.id,
        occurredAt: "2026-01-03T00:00:00.000Z",
        payload: {
          condition: "excellent",
          finish: "reverse",
          unitCost: { amount: 2.5, currency: "CAD" },
          quote: {
            source: "TCGdex",
            market: "global",
            currency: "CAD",
            low: 4,
            marketPrice: 5,
            high: 7,
            observedAt: "2026-01-02T00:00:00.000Z",
            staleAfter: "2026-01-09T00:00:00.000Z",
          },
        },
      }),
    ]);

    expect(snapshot.holdings[0]).toMatchObject({
      condition: "excellent",
      finish: "reverse",
    });
    expect(snapshot.holdings[0].unitCost?.amount).toBe(2.5);
    expect(snapshot.holdings[0].quote?.marketPrice).toBe(5);
    expect(snapshot.activities).toHaveLength(2);
  });

  it("should invalidate a stored quote when a new finish has no compatible quote", () => {
    const priced = {
      ...holding,
      quote: {
        source: "TCGdex",
        market: "tcgplayer",
        currency: "USD",
        finish: "normal" as const,
        low: 4,
        marketPrice: 5,
        high: 7,
        observedAt: "2026-07-20T00:00:00.000Z",
        staleAfter: "2026-07-27T00:00:00.000Z",
      },
    };
    const snapshot = replayCollection([
      event({
        id: "a",
        type: "holding.added",
        holdingId: priced.id,
        occurredAt: priced.addedAt,
        payload: { holding: priced },
      }),
      event({
        id: "b",
        type: "holding.updated",
        holdingId: priced.id,
        occurredAt: "2026-07-21T00:00:00.000Z",
        payload: { finish: "reverse", quote: null },
      }),
    ]);

    expect(snapshot.holdings[0]).toMatchObject({ finish: "reverse" });
    expect(snapshot.holdings[0].quote).toBeUndefined();
  });

  it("should find duplicate holdings only when card, finish, and condition match", () => {
    const snapshot = replayCollection([
      event({
        id: "a",
        type: "holding.added",
        holdingId: holding.id,
        occurredAt: holding.addedAt,
        payload: { holding },
      }),
    ]);

    expect(
      findDuplicate(snapshot, {
        card: holding.card,
        finish: "normal",
        condition: "near-mint",
      })?.id,
    ).toBe(holding.id);
    expect(
      findDuplicate(snapshot, {
        card: holding.card,
        finish: "holo",
        condition: "near-mint",
      }),
    ).toBeUndefined();
  });

  it("should keep copies separate when any copy-specific metadata differs", () => {
    const priced: Holding = {
      ...holding,
      unitCost: { amount: 1, currency: "USD" },
      note: "binder copy",
    };
    const snapshot = replayCollection([
      event({
        id: "a",
        type: "holding.added",
        holdingId: priced.id,
        occurredAt: priced.addedAt,
        payload: { holding: priced },
      }),
    ]);

    expect(
      findDuplicate(snapshot, {
        card: priced.card,
        finish: priced.finish,
        condition: priced.condition,
        unitCost: { amount: 100, currency: "USD" },
        note: priced.note,
      }),
    ).toBeUndefined();
    expect(
      findDuplicate(snapshot, {
        card: priced.card,
        finish: priced.finish,
        condition: priced.condition,
        unitCost: priced.unitCost,
        note: "display copy",
      }),
    ).toBeUndefined();
    expect(
      findDuplicate(snapshot, {
        card: priced.card,
        finish: priced.finish,
        condition: priced.condition,
        unitCost: priced.unitCost,
        note: priced.note,
      })?.id,
    ).toBe(priced.id);
    expect(
      findDuplicate(snapshot, {
        card: priced.card,
        finish: priced.finish,
        condition: priced.condition,
        unitCost: priced.unitCost,
        note: priced.note,
        acquiredAt: "2026-02-01T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("should hide a holding after removal without deleting its activity trail", () => {
    const snapshot = replayCollection([
      event({
        id: "a",
        type: "holding.added",
        holdingId: holding.id,
        occurredAt: holding.addedAt,
        payload: { holding },
      }),
      event({
        id: "b",
        type: "holding.removed",
        holdingId: holding.id,
        occurredAt: "2026-01-04T00:00:00.000Z",
        payload: { reason: "sold" },
      }),
    ]);

    expect(snapshot.holdings).toHaveLength(0);
    expect(snapshot.activities).toHaveLength(2);
  });

  it("should round-trip CardScope CSV fields without treating imported prices as fresh", () => {
    const valuedHolding: Holding = {
      ...holding,
      quantity: 2,
      acquiredAt: "2025-12-24T12:00:00.000Z",
      note: "gift copy",
      unitCost: { amount: 1.5, currency: "EUR" },
      quote: {
        source: "TCGdex",
        market: "cardmarket",
        currency: "EUR",
        finish: "normal",
        condition: "near-mint",
        low: 4,
        marketPrice: 5,
        high: 7,
        observedAt: "2026-07-20T00:00:00.000Z",
        staleAfter: "2026-07-27T00:00:00.000Z",
      },
    };

    const [imported] = holdingsFromCsv(holdingsToCsv([valuedHolding]));

    expect(imported).toMatchObject({
      quantity: 2,
      finish: "normal",
      condition: "near-mint",
    });
    expect(imported.unitCost).toEqual({ amount: 1.5, currency: "EUR" });
    expect(imported.quote).toMatchObject({
      marketPrice: 5,
      staleAfter: "2026-07-20T00:00:00.000Z",
    });
    expect(imported).toMatchObject({
      acquiredAt: "2025-12-24T12:00:00.000Z",
      note: "gift copy",
    });
  });

  it("should reject negative values and currencies unsupported by Intl in CSV", () => {
    const header =
      "card_id,name,quantity,finish,condition,cost,cost_currency,market_price,price_currency";

    expect(() =>
      holdingsFromCsv(
        `${header}\ncard-1,Pikachu,1,normal,near-mint,-1,USD,2,USD`,
      ),
    ).toThrow(/row 2/i);
    expect(() =>
      holdingsFromCsv(
        `${header}\ncard-1,Pikachu,1,normal,near-mint,1,USD,-2,USD`,
      ),
    ).toThrow(/row 2/i);
    expect(() =>
      holdingsFromCsv(
        `${header}\ncard-1,Pikachu,1,normal,near-mint,1,ZZZ,2,USD`,
      ),
    ).toThrow(/currency|devise|row 2/i);
    expect(() =>
      holdingsFromCsv(
        `${header}\ncard-1,Pikachu,9007199254740992,normal,near-mint,1,USD,2,USD`,
      ),
    ).toThrow(/row 2/i);
  });
});
